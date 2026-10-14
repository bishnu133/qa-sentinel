import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../config.js";
import { changeSet, ensureAtCommit, isGitRepo } from "../git.js";
import { matchesAny } from "../fsutil.js";
import { formatUsage, runClaude } from "../claude.js";
import { ARTIFACT_GLOBS, agentEnv, cleanAgentAnswer, createRunDir, findService, startManifest, writeManifest } from "../run.js";
import { checkServiceUntouched, claudePermissions, diffSnapshots, findingsMarkdown, snapshotTree, type Finding } from "../guardrails.js";
import { requirementsLine, resolveRequirements, storyMarkdown } from "../requirements.js";
import { gitlabContext, gitlabMrFromEnv, upsertMrNote } from "../scm/gitlab.js";
import { log } from "../log.js";

export interface GapReportOptions {
  cwd: string;
  service: string;
  servicePath?: string;
  base?: string;
  head?: string;
  checkout?: boolean;
  storyFile?: string;
  out?: string;
  post?: boolean;
  dryRun?: boolean;
}

export async function gapReportCommand(o: GapReportOptions): Promise<{ report: string; skipped: boolean }> {
  const cwd = path.resolve(o.cwd);
  const c = loadConfig(cwd);
  const service = findService(c, o.service, cwd, o.servicePath);
  const repo = path.resolve(cwd, service.path);
  if (!isGitRepo(repo)) throw new Error(`${repo} is not a git repository`);

  const mr = gitlabMrFromEnv();
  const cs = changeSet(repo, o.base ?? mr.base ?? `origin/${c.ci.targetBranch}`, o.head ?? "HEAD");
  // The agent reads the working tree, so it must be exactly the commit whose diff it analyses.
  ensureAtCommit(repo, cs.head, Boolean(o.checkout));
  const relevant = cs.files.filter((f) => !matchesAny(f, c.agent.skipPaths));

  const out = path.resolve(cwd, o.out ?? "qa-gap-report.md");
  if (relevant.length === 0) {
    const report = `### QA impact – ${service.name}\n**Verdict:** no test-relevant changes (${cs.files.length} file(s) changed, all docs/config). Nothing to check.\n`;
    fs.writeFileSync(out, report);
    log.ok("no test-relevant changes; skipped agent run");
    return { report, skipped: true };
  }

  const req = await resolveRequirements(c, {
    storyFile: o.storyFile,
    mr: { title: mr.title, description: mr.description, url: mr.url, sourceBranch: mr.sourceBranch },
  });
  const run = createRunDir(cwd, `gap-${service.name}`);
  fs.writeFileSync(path.join(run.dir, "change.diff"), cs.diff);
  fs.writeFileSync(path.join(run.dir, "story.md"), storyMarkdown(req));
  fs.writeFileSync(path.join(run.dir, "requirements.json"), JSON.stringify(req, null, 2));
  fs.writeFileSync(
    path.join(run.dir, "context.json"),
    JSON.stringify({ kind: "gap-report", service, serviceRepo: service.path, base: cs.base, head: cs.head, changedFiles: relevant, oracle: oracleHint(req) }, null, 2),
  );
  const manifest = startManifest(cwd, c, run, "gap-report", { service, base: cs.base, head: cs.head, changedFiles: relevant }, req);
  log.step(`${service.name}@${cs.head.slice(0, 8)}: ${relevant.length} relevant file(s) changed; running gap analysis`);

  const testBefore = snapshotTree(cwd);
  const serviceBefore = snapshotTree(repo);
  const addDirs = [repo, ...c.workspace.services.filter((s) => service.dependsOn.includes(s.name)).map((s) => path.resolve(cwd, s.path))];
  const perms = claudePermissions({ write: undefined, bash: [], readOnlyDirs: addDirs });
  const res = await runClaude({
    cwd,
    prompt: [
      "Use the qa-gap-report skill.",
      `Run context: ${run.rel}/context.json, diff: ${run.rel}/change.diff, story: ${run.rel}/story.md.`,
      "Return ONLY the final markdown report as your answer. Do not modify any files.",
    ].join("\n"),
    maxTurns: c.agent.maxTurns.gapReport,
    tools: ["Read", "Grep", "Glob", "Agent"],
    allow: perms.allow,
    deny: perms.deny,
    addDirs,
    model: c.agent.model,
    maxBudgetUsd: c.agent.maxBudgetUsd.gapReport,
    timeoutMs: c.agent.timeoutMinutes.gapReport * 60_000,
    env: agentEnv(c),
    dryRun: o.dryRun,
  });
  manifest.agent = { status: res.status, turns: res.turns, durationMs: res.durationMs, costUsd: res.costUsd, deniedToolCalls: res.denials?.length ?? 0 };
  if (res.denials?.length) fs.writeFileSync(path.join(run.dir, "permission-denials.json"), JSON.stringify(res.denials, null, 2));

  // Read-only means read-only: verify nothing changed, in either repo.
  const findings: Finding[] = [
    ...checkServiceUntouched(repo, service.name, serviceBefore),
    ...diffSnapshots(testBefore, snapshotTree(cwd))
      .filter((p) => !matchesAny(p, ARTIFACT_GLOBS))
      .map((p) => ({ level: "violation" as const, rule: "outside-allowed" as const, file: p, message: "gap reports must not modify the test repo" })),
  ];
  manifest.guardrails = { violations: findings.length, warnings: 0 };
  manifest.finishedAt = new Date().toISOString();

  if (!res.ok) {
    manifest.outcome = `agent-${res.status}`;
    writeManifest(run, manifest);
    throw new Error(`Gap analysis ${res.status}: ${res.result.slice(0, 500)}`);
  }
  if (findings.length) {
    manifest.outcome = "guardrail-violation";
    writeManifest(run, manifest);
    log.fail("the read-only agent modified files; report discarded");
    log.info(findingsMarkdown(findings));
    throw new Error("guardrail violation during gap report");
  }

  const usage = formatUsage(res);
  const report = `${cleanAgentAnswer(res.result)}\n\n${requirementsLine(req)}\n\n<sub>qa-sentinel ${manifest.qaSentinelVersion} gap report · ${service.name}@${cs.head.slice(0, 8)}${usage ? ` · ${usage}` : ""}</sub>\n`;
  fs.writeFileSync(out, report);
  fs.writeFileSync(path.join(run.dir, "report.md"), report);
  manifest.outcome = "reported";
  writeManifest(run, manifest);
  log.ok(`report written to ${path.relative(cwd, out)}${usage ? ` (${usage})` : ""}`);

  if (o.post && !o.dryRun) {
    const ctx = gitlabContext(c.ci.gitlabUrl);
    if (!ctx) log.warn("--post: set QA_SENTINEL_GITLAB_TOKEN (or GITLAB_TOKEN) to comment on the MR");
    else if (!mr.project || !mr.mrIid) log.warn("--post: no merge request context (CI_PROJECT_ID / CI_MERGE_REQUEST_IID) found");
    else {
      const r = await upsertMrNote(ctx, mr.project, mr.mrIid, report);
      log.ok(`MR !${mr.mrIid}: comment ${r.action}`);
    }
  }
  return { report, skipped: false };
}

/** Plain-language oracle state for the agents (see the oracle hierarchy in the change-analyzer agent). */
export function oracleHint(req: { source: string; acceptanceCriteria: unknown[] }): string {
  if (req.source === "none") return "missing";
  return req.acceptanceCriteria.length ? "provided" : "ambiguous";
}
