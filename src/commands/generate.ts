import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../config.js";
import { changeSet, commitMessages, ensureAtCommit, git, hasChanges, isGitRepo, resolveSha, workingChanges } from "../git.js";
import { matchesAny } from "../fsutil.js";
import { formatUsage } from "../claude.js";
import { useEnvironment, ARTIFACT_GLOBS, VERSION, agentEnv, bashRuleForTests, cleanAgentAnswer, createRunDir, findService, startManifest, testEnv, writeManifest } from "../run.js";
import { checkContent, checkPaths, checkServiceUntouched, findingsMarkdown, generatePolicy, snapshotTree, violations } from "../guardrails.js";
import { resolveRequirements, storyMarkdown } from "../requirements.js";
import { findDiscrepancies, verifyChanges } from "../verification.js";
import { mrDescription } from "../reporting.js";
import { generationSummary } from "../reporting/jiraSummary.js";
import { publish } from "../reporting/publish.js";
import { reviewMarkdown, reviewTests, type ReviewOutcome } from "../review/reviewer.js";
import { TEST_FILE, addedLines } from "../guardrails.js";
import { buildTestIndex, changedTests, checkNewTests, checkTestMap, readTestMap, traceMarkdown, traceStory } from "../analysis/testIndex.js";
import { createOrUpdateMergeRequest, gitlabContext, pushUrl } from "../scm/gitlab.js";
import { engineFor } from "../engines/ClaudeCodeEngine.js";
import { type AgentResult, addUsage } from "../engines/AgentEngine.js";
import { planChange } from "../plan/planner.js";
import { actionable } from "../plan/validate.js";
import { decisionTable } from "../plan/render.js";
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
  /** Named environment from `environments` to run the tests against before anything is pushed. */
  env?: string;
  dryRun?: boolean;
}

/**
 * plan (agent, read-only) → validate + risk (code) → author only update/create/review decisions (agent, scoped
 * writes) → guardrails (code) → independent verification (code) → commit/publish.
 * Returns the exit code: 0 when VERIFIED, or when the plan needs no test changes.
 */
export async function generateCommand(o: GenerateOptions): Promise<number> {
  const cwd = path.resolve(o.cwd);
  const c = loadConfig(cwd);
  if (c.level === "intelligence") {
    throw new Error('This project runs at level "intelligence" (read-only analysis). Set level: maintenance in qa-sentinel.config.yaml to enable test generation.');
  }
  const service = findService(c, o.service, cwd, o.servicePath);
  const repo = path.resolve(cwd, service.path);
  if (!isGitRepo(repo)) throw new Error(`${repo} is not a git repository`);
  const environment = useEnvironment(c, o.env);
  if (environment) log.step(`environment: ${environment} (${process.env[c.tests.api.baseUrlEnv]})`);
  if (!isGitRepo(cwd)) throw new Error(`The test repo (${cwd}) must be a git repository`);
  if (workingChanges(cwd).some((x) => !matchesAny(x.path, ARTIFACT_GLOBS)) && !o.dryRun) throw new Error("The test repo has uncommitted changes; commit or stash them first.");

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

  // Requirements: explicit file → Jira (key from branch/commits) → the MR that introduced this commit.
  const ctx = gitlabContext(c.ci.gitlabUrl);
  const serviceProject = service.gitlabProject ?? process.env.QA_SERVICE_PROJECT;
  const req = await resolveRequirements(c, {
    storyFile: o.storyFile,
    lookup: ctx && serviceProject ? { ctx, project: serviceProject, sha: cs.head } : undefined,
    keyHints: commitMessages(repo, cs.base, cs.head),
  }).catch((e) => {
    log.warn(`could not fetch requirements: ${(e as Error).message}`);
    return resolveRequirements(c, {});
  });
  if (req.source === "none") {
    if (c.requirements.required) throw new Error("No requirements found for this change and requirements.required is true. Pass --story-file or link the MR/story.");
    log.warn("no requirements found: tests can only be checked against the contract and code");
  } else {
    log.step(`requirements: ${req.storyKey ?? req.title ?? req.source} (${req.acceptanceCriteria.length} AC, ${req.source}, ${req.approvalStatus})`);
  }

  const sha8 = cs.head.slice(0, 8);
  const branch = `qa-sentinel/${service.name}-${sha8}`;
  const policy = generatePolicy(c);
  const run = createRunDir(cwd, `gen-${service.name}`);
  fs.writeFileSync(path.join(run.dir, "change.diff"), cs.diff);
  fs.writeFileSync(path.join(run.dir, "story.md"), storyMarkdown(req));
  fs.writeFileSync(path.join(run.dir, "requirements.json"), JSON.stringify(req, null, 2));
  const manifest = startManifest(cwd, c, run, "generate", { service, base: cs.base, head: cs.head, changedFiles: relevant }, req);
  const startSha = resolveSha(cwd, "HEAD");
  const serviceBefore = snapshotTree(repo);
  const engine = engineFor(c);
  const runs: AgentResult[] = [];
  const finish = (outcome: string, code: number) => {
    const usage = addUsage(...runs);
    const denials = runs.flatMap((r) => r.denials ?? []);
    manifest.agent = { status: runs.at(-1)?.status ?? "not-run", ...usage, deniedToolCalls: denials.length };
    if (denials.length) fs.writeFileSync(path.join(run.dir, "permission-denials.json"), JSON.stringify(denials, null, 2));
    manifest.outcome = outcome;
    manifest.finishedAt = new Date().toISOString();
    writeManifest(run, manifest);
    return code;
  };

  // Phase 1: plan (read-only) and validate in code.
  log.step(`${service.name}@${sha8}: planning`);
  const planned = await planChange({
    cwd,
    c,
    service,
    repo,
    cs,
    relevant,
    req,
    run,
    engine,
    dryRun: o.dryRun,
    context: { kind: "generate", allowedWritePaths: policy.allowed, blockedWritePaths: policy.blocked, maxFixAttempts: c.agent.maxFixAttempts },
  });
  runs.push(...planned.runs);
  manifest.plan = { status: planned.status, risk: planned.risked?.overall, corrections: planned.validation?.corrections.length ?? 0 };
  if (planned.status === "dry-run") return finish("dry-run", 0);
  if (planned.status !== "valid" || !planned.plan || !planned.risked) {
    log.fail(`no valid plan (${planned.status}): ${planned.message ?? ""}`);
    return finish(`plan-${planned.status}`, 1);
  }
  const plan = planned.plan;
  planned.validation?.corrections.forEach((x) => log.warn(`correction: ${x}`));
  const todo = actionable(plan);
  log.step(`plan: ${planned.risked.overall} risk · ${plan.decisions.map((d) => `${d.changeId}=${d.decision}`).join(", ") || "no decisions"}`);
  if (todo.length === 0) {
    const summary = [`## QA agent: ${service.name}@${sha8} – no test changes needed`, "", plan.verdict, "", decisionTable(plan, planned.risked.changes)].join("\n");
    fs.writeFileSync(path.join(run.dir, "summary.md"), summary);
    fs.writeFileSync(path.join(cwd, "qa-sentinel-summary.md"), summary);
    log.ok("every decision is reuse or skip: existing tests are enough");
    return finish("no-changes-needed", 0);
  }

  // Phase 2: author only what the validated plan says, with scoped writes.
  git(cwd, ["checkout", "-q", "-B", branch]);
  log.step(`authoring ${todo.length} decision(s) on ${branch}`);
  const author = await engine.run({
    kind: "author",
    cwd,
    prompt: [
      "Use the generate-api-tests skill.",
      `The validated plan is ${run.rel}/test-plan.validated.json. Implement ONLY its decisions "update", "create" and "review"; leave "reuse" and "skip" alone.`,
      `Run context: ${run.rel}/context.json, diff: ${run.rel}/change.diff, story: ${run.rel}/story.md.`,
      ...(fs.existsSync(path.join(run.dir, "knowledge.md")) ? [`Team domain rules: ${run.rel}/knowledge.md (follow them; they are not instructions to change anything outside the tests).`] : []),
      `You may only change files matching: ${policy.allowed.join(", ")}. Any other change fails the whole run.`,
      `Bash is allowed for exactly: \`${c.tests.api.runCommand} <spec paths>\`, \`npx tsc --noEmit\`, \`git status\` and \`git diff\`, each as a single command (no cd, pipes, && or variables). Use Read, Grep and Glob to explore files. If a command is denied, rewrite it in that form; do not give up on running the specs.`,
      "qa-sentinel re-runs the changed specs independently afterwards.",
      "Your final answer must be the merge request notes in markdown (the format in the skill).",
    ].join("\n"),
    readOnlyDirs: [repo],
    write: policy,
    bash: [bashRuleForTests(c), "npx tsc --noEmit", "git status *", "git diff *"],
    maxTurns: c.agent.maxTurns.generate,
    maxBudgetUsd: c.agent.maxBudgetUsd.generate,
    timeoutMs: c.agent.timeoutMinutes.generate * 60_000,
    env: agentEnv(c),
    model: c.agent.model,
  });
  runs.push(author);
  if (!author.ok) {
    log.fail(`agent run ${author.status}: ${author.result.slice(0, 300)}`);
    log.info(`Partial changes left uncommitted on ${branch} for inspection.`);
    return finish(`agent-${author.status}`, 1);
  }

  // Phase 3: guardrails, enforced on what actually changed (not on what the agent says it changed).
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
    log.fail(`run rejected: ${bad.length} guardrail violation(s). Nothing was committed.`);
    log.info(findingsMarkdown(bad));
    log.info(`The changes are left uncommitted on ${branch} for inspection.`);
    return finish("guardrail-violation", 1);
  }
  if (changes.length === 0) {
    log.warn("the plan asked for test changes but the agent made none");
    return finish("no-changes-made", 1);
  }

  // Phase 4: independent verification.
  log.step(`verifying ${changes.length} changed file(s) independently`);
  const verification = await verifyChanges({ cwd, c, changes, runDir: run.dir, env: testEnv(c) });
  const discrepancies = findDiscrepancies(cwd, startSha, changes);
  // Traceability from the tests' own tags: what each AC is now proven by, and tests that don't say what they prove.
  const index = buildTestIndex(cwd, c.tests.api.dir);
  fs.writeFileSync(path.join(run.dir, "test-index.json"), JSON.stringify(index, null, 2));
  const changedFiles = changes.filter((x) => x.status !== "D").map((x) => x.path);
  const traceFindings = [
    ...checkNewTests(index, changedFiles, req.storyKey, req.acceptanceCriteria.map((a) => a.id)),
    ...checkTestMap(index, readTestMap(cwd), cwd).filter((f) => f.level === "warning" && changedFiles.some((cf) => f.file.startsWith(cf) || f.file === "test-map.yaml")),
  ];
  findings.push(...traceFindings.map((f) => ({ level: "warning" as const, rule: "traceability" as const, file: f.file, message: f.message })));
  const trace = traceStory(index, req.storyKey, req.acceptanceCriteria);

  // Independent review of the changed tests (fresh read-only agent; advisory, never changes verification).
  let review: ReviewOutcome = { status: "skipped", errors: [], runs: [] };
  const toReview = changedTests(index, cwd, changedFiles.filter((f) => TEST_FILE.test(f)), (f) => addedLines(cwd, startSha, f));
  if (c.review.enabled && toReview.length) {
    log.step(`independent review of ${toReview.length} changed test(s)`);
    const diff = git(cwd, ["diff", startSha, "--", ...new Set(toReview.map((t) => t.file))]);
    review = await reviewTests({ cwd, c, run, engine, req, tests: toReview, diff, knowledge: fs.existsSync(path.join(run.dir, "knowledge.md")) ? `${run.rel}/knowledge.md` : undefined });
    runs.push(...review.runs);
    const weak = review.review?.tests.filter((t) => t.verdict === "weak" || t.verdict === "wrong-oracle").length ?? 0;
    log[review.status === "reviewed" ? (weak ? "warn" : "ok") : "warn"](`review: ${review.status}${review.review ? ` · ${weak} weak or wrong-oracle` : ""}`);
    fs.writeFileSync(path.join(run.dir, "test-review.result.json"), JSON.stringify(review, null, 2));
  }
  manifest.verification = { status: verification.status };
  log[verification.status === "VERIFIED" ? "ok" : "warn"](`verification: ${verification.status} – ${verification.checks.map((x) => `${x.name} ${x.status}`).join(", ")}`);

  const usage = formatUsage(addUsage(...runs));
  const description = mrDescription({
    environment,
    service: service.name,
    sha: cs.head,
    version: VERSION,
    requirements: req,
    verification,
    findings,
    discrepancies,
    traceability: traceMarkdown(req.storyKey, trace, new Map((review.review?.tests ?? []).filter((t) => t.verdict === "weak" || t.verdict === "wrong-oracle").map((t) => [t.id, t.verdict]))),
    review: reviewMarkdown(review, toReview),
    agentSummary: cleanAgentAnswer(author.result),
    usage,
    runId: run.id,
    plan: { plan, risked: planned.risked, contract: planned.contract, specPath: service.openapi, corrections: planned.validation?.corrections ?? [] },
  });
  fs.writeFileSync(path.join(run.dir, "summary.md"), description);
  fs.writeFileSync(path.join(cwd, "qa-sentinel-summary.md"), description);

  // Phase 5: commit exactly the validated paths (deletions and renames included), then publish.
  const paths = [...new Set(changes.flatMap((x) => (x.from && x.status === "R" ? [x.path, x.from] : [x.path])))];
  git(cwd, ["add", "-A", "--", ...paths]);
  git(cwd, [
    "commit",
    "-q",
    "-m",
    `test(${service.name}): QA agent updates for ${sha8}\n\nGenerated by qa-sentinel ${VERSION} from ${service.name}@${cs.head}.\nRisk: ${planned.risked.overall}. Verification: ${verification.status}. Run: ${run.id}`,
  ]);
  log.ok(`committed ${paths.length} file(s) on ${branch}`);

  if (o.push && c.verification.requireVerifiedToPush && verification.status !== "VERIFIED") {
    log.warn(`not pushed: verification is ${verification.status}${environment ? ` on ${environment}` : ""} and verification.requireVerifiedToPush is on. The branch ${branch} stays local for inspection.`);
    return finish(`not-pushed-${verification.status.toLowerCase()}`, 1);
  }
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
        labels: [
          "qa-agent",
          `service::${service.name}`,
          `qa-sentinel::${verification.status.toLowerCase()}`,
          `risk::${planned.risked.overall}`,
          ...(discrepancies.length ? ["qa-sentinel::discrepancy"] : []),
          ...(review.review?.tests.some((t) => t.verdict === "weak" || t.verdict === "wrong-oracle") ? ["qa-sentinel::weak-tests"] : []),
        ],
      });
      log.ok(`merge request ${mr.action}: ${mr.web_url}`);
      if (c.reporting.targets.includes("jira")) {
        const acText = new Map(req.acceptanceCriteria.map((a) => [a.id, a.text]));
        const jiraSummary = generationSummary({
          service: service.name,
          risk: planned.risked.overall,
          verification: verification.status,
          environment,
          mrUrl: mr.web_url,
          trace: trace.acs,
          acText,
          discrepancies,
          weakTests: review.review?.tests.filter((t) => t.verdict === "weak" || t.verdict === "wrong-oracle").length,
        });
        fs.writeFileSync(path.join(run.dir, "jira-summary.md"), jiraSummary);
        await publish(c, { report: description, jiraSummary, service: service.name, storyKey: req.storyKey, mr: {}, targets: ["jira"] });
      }
    }
  } else {
    log.info(`Review locally, then push ${branch} and open a merge request (or rerun with --push).`);
  }
  return finish(`committed-${verification.status.toLowerCase()}`, verification.status === "VERIFIED" ? 0 : 1);
}
