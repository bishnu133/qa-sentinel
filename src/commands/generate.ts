import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../config.js";
import { changeSet, ensureAtCommit, git, hasChanges, isGitRepo, resolveSha, workingChanges } from "../git.js";
import { matchesAny } from "../fsutil.js";
import { formatUsage, runClaude } from "../claude.js";
import {
  ARTIFACT_GLOBS,
  VERSION,
  agentEnv,
  bashRuleForTests,
  cleanAgentAnswer,
  createRunDir,
  findService,
  startManifest,
  testEnv,
  writeManifest,
} from "../run.js";
import {
  checkContent,
  checkPaths,
  checkServiceUntouched,
  claudePermissions,
  findingsMarkdown,
  generatePolicy,
  snapshotTree,
  violations,
} from "../guardrails.js";
import { resolveRequirements, storyMarkdown } from "../requirements.js";
import { findDiscrepancies, verifyChanges } from "../verification.js";
import { mrDescription } from "../reporting.js";
import { createOrUpdateMergeRequest, gitlabContext, pushUrl } from "../scm/gitlab.js";
import { oracleHint } from "./gapReport.js";
import { log } from "../log.js";

export interface GenerateOptions {
  cwd: string;
  service: string;
  servicePath?: string;
  base?: string;
  head?: string;
  checkout?: boolean;
  storyFile?: string;
  push?: boolean;
  dryRun?: boolean;
}

/** Returns the process exit code: 0 only when the change was independently VERIFIED (or there was nothing to do). */
export async function generateCommand(o: GenerateOptions): Promise<number> {
  const cwd = path.resolve(o.cwd);
  const c = loadConfig(cwd);
  const service = findService(c, o.service, cwd, o.servicePath);
  const repo = path.resolve(cwd, service.path);
  if (!isGitRepo(repo)) throw new Error(`${repo} is not a git repository`);
  if (!isGitRepo(cwd)) throw new Error(`The test repo (${cwd}) must be a git repository`);
  if (hasChanges(cwd) && !o.dryRun) throw new Error("The test repo has uncommitted changes; commit or stash them first.");

  const headRef = o.head ?? "HEAD";
  // GitLab sends 0000… as the "before" SHA for new branches; fall back to the previous commit.
  const baseRef = !o.base || /^0+$/.test(o.base) ? `${headRef}~1` : o.base;
  const cs = changeSet(repo, baseRef, headRef);
  ensureAtCommit(repo, cs.head, Boolean(o.checkout));
  const relevant = cs.files.filter((f) => !matchesAny(f, c.agent.skipPaths));
  if (relevant.length === 0) {
    log.ok("no test-relevant changes; nothing to generate");
    return 0;
  }

  // Requirements: explicit file, else the MR that introduced this commit (post-merge pipelines have no MR context).
  const ctx = gitlabContext(c.ci.gitlabUrl);
  const serviceProject = service.gitlabProject ?? process.env.QA_SERVICE_PROJECT;
  const req = await resolveRequirements(c, {
    storyFile: o.storyFile,
    lookup: ctx && serviceProject ? { ctx, project: serviceProject, sha: cs.head } : undefined,
  }).catch((e) => {
    log.warn(`could not fetch requirements from GitLab: ${(e as Error).message}`);
    return resolveRequirements(c, {});
  });
  if (req.source === "none") {
    if (c.requirements.required) throw new Error("No requirements found for this change and requirements.required is true. Pass --story-file or link the MR.");
    log.warn("no requirements found: tests can only be checked against the contract and code");
  } else {
    log.step(`requirements: ${req.storyKey ?? req.title ?? req.source} (${req.acceptanceCriteria.length} AC, ${req.source})`);
  }

  const sha8 = cs.head.slice(0, 8);
  const branch = `qa-sentinel/${service.name}-${sha8}`;
  const policy = generatePolicy(c);
  const run = createRunDir(cwd, `gen-${service.name}`);
  fs.writeFileSync(path.join(run.dir, "change.diff"), cs.diff);
  fs.writeFileSync(path.join(run.dir, "story.md"), storyMarkdown(req));
  fs.writeFileSync(path.join(run.dir, "requirements.json"), JSON.stringify(req, null, 2));
  fs.writeFileSync(
    path.join(run.dir, "context.json"),
    JSON.stringify(
      {
        kind: "generate",
        service,
        serviceRepo: service.path,
        base: cs.base,
        head: cs.head,
        changedFiles: relevant,
        oracle: oracleHint(req),
        maxFixAttempts: c.agent.maxFixAttempts,
        allowedWritePaths: policy.allowed,
        blockedWritePaths: policy.blocked,
      },
      null,
      2,
    ),
  );
  const manifest = startManifest(cwd, c, run, "generate", { service, base: cs.base, head: cs.head, changedFiles: relevant }, req);
  const startSha = resolveSha(cwd, "HEAD");
  const serviceBefore = snapshotTree(repo);

  if (!o.dryRun) git(cwd, ["checkout", "-q", "-B", branch]);
  log.step(`${service.name}@${sha8}: generating API tests on branch ${branch}`);

  const perms = claudePermissions({
    write: policy,
    bash: [bashRuleForTests(c), "npx tsc --noEmit", "git status *", "git diff *"],
    readOnlyDirs: [repo],
  });
  const res = await runClaude({
    cwd,
    prompt: [
      "Use the generate-api-tests skill.",
      `Run context: ${run.rel}/context.json, diff: ${run.rel}/change.diff, story: ${run.rel}/story.md.`,
      `You may only change files matching: ${policy.allowed.join(", ")}. Any other change fails the whole run.`,
      `Bash is allowed for exactly: \`${c.tests.api.runCommand} <spec paths>\`, \`npx tsc --noEmit\`, \`git status\` and \`git diff\`, each as a single command (no cd, pipes, && or variables). Use Read, Grep and Glob to explore files. If a command is denied, rewrite it in that form; do not give up on running the specs.`,
      "qa-sentinel re-runs the changed specs independently afterwards.",
      "Your final answer must be the merge request notes in markdown (the format in the skill).",
    ].join("\n"),
    maxTurns: c.agent.maxTurns.generate,
    tools: ["Read", "Grep", "Glob", "Agent", "Edit", "Write", "Bash"],
    allow: perms.allow,
    deny: perms.deny,
    addDirs: [repo],
    model: c.agent.model,
    maxBudgetUsd: c.agent.maxBudgetUsd.generate,
    timeoutMs: c.agent.timeoutMinutes.generate * 60_000,
    env: agentEnv(c),
    dryRun: o.dryRun,
  });
  manifest.agent = { status: res.status, turns: res.turns, durationMs: res.durationMs, costUsd: res.costUsd, deniedToolCalls: res.denials?.length ?? 0 };
  if (res.denials?.length) fs.writeFileSync(path.join(run.dir, "permission-denials.json"), JSON.stringify(res.denials, null, 2));
  const usage = formatUsage(res);

  if (o.dryRun) {
    writeManifest(run, manifest);
    log.ok("dry run complete");
    return 0;
  }
  if (!res.ok) {
    manifest.outcome = `agent-${res.status}`;
    manifest.finishedAt = new Date().toISOString();
    writeManifest(run, manifest);
    log.fail(`agent run ${res.status}: ${res.result.slice(0, 300)}`);
    log.info(`Partial changes left uncommitted on ${branch} for inspection.`);
    return 1;
  }

  // 1. Guardrails, enforced on what actually changed (not on what the agent says it changed).
  const changes = workingChanges(cwd).filter((x) => !matchesAny(x.path, ARTIFACT_GLOBS));
  const findings = [
    ...checkPaths(changes, policy),
    ...checkContent(changes, {
      repo: cwd,
      ref: startSha,
      allowedHosts: c.guardrails.allowedHosts,
      baseUrl: process.env[c.tests.api.baseUrlEnv],
      assertionRemoval: c.guardrails.assertionRemoval,
    }),
    ...checkServiceUntouched(repo, service.name, serviceBefore),
  ];
  const bad = violations(findings);
  manifest.guardrails = { violations: bad.length, warnings: findings.length - bad.length };
  fs.writeFileSync(path.join(run.dir, "guardrails.json"), JSON.stringify(findings, null, 2));

  if (bad.length) {
    manifest.outcome = "guardrail-violation";
    manifest.finishedAt = new Date().toISOString();
    writeManifest(run, manifest);
    log.fail(`run rejected: ${bad.length} guardrail violation(s). Nothing was committed.`);
    log.info(findingsMarkdown(bad));
    log.info(`The changes are left uncommitted on ${branch} for inspection.`);
    return 1;
  }
  if (changes.length === 0) {
    manifest.outcome = "no-changes";
    manifest.finishedAt = new Date().toISOString();
    writeManifest(run, manifest);
    log.ok("agent made no test changes (existing coverage judged sufficient)");
    fs.writeFileSync(path.join(cwd, "qa-sentinel-summary.md"), cleanAgentAnswer(res.result));
    return 0;
  }

  // 2. Independent verification: qa-sentinel runs the checks itself.
  log.step(`verifying ${changes.length} changed file(s) independently`);
  const verification = await verifyChanges({ cwd, c, changes, runDir: run.dir, env: testEnv(c) });
  const discrepancies = findDiscrepancies(cwd, startSha, changes);
  manifest.verification = { status: verification.status };
  log[verification.status === "VERIFIED" ? "ok" : "warn"](
    `verification: ${verification.status} – ${verification.checks.map((x) => `${x.name} ${x.status}`).join(", ")}`,
  );

  const description = mrDescription({
    service: service.name,
    sha: cs.head,
    version: VERSION,
    requirements: req,
    verification,
    findings,
    discrepancies,
    agentSummary: cleanAgentAnswer(res.result),
    usage,
    runId: run.id,
  });
  fs.writeFileSync(path.join(run.dir, "summary.md"), description);
  fs.writeFileSync(path.join(cwd, "qa-sentinel-summary.md"), description);

  // 3. Commit exactly the validated paths (deletions and renames included).
  const paths = [...new Set(changes.flatMap((x) => (x.from && x.status === "R" ? [x.path, x.from] : [x.path])))];
  git(cwd, ["add", "-A", "--", ...paths]);
  git(cwd, [
    "commit",
    "-q",
    "-m",
    `test(${service.name}): QA agent updates for ${sha8}\n\nGenerated by qa-sentinel ${VERSION} from ${service.name}@${cs.head}.\nVerification: ${verification.status}. Run: ${run.id}`,
  ]);
  log.ok(`committed ${paths.length} file(s) on ${branch}`);
  manifest.outcome = `committed-${verification.status.toLowerCase()}`;

  if (o.push) {
    // Push with a one-off URL so the token never sits in .git/config where an agent could read it.
    const projectPath = c.ci.testRepoProject && !/^\d+$/.test(c.ci.testRepoProject) ? c.ci.testRepoProject : process.env.CI_PROJECT_PATH;
    const url = pushUrl(c.ci.gitlabUrl, projectPath);
    // The branch is owned by qa-sentinel and named after the source SHA, so a rerun may overwrite it.
    git(cwd, ["push", "--force", url ?? "origin", `HEAD:refs/heads/${branch}`]);
    const project = c.ci.testRepoProject ?? process.env.CI_PROJECT_ID;
    if (!ctx || !project) {
      log.warn("pushed; set QA_SENTINEL_GITLAB_TOKEN and ci.testRepoProject to open the MR automatically");
    } else {
      const verified = verification.status === "VERIFIED";
      const mr = await createOrUpdateMergeRequest(ctx, project, {
        source: branch,
        target: c.ci.targetBranch,
        title: `${verified ? "" : "Draft: "}QA agent: tests for ${service.name}@${sha8}${verified ? "" : ` (${verification.status})`}`,
        description,
        labels: ["qa-agent", `service::${service.name}`, `qa-sentinel::${verification.status.toLowerCase()}`, ...(discrepancies.length ? ["qa-sentinel::discrepancy"] : [])],
      });
      log.ok(`merge request ${mr.action}: ${mr.web_url}`);
    }
  } else {
    log.info(`Review locally, then push ${branch} and open a merge request (or rerun with --push).`);
  }
  manifest.finishedAt = new Date().toISOString();
  writeManifest(run, manifest);
  return verification.status === "VERIFIED" ? 0 : 1;
}
