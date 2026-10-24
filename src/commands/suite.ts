import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { loadConfig } from "../config.js";
import { indexTests } from "../analysis/testIndex.js";
import { activeParts, assembleFeature, newFeatureCache, revertedParts, type FeatureManifest } from "../feature/manifest.js";
import { inRef, safeRef } from "../release/git.js";
import { gitlabContext } from "../scm/gitlab.js";
import { suiteRunCommands } from "../layers.js";
import { packageScripts } from "../verification.js";
import { testEnv, useEnvironment } from "../run.js";
import { log } from "../log.js";
import { wrapTestCommand } from "../wrapper.js";

export interface SuiteOptions {
  cwd: string;
  /** An environment from `environments:`: run what is deployed there. */
  env?: string;
  /** A release tag (or branch): run what that release contains. */
  tag?: string;
  run?: boolean;
  json?: boolean;
  out?: string;
}

export type StoryState = "included" | "held-back" | "unknown";
export interface StoryVerdict {
  story: string;
  state: StoryState;
  why: string;
}

/**
 * Is a story's feature in this environment (or release tag)? Held back when any of its changes is not merged,
 * was reverted, or is not deployed there (or not in the tag). Unknown (no change found, or the environment/tag cannot
 * tell) counts as established work, so it runs: only a change that is known to be missing is held back.
 */
export function judgeStory(m: FeatureManifest, tag: { ref: string; inRef: (service: string, sha: string) => boolean | undefined } | undefined): StoryVerdict {
  const story = m.story;
  // A change that was reverted and then landed again counts as landed.
  const gone = revertedParts(m.parts);
  const parts = activeParts(m.parts);
  if (!m.parts.length) return { story, state: "unknown", why: "no service change found for this story: treated as established" };
  if (gone.length) return { story, state: "held-back", why: `reverted in ${gone.map((p) => p.service).join(", ")}` };
  if (tag) {
    const states = parts.map((p) => ({ p, in: p.sha ? tag.inRef(p.service, p.sha) : undefined }));
    const missing = states.filter((x) => x.in === false);
    if (missing.length) return { story, state: "held-back", why: `not in ${tag.ref}: ${missing.map((x) => x.p.service).join(", ")}` };
    if (states.some((x) => x.in === undefined)) return { story, state: "unknown", why: `cannot tell if ${tag.ref} contains it (the tag or commit is not in this clone)` };
    return { story, state: "included", why: `in ${tag.ref}` };
  }
  // A hotfix runs on its environment before it is on the main branch, so what is deployed decides, not "merged".
  const open = parts.filter((p) => !p.merged && p.deployed?.includesChange !== true);
  if (open.length) return { story, state: "held-back", why: `not merged yet in ${open.map((p) => p.service).join(", ")}` };
  const behind = parts.filter((p) => p.deployed?.includesChange === false);
  if (behind.length) return { story, state: "held-back", why: `not deployed on ${m.environment}: ${behind.map((p) => p.service).join(", ")}` };
  if (parts.some((p) => p.deployed?.includesChange === undefined)) return { story, state: "unknown", why: `cannot tell if ${m.environment} has it${parts.find((p) => p.deployed?.error)?.deployed?.error ? ` (${parts.find((p) => p.deployed?.error)!.deployed!.error})` : ""}` };
  return { story, state: "included", why: `deployed on ${m.environment}` };
}

/**
 * `qa-sentinel suite --env uat` / `--tag v3.4`: the tests that make sense for what that environment or release
 * contains. A full run on UAT (tag 3.4) while main has 3.5 features fails for the wrong reason. Baseline tests
 * (no @story tag) always run; a test of a story runs when every story it names is in; a test of a held-back story
 * is left out with the reason. Nothing is deleted or changed.
 */
export async function suiteCommand(o: SuiteOptions): Promise<number> {
  const cwd = path.resolve(o.cwd);
  const c = loadConfig(cwd);
  if (o.tag) safeRef(o.tag, "tag");
  if (!o.env && !o.tag) throw new Error("Pass --env <environment> (what is deployed there) or --tag <release tag> (what the release contains)");
  const environment = o.env ? useEnvironment(c, o.env) : undefined;
  const baseUrl = environment ? process.env[c.tests.api.baseUrlEnv] : undefined;
  if (o.env && !baseUrl) throw new Error(`${c.tests.api.baseUrlEnv} is not set for environment ${o.env}: needed to ask the services what they run`);
  const gl = c.workspace.services.some((s) => s.gitlabProject) ? gitlabContext(c.ci.gitlabUrl) : undefined;
  const active = indexTests(cwd, c).filter((t) => t.status === "active");
  const stories = [...new Set(active.flatMap((t) => t.stories))].sort();
  const tag = o.tag ? { ref: o.tag, inRef: (service: string, sha: string) => { const s = c.workspace.services.find((x) => x.name === service); return s ? inRef(path.resolve(cwd, s.path), sha, o.tag!) : undefined; } } : undefined;

  const verdicts = new Map<string, StoryVerdict>();
  // One lookup per service and one revert scan per repository for the whole run, not one per story.
  const cache = newFeatureCache();
  const scanCache = new Map();
  for (const story of stories) verdicts.set(story, judgeStory(await assembleFeature({ c, cwd, story, gitlab: gl, environment, baseUrl, checkUnmerged: true, cache, scanCache }), tag));

  const run: typeof active = [];
  const left: { test: (typeof active)[number]; why: string }[] = [];
  for (const t of active) {
    const held = t.stories.map((s) => verdicts.get(s)!).filter((v) => v.state === "held-back");
    if (held.length) left.push({ test: t, why: held.map((v) => `${v.story}: ${v.why}`).join("; ") });
    else run.push(t);
  }
  const scenarios = run.filter((t) => t.bdd);
  const where = o.env ? `on ${o.env}` : `in ${o.tag}`;
  const md = [
    `### Suite for what is ${o.env ? "deployed" : "released"} ${where}`,
    "",
    `**${run.length} of ${active.length}** active tests run; ${left.length} are left out because their feature is not ${o.env ? "deployed there" : "in the release"}.`,
    "",
    "| Story | In? | Why |",
    "| --- | --- | --- |",
    ...[...verdicts.values()].map((v) => `| ${v.story} | ${v.state === "included" ? "✅" : v.state === "held-back" ? "⏸️ held back" : "❔ unknown (runs)"} | ${v.why} |`),
    ...(left.length ? ["", "Left out:", ...left.map((l) => `- \`${l.test.file}:${l.test.line}\` ${l.test.title} (${l.why})`)] : []),
    ...(scenarios.length ? ["", `Cucumber scenarios (${scenarios.length}; qa-sentinel does not run them, your BDD job does):`, ...scenarios.map((t) => `- \`${t.file}:${t.line}\` ${t.title}`)] : []),
  ].join("\n");
  if (!o.json) log.dim(`lookups this run: ${cache.asked.versionCalls} version endpoint call(s), ${cache.asked.revertScans} revert scan(s) for ${stories.length} stor${stories.length === 1 ? "y" : "ies"} (an answer that failed is kept for the run, not asked again)`);
  const base = path.resolve(cwd, o.out ?? "qa-suite");
  fs.writeFileSync(`${base}.md`, md + "\n");
  fs.writeFileSync(`${base}.txt`, run.filter((t) => !t.bdd).map((t) => `${t.file}:${t.line}`).join("\n") + (run.some((t) => !t.bdd) ? "\n" : ""));
  if (o.json) process.stdout.write(JSON.stringify({ where, run: run.filter((t) => !t.bdd).map((t) => `${t.file}:${t.line}`), asked: cache.asked, cucumber: scenarios.map((t) => `${t.file}:${t.line}`), leftOut: left.map((l) => ({ test: `${l.test.file}:${l.test.line}`, why: l.why })), stories: [...verdicts.values()] }, null, 2) + "\n");
  else log.info(md + `\n\nwritten to ${path.basename(base)}.md and ${path.basename(base)}.txt (file:line list for the runner)`);

  if (!o.run) return 0;
  if (!run.length) {
    log.warn("no tests to run");
    return 2;
  }
  if (scenarios.length) log.warn(`${scenarios.length} Cucumber scenario(s) are listed separately and not run here: run them with your BDD job`);
  const plain = run.filter((t) => !t.bdd);
  if (!plain.length) {
    log.warn("only Cucumber scenarios were selected: nothing to run here");
    return 0;
  }
  const held = [...verdicts.values()].filter((v) => v.state === "held-back").map((v) => v.story);
  let status = 0;
  for (const { command: cmd, note } of suiteRunCommands(c, plain, held, packageScripts(cwd))) {
    if (note) log.warn(note);
    if (!o.json) log.dim(`running: ${cmd}`);
    const r = spawnSync(wrapTestCommand(c, cmd), { cwd, shell: true, stdio: "inherit", env: testEnv(c, process.env, { healing: true }) });
    if ((r.status ?? 1) !== 0) status = r.status ?? 1;
  }
  return status;
}
