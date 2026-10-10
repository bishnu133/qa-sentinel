import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../config.js";
import { changeSet, commitMessages, ensureAtCommit, isGitRepo } from "../git.js";
import { matchesAny } from "../fsutil.js";
import { formatUsage } from "../claude.js";
import { ARTIFACT_GLOBS, createRunDir, findService, startManifest, writeManifest } from "../run.js";
import { checkServiceUntouched, diffSnapshots, findingsMarkdown, snapshotTree, type Finding } from "../guardrails.js";
import { requirementsLine, resolveRequirements, storyMarkdown } from "../requirements.js";
import { gitlabContext, gitlabMrFromEnv, upsertMrNote } from "../scm/gitlab.js";
import { capForJira, jiraContext, markdownToJiraWiki, upsertIssueComment } from "../scm/jira.js";
import type { Config } from "../config.js";
import { engineFor } from "../engines/ClaudeCodeEngine.js";
import { addUsage } from "../engines/AgentEngine.js";
import { oracleOf, planChange } from "../plan/planner.js";
import { renderGapReport } from "../plan/render.js";
import { contractDiffMarkdown } from "../analysis/contractDiff.js";
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

export async function gapReportCommand(o: GapReportOptions): Promise<{ report: string; skipped: boolean; exitCode: number }> {
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
    const report = `### QA impact – ${service.name} · 🟢 Low risk\n**Verdict:** no test-relevant changes (${cs.files.length} file(s) changed, all docs/config). Nothing to check.\n`;
    fs.writeFileSync(out, report);
    log.ok("no test-relevant changes; skipped agent run");
    return { report, skipped: true, exitCode: 0 };
  }

  const req = await resolveRequirements(c, {
    storyFile: o.storyFile,
    mr: { title: mr.title, description: mr.description, url: mr.url, sourceBranch: mr.sourceBranch },
    keyHints: [mr.sourceBranch, ...commitMessages(repo, cs.base, cs.head)],
  });
  const run = createRunDir(cwd, `gap-${service.name}`);
  fs.writeFileSync(path.join(run.dir, "change.diff"), cs.diff);
  fs.writeFileSync(path.join(run.dir, "story.md"), storyMarkdown(req));
  fs.writeFileSync(path.join(run.dir, "requirements.json"), JSON.stringify(req, null, 2));
  const manifest = startManifest(cwd, c, run, "gap-report", { service, base: cs.base, head: cs.head, changedFiles: relevant }, req);
  log.step(`${service.name}@${cs.head.slice(0, 8)}: ${relevant.length} relevant file(s) changed; planning`);

  const testBefore = snapshotTree(cwd);
  const serviceBefore = snapshotTree(repo);
  const engine = engineFor(c);
  const outcome = await planChange({ cwd, c, service, repo, cs, relevant, req, run, engine, dryRun: o.dryRun, context: { kind: "gap-report" } });
  const usage = addUsage(...outcome.runs);
  const denials = outcome.runs.flatMap((r) => r.denials ?? []);
  manifest.agent = { status: outcome.runs.at(-1)?.status ?? "not-run", ...usage, deniedToolCalls: denials.length };
  if (denials.length) fs.writeFileSync(path.join(run.dir, "permission-denials.json"), JSON.stringify(denials, null, 2));

  // Read-only means read-only: nothing outside the run directory may change, in either repo.
  const findings: Finding[] = [
    ...checkServiceUntouched(repo, service.name, serviceBefore),
    ...diffSnapshots(testBefore, snapshotTree(cwd))
      .filter((p) => !matchesAny(p, ARTIFACT_GLOBS))
      .map((p) => ({ level: "violation" as const, rule: "outside-allowed" as const, file: p, message: "gap reports must not modify the test repo" })),
  ];
  manifest.guardrails = { violations: findings.length, warnings: 0 };
  manifest.plan = { status: outcome.status, risk: outcome.risked?.overall, corrections: outcome.validation?.corrections.length ?? 0 };
  manifest.finishedAt = new Date().toISOString();

  if (outcome.status === "dry-run") {
    writeManifest(run, manifest);
    log.ok("dry run complete");
    return { report: "", skipped: false, exitCode: 0 };
  }
  if (findings.length) {
    manifest.outcome = "guardrail-violation";
    writeManifest(run, manifest);
    log.fail("the read-only agent modified files; report discarded");
    log.info(findingsMarkdown(findings));
    throw new Error("guardrail violation during gap report");
  }

  const u = formatUsage(usage);
  const footer = `<sub>qa-sentinel ${manifest.qaSentinelVersion} gap report · ${service.name}@${cs.head.slice(0, 8)}${u ? ` · ${u}` : ""}</sub>\n`;
  let report: string;
  let exitCode = 0;
  if (outcome.status === "valid" && outcome.plan && outcome.risked) {
    report =
      renderGapReport({
        service: service.name,
        plan: outcome.plan,
        risked: outcome.risked,
        contract: outcome.contract,
        specPath: service.openapi,
        requirementsLine: requirementsLine(req),
        corrections: outcome.validation?.corrections ?? [],
        warnings: outcome.validation?.warnings ?? [],
        oracle: oracleOf(req),
      }) + `\n\n${footer}`;
    manifest.outcome = "reported";
    log.ok(`plan valid · ${outcome.risked.overall} risk · ${outcome.plan.decisions.length} decision(s)`);
  } else {
    // Still useful: the deterministic parts, plus an honest statement that the AI analysis failed.
    report = [
      `### QA impact – ${service.name} · ⚪ analysis incomplete`,
      "",
      `**qa-sentinel could not produce a valid test plan** (${outcome.status}). A human should review this change.`,
      outcome.message ? `\n<details><summary>Details</summary>\n\n${outcome.message}\n</details>` : "",
      "",
      contractDiffMarkdown(outcome.contract, service.openapi),
      "",
      requirementsLine(req),
      "",
      footer,
    ].join("\n");
    manifest.outcome = `plan-${outcome.status}`;
    exitCode = 1;
    log.fail(`no valid plan: ${outcome.message ?? outcome.status}`);
  }
  fs.writeFileSync(out, report);
  fs.writeFileSync(path.join(run.dir, "report.md"), report);
  writeManifest(run, manifest);
  log.ok(`report written to ${path.relative(cwd, out)}${u ? ` (${u})` : ""}`);

  if (o.post) await publish(c, { report, service: service.name, storyKey: req.storyKey, mr });
  return { report, skipped: false, exitCode };
}

/**
 * Publish the report to every configured target. Publishing never fails the job: a missing token, MR or
 * story key is a warning, because the report itself is already written and kept as a CI artifact.
 */
export async function publish(
  c: Config,
  i: { report: string; service: string; storyKey?: string; mr: ReturnType<typeof gitlabMrFromEnv> },
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  const done: string[] = [];
  for (const target of c.reporting.targets) {
    try {
      if (target === "gitlab-mr") {
        const ctx = gitlabContext(c.ci.gitlabUrl);
        if (!ctx) log.warn("--post (gitlab-mr): set QA_SENTINEL_GITLAB_TOKEN (or GITLAB_TOKEN) to comment on the MR");
        else if (!i.mr.project || !i.mr.mrIid) log.warn("--post (gitlab-mr): no merge request context (CI_PROJECT_ID / CI_MERGE_REQUEST_IID)");
        else {
          const r = await upsertMrNote(ctx, i.mr.project, i.mr.mrIid, i.report);
          log.ok(`MR !${i.mr.mrIid}: comment ${r.action}`);
          done.push("gitlab-mr");
        }
      } else if (target === "jira") {
        const ctx = jiraContext(c.requirements.jira.baseUrl, env);
        if (!ctx) log.warn("--post (jira): set requirements.jira.baseUrl and JIRA_EMAIL + JIRA_API_TOKEN (Cloud) or JIRA_PAT (Server/DC)");
        else if (!i.storyKey) log.warn("--post (jira): no story key found in the MR title, branch or commits; nothing to comment on");
        else {
          const artifact = env.CI_JOB_URL ? `${env.CI_JOB_URL}/artifacts/file/qa-gap-report.md` : undefined;
          const body = capForJira(markdownToJiraWiki(i.report), c.reporting.jira.maxChars, artifact);
          const r = await upsertIssueComment(ctx, i.storyKey, i.service, body, c.reporting.jira.visibility);
          log.ok(`Jira ${i.storyKey}: comment ${r.action} (${r.url})`);
          done.push("jira");
        }
      }
    } catch (e) {
      log.warn(`--post (${target}) failed: ${(e as Error).message}`);
    }
  }
  return done;
}
