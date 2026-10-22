import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { loadConfig } from "../config.js";
import { indexTests } from "../analysis/testIndex.js";
import { activeParts, assembleFeature, revertedParts, type FeatureManifest } from "../feature/manifest.js";
import { inRef, safeRef } from "../release/git.js";
import { gitlabContext } from "../scm/gitlab.js";
import { runCommandsFor } from "../layers.js";
import { testEnv, useEnvironment } from "../run.js";
import { log } from "../log.js";

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
  for (const story of stories) verdicts.set(story, judgeStory(await assembleFeature({ c, cwd, story, gitlab: gl, environment, baseUrl, checkUnmerged: true }), tag));

  const run: typeof active = [];
  const left: { test: (typeof active)[number]; why: string }[] = [];
  for (const t of active) {
    const held = t.stories.map((s) => verdicts.get(s)!).filter((v) => v.state === "held-back");
    if (held.length) left.push({ test: t, why: held.map((v) => `${v.story}: ${v.why}`).join("; ") });
    else run.push(t);
  }
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
  ].join("\n");
  const base = path.resolve(cwd, o.out ?? "qa-suite");
  fs.writeFileSync(`${base}.md`, md + "\n");
  fs.writeFileSync(`${base}.txt`, run.map((t) => `${t.file}:${t.line}`).join("\n") + (run.length ? "\n" : ""));
  if (o.json) process.stdout.write(JSON.stringify({ where, run: run.map((t) => `${t.file}:${t.line}`), leftOut: left.map((l) => ({ test: `${l.test.file}:${l.test.line}`, why: l.why })), stories: [...verdicts.values()] }, null, 2) + "\n");
  else log.info(md + `\n\nwritten to ${path.basename(base)}.md and ${path.basename(base)}.txt (file:line list for the runner)`);

  if (!o.run) return 0;
  if (!run.length) {
    log.warn("no tests to run");
    return 2;
  }
  const bdd = active.filter((t) => t.bdd && run.includes(t)).length;
  if (bdd) log.warn(`${bdd} Cucumber scenario(s) are in the list but not run here: run them with your BDD job`);
  let status = 0;
  for (const cmd of runCommandsFor(c, run.filter((t) => !t.bdd).map((t) => `${t.file}:${t.line}`))) {
    const r = spawnSync(cmd, { cwd, shell: true, stdio: "inherit", env: testEnv(c, process.env, { healing: true }) });
    if ((r.status ?? 1) !== 0) status = r.status ?? 1;
  }
  return status;
}
