import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../config.js";
import { indexTests } from "../analysis/testIndex.js";
import { git, resolveSha, workingChanges } from "../git.js";
import { matchesAny } from "../fsutil.js";
import { ARTIFACT_GLOBS, agentEnv, createRunDir, testEnv } from "../run.js";
import { specAt } from "../specs.js";
import { layers } from "../layers.js";
import { engineFor } from "../engines/ClaudeCodeEngine.js";
import { runProcess } from "../proc.js";
import { createOrUpdateMergeRequest, gitlabContext, pushUrl } from "../scm/gitlab.js";
import { formatUsage } from "../claude.js";
import { log } from "../log.js";

/** Tags as qa-sentinel writes them: `@key` or `@key:value`, value limited to route/id characters (no `${`, quotes or code). */
const TAGS = /\s+@[\w-]+(?::[\w./:{},-]+)?(?=[\s"'`]|$)/g;
const tagsIn = (line: string) => (line.match(TAGS) ?? []).map((t) => t.trim());
/** A line with its @tags removed: what must stay identical when only tags were added. */
export const untagged = (line: string) => line.replace(TAGS, "").replace(/\s+$/, "");
/** A test or suite declaration with its title: the only kind of line the tag command may change. */
const DECLARATION = /\b(?:test|it|describe)(?:\.\w+)?\s*\(\s*["'`]/;

/**
 * Only tags may change: pair removed and added lines hunk by hunk. Each pair must be a test/describe declaration,
 * equal once tags are removed, and keep every tag it had (tags are only added). Returns the offending lines
 * (empty = only tags changed).
 */
export function nonTagChanges(diff: string): string[] {
  const bad: string[] = [];
  for (const hunk of diff.split(/^@@.*@@.*$/m).slice(1)) {
    const removed = hunk.split("\n").filter((l) => l.startsWith("-") && !l.startsWith("---")).map((l) => l.slice(1));
    const added = hunk.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).map((l) => l.slice(1));
    if (removed.length !== added.length) {
      bad.push(...added.slice(0, 3).map((l) => `+${l}`), ...removed.slice(0, 3).map((l) => `-${l}`));
      continue;
    }
    removed.forEach((r, i) => {
      const a = added[i];
      const kept = tagsIn(r).every((t) => tagsIn(a).includes(t));
      if (!DECLARATION.test(r) || !DECLARATION.test(a) || untagged(r) !== untagged(a) || !kept) bad.push(`-${r}`, `+${a}`);
    });
  }
  return bad;
}

export interface TagOptions {
  cwd: string;
  push?: boolean;
  dryRun?: boolean;
  limit?: number;
}

/** `qa-sentinel tag`: one-off backfill of @service/@endpoint/@page tags on existing tests, as a branch (and MR). */
export async function tagCommand(o: TagOptions): Promise<number> {
  const cwd = path.resolve(o.cwd);
  const c = loadConfig(cwd);
  const index = indexTests(cwd, c);
  const missing = index.filter((t) => !t.endpoints.length && !t.pages.length).slice(0, o.limit ?? 200);
  log.step(`tag backfill: ${index.length} tests, ${missing.length} without @endpoint or @page`);
  if (!missing.length) {
    log.ok("every test is tagged");
    return 0;
  }
  if (workingChanges(cwd).some((x) => !matchesAny(x.path, ARTIFACT_GLOBS))) throw new Error("The test repo has uncommitted changes; commit or stash them first.");
  const run = createRunDir(cwd, "tag");
  const services = c.workspace.services.map((s) => {
    if (!s.openapi || !s.openapiCommand) return { name: s.name, kind: s.kind, openapi: s.openapi ? path.join(s.path, s.openapi) : undefined, routes: s.routes };
    // Generated at build time: generate it for the current commit and hand the agent that copy.
    const spec = specAt(path.resolve(cwd, s.path), "HEAD", s, { env: testEnv(c), timeoutMs: (s.openapiCommandTimeoutSeconds ?? 180) * 1000 });
    const file = `spec-${s.name}${path.extname(s.openapi) || ".yaml"}`;
    if (spec) fs.writeFileSync(path.join(run.dir, file), spec);
    return { name: s.name, kind: s.kind, openapi: spec ? `${run.rel}/${file}` : undefined, routes: s.routes };
  });
  fs.writeFileSync(path.join(run.dir, "tests-to-tag.json"), JSON.stringify({ services, tests: missing.map((t) => ({ file: t.file, line: t.line, title: t.title })) }, null, 2));
  if (o.dryRun) {
    missing.slice(0, 20).forEach((t) => log.info(`  ${t.file}:${t.line} ${t.title}`));
    return 0;
  }
  const start = resolveSha(cwd, "HEAD");
  const branch = "qa-sentinel/tag-backfill";
  git(cwd, ["checkout", "-q", "-B", branch]);
  const allowed = layers(c).map((l) => `${l.dir}/**`);
  const r = await engineFor(c).run({
    kind: "tag",
    cwd,
    prompt: [
      "Use the tag-tests skill.",
      `Tests to tag: ${run.rel}/tests-to-tag.json. Service repos are readable for their OpenAPI specs and routes.`,
      `You may only change files matching: ${allowed.join(", ")}, and only test title strings.`,
    ].join("\n"),
    readOnlyDirs: c.workspace.services.map((s) => path.resolve(cwd, s.path)).filter((d) => fs.existsSync(d)),
    write: { allowed, blocked: c.guardrails.blockedWritePaths },
    bash: [],
    maxTurns: c.agent.maxTurns.generate,
    maxBudgetUsd: c.agent.maxBudgetUsd.generate,
    timeoutMs: c.agent.timeoutMinutes.generate * 60_000,
    env: agentEnv(c),
    model: c.agent.model,
  });
  const changes = workingChanges(cwd).filter((x) => !matchesAny(x.path, ARTIFACT_GLOBS));
  const outside = changes.filter((x) => !matchesAny(x.path, allowed) || x.status !== "M");
  const bad = changes.length ? nonTagChanges(git(cwd, ["diff", "-U0", "--", ...changes.map((x) => x.path)])) : [];
  if (!r.ok || outside.length || bad.length) {
    log.fail(`tag backfill rejected${!r.ok ? ` (agent ${r.status})` : ""}: ${outside.length ? `files outside the tests or added/deleted: ${outside.map((x) => x.path).join(", ")}; ` : ""}${bad.length ? `non-tag changes:\n${bad.slice(0, 8).join("\n")}` : ""}`);
    git(cwd, ["checkout", "-q", "-f", start]);
    return 1;
  }
  if (!changes.length) {
    log.warn("the agent tagged nothing");
    return 1;
  }
  const tsc = fs.existsSync(path.join(cwd, "tsconfig.json")) ? await runProcess("npx", ["--no-install", "tsc", "--noEmit"], { cwd, env: process.env, timeoutMs: 300_000 }) : undefined;
  if (tsc && tsc.code !== 0) {
    log.fail(`type-check failed after tagging; nothing committed:\n${(tsc.stdout + tsc.stderr).trim().split("\n").slice(-6).join("\n")}`);
    return 1;
  }
  const after = indexTests(cwd, c).filter((t) => !t.endpoints.length && !t.pages.length).length;
  git(cwd, ["add", "-A", "--", ...changes.map((x) => x.path)]);
  git(cwd, ["commit", "-q", "-m", `test: add traceability tags (${missing.length - after} tests)\n\nGenerated by qa-sentinel tag; only test titles changed (checked).`]);
  const summary = `## Traceability tags for existing tests\n\n${missing.length - after} of ${missing.length} untagged tests now carry \`@service\` and \`@endpoint\`/\`@page\` tags. Only test titles changed (qa-sentinel checked every line).\n\n${r.result.trim()}\n\n<sub>${formatUsage(r)}</sub>`;
  fs.writeFileSync(path.join(run.dir, "summary.md"), summary);
  log.ok(`committed on ${branch}: ${missing.length - after}/${missing.length} tests tagged`);
  if (o.push) {
    const ctx = gitlabContext(c.ci.gitlabUrl);
    const projectPath = c.ci.testRepoProject && !/^\d+$/.test(c.ci.testRepoProject) ? c.ci.testRepoProject : process.env.CI_PROJECT_PATH;
    git(cwd, ["push", "--force", pushUrl(c.ci.gitlabUrl, projectPath) ?? "origin", `HEAD:refs/heads/${branch}`]);
    const project = c.ci.testRepoProject ?? process.env.CI_PROJECT_ID;
    if (ctx && project) {
      const mr = await createOrUpdateMergeRequest(ctx, project, { source: branch, target: c.ci.targetBranch, title: "QA agent: traceability tags for existing tests", description: summary, labels: ["qa-agent", "qa-sentinel::tags"] });
      log.ok(`merge request ${mr.action}: ${mr.web_url}`);
    }
  }
  return 0;
}
