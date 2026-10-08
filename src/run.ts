import fs from "node:fs";
import path from "node:path";
import type { Config, ServiceConfig } from "./config.js";
import { ensureDir } from "./fsutil.js";

/** Tools every agent run may use to read the workspace and delegate to sub-agents. */
export const READ_TOOLS = ["Read", "Grep", "Glob", "Task", "Agent"];

export function writeTools(c: Config): string[] {
  const run = c.tests.api.runCommand.trim();
  return [
    ...READ_TOOLS,
    "Edit",
    "Write",
    `Bash(${run}:*)`,
    "Bash(npx tsc --noEmit:*)",
    "Bash(npx eslint:*)",
    "Bash(git status:*)",
    "Bash(git diff:*)",
  ];
}

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
  const byName = c.workspace.services.find((s) => s.name === nameOrPath);
  if (byName) return overridePath ? { ...byName, path: overridePath } : byName;
  if (overridePath) return { name: nameOrPath, path: overridePath, dependsOn: [] };
  const abs = path.resolve(cwd, nameOrPath);
  const byPath = c.workspace.services.find((s) => path.resolve(cwd, s.path) === abs);
  if (byPath) return byPath;
  if (fs.existsSync(abs)) return { name: path.basename(abs), path: path.relative(cwd, abs) || ".", dependsOn: [] };
  throw new Error(`Unknown service "${nameOrPath}". Add it to workspace.services or pass a valid path.`);
}

export function readStory(opts: { storyFile?: string; title?: string; description?: string }): string {
  if (opts.storyFile && fs.existsSync(opts.storyFile)) return fs.readFileSync(opts.storyFile, "utf8");
  const parts = [opts.title && `# ${opts.title}`, opts.description].filter(Boolean);
  return parts.length ? parts.join("\n\n") : "(no story or acceptance criteria provided)";
}

/** Files the generate command must never commit. */
export const ARTIFACT_GLOBS = [
  ".qa-sentinel/**",
  "qa-sentinel-summary.md",
  "qa-gap-report.md",
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
