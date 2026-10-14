import { log } from "./log.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CONFIG_FILE, type Config, type ServiceConfig } from "./config.js";
import { ensureDir } from "./fsutil.js";
import { resolveSha } from "./git.js";
import { scrubbedEnv } from "./env.js";
import type { RequirementSnapshot } from "./requirements.js";

export const VERSION = "0.4.0";

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
  if (byName) return overridePath ? { ...byName, path: overridePath } : byName;
  if (overridePath) {
    const known = c.workspace.services.map((s) => s.name);
    if (known.length) log.warn(`service "${nameOrPath}" is not in workspace.services (${known.join(", ")}); its openapi, dependsOn and gitlabProject settings are not used`);
    return { name: nameOrPath, path: overridePath, dependsOn: [] };
  }
  const abs = path.resolve(cwd, nameOrPath);
  const byPath = c.workspace.services.find((s) => path.resolve(cwd, s.path) === abs);
  if (byPath) return byPath;
  if (fs.existsSync(abs)) return { name: path.basename(abs), path: path.relative(cwd, abs) || ".", dependsOn: [] };
  throw new Error(`Unknown service "${nameOrPath}". Add it to workspace.services or pass a valid path.`);
}

/** Environment for the agent process and for test runs: allowlisted, never carrying publisher credentials. */
export function agentEnv(c: Config, env: NodeJS.ProcessEnv = process.env) {
  return scrubbedEnv({ baseUrlEnv: c.tests.api.baseUrlEnv, passEnv: c.guardrails.passEnv, forAgent: true }, env);
}
export function testEnv(c: Config, env: NodeJS.ProcessEnv = process.env) {
  return scrubbedEnv({ baseUrlEnv: c.tests.api.baseUrlEnv, passEnv: c.guardrails.passEnv, forAgent: false }, env);
}

/** The test command as a Bash permission rule, e.g. `npx playwright test --project=api *`. */
export function bashRuleForTests(c: Config): string {
  return `${c.tests.api.runCommand.trim()} *`;
}

/** Files the generate command must never commit. */
export const ARTIFACT_GLOBS = [
  ".qa-sentinel/**",
  "qa-sentinel-summary.md",
  "qa-gap-report.md",
  "qa-regression.txt",
  "qa-feature-*",
  "qa-showcase.md",
  "qa-showcase/**",
  "qa-verify.md",
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
}

export function startManifest(
  cwd: string,
  c: Config,
  run: RunDir,
  kind: string,
  svc: { service: ServiceConfig; base: string; head: string; changedFiles: string[] },
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
  return chosen;
}
