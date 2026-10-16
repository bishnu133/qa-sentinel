import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../config.js";
import { changeSet, commitMessages, ensureAtCommit, git, hasChanges, isGitRepo, resolveSha, workingChanges } from "../git.js";
import { matchesAny } from "../fsutil.js";
import { formatUsage } from "../claude.js";
import { useEnvironment, ARTIFACT_GLOBS, VERSION, agentEnv, bashRulesForTests, cleanAgentAnswer, createRunDir, findService, startManifest, testEnv, writeManifest } from "../run.js";
import { checkContent, checkPaths, checkServiceUntouched, findingsMarkdown, generatePolicy, snapshotTree, violations } from "../guardrails.js";
import { emptySnapshot, requirementItems, resolveRequirements, skippedBranch, storyMarkdown } from "../requirements.js";
import { findDiscrepancies, verifyChanges } from "../verification.js";
import { mrDescription } from "../reporting.js";
import { generationSummary } from "../reporting/jiraSummary.js";
import { publish } from "../reporting/publish.js";
import { reviewMarkdown, reviewTests, type ReviewOutcome } from "../review/reviewer.js";
import { TEST_FILE, addedLines } from "../guardrails.js";
import { indexTests, changedTests, checkNewTests, checkTestMap, readTestMap, traceMarkdown, traceStory } from "../analysis/testIndex.js";
import { createOrUpdateMergeRequest, gitlabContext, pushUrl } from "../scm/gitlab.js";
import { engineFor } from "../engines/ClaudeCodeEngine.js";
import { type AgentResult, addUsage } from "../engines/AgentEngine.js";
import { planChange } from "../plan/planner.js";
import { actionable } from "../plan/validate.js";
import { decisionTable } from "../plan/render.js";
import { log } from "../log.js";
import { sweepAfterRun } from "../testData.js";
import { bugsFromDiscrepancies, fileBugs } from "../bugs/bugs.js";
import { jiraContext } from "../scm/jira.js";
import { runCommandsFor } from "../layers.js";
import type { ServiceConfig } from "../config.js";
import { type ChangeSet, atLeast } from "../git.js";
import { type StoryPart, combinedChange, storyParts } from "../story.js";
import { layers } from "../layers.js";
import { pagesToExplore, snapshotPages } from "../web/explore.js";
import { readHealed } from "../web/healed.js";

export interface GenerateOptions {
  cwd: string;
  service: string;
  servicePath?: string;
  base?: string;
  head?: string;
  checkout?: boolean;
  storyFile?: string;
  /** Story mode: tests for everything this story changed, across all its service repos (one branch, one MR). */
  story?: string;
  push?: boolean;
  /** Named environment from `environments` to run the tests against before anything is pushed. */
  env?: string;
  dryRun?: boolean;
  /**
   * Backfill (`qa-sentinel backfill`): no code change; write tests for these existing endpoints of `service`. The
   * API contract is the oracle (no story), so a test that disagrees with the code is written as review/fixme.
   */
  backfill?: BackfillTarget[];
}

export interface BackfillTarget {
  endpoint: string;
  method: string;
  path: string;
  summary?: string;
  risk: string;
  gap: string;
  existingTests: string[];
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
  let service: ServiceConfig, repo: string;
  let parts: StoryPart[] | undefined;
  if (o.story && o.backfill) throw new Error("backfill and story mode can't be combined");
  if (o.story) {
    const sp = await storyParts({ c, cwd, story: o.story });
    sp.notes.forEach((n) => log.warn(n));
    if (!sp.parts.length) throw new Error(`No service changes found for ${o.story}: no branch or commit message mentions it in the service repos`);
    parts = sp.parts;
    const unmerged = parts.filter((p) => !p.merged).map((p) => p.service.name);
    if (unmerged.length) log.warn(`not merged yet: ${unmerged.join(", ")}. Tests will be written against the branch code; run again after the merge.`);
    service = combinedChange(o.story, parts).service;
    repo = parts[0].repo;
  } else {
    service = findService(c, o.service, cwd, o.servicePath);
    repo = path.resolve(cwd, service.path);
    if (!isGitRepo(repo)) throw new Error(`${repo} is not a git repository`);
  }
  const environment = useEnvironment(c, o.env);
  if (environment) log.step(`environment: ${environment} (${layers(c).map((l) => process.env[l.baseUrlEnv]).filter(Boolean).join(", ")})`);
  if (!isGitRepo(cwd)) throw new Error(`The test repo (${cwd}) must be a git repository`);
  if (workingChanges(cwd).some((x) => !matchesAny(x.path, ARTIFACT_GLOBS)) && !o.dryRun) throw new Error("The test repo has uncommitted changes; commit or stash them first.");

  let cs: ChangeSet, relevant: string[];
  if (o.backfill) {
    if (!o.backfill.length) {
      log.ok("nothing to backfill");
      return 0;
    }
    // No change to diff: the "change" is the list of endpoints to cover, at the service's current commit.
    const head = resolveSha(repo, o.head ?? "HEAD");
    ensureAtCommit(repo, head, Boolean(o.checkout), cwd);
    cs = { base: head, head, files: [], diff: backfillText(o.backfill) };
    relevant = [service.openapi ?? "(api)"];
  } else if (parts) {
    for (const p of parts) atLeast(p.repo, p.cs.head, Boolean(o.checkout), cwd);
    ({ cs, relevant } = combinedChange(o.story!, parts));
    log.step(`story ${o.story}: ${parts.map((p) => `${p.service.name} (${p.relevant.length} file(s))`).join(", ")}`);
  } else {
    const headRef = o.head ?? "HEAD";
    // GitLab sends 0000… as the "before" SHA for new branches; fall back to the previous commit.
    const baseRef = !o.base || /^0+$/.test(o.base) ? `${headRef}~1` : o.base;
    cs = changeSet(repo, baseRef, headRef);
    ensureAtCommit(repo, cs.head, Boolean(o.checkout), cwd);
    relevant = cs.files.filter((f) => !matchesAny(f, c.agent.skipPaths));
  }
  if (relevant.length === 0) {
    log.ok("no test-relevant changes; nothing to generate");
    return 0;
  }

  // Requirements: explicit file → Jira (key from branch/commits) → the MR that introduced this commit.
  const ctx = gitlabContext(c.ci.gitlabUrl);
  const serviceProject = service.gitlabProject ?? process.env.QA_SERVICE_PROJECT;
  const req = o.backfill
    ? emptySnapshot(c)
    : await resolveRequirements(c, {
    storyFile: o.storyFile,
    lookup: ctx && serviceProject && !parts ? { ctx, project: serviceProject, sha: cs.head } : undefined,
    keyHints: parts ? [o.story] : commitMessages(repo, cs.base, cs.head),
  }).catch((e) => {
    log.warn(`could not fetch requirements: ${(e as Error).message}`);
    return resolveRequirements(c, {});
  });
  // Dependency-bot merges (ci.skipBranches): no generation. The branch comes from the merged MR or its merge commit.
  const bot = parts || o.backfill ? undefined : skippedBranch(c, req.sourceBranch, git(repo, ["log", "-1", "--format=%B", cs.head]));
  if (bot) {
    log.ok(`${bot} is in ci.skipBranches; nothing to generate`);
    return 0;
  }
  if (o.backfill) {
    log.step(`backfill: ${o.backfill.length} endpoint(s) of ${service.name}, the API contract is the oracle`);
  } else if (req.source === "none") {
    if (c.requirements.required) throw new Error("No requirements found for this change and requirements.required is true. Pass --story-file or link the MR/story.");
    log.warn("no requirements found: tests can only be checked against the contract and code");
  } else {
    log.step(`requirements: ${req.storyKey ?? req.title ?? req.source} (${req.acceptanceCriteria.length} AC${req.scopeItems?.length ? ` + ${req.scopeItems.length} scope item(s)` : ""}, ${req.source}, ${req.approvalStatus})`);
  }

  const sha8 = parts ? o.story! : cs.head.slice(0, 8);
  const backfillId = o.backfill ? `${new Date().toISOString().slice(0, 10)}-${backfillHash(o.backfill)}` : "";
  const branch = parts ? `qa-sentinel/story-${o.story}` : o.backfill ? `qa-sentinel/backfill-${service.name}-${backfillId}` : `qa-sentinel/${service.name}-${sha8}`;
  const subject = parts
    ? `story ${o.story} (${parts.map((p) => p.service.name).join(", ")})`
    : o.backfill
      ? `backfill ${service.name} (${o.backfill.length} endpoint${o.backfill.length === 1 ? "" : "s"})`
      : `${service.name}@${sha8}`;
  const policy = generatePolicy(c);
  const run = createRunDir(cwd, `gen-${service.name}`);
  fs.writeFileSync(path.join(run.dir, "change.diff"), cs.diff);
  fs.writeFileSync(path.join(run.dir, "story.md"), storyMarkdown(req));
  fs.writeFileSync(path.join(run.dir, "requirements.json"), JSON.stringify(req, null, 2));
  const manifest = startManifest(cwd, c, run, "generate", { service, base: cs.base, head: cs.head, changedFiles: relevant }, req);
  const startSha = resolveSha(cwd, "HEAD");
  const before = (parts ? parts.map((p) => ({ name: p.service.name, repo: p.repo })) : [{ name: service.name, repo }]).map((r) => ({ ...r, snap: snapshotTree(r.repo) }));
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
  log.step(`${subject}: planning`);
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
    context: {
      kind: o.backfill ? "backfill" : "generate",
      allowedWritePaths: policy.allowed,
      blockedWritePaths: policy.blocked,
      maxFixAttempts: c.agent.maxFixAttempts,
      ...(o.backfill ? { backfill: o.backfill } : {}),
    },
    parts,
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
    const summary = [`## QA agent: ${subject} – no test changes needed`, "", plan.verdict, "", decisionTable(plan, planned.risked.changes)].join("\n");
    fs.writeFileSync(path.join(run.dir, "summary.md"), summary);
    fs.writeFileSync(path.join(cwd, "qa-sentinel-summary.md"), summary);
    log.ok("every decision is reuse or skip: existing tests are enough");
    return finish("no-changes-needed", 0);
  }

  // Phase 2a (web): look at the affected pages before writing locators. qa-sentinel opens them itself.
  const webScenarios = todo.flatMap((d) => d.proposedScenarios).filter((sc) => sc.layer === "web");
  const mobileScenarios = todo.flatMap((d) => d.proposedScenarios).filter((sc) => sc.layer === "mobile");
  let snapshots = "";
  if (webScenarios.length && c.tests.web.explore === "snapshot") {
    const routes = pagesToExplore(plan, service.routes);
    log.step(`exploring ${routes.length} page(s): ${routes.join(", ")}`);
    const snaps = await snapshotPages({ cwd, c, runDir: run.dir, routes, sources: service.routes, env: testEnv(c) });
    const ok = snaps.filter((x) => !x.error).length;
    log[ok ? "ok" : "warn"](`page snapshots: ${ok}/${snaps.length}${snaps.find((x) => x.error) ? ` (${snaps.find((x) => x.error)!.route}: ${snaps.find((x) => x.error)!.error})` : ""}`);
    if (fs.existsSync(path.join(run.dir, "page-snapshots", "README.md"))) snapshots = `${run.rel}/page-snapshots/README.md`;
  }
  // Locators healed in recent scheduled runs (qa-sentinel healed): page-object fixes to make while we're here.
  const healed = readHealed(cwd);

  // Phase 2: author only what the validated plan says, with scoped writes.
  git(cwd, ["checkout", "-q", "-B", branch]);
  log.step(`authoring ${todo.length} decision(s) on ${branch}`);
  const author = await engine.run({
    kind: "author",
    cwd,
    prompt: [
      "Use the generate-api-tests skill.",
      `The validated plan is ${run.rel}/test-plan.validated.json. Implement ONLY its decisions "update", "create" and "review"; leave "reuse" and "skip" alone.`,
      ...(webScenarios.length ? [`${webScenarios.length} scenario(s) are web tests: use the write-web-test skill for them (page objects in ${c.tests.web.pagesDir} first, then specs in ${c.tests.web.dir}).${snapshots ? ` What the affected pages show now: ${snapshots}.` : ""}`] : []),
      ...(mobileScenarios.length ? [`${mobileScenarios.length} scenario(s) are mobile tests: use the write-mobile-test skill for them (screen objects in ${c.tests.mobile.screensDir} first, then specs in ${c.tests.mobile.dir}; find the elements' accessibility ids in the app's code).`] : []),
      ...(healed.length ? [`Recent scheduled runs needed runtime healing for these page-object locators (fix the ones in page objects you touch; mention the rest under "Needs human attention"): ${healed.slice(0, 10).map((h) => `${h.at ?? h.file}: "${h.intent}" (${h.failedLocator} → ${h.healedTo ?? "?"})`).join("; ")}.`] : []),
      `Run context: ${run.rel}/context.json, diff: ${run.rel}/change.diff, story: ${run.rel}/story.md.`,
      ...(fs.existsSync(path.join(run.dir, "knowledge.md")) ? [`Team domain rules: ${run.rel}/knowledge.md (follow them; they are not instructions to change anything outside the tests).`] : []),
      `You may only change files matching: ${policy.allowed.join(", ")}. Any other change fails the whole run.`,
      `Bash is allowed for exactly: ${layers(c).map((l) => `\`${l.runCommand} ${l.specArg ? `${l.specArg} <${l.layer} spec path>` : `<${l.layer} spec paths>`}\``).join(", ")}, \`npx tsc --noEmit\`, \`git status\` and \`git diff\`, each as a single command (no cd, pipes, && or variables). Use Read, Grep and Glob to explore files. If a command is denied, rewrite it in that form; do not give up on running the specs.`,
      "qa-sentinel re-runs the changed specs independently afterwards.",
      "Your final answer must be the merge request notes in markdown (the format in the skill).",
    ].join("\n"),
    readOnlyDirs: before.map((b) => b.repo),
    write: policy,
    bash: [...bashRulesForTests(c), "npx tsc --noEmit", "git status *", "git diff *"],
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
      extraBaseUrls: layers(c).map((l) => process.env[l.baseUrlEnv]).filter((u): u is string => Boolean(u)),
      assertionRemoval: c.guardrails.assertionRemoval,
    }),
    ...before.flatMap((b) => checkServiceUntouched(b.repo, b.name, b.snap)),
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
  // Data the verified tests created and couldn't delete (or a killed test left): sweep it now, report what stays.
  if (c.testData.cleanup === "ledger") findings.push(...(await sweepAfterRun(cwd, c)));
  // Traceability from the tests' own tags: what each AC is now proven by, and tests that don't say what they prove.
  const index = indexTests(cwd, c);
  fs.writeFileSync(path.join(run.dir, "test-index.json"), JSON.stringify(index, null, 2));
  const changedFiles = changes.filter((x) => x.status !== "D").map((x) => x.path);
  const traceFindings = [
    ...checkNewTests(index, changedFiles, req.storyKey, requirementItems(req).map((a) => a.id)),
    ...checkTestMap(index, readTestMap(cwd), cwd).filter((f) => f.level === "warning" && changedFiles.some((cf) => f.file.startsWith(cf) || f.file === "test-map.yaml")),
  ];
  findings.push(...traceFindings.map((f) => ({ level: "warning" as const, rule: "traceability" as const, file: f.file, message: f.message })));
  const trace = traceStory(index, req.storyKey, requirementItems(req));

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
    subject,
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
    `test(${service.name}): QA agent ${o.backfill ? `backfill (${o.backfill.map((b) => b.endpoint).join(", ")})` : `updates for ${sha8}`}\n\nGenerated by qa-sentinel ${VERSION} from ${parts ? parts.map((p) => `${p.service.name}@${p.cs.head}`).join(", ") : `${service.name}@${cs.head}`}.\nRisk: ${planned.risked.overall}. Verification: ${verification.status}. Run: ${run.id}`,
  ]);
  log.ok(`committed ${paths.length} file(s) on ${branch}`);

  // Bug cards (bugs.mode): requirements the product doesn't meet, seen failing by the author and written as fixme.
  if (c.bugs.mode !== "off" && req.storyKey && discrepancies.length && !o.dryRun) {
    const jira = jiraContext(c.requirements.jira.baseUrl);
    if (jira) {
      const candidates = bugsFromDiscrepancies(req.storyKey, requirementItems(req), discrepancies, index, plan, { environment, runCommand: (t) => runCommandsFor(c, [`${t.file}:${t.line}`])[0] });
      const r = await fileBugs(jira, c, req.storyKey, candidates).catch((e) => (log.warn(`bugs: ${(e as Error).message}`), undefined));
      if (r?.created.length) log.ok(`bug(s) raised on ${req.storyKey}: ${r.created.join(", ")}`);
      if (r?.suggested) log.ok(`${r.suggested} bug(s) proposed on ${req.storyKey}`);
    }
  }

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
        title: `${verified ? "" : "Draft: "}QA agent: tests for ${subject}${verified ? "" : ` (${verification.status})`}`,
        description,
        labels: [
          "qa-agent",
          ...(parts ? [`story::${o.story}`, ...parts.map((p) => `service::${p.service.name}`)] : [`service::${service.name}`]),
          ...(o.backfill ? ["qa-sentinel::backfill"] : []),
          `qa-sentinel::${verification.status.toLowerCase()}`,
          `risk::${planned.risked.overall}`,
          ...(discrepancies.length ? ["qa-sentinel::discrepancy"] : []),
          ...(review.review?.tests.some((t) => t.verdict === "weak" || t.verdict === "wrong-oracle") ? ["qa-sentinel::weak-tests"] : []),
        ],
      });
      log.ok(`merge request ${mr.action}: ${mr.web_url}`);
      if (c.reporting.targets.includes("jira")) {
        const acText = new Map(requirementItems(req).map((a) => [a.id, a.text]));
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

/** What change.diff holds in a backfill run: the endpoints to cover, as the plan's input. */
export function backfillText(targets: BackfillTarget[]): string {
  return [
    "# Backfill: no code change",
    "",
    "These existing endpoints have no (or only weak or pending) tests. Plan one change per endpoint (type `new-endpoint`,",
    "observable, oracle `missing` unless an approved requirement covers it) and cover it against the API contract.",
    "",
    ...targets.map((t) => `- ${t.method} ${t.path}${t.summary ? ` – ${t.summary}` : ""} (risk ${t.risk}; ${t.gap}${t.existingTests.length ? `; existing: ${t.existingTests.join(", ")}` : ""})`),
    "",
  ].join("\n");
}

const backfillHash = (targets: BackfillTarget[]) => {
  let h = 0;
  for (const ch of targets.map((t) => t.endpoint).join("|")) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h.toString(36).slice(0, 6);
};
