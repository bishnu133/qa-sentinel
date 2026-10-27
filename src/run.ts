import { execFileSync } from "node:child_process";
import { log } from "./log.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CONFIG_FILE, type Config, type ServiceConfig } from "./config.js";
import { ensureDir } from "./fsutil.js";
import { resolveSha } from "./git.js";
import { scrubbedEnv } from "./env.js";
import { layerEnvNames, layers, testOnlyEnvNames } from "./layers.js";
import type { RequirementSnapshot } from "./requirements.js";

export const VERSION = "0.8.0-beta.2";

export interface RunDir {
  id: string;
  dir: string; // absolute
  rel: string; // relative to test repo
}

export function createRunDir(cwd: string, kind: string): RunDir {
  const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${kind}`;
  const rel = `.qa-sentinel/runs/${id}`;
  const dir = path.join(cwd, rel);
  ensureDir(dir);
  return { id, dir, rel };
}

export function findService(c: Config, nameOrPath: string, cwd: string, overridePath?: string): ServiceConfig {
  if (/\$\{?[A-Za-z_]/.test(nameOrPath))
    throw new Error(`Service name "${nameOrPath}" looks like an unexpanded CI variable. Check how the pipeline sets it.`);
  const byName = c.workspace.services.find((s) => s.name === nameOrPath);
  if (byName) return overridePath ? { ...byName, path: byName.subdir ? path.join(overridePath, byName.subdir) : overridePath } : byName;
  if (overridePath) {
    const known = c.workspace.services.map((s) => s.name);
    if (known.length) log.warn(`service "${nameOrPath}" is not in workspace.services (${known.join(", ")}); its openapi, dependsOn and gitlabProject settings are not used`);
    return { name: nameOrPath, path: overridePath, dependsOn: [], kind: "api", routes: [] };
  }
  const abs = path.resolve(cwd, nameOrPath);
  const byPath = c.workspace.services.find((s) => path.resolve(cwd, s.path) === abs);
  if (byPath) return byPath;
  if (fs.existsSync(abs)) return { name: path.basename(abs), path: path.relative(cwd, abs) || ".", dependsOn: [], kind: "api", routes: [] };
  throw new Error(`Unknown service "${nameOrPath}". Add it to workspace.services or pass a valid path.`);
}

/** Environment for the agent process and for test runs: allowlisted, never carrying publisher credentials. */
export function agentEnv(c: Config, env: NodeJS.ProcessEnv = process.env) {
  // Login credentials and the cleanup token stay out of the model-driven process unless the team opts in.
  const shared = c.tests.auth.shareWithAgent ? testOnlyEnvNames(c) : [];
  const out = scrubbedEnv({ baseUrlEnv: c.tests.api.baseUrlEnv, passEnv: [...c.guardrails.passEnv, ...layerEnvNames(c), ...shared], forAgent: true }, env);
  // The agent's own test runs must not heal either (and an explicit value beats a .env file's QA_HEALING).
  if (c.tests.web.enabled) out.QA_HEALING = "off";
  return out;
}
/**
 * Test runs started by qa-sentinel (verification, feature runs). Healing is off unless the caller allows it:
 * tests the agent just wrote must pass on their own locators.
 */
export function testEnv(c: Config, env: NodeJS.ProcessEnv = process.env, o: { healing?: boolean } = {}) {
  const out = scrubbedEnv({ baseUrlEnv: c.tests.api.baseUrlEnv, passEnv: [...c.guardrails.passEnv, ...layerEnvNames(c), ...testOnlyEnvNames(c)], forAgent: false }, env);
  if (c.tests.web.enabled) out.QA_HEALING = o.healing && c.tests.web.healing !== "none" ? c.tests.web.healing : "off";
  return out;
}

/** The test commands as Bash permission rules, e.g. `npx playwright test --project=api *` (one per layer). */
export function bashRulesForTests(c: Config): string[] {
  return layers(c).map((l) => `${l.runCommand.trim()} *`);
}
/** @deprecated single-layer form, kept for callers outside generate. */
export function bashRuleForTests(c: Config): string {
  return bashRulesForTests(c)[0];
}

/** Files the generate command must never commit. */
export const ARTIFACT_GLOBS = [
  ".qa-sentinel/**",
  "qa-sentinel-summary.md",
  "qa-gap-report.md",
  "qa-regression.txt",
  "qa-suite.md",
  "qa-suite.txt",
  "qa-feature-*",
  "qa-showcase.md",
  "qa-showcase/**",
  "qa-verify.md",
  "qa-healed.md",
  "qa-metrics.md",
  "qa-story-check.md",
  "qa-stories.md",
  "qa-lessons.md",
  "qa-story-review.md",
  "qa-healed.json",
  ".qa-sentinel-snapshots/**",
  ".qa-data/**",
  "qa-contract-check.md",
  "qa-coverage.md",
  "qa-post-deploy.md",
  "qa-coverage.json",
  "qa-services.draft.yaml",
  "qa-services.draft.md",
  "test-results/**",
  "playwright-report/**",
  "blob-report/**",
  "coverage/**",
  "allure-results/**",
  "node_modules/**",
];

/** Drop any chatter before the first markdown heading of an agent's final answer. */
export function cleanAgentAnswer(text: string): string {
  const t = text.trim();
  const i = t.search(/^#{1,3} /m);
  return (i > 0 ? t.slice(i) : t).trim();
}

export interface Manifest {
  qaSentinelVersion: string;
  kind: string;
  runId: string;
  startedAt: string;
  finishedAt?: string;
  configSha256: string;
  model?: string;
  testRepo: { sha: string };
  service: { name: string; path: string; base: string; head: string; changedFiles: string[] };
  dependencies: { name: string; sha?: string }[];
  requirements: Pick<RequirementSnapshot, "source" | "sourceUrl" | "revision" | "storyKey" | "approvalStatus"> & { acCount: number };
  agent?: { status: string; turns?: number; durationMs?: number; costUsd?: number; deniedToolCalls?: number };
  guardrails?: { violations: number; warnings: number };
  verification?: { status: string };
  plan?: { status: string; risk?: string; corrections: number };
  outcome?: string;
  /** How big the change and the service are, to see how cost grows with them (metrics). */
  size?: { changedFiles: number; diffLines: number; serviceFiles?: number };
  /**
   * generate: when the service change landed (the committer date of its head: a merge commit's date is the merge time)
   * and when its test merge request was opened or updated. `metrics` reports the hours between them.
   */
  trigger?: { serviceCommitAt?: string; mrOpenedAt?: string };
  /** gap-report: the note qa-sentinel wrote on the merge request, so `metrics --online` can count 👍 and 👎 on it. */
  mr?: { project: string; iid: string; noteId: number };
}

/** Add fields to a run's manifest.json after the fact (a deferred publish step knows things the analysis job did not). Best effort. */
export function patchManifest(runDir: string, patch: Partial<Manifest>): boolean {
  const file = path.join(runDir, "manifest.json");
  try {
    const m = JSON.parse(fs.readFileSync(file, "utf8")) as Manifest;
    fs.writeFileSync(file, JSON.stringify({ ...m, ...patch }, null, 2));
    return true;
  } catch {
    return false;
  }
}

/** The test merge request of a deferred generate run was opened now: note it in the run's manifest (metrics: merge to test MR). */
export function markMrOpened(runDir: string): void {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(runDir, "manifest.json"), "utf8")) as Manifest;
    patchManifest(runDir, { trigger: { ...m.trigger, mrOpenedAt: new Date().toISOString() } });
  } catch {
    /* no manifest: nothing to note */
  }
}

/** The committer date of a commit as ISO text, or undefined when git can't tell. */
export function commitDate(repo: string, sha: string): string | undefined {
  try {
    const t = execFileSync("git", ["log", "-1", "--format=%cI", sha], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return t ? new Date(t).toISOString() : undefined;
  } catch {
    return undefined;
  }
}

const countFiles = (repo: string) => {
  try {
    return execFileSync("git", ["ls-files"], { cwd: repo, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\n").filter(Boolean).length;
  } catch {
    return undefined;
  }
};

export function startManifest(
  cwd: string,
  c: Config,
  run: RunDir,
  kind: string,
  svc: { service: ServiceConfig; base: string; head: string; changedFiles: string[]; diff?: string },
  req: RequirementSnapshot,
): Manifest {
  const cfg = fs.readFileSync(path.join(cwd, CONFIG_FILE));
  const m: Manifest = {
    qaSentinelVersion: VERSION,
    kind,
    runId: run.id,
    startedAt: new Date().toISOString(),
    configSha256: crypto.createHash("sha256").update(cfg).digest("hex"),
    model: c.agent.model,
    testRepo: { sha: safeSha(cwd) },
    service: { name: svc.service.name, path: svc.service.path, base: svc.base, head: svc.head, changedFiles: svc.changedFiles },
    dependencies: c.workspace.services
      .filter((s) => svc.service.dependsOn.includes(s.name))
      .map((s) => ({ name: s.name, sha: safeSha(path.resolve(cwd, s.path)) })),
    requirements: {
      source: req.source,
      sourceUrl: req.sourceUrl,
      revision: req.revision,
      storyKey: req.storyKey,
      approvalStatus: req.approvalStatus,
      acCount: req.acceptanceCriteria.length,
    },
    size: {
      changedFiles: svc.changedFiles.length,
      diffLines: (svc.diff ?? "").split("\n").filter((l) => /^[+-](?![+-]{2} )/.test(l)).length,
      serviceFiles: countFiles(path.resolve(cwd, svc.service.path)),
    },
  };
  writeManifest(run, m);
  return m;
}

export function writeManifest(run: RunDir, m: Manifest): void {
  fs.writeFileSync(path.join(run.dir, "manifest.json"), JSON.stringify(m, null, 2));
}

function safeSha(repo: string): string {
  try {
    return resolveSha(repo, "HEAD");
  } catch {
    return "unknown";
  }
}

/**
 * Point the run at a named environment: sets the base URL variable for the agent, the tests and the preflight.
 * Returns the environment's name (or undefined when the base URL comes from the shell as before).
 */
export function useEnvironment(c: Config, name: string | undefined, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const chosen = name ?? c.verification.defaultEnvironment;
  if (!chosen) return undefined;
  const e = c.environments[chosen];
  if (!e) throw new Error(`Unknown environment "${chosen}". Configured: ${Object.keys(c.environments).join(", ") || "none (add environments: in qa-sentinel.config.yaml)"}`);
  env[c.tests.api.baseUrlEnv] = e.baseUrl;
  if (e.webUrl && c.tests.web.enabled) env[c.tests.web.baseUrlEnv] = e.webUrl;
  return chosen;
}
