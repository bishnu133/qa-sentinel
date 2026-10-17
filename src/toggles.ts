import type { Config } from "./config.js";
import type { IndexedTest } from "./analysis/testIndex.js";
import { runProcess } from "./proc.js";
import { log } from "./log.js";

/**
 * Feature toggles. A test says which toggles it needs in its title: `@toggle:new-checkout=on` (several:
 * `@toggle:a=on,b=off`). When qa-sentinel runs tests (verification, post-deploy), it sets those toggles in the
 * environment first with the team's own commands, runs the tests, and always puts every toggle back the way it was,
 * also when the run fails or is interrupted. On a shared environment, a lock (the team's commands, or a GitLab
 * resource_group per environment) keeps two runs from flipping the same toggles at once.
 *
 *   toggles:
 *     passEnv: [FLAGS_TOKEN]
 *     environments:
 *       sit:
 *         get: curl -sf -H "Authorization: Bearer $FLAGS_TOKEN" $FLAGS_URL/flags/{toggle} | jq -r .value
 *         set: curl -sf -X PUT -H "Authorization: Bearer $FLAGS_TOKEN" $FLAGS_URL/flags/{toggle} -d '{"value":"{value}"}'
 */
export type ToggleState = Record<string, string>;

const NAME = /^[A-Za-z0-9_.:-]+$/;
const VALUE = /^[A-Za-z0-9_.:-]+$/;

/** Toggles one test needs, from its @toggle tags. */
export function togglesOf(t: Pick<IndexedTest, "tags">): ToggleState {
  const out: ToggleState = {};
  for (const tag of t.tags) {
    if (!tag.startsWith("toggle:")) continue;
    for (const pair of tag.slice("toggle:".length).split(",")) {
      const [name, value = "on"] = pair.split("=");
      if (name && NAME.test(name) && VALUE.test(value)) out[name] = value;
    }
  }
  return out;
}

export interface ToggleGroup {
  toggles: ToggleState;
  files: string[];
}

/**
 * Spec files grouped by the toggle state their tests need, so each group runs once with its toggles set. A file whose
 * tests need different values of one toggle can't run in one go: it is returned in `conflicts`.
 */
export function groupByToggles(files: string[], index: Pick<IndexedTest, "file" | "tags">[]): { groups: ToggleGroup[]; conflicts: { file: string; toggle: string }[] } {
  const groups = new Map<string, ToggleGroup>();
  const conflicts: { file: string; toggle: string }[] = [];
  for (const f of files) {
    const need: ToggleState = {};
    let conflict: string | undefined;
    for (const t of index.filter((x) => x.file === f || f.endsWith(`/${x.file}`) || x.file.endsWith(`/${f}`))) {
      for (const [k, v] of Object.entries(togglesOf(t))) {
        if (need[k] !== undefined && need[k] !== v) conflict = k;
        need[k] = v;
      }
    }
    if (conflict) {
      conflicts.push({ file: f, toggle: conflict });
      continue;
    }
    const key = JSON.stringify(Object.entries(need).sort());
    const g = groups.get(key) ?? { toggles: need, files: [] };
    g.files.push(f);
    groups.set(key, g);
  }
  return { groups: [...groups.values()], conflicts };
}

export interface ToggleCommands {
  get?: string;
  set: string;
  /** Put a toggle back; default: `set` with the value `get` returned (or `defaults[toggle]`). */
  reset?: string;
  lockAcquire?: string;
  lockRelease?: string;
}

export function commandsFor(c: Config, environment: string | undefined): ToggleCommands | undefined {
  const t = c.toggles;
  return (environment ? t.environments[environment] : undefined) ?? t.environments["*"];
}

const fill = (cmd: string, toggle: string, value = "") => cmd.replace(/\{toggle\}/g, toggle).replace(/\{value\}/g, value);

/**
 * Set the toggles, run `fn`, then put every toggle back (in reverse order), whatever happens. Without commands for
 * the environment, nothing is set and `fn` runs as is, with a warning: the tests may fail for that reason.
 */
export async function withToggles<T>(c: Config, environment: string | undefined, wanted: ToggleState, env: NodeJS.ProcessEnv, fn: () => Promise<T>): Promise<{ result: T; problems: string[] }> {
  const names = Object.keys(wanted);
  if (!names.length) return { result: await fn(), problems: [] };
  const cmds = commandsFor(c, environment);
  const problems: string[] = [];
  if (!cmds) {
    problems.push(`tests need toggles ${names.map((n) => `${n}=${wanted[n]}`).join(", ")}, but toggles.environments has no commands for ${environment ?? "this environment"} ("*" for any)`);
    log.warn(problems[0]);
    return { result: await fn(), problems };
  }
  const shellEnv = { ...env, ...Object.fromEntries(c.toggles.passEnv.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]])) };
  const sh = async (cmd: string) => {
    const r = await runProcess(cmd, [], { cwd: process.cwd(), env: shellEnv, timeoutMs: c.toggles.timeoutSeconds * 1000, shell: true });
    if (r.timedOut || r.code !== 0) throw new Error(`\`${cmd.split(" ")[0]} …\` ${r.timedOut ? "timed out" : `exit ${r.code}: ${(r.stderr || r.stdout).trim().split("\n").at(-1)?.slice(0, 200) ?? ""}`}`);
    return r.stdout.trim();
  };
  if (cmds.lockAcquire) await sh(cmds.lockAcquire);
  const previous: ToggleState = {};
  const changed: string[] = [];
  const restore = async () => {
    for (const name of changed.reverse()) {
      const back = previous[name] ?? c.toggles.defaults[name];
      try {
        if (cmds.reset) await sh(fill(cmds.reset, name, back));
        else if (back !== undefined) await sh(fill(cmds.set, name, back));
        else problems.push(`${name}: no previous value known (add a get command or toggles.defaults.${name}); left at ${wanted[name]}`);
      } catch (e) {
        problems.push(`${name} could not be put back: ${(e as Error).message}`);
      }
    }
    changed.length = 0;
    if (cmds.lockRelease) await sh(cmds.lockRelease).catch((e) => problems.push(`lock not released: ${(e as Error).message}`));
  };
  // An interrupted run (Ctrl C, CI cancel) still puts the toggles back.
  const onSignal = () => void restore().finally(() => process.exit(130));
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    for (const name of names) {
      if (cmds.get) previous[name] = await sh(fill(cmds.get, name));
      if (previous[name] === wanted[name]) continue;
      await sh(fill(cmds.set, name, wanted[name]));
      changed.push(name);
    }
    log.dim(`  toggles: ${names.map((n) => `${n}=${wanted[n]}`).join(", ")}${environment ? ` on ${environment}` : ""}`);
    return { result: await fn(), problems };
  } catch (e) {
    problems.push(`toggles: ${(e as Error).message}`);
    throw Object.assign(new Error(problems.join("; ")), { problems });
  } finally {
    await restore();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    problems.forEach((p) => log.warn(`  ${p}`));
  }
}
