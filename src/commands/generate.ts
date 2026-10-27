import fs from "node:fs";
import path from "node:path";
import { jiraMode, loadConfig } from "../config.js";
import { pendingWiki } from "../reporting/pending.js";
import { refreshStaleness } from "../reporting/statusComment.js";
import { changeSet, commitMessages, ensureAtCommit, git, hasChanges, isGitRepo, resolveSha, showFile, workingChanges } from "../git.js";
import { checkExpectationLock, expectedDirOf } from "../expected/lock.js";
import { acTrailer } from "../expected/commits.js";
import { type ExpectedFile, expectedPath, readExpected, renderExpected } from "../expected/format.js";
import { expectedCommitMessage, poQuestions, runSpecPass, specDenyRead } from "../expected/spec.js";
import { checkExpectedValues } from "../expected/assertions.js";
import { matchesAny } from "../fsutil.js";
import { formatUsage } from "../claude.js";
import { useEnvironment, commitDate, ARTIFACT_GLOBS, VERSION, agentEnv, bashRulesForTests, cleanAgentAnswer, createRunDir, findService, startManifest, testEnv, writeManifest } from "../run.js";
import { checkKnownDefectMarkers, checkContent, checkPaths, checkServiceUntouched, findingsMarkdown, generatePolicy, snapshotTree, violations } from "../guardrails.js";
import { isFeature, emptySnapshot, requirementItems, resolveRequirements, skippedBranch, storyMarkdown } from "../requirements.js";
import { findDiscrepancies, verifyChanges } from "../verification.js";
import { mrDescription } from "../reporting.js";
import { generationSummary } from "../reporting/jiraSummary.js";
import { notifyStory } from "../reporting/notify.js";
import { publish } from "../reporting/publish.js";
import { reviewMarkdown, reviewTests, type ReviewOutcome } from "../review/reviewer.js";
import { TEST_FILE, addedLines } from "../guardrails.js";
import { indexTests, changedTests, checkNewTests, checkTestMap, readTestMap, traceMarkdown, traceStory } from "../analysis/testIndex.js";
import { bundleBranch, deferInNewRun, deferSteps, type PublishStep, type RecordStep } from "../reporting/deferred.js";
import { createOrUpdateMergeRequest, gitlabContext, latestMrForBranch, pushUrl, upsertMarkedNote } from "../scm/gitlab.js";
import { engineFor } from "../engines/ClaudeCodeEngine.js";
import { ClaudeAccessError } from "../claude.js";
import { budgetedEngine, crossServiceJobKey, endStateOf, generateJobKey } from "../stories/jobs.js";
import { NO_STORY, SAFE_KEY, emptyRecord } from "../stories/record.js";
import { type JobHandle } from "../stories/jobs.js";
import { type RecordStore } from "../stories/record.js";
import { endJob, openStore, startJob } from "../stories/start.js";
import { acHash, parseExpected } from "../expected/format.js";
import { isReadyStatus, servicesFromComponents } from "../stories/resolve.js";
import { prepareStoryBranch, pushStoryBranch, remoteFor, storyBranchName, type PrepareResult } from "../generation/storyBranch.js";
import { storyBranchView, storyExpected, type StoryBranchView } from "../generation/storyView.js";
import { headsDigest, storyScope, type StoryScope } from "../generation/storyScope.js";
import { addedFiles, listOpenAgentMrs, writeOpenAgentMrs } from "../generation/openAgentMrs.js";
import { checkDuplicateFiles } from "../guardrails.js";
import type { ServicePart } from "../feature/manifest.js";
import { type AgentResult, addUsage } from "../engines/AgentEngine.js";
import { planChange } from "../plan/planner.js";
import { actionable, specDriftLabels } from "../plan/validate.js";
import { decisionTable } from "../plan/render.js";
import { log } from "../log.js";
import { sweepAfterRun } from "../testData.js";
import { readManualCards, writeCards } from "../manualTests.js";
import { applyDeploymentGate, deploymentStates, notDeployed } from "../deployment.js";
import { bugsFromDiscrepancies, fileBugs } from "../bugs/bugs.js";
import { jiraContext } from "../scm/jira.js";
import { runCommandsFor } from "../layers.js";
import type { Config, ServiceConfig } from "../config.js";
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
  /** Story mode: plan only these ACs (comma list from the CLI). An AC that is still waiting is refused unless `force`. */
  acs?: string[];
  /** The environment this run reads (CI, GitLab token, project ids). Default: the process environment. Tests pass their own. */
  processEnv?: NodeJS.ProcessEnv;
  /** Called once the job is claimed and AI work is about to start (not for a skipped, blocked or empty run): `stories --act` counts only these against its limit. */
  onStarted?: () => void;
  /** Run even if the same job (same story, ACs and commit) already finished, failed too often or looks to be running. Budgets still apply. */
  force?: boolean;
  /** Skip a job that already finished with the same inputs, also outside CI. */
  once?: boolean;
  push?: boolean;
  /** Named environment from `environments` to run the tests against before anything is pushed. */
  env?: string;
  dryRun?: boolean;
  /**
   * Backfill (`qa-sentinel backfill`): no code change; write tests for these existing endpoints of `service`. The
   * API contract is the oracle (no story), so a test that disagrees with the code is written as review/fixme.
   */
  backfill?: BackfillTarget[];
  /**
   * Do not push or open the merge request: leave the branch as `branch.bundle` and the rest in `publish.json` in the run
   * folder, for `qa-sentinel publish` (write tokens, no model key). Implies --push.
   */
  deferPublish?: boolean;
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
  if (o.deferPublish) o = { ...o, push: true };
  const ctl: JobControl = {};
  let code: number;
  try {
    code = await generateRun(o, ctl);
  } catch (e) {
    // Credentials missing or refused (stopped by something outside this story) don't count against the job; other errors do.
    if (ctl.handle && ctl.store) await endJob(ctl.store, ctl.handle, { state: e instanceof ClaudeAccessError ? "aborted" : "failed", outcome: ctl.outcome ?? "error", error: (e as Error).message, runId: ctl.runId });
    throw e;
  }
  if (ctl.handle && ctl.store) await endJob(ctl.store, ctl.handle, { state: endStateOf(code, ctl.outcome ?? ""), outcome: ctl.outcome ?? `exit ${code}`, runId: ctl.runId });
  return code;
}

/** What the wrapper needs to close the story record's job when the run ends. */
interface JobControl {
  store?: RecordStore;
  handle?: JobHandle;
  outcome?: string;
  runId?: string;
}

async function generateRun(o: GenerateOptions, ctl: JobControl): Promise<number> {
  const cwd = path.resolve(o.cwd);
  const c = loadConfig(cwd);
  const penv = o.processEnv ?? process.env;
  const gated = c.generation.scope === "story";
  if (c.level === "intelligence") {
    throw new Error('This project runs at level "intelligence" (read-only analysis). Set level: maintenance in qa-sentinel.config.yaml to enable test generation.');
  }
  let service: ServiceConfig, repo: string;
  let parts: StoryPart[] | undefined;
  /** The story's parts as the manifest found them (all services, merged or not). */
  let manifestParts: ServicePart[] = [];
  let storyRec: Awaited<ReturnType<RecordStore["load"]>>;
  if (o.story && o.backfill) throw new Error("backfill and story mode can't be combined");
  if (o.story && (!SAFE_KEY.test(o.story) || o.story.includes(".."))) throw new Error(`"${o.story}" is not a story key (letters, digits, - _ . only)`);
  if (o.acs?.length && !o.story) throw new Error("--acs needs --story: it names the ACs of one story");
  if (o.story) {
    const record = await openStore(cwd, c, penv, o.deferPublish).load(o.story).catch(() => undefined);
    storyRec = record;
    const sp = await storyParts({ c, cwd, story: o.story, gitlab: c.workspace.services.some((x) => x.gitlabProject) ? gitlabContext(c.ci.gitlabUrl, penv) : undefined, record });
    sp.notes.forEach((n) => log.warn(n));
    manifestParts = sp.manifest.parts.filter((p) => !p.dropped);
    const live = manifestParts;
    if (!sp.parts.length && live.length && live.every((p) => p.reverted)) {
      log.ok("nothing to generate: the story's changes were reverted on the main branch (tests come back when the work lands again)");
      return 0;
    }
    if (!sp.parts.length) throw new Error(`No service changes found for ${o.story}: no branch or commit message mentions it in the service repos`);
    parts = sp.parts;
    const unmerged = parts.filter((p) => !p.merged).map((p) => p.service.name);
    if (unmerged.length && c.generation.scope === "service") log.warn(`not merged yet: ${unmerged.join(", ")}. Tests will be written against the branch code; run again after the merge.`);
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
    for (const p of parts) if (p.merged || !gated) for (const h of p.heads) atLeast(p.repo, h, Boolean(o.checkout), cwd);
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
  const ctx = gitlabContext(c.ci.gitlabUrl, penv);
  const serviceProject = service.gitlabProject ?? penv.QA_SERVICE_PROJECT;
  const req = o.backfill
    ? emptySnapshot(c)
    : await resolveRequirements(c, {
    storyFile: o.storyFile,
    hasCode: true,
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
  // A hotfix branch: no generation here. The change reaches the target branch by cherry-pick, and tests are written once, there.
  // The service's branch is passed down by the trigger job (QA_SERVICE_BRANCH): this pipeline's own branch is the test repo's.
  const pipelineBranch = process.env.QA_SERVICE_BRANCH;
  if (!parts && !o.backfill && pipelineBranch && matchesAny(pipelineBranch, c.ci.hotfixBranches)) {
    log.ok(`${pipelineBranch} is a hotfix branch (ci.hotfixBranches): no test generation here; tests are written when the change reaches ${c.ci.targetBranch}`);
    return 0;
  }
  // Story scope: one test branch and merge request per story, built on after every merge. Which ACs are written now is decided here, from facts.
  const ownHead = cs.head;
  let storyKey: string | undefined = o.story?.toUpperCase();
  let triggerService: string | undefined;
  let scope: StoryScope | undefined;
  const genv = o.processEnv ? { ...process.env, ...o.processEnv } : undefined;
  const testProject = c.ci.testRepoProject ?? penv.CI_PROJECT_ID;
  if (!o.backfill && !parts && gated && req.storyKey && SAFE_KEY.test(req.storyKey) && isFeature(c, req)) {
    storyKey = req.storyKey.toUpperCase();
    triggerService = service.name;
  }
  if (storyKey && !o.backfill) {
    const key = storyKey;
    storyRec ??= await openStore(cwd, c, penv, o.deferPublish).load(key).catch(() => undefined);
    let sp: Awaited<ReturnType<typeof storyParts>> | undefined;
    if (triggerService) {
      try {
        sp = await storyParts({ c, cwd, story: key, gitlab: ctx, record: storyRec });
        sp.notes.forEach((n) => log.warn(n));
      } catch (e) {
        log.warn(`could not look for the story's other changes: ${(e as Error).message.split("\n")[0]}`);
      }
      manifestParts = (sp?.manifest.parts ?? []).filter((p) => !p.dropped);
      // The merge that started this run is merged by definition, even when nothing links it to the story but the commit message.
      if (!manifestParts.some((p) => p.service === triggerService && p.merged)) manifestParts.push({ service: triggerService, source: "git", sha: ownHead, merged: true, keys: [key] });
    }
    if (gated) {
      // The story's test branch as `stories` reads it: its expected file and records only count while its merge request is open.
      const view = await storyBranchView(cwd, c, key, { gitlab: ctx, project: testProject, env: genv });
      view.notes.forEach((n) => log.info(n));
      if (view.branchGone) log.warn(`merge request !${view.mr!.iid} is open, but its branch ${view.branch} is gone`);
      const expectedNow = storyExpected(cwd, c, key, view).file;
      // Records of what was written belong to a branch that no longer counts (closed or merged merge request, deleted branch): start from none.
      const recNow = storyRec && !view.live ? { ...storyRec, crossService: {}, singleService: {} } : storyRec;
      if (storyRec && !view.live && (Object.keys(storyRec.crossService).length || Object.keys(storyRec.singleService).length)) log.info(`${view.branch} is not live (${view.mr ? `its merge request !${view.mr.iid} is ${view.mr.state}` : "no such branch"}): what was written before is written again on a new branch`);
      // A story with no acceptance criteria that qa-sentinel can read has no per-AC scope: the change itself is planned, on the story branch.
      if (!req.acceptanceCriteria.length) {
        if (o.acs?.length) throw new Error(`${key} has no acceptance criteria to choose from (--acs ${o.acs.join(",")})`);
        log.info(`${key}: no acceptance criteria found; planning from the change itself, on the story branch`);
      } else {
        scope = storyScope(
          {
            c,
            acs: req.acceptanceCriteria.map((a) => ({ id: a.id, text: a.text })),
            expected: expectedNow,
            parts: manifestParts,
            rec: recNow,
            service: triggerService,
            jiraReady: req.source === "jira" ? isReadyStatus(c, key, req.trackerStatus) : undefined,
            components: servicesFromComponents(c, req.components).services,
            only: o.acs,
            force: o.force,
          },
          acHash,
        );
        if (scope.unknown.length) throw new Error(`${scope.unknown.join(", ")} ${scope.unknown.length === 1 ? "is" : "are"} not in ${key} (its ACs: ${req.acceptanceCriteria.map((a) => a.id).join(", ")})`);
        if (scope.refused.length) throw new Error(`${scope.refused.join(", ")} cannot be planned yet: ${scope.refused.map((id) => `${id} waits for ${scope!.heldAcs.get(id)}`).join("; ")}. Use --force to plan it anyway.`);
        for (const ac of scope.alreadyWritten) if (o.acs?.some((x) => x.toLowerCase() === ac.toLowerCase())) log.info(`${ac} is already written for these commits (use --force to plan it again)`);
        for (const [ac, why] of scope.heldAcs) log.info(`${ac} waits for ${why}`);
        if (!scope.acScope.length) {
          log.ok(`${key}: no acceptance criterion is ready to get tests now; nothing to generate`);
          return 0;
        }
        log.step(`${key}: planning ${scope.acScope.join(", ")}${scope.crossInScope.length ? ` (${scope.crossInScope.join(", ")} need several services)` : ""}`);
      }
    }
    // The parts this run plans against: the merge itself, plus the other merged services when a cross-service AC is written.
    if (triggerService) {
      const own: StoryPart = { service, repo, cs, heads: [cs.head], relevant, merged: true, label: `${service.name} ${cs.head.slice(0, 8)} merged` };
      const mine = sp?.parts.find((p) => p.service.name === triggerService && p.heads.includes(cs.head)) ?? own;
      parts = [mine, ...(scope?.crossInScope.length ? (sp?.parts ?? []).filter((p) => p.merged && p.service.name !== triggerService) : [])];
    } else if (parts && gated) {
      parts = parts.filter((p) => p.merged);
    }
    if (parts) {
      if (!parts.length) {
        log.ok("nothing to generate: no merged change to write tests against");
        return 0;
      }
      for (const p of parts) for (const h of p.heads) atLeast(p.repo, h, Boolean(o.checkout), cwd);
      const combined = combinedChange(key, parts);
      ({ cs, relevant } = combined);
      service = combined.service;
      repo = parts[0].repo;
    }
  }
  if (o.backfill) {
    log.step(`backfill: ${o.backfill.length} endpoint(s) of ${service.name}, the API contract is the oracle`);
  } else if (req.source === "none") {
    if (c.requirements.required) throw new Error("No requirements found for this change and requirements.required is true. Pass --story-file or link the MR/story.");
    log.warn("no requirements found: tests can only be checked against the contract and code");
  } else {
    log.step(`requirements: ${req.storyKey ?? req.title ?? req.source} (${req.acceptanceCriteria.length} AC${req.scopeItems?.length ? ` + ${req.scopeItems.length} scope item(s)` : ""}, ${req.source}, ${req.approvalStatus})`);
  }

  // AI work starts here: claim the job (same story, ACs and commit = same key) and check the budget first.
  if (!o.dryRun) {
    const story = (req.storyKey ?? o.story ?? "").toUpperCase() || NO_STORY;
    const hashes = o.backfill ? o.backfill.map((t) => `${t.method} ${t.path}`) : req.acceptanceCriteria.map((a) => acHash(a.text));
    const head = triggerService ? ownHead : parts ? parts.flatMap((p) => p.heads).join("+") : cs.head;
    // Story scope: the key is the ACs planned and the commits they are written against, however the run was started (a merge, --acs, stories --act).
    // Cross-service ACs in scope make it theirs alone; otherwise it is the single-service ACs'. One service, no story scope: the merge.
    const jobKey =
      scope && storyKey
        ? crossServiceJobKey(storyKey, scope.crossInScope.length ? scope.crossInScope : scope.acScope, scope.crossInScope.length ? scope.heads : scope.allHeads, hashes)
        : generateJobKey(story === NO_STORY ? undefined : story, triggerService ?? (parts ? "story" : service.name), head, hashes);
    // Two generate jobs of one story write the same test branch: only one runs at a time.
    const start = await startJob({ cwd, c, story, kind: "generate", key: jobKey, force: o.force, once: o.once, env: penv, exclusive: Boolean(storyKey && parts), local: o.deferPublish });
    if (!start.run) return start.exitCode;
    ctl.store = start.store;
    ctl.handle = start.handle;
    o.onStarted?.();
  }

  const storyMode = Boolean(parts && storyKey);
  // The story's test branch: continue from the server's copy, merge the main branch into it. Never rebuilt, never force-pushed.
  let sb: Extract<PrepareResult, { ok: true }> | undefined;
  let recordReset = false;
  if (storyMode && !o.dryRun) {
    const prep = await prepareStoryBranch(cwd, c, storyKey!, { gitlab: ctx, env: o.processEnv, project: testProject });
    if (!prep.ok) {
      log.fail(prep.message);
      ctl.outcome = `blocked-${prep.reason}`;
      if (o.deferPublish) {
        // Split CI jobs: this job writes nothing to Jira or GitLab; the note waits for `qa-sentinel publish`.
        if (storyKey) {
          const steps: PublishStep[] = [];
          const key = conflictKey(cwd, c, prep.branch);
          if (prep.reason === "conflict") {
            steps.push({ type: "record", story: storyKey, entries: [], evidence: [], conflict: { branch: prep.branch, message: prep.message.slice(0, 300), key } });
            steps.push({ type: "notify", story: storyKey, event: "merge-conflict", text: `the test branch ${prep.branch} cannot take ${c.ci.targetBranch}: ${prep.message}`.slice(0, 2000), key });
          }
          steps.push({ type: "branch-note", story: storyKey, marker: "<!-- qa-sentinel:story-branch-blocked -->", text: `**QA agent: blocked.** ${prep.message}`.slice(0, 4000) });
          const dir = deferInNewRun(cwd, "generate", "gen-blocked", steps);
          log.ok(`blocked note left for \`qa-sentinel publish\`: ${path.relative(cwd, dir)}/publish.json`);
        }
        return 1;
      }
      if (prep.reason === "conflict" && storyKey) await reportConflict(cwd, c, storyKey, prep.branch, prep.message, penv, ctl.store);
      if (ctx && testProject !== undefined) {
        try {
          const mr = await latestMrForBranch(ctx, testProject, prep.branch, c.ci.targetBranch);
          if (mr?.state === "opened") await upsertMarkedNote(ctx, testProject, mr.iid, "<!-- qa-sentinel:story-branch-blocked -->", `**QA agent: blocked.** ${prep.message}`);
        } catch (e) {
          log.warn(`could not leave a note on the merge request: ${(e as Error).message.split("\n")[0]}`);
        }
      }
      return 1;
    }
    prep.notes.forEach((n) => log.warn(n));
    // A new branch (the earlier merge request was closed or merged, or the branch was gone) starts with no record of tests written: they are written again.
    if ((!prep.existing || prep.previousMr) && ctl.store) {
      await resetWrittenRecords(ctl.store, storyKey!);
      recordReset = true;
    }
    if (prep.mergedMain) log.info(`merged ${c.ci.targetBranch} into ${prep.branch}`);
    log.step(`${prep.branch}: ${prep.existing ? "building on the existing branch" : `new branch from ${c.ci.targetBranch}`}`);
    sb = prep;
  }
  // Per-merge branches: other open QA agent merge requests already add tests the planner cannot see on the main branch.
  let openMrFiles: Map<string, string> | undefined;
  let openMrsPath: string | undefined;
  const sha8 = triggerService ? ownHead.slice(0, 8) : parts ? storyKey! : cs.head.slice(0, 8);
  const backfillId = o.backfill ? `${new Date().toISOString().slice(0, 10)}-${backfillHash(o.backfill)}` : "";
  const branch = storyMode ? storyBranchName(c, storyKey!) : o.backfill ? `qa-sentinel/backfill-${service.name}-${backfillId}` : `qa-sentinel/${service.name}-${sha8}`;
  const subject = storyMode
    ? `story ${storyKey}`
    : o.backfill
      ? `backfill ${service.name} (${o.backfill.length} endpoint${o.backfill.length === 1 ? "" : "s"})`
      : `${service.name}@${sha8}`;
  const policy = generatePolicy(c);
  const run = createRunDir(cwd, `gen-${service.name}`);
  if (!o.backfill && ctx && testProject !== undefined) {
    try {
      const open = await listOpenAgentMrs(cwd, c, { gitlab: ctx, project: testProject, ownBranch: branch, env: penv });
      writeOpenAgentMrs(run.dir, open);
      if (open.length) {
        openMrFiles = addedFiles(open);
        openMrsPath = `${run.rel}/open-agent-mrs.md`;
        log.info(`${open.length} open QA agent merge request(s) already add tests: ${open.map((m) => `!${m.iid}`).join(", ")} (the planner is told)`);
      }
    } catch (e) {
      log.warn(`could not list the open QA agent merge requests: ${(e as Error).message.split("\n")[0]}`);
    }
  }
  fs.writeFileSync(path.join(run.dir, "change.diff"), cs.diff);
  fs.writeFileSync(path.join(run.dir, "story.md"), storyMarkdown(req));
  fs.writeFileSync(path.join(run.dir, "requirements.json"), JSON.stringify(req, null, 2));
  const manifest = startManifest(cwd, c, run, "generate", { service, base: cs.base, head: cs.head, changedFiles: relevant, diff: cs.diff }, req);
  // The latest change of the run is the one that triggered it (story mode: the newest of the parts).
  manifest.trigger = { serviceCommitAt: (parts ?? [{ repo, cs }]).map((p) => commitDate(p.repo, p.cs.head)).filter((d): d is string => Boolean(d)).sort().at(-1) };
  let startSha = resolveSha(cwd, "HEAD");
  const before = (parts ? parts.map((p) => ({ name: p.service.name, repo: p.repo })) : [{ name: service.name, repo }]).map((r) => ({ ...r, snap: snapshotTree(r.repo) }));
  ctl.runId = run.id;
  const engine = ctl.handle ? budgetedEngine(engineFor(c), ctl.handle) : engineFor(c);
  const runs: AgentResult[] = [];
  const finish = (outcome: string, code: number) => {
    ctl.outcome = outcome;
    const usage = addUsage(...runs);
    const denials = runs.flatMap((r) => r.denials ?? []);
    manifest.agent = { status: runs.at(-1)?.status ?? "not-run", ...usage, deniedToolCalls: denials.length };
    if (denials.length) fs.writeFileSync(path.join(run.dir, "permission-denials.json"), JSON.stringify(denials, null, 2));
    manifest.outcome = outcome;
    manifest.finishedAt = new Date().toISOString();
    writeManifest(run, manifest);
    return code;
  };

  // Phase 0: expected behaviour from the story alone (code-blind), before anyone looks at the code.
  const expDir = expectedDirOf(c.tests.expectedDir);
  let pendingExpected: { rel: string; text: string } | undefined;
  let expectedForPlan: string | undefined;
  let expectedFile: ExpectedFile | undefined;
  /** For the merge request: what the requirements pass changed, and the PO's open questions. */
  let expectedNotes: { rel: string; changes: string[]; questions: string[] } | undefined;
  const feature = isFeature(c, req);
  if (!feature) log.info(`${req.storyKey} is a ${req.issueType}, not a feature type (requirements.jira.featureIssueTypes): no expected behaviour, tests from its text`);
  // A story the developer wrote themselves (the MR description) can't be the oracle for the developer's code.
  const devWritten = req.source === "gitlab-mr";
  if (devWritten && feature && c.tests.expectations === "write" && req.acceptanceCriteria.length) log.warn("the ACs come from the merge request description (written by the developer), not Jira or a story file: no expected behaviour is written from them");
  if (!o.backfill && feature && !devWritten && c.tests.expectations === "write" && req.storyKey && req.acceptanceCriteria.length) {
    const story = req.storyKey.toUpperCase();
    const rel = expectedPath(expDir, story);
    let stored: ExpectedFile | undefined;
    let unreadable = false;
    try {
      stored = readExpected(cwd, expDir, story);
    } catch (e) {
      // Never write over a file QA is editing: skip the pass, plan without expected behaviour this run.
      unreadable = true;
      log.warn(`${rel} can't be read (${(e as Error).message}). A person must fix it in its own commit. Tests are planned without expected behaviour this run.`);
    }
    if (!unreadable) {
      log.step(`expected behaviour for ${story}: requirements pass (code-blind)`);
      const spec = await runSpecPass({ cwd, c, engine, req, story, stored, runDir: run.dir, denyRead: specDenyRead(cwd, c, [repo, ...(parts ?? []).map((p) => p.repo)]), dryRun: o.dryRun });
      runs.push(...spec.runs);
      if (spec.errors.length) {
        // Without expectations for its new or changed ACs, the tests would be written from the code: stop instead.
        log.fail(`requirements pass failed: ${spec.errors.slice(0, 5).join("; ")}`);
        log.info(`Fix the story (or write ${rel} by hand) and run again; or set tests.expectations: off to generate without expected behaviour.`);
        return finish("expectations-failed", 1);
      }
      const file = spec.file ?? stored;
      if (file) {
        const text = renderExpected(file);
        fs.writeFileSync(path.join(run.dir, "expected.md"), text);
        expectedForPlan = `${run.rel}/expected.md`;
        expectedFile = file;
        if (!stored || renderExpected(stored) !== text) pendingExpected = { rel, text };
        spec.changes.forEach((x) => log.warn(`  ${x}`));
        expectedNotes = { rel, changes: spec.changes, questions: poQuestions(file) };
      }
    }
  } else if (!o.backfill && req.storyKey) {
    // No requirements pass this run: a stored, reviewed file still guides the plan (the lock uses it either way).
    try {
      const stored = readExpected(cwd, expDir, req.storyKey.toUpperCase());
      if (stored) {
        fs.writeFileSync(path.join(run.dir, "expected.md"), renderExpected(stored));
        expectedForPlan = `${run.rel}/expected.md`;
        expectedFile = stored;
      }
    } catch (e) {
      log.warn(`${(e as Error).message}; planning without it`);
    }
  }

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
      ...(expectedForPlan ? { expectedBehaviour: expectedForPlan } : {}),
      ...(o.backfill ? { backfill: o.backfill } : {}),
      ...(openMrsPath ? { openAgentMrs: openMrsPath } : {}),
    },
    parts,
    expected: expectedFile,
    ...(scope ? { acScope: scope.acScope, heldAcs: scope.heldAcs } : {}),
    ...(openMrFiles ? { addedByOpenMrs: openMrFiles } : {}),
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
  if (todo.length === 0 && pendingExpected && sb) {
    // Story branch: the proposal is committed on it (its own commit) and pushed, so QA reviews it in the story's merge request.
    fs.mkdirSync(path.dirname(path.join(cwd, pendingExpected.rel)), { recursive: true });
    fs.writeFileSync(path.join(cwd, pendingExpected.rel), pendingExpected.text);
    git(cwd, ["add", "--", pendingExpected.rel]);
    git(cwd, ["commit", "-q", "-m", expectedCommitMessage(req.storyKey!, req.acceptanceCriteria, VERSION, run.id)]);
    log.ok(`expected behaviour committed on ${branch}: ${pendingExpected.rel}`);
    if (o.push && o.deferPublish) {
      bundleBranch(cwd, run.dir, branch);
      deferSteps(run.dir, "generate", run.id, [
        { type: "merge-request", branch, headSha: git(cwd, ["rev-parse", "HEAD"]), ...(sb.remoteSha ? { expectSha: sb.remoteSha } : {}), storyKey, title: `QA agent: tests for ${subject}`, description: `## QA agent: ${subject}\n\nExpected behaviour proposed for review (${pendingExpected.rel}). No test changes were needed yet.\n\n${plan.verdict}`, labels: ["qa-agent", `story::${storyKey}`] },
      ]);
      log.ok(`publishing deferred: ${run.rel}/publish.json (run \`qa-sentinel publish --run ${run.id}\`)`);
    } else if (o.push) {
      const pushed = pushStoryBranch(cwd, { branch, remote: remoteFor(c, penv), expect: sb.remoteSha, env: o.processEnv });
      log.ok(`pushed ${branch}${pushed.retried ? " (after merging what a reviewer pushed meanwhile)" : ""}`);
      if (ctx && testProject !== undefined) {
        const mr = await createOrUpdateMergeRequest(ctx, testProject, { source: branch, target: c.ci.targetBranch, title: `QA agent: tests for ${subject}`, description: `## QA agent: ${subject}\n\nExpected behaviour proposed for review (${pendingExpected.rel}). No test changes were needed yet.\n\n${plan.verdict}`, labels: ["qa-agent", `story::${storyKey}`] });
        log.ok(`merge request ${mr.action}: ${mr.web_url}`);
      }
    }
  } else if (todo.length === 0 && pendingExpected) {
    // No branch is made for no test changes: the proposal goes to the working tree for QA to review and commit.
    fs.mkdirSync(path.dirname(path.join(cwd, pendingExpected.rel)), { recursive: true });
    fs.writeFileSync(path.join(cwd, pendingExpected.rel), pendingExpected.text);
    log.info(`expected behaviour proposed (no test changes needed): written to ${pendingExpected.rel}. Review it, then commit it in a merge request.`);
  }
  if (todo.length === 0) {
    const summary = [`## QA agent: ${subject} – no test changes needed`, "", plan.verdict, "", decisionTable(plan, planned.risked.changes)].join("\n");
    fs.writeFileSync(path.join(run.dir, "summary.md"), summary);
    fs.writeFileSync(path.join(cwd, "qa-sentinel-summary.md"), summary);
    log.ok("every decision is reuse or skip: existing tests are enough");
    // The ACs were planned and need nothing new: written, as far as the story is concerned (so `stories` stops listing them as ready).
    if (storyMode && storyKey && scope && ctl.store) {
      await recordStoryRun(ctl.store, storyKey, { scope, parts: manifestParts, acs: req.acceptanceCriteria, plan, runId: run.id, branch });
      if (o.deferPublish) deferSteps(run.dir, "generate", run.id, [{ type: "record", story: storyKey, ...storyRecordPatch({ scope, parts: manifestParts, acs: req.acceptanceCriteria, plan, runId: run.id }) }]);
    }
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
  if (!sb) git(cwd, ["checkout", "-q", "-B", branch]);
  const startShaBefore = startSha;
  // The expected behaviour goes in as its own commit, before the author runs: the lock then protects it from the
  // author too, and QA reviews it on its own in the merge request.
  if (pendingExpected) {
    fs.mkdirSync(path.dirname(path.join(cwd, pendingExpected.rel)), { recursive: true });
    fs.writeFileSync(path.join(cwd, pendingExpected.rel), pendingExpected.text);
    git(cwd, ["add", "--", pendingExpected.rel]);
    git(cwd, ["commit", "-q", "-m", expectedCommitMessage(req.storyKey!, req.acceptanceCriteria, VERSION, run.id)]);
    startSha = resolveSha(cwd, "HEAD");
    log.ok(`expected behaviour committed: ${pendingExpected.rel}`);
  }
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
      // A change made for a bug or task of the story: its tests belong to the story and say which card they were written for.
      ...(req.workKey && req.storyKey ? [`This change was made for ${req.workKey}, a card of ${req.storyKey}: tag every test you add or change for it \`@story:${req.storyKey} @bug:${req.workKey}\` (with \`@ac:\` as usual), so the card's tests are found again when ${req.storyKey} is re-tested.`] : []),
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
    ...checkKnownDefectMarkers(changes, cwd, startSha),
    // Files another open QA agent merge request already adds (also other stories', and per-merge ones).
    ...checkDuplicateFiles(changes, openMrFiles),
    // The tests assert the expected values (named by @b: tags), not the code's.
    ...(expectedFile ? checkExpectedValues({ repo: cwd, ref: startSha, changes, expected: expectedFile, plannedBehaviours: [...new Set(todo.flatMap((d) => d.proposedScenarios.flatMap((s) => s.behaviourIds)))] }) : []),
    // Expected values follow the story, never the code: an AI run may not change them unless the AC changed.
    ...checkExpectationLock({
      expectedDir: c.tests.expectedDir,
      changes,
      before: (f) => showFile(cwd, startSha, f),
      after: (f) => (fs.existsSync(path.join(cwd, f)) ? fs.readFileSync(path.join(cwd, f), "utf8") : undefined),
      currentAcs: req.storyKey && requirementItems(req).length ? new Map([[req.storyKey.toUpperCase(), requirementItems(req).map((a) => ({ id: a.id, text: a.text }))]]) : undefined,
    }),
  ];
  const bad = violations(findings);
  manifest.guardrails = { violations: bad.length, warnings: findings.length - bad.length };
  fs.writeFileSync(path.join(run.dir, "guardrails.json"), JSON.stringify(findings, null, 2));
  if (bad.length) {
    log.fail(`run rejected: ${bad.length} guardrail violation(s). No tests were committed${pendingExpected ? ` (the expected-behaviour commit stays on ${branch}; reset it with: git reset --hard ${startShaBefore})` : ""}.`);
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
  const verifyStarted = Date.now() - 1000;
  const verified0 = await verifyChanges({ cwd, c, changes, runDir: run.dir, env: testEnv(c), environment });
  // Tests written for a change that isn't deployed where they ran fail for that reason alone: say so (C1).
  const deployBase = process.env[c.tests.api.baseUrlEnv];
  const deployNeeds = (parts ? parts.map((p) => ({ service: p.service, sha: p.cs.head, repo: p.repo })) : o.backfill ? [] : [{ service, sha: cs.head, repo }]).filter((n) => n.service.version);
  const deployStates = deployBase && deployNeeds.length ? await deploymentStates(deployNeeds, environment ?? "test environment", deployBase, gitlabContext(c.ci.gitlabUrl)) : [];
  const verification = applyDeploymentGate(verified0, deployStates);
  if (verification.status === "WAITING_FOR_DEPLOYMENT") log.warn(`the change isn't deployed on ${environment ?? deployBase} yet: ${notDeployed(deployStates).map((d) => d.service).join(", ")}; failed tests may only be waiting for it`);
  const discrepancies = findDiscrepancies(cwd, startSha, changes);
  // Data the verified tests created and couldn't delete (or a killed test left): sweep it now, report what stays.
  if (c.testData.cleanup === "ledger") findings.push(...(await sweepAfterRun(cwd, c, verifyStarted)));
  // Traceability from the tests' own tags: what each AC is now proven by, and tests that don't say what they prove.
  const index = indexTests(cwd, c);
  fs.writeFileSync(path.join(run.dir, "test-index.json"), JSON.stringify(index, null, 2));
  const changedFiles = changes.filter((x) => x.status !== "D").map((x) => x.path);
  const traceFindings = [
    ...checkNewTests(index, changedFiles, req.storyKey, requirementItems(req).map((a) => a.id)),
    ...checkTestMap(index, readTestMap(cwd), cwd).filter((f) => f.level === "warning" && changedFiles.some((cf) => f.file.startsWith(cf) || f.file === "test-map.yaml")),
  ];
  findings.push(...traceFindings.map((f) => ({ level: "warning" as const, rule: "traceability" as const, file: f.file, message: f.message })));
  const trace = traceStory(index, req.storyKey, requirementItems(req), [...readManualCards(cwd, c.tests.manualDir), ...(plan.manualTests ?? []).map((m) => ({ story: req.storyKey, acs: m.requirementIds.map((r) => r.toUpperCase()), file: `${c.tests.manualDir}/${req.storyKey ?? `${service.name}-${sha8}`}.md`, line: 0, title: m.title }))]);

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
  const baseDescription = mrDescription({
    environment,
    service: service.name,
    sha: cs.head,
    subject,
    version: VERSION,
    requirements: req,
    verification,
    findings,
    discrepancies,
    expected: expectedNotes,
    traceability: traceMarkdown(req.storyKey, trace, new Map((review.review?.tests ?? []).filter((t) => t.verdict === "weak" || t.verdict === "wrong-oracle").map((t) => [t.id, t.verdict]))),
    review: reviewMarkdown(review, toReview),
    agentSummary: cleanAgentAnswer(author.result),
    usage,
    runId: run.id,
    plan: { plan, risked: planned.risked, contract: planned.contract, specPath: service.openapi, corrections: planned.validation?.corrections ?? [] },
  });
  // The story's merge request is rewritten after every run: it also says which ACs still wait, and what the closed one was.
  const extra = [
    ...(scope && scope.heldAcs.size ? ["", "### Waiting ACs", "", "These get their tests in a later run, when they are ready:", ...[...scope.heldAcs].map(([ac, why]) => `- ${ac}: waits for ${why}`)] : []),
    ...(sb?.previousMr ? ["", `Previous test merge request [!${sb.previousMr.iid}](${sb.previousMr.url}) was ${sb.previousMr.state}; this branch started again from ${c.ci.targetBranch}.`] : []),
  ];
  const description = extra.length ? `${baseDescription}\n${extra.join("\n")}\n` : baseDescription;
  fs.writeFileSync(path.join(run.dir, "summary.md"), description);
  fs.writeFileSync(path.join(cwd, "qa-sentinel-summary.md"), description);

  // Manual test cards for requirements that can't be automated: written by qa-sentinel from the validated plan.
  const cards = writeCards(cwd, c.tests.manualDir, req.storyKey, req.storyKey ?? `${service.name}-${sha8}`, plan.manualTests ?? []);
  if (cards.added) log.ok(`${cards.added} manual test card(s) in ${cards.file}`);

  // Phase 5: commit exactly the validated paths (deletions and renames included), then publish.
  const paths = [...new Set([...changes.flatMap((x) => (x.from && x.status === "R" ? [x.path, x.from] : [x.path])), ...(cards.file ? [cards.file] : [])])];
  git(cwd, ["add", "-A", "--", ...paths]);
  // The AC texts this commit was written for: lets `verify --policy` check it later, even without Jira access.
  const trailer = acTrailer(req.storyKey, requirementItems(req));
  git(cwd, [
    "commit",
    "-q",
    "-m",
    `test(${service.name}): QA agent ${o.backfill ? `backfill (${o.backfill.map((b) => b.endpoint).join(", ")})` : `updates for ${sha8}`}\n\nGenerated by qa-sentinel ${VERSION} from ${parts ? parts.map((p) => `${p.service.name}@${p.cs.head}`).join(", ") : `${service.name}@${cs.head}`}.\nRisk: ${planned.risked.overall}. Verification: ${verification.status}. Run: ${run.id}${trailer ? `\n\n${trailer}` : ""}`,
  ]);
  log.ok(`committed ${paths.length} file(s) on ${branch}`);
  // The story record says "written" only once the tests are really on the server's branch (after the push below), or on the local one when this run does not push.
  const recordWritten = async () => {
    if (storyMode && storyKey && scope && ctl.store) await recordStoryRun(ctl.store, storyKey, { scope, parts: manifestParts, acs: req.acceptanceCriteria, plan, runId: run.id, branch });
  };
  if (!o.push) await recordWritten();

  // Bug cards (bugs.mode): requirements the product doesn't meet, seen failing by the author and written as fixme.
  if (c.bugs.mode !== "off" && req.storyKey && discrepancies.length && !o.dryRun) {
    const jira = o.deferPublish ? undefined : jiraContext(c.requirements.jira);
    if (o.deferPublish) {
      // Split CI jobs: the Jira writes belong to `qa-sentinel publish`.
      const candidates = bugsFromDiscrepancies(req.storyKey, requirementItems(req), discrepancies, index, plan, { environment, runCommand: (t) => runCommandsFor(c, [`${t.file}:${t.line}`])[0] });
      if (candidates.length) deferSteps(run.dir, "generate", run.id, [{ type: "bugs", story: req.storyKey, candidates: JSON.parse(JSON.stringify(candidates)) }]);
    }
    if (jira) {
      const candidates = bugsFromDiscrepancies(req.storyKey, requirementItems(req), discrepancies, index, plan, { environment, runCommand: (t) => runCommandsFor(c, [`${t.file}:${t.line}`])[0] });
      const r = await fileBugs(jira, c, req.storyKey, candidates, cwd).catch((e) => (log.warn(`bugs: ${(e as Error).message}`), undefined));
      if (r?.created.length) log.ok(`bug(s) raised on ${req.storyKey}: ${r.created.join(", ")}`);
      if (r?.suggested) log.ok(`${r.suggested} bug(s) proposed on ${req.storyKey}`);
    }
  }

  if (o.push && c.verification.requireVerifiedToPush && verification.status !== "VERIFIED" && verification.status !== "WAITING_FOR_DEPLOYMENT") {
    log.warn(`not pushed: verification is ${verification.status}${environment ? ` on ${environment}` : ""} and verification.requireVerifiedToPush is on. The branch ${branch} stays local for inspection.`);
    return finish(`not-pushed-${verification.status.toLowerCase()}`, 1);
  }
  const verifiedOk = verification.status === "VERIFIED";
  const mrTitle = `${verifiedOk ? "" : "Draft: "}QA agent: tests for ${subject}${verifiedOk ? "" : ` (${verification.status === "WAITING_FOR_DEPLOYMENT" ? "waiting for deployment" : verification.status})`}`;
  const mrLabels = [
    "qa-agent",
    ...(storyMode ? [`story::${storyKey}`, ...[...new Set([...manifestParts.filter((p) => p.merged).map((p) => p.service), ...(parts ?? []).map((p) => p.service.name)])].map((n) => `service::${n}`)] : parts ? [`story::${o.story}`, ...parts.map((p) => `service::${p.service.name}`)] : [`service::${service.name}`]),
    ...(o.backfill ? ["qa-sentinel::backfill"] : []),
    `qa-sentinel::${verification.status.toLowerCase()}`,
    `risk::${planned.risked.overall}`,
    ...(discrepancies.length ? ["qa-sentinel::discrepancy"] : []),
    ...(planned.plan ? specDriftLabels(planned.plan) : []),
    ...(review.review?.tests.some((t) => t.verdict === "weak" || t.verdict === "wrong-oracle") ? ["qa-sentinel::weak-tests"] : []),
  ];
  if (o.push && o.deferPublish) {
    // The analysis is done. The branch travels as a bundle and the writing (push, merge request, Jira, record) is left to `qa-sentinel publish`.
    bundleBranch(cwd, run.dir, branch);
    const crossAcs = storyMode && storyKey && scope?.crossInScope.length ? scope.crossInScope : [];
    const acText = new Map(requirementItems(req).map((a) => [a.id, a.text]));
    // The branch starts again (see resetWrittenRecords): the old record is cleared BEFORE the merge request is recorded, not after.
    deferSteps(run.dir, "generate", run.id, [
      {
        type: "merge-request",
        branch,
        headSha: git(cwd, ["rev-parse", "HEAD"]),
        ...(sb?.remoteSha ? { expectSha: sb.remoteSha } : {}),
        ...(storyMode && storyKey ? { storyKey } : {}),
        ...(recordReset && storyMode && storyKey ? { resetRecord: true } : {}),
        title: mrTitle,
        description,
        labels: mrLabels,
        ...(crossAcs.length && storyKey ? { notify: { story: storyKey, event: "cross-service-tests-ready", text: `end-to-end tests for ${crossAcs.join(", ")} are ready for review: {mr}`, key: `${crossAcs.join("+")}@{iid}` } } : {}),
        ...(c.reporting.targets.includes("jira") ? { jira: { storyKey: req.storyKey, service: service.name, risk: planned.risked.overall, verification: verification.status, environment, trace: trace.acs, acText: [...acText], discrepancies: discrepancies.map((d) => ({ test: String(d.test).slice(0, 500), ...(d.note ? { note: String(d.note).slice(0, 2000) } : {}) })).slice(0, 500), weakTests: review.review?.tests.filter((t) => t.verdict === "weak" || t.verdict === "wrong-oracle").length, report: description } } : {}),
      },
    ]);
    // The story record: written only once the push is done, so it is a step of its own, after the merge request.
    if (storyMode && storyKey && scope) deferSteps(run.dir, "generate", run.id, [{ type: "record", story: storyKey, ...storyRecordPatch({ scope, parts: manifestParts, acs: req.acceptanceCriteria, plan, runId: run.id }) }]);
    log.ok(`publishing deferred: ${run.rel}/publish.json and ${run.rel}/branch.bundle (run \`qa-sentinel publish --run ${run.id}\`)`);
  } else if (o.push) {
    // Push with a one-off URL so the token never sits in .git/config where an agent could read it.
    if (sb) {
      // The story branch is built on, never rebuilt: pushed only if nobody pushed to it since this run started (a reviewer's commits are merged in and kept).
      const pushed = pushStoryBranch(cwd, { branch, remote: remoteFor(c, penv), expect: sb.remoteSha, env: o.processEnv });
      if (pushed.retried) log.info(`${branch}: a reviewer pushed meanwhile; their commits were merged in`);
    } else {
      const projectPath = c.ci.testRepoProject && !/^\d+$/.test(c.ci.testRepoProject) ? c.ci.testRepoProject : penv.CI_PROJECT_PATH;
      const url = pushUrl(c.ci.gitlabUrl, projectPath, penv);
      // A per-merge branch is owned by qa-sentinel and named after the source SHA, so a rerun may overwrite it.
      git(cwd, ["push", "--force", url ?? "origin", `HEAD:refs/heads/${branch}`]);
    }
    await recordWritten();
    const project = testProject;
    if (!ctx || !project) {
      log.warn("pushed; set QA_SENTINEL_GITLAB_TOKEN and ci.testRepoProject to open the MR automatically");
    } else {
      const mr = await createOrUpdateMergeRequest(ctx, project, {
        source: branch,
        target: c.ci.targetBranch,
        title: mrTitle,
        description,
        labels: mrLabels,
      });
      log.ok(`merge request ${mr.action}: ${mr.web_url}`);
      manifest.trigger = { ...manifest.trigger, mrOpenedAt: new Date().toISOString() };
      if (storyMode && storyKey && ctl.store) await recordAgentMr(ctl.store, storyKey, { branch, iid: mr.iid, url: mr.web_url, headSha: git(cwd, ["rev-parse", "HEAD"]) });
      // A cross-service run: the people who asked to know are told the test merge request is ready for review.
      if (storyMode && storyKey && scope?.crossInScope.length) await notifyStory(cwd, c, storyKey, "cross-service-tests-ready", `end-to-end tests for ${scope.crossInScope.join(", ")} are ready for review: ${mr.web_url}`, `${scope.crossInScope.join("+")}@${mr.iid}`, penv, ctl.store);
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
        await publish(c, { report: description, jiraSummary, cwd, service: service.name, storyKey: req.storyKey, mr: {}, targets: ["jira"] });
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

/** What a story-scoped run leaves in the story record: the cross-service ACs it wrote (or still holds), and what the plan said about each AC. A cache; losing it only repeats work the job key would have skipped. */
export type RecordPatch = Omit<RecordStep, "type" | "story">;

export function storyRecordPatch(i: { scope: StoryScope; parts: ServicePart[]; acs: { id: string; text: string }[]; plan: { requirementStatus: { id: string; status: string }[] }; runId: string }): RecordPatch {
  const text = new Map(i.acs.map((a) => [a.id, a.text]));
  const entries: RecordPatch["entries"] = [];
  for (const r of i.scope.readiness) {
    const heads = headsDigest(i.parts, r.services);
    const hash = acHash(text.get(r.ac) ?? "");
    if (i.scope.acScope.includes(r.ac)) entries.push({ ac: r.ac, kind: r.kind, state: "written", heads, acHash: hash });
    // Only the cross-service ACs keep a "held" note (what they wait for); a single-service AC that waits has nothing written to remember.
    else if (r.kind === "cross") entries.push({ ac: r.ac, kind: r.kind, state: "held", heads, acHash: hash, reason: (i.scope.heldAcs.get(r.ac) ?? r.reason ?? "").slice(0, 500) || undefined });
  }
  const evidence = i.plan.requirementStatus.filter((st) => i.scope.acScope.includes(st.id)).map((st) => ({ id: st.id, status: st.status.slice(0, 40), runId: i.runId }));
  return { entries, evidence, clearConflict: true };
}

/** Apply a patch to the record. Used by the run itself and, in split mode, by `qa-sentinel publish` (the record step). */
export async function applyRecordPatch(store: RecordStore, story: string, patch: RecordPatch & { reset?: boolean }): Promise<void> {
  const at = new Date().toISOString();
  await store.locked(story, async () => {
    const rec = (await store.load(story)) ?? emptyRecord(story);
    if (patch.reset) {
      rec.crossService = {};
      rec.singleService = {};
      delete rec.agentMr;
    }
    for (const e of patch.entries ?? []) {
      const map = e.kind === "cross" ? rec.crossService : rec.singleService;
      if (e.state === "written") map[e.ac] = { state: "written", heads: e.heads, acHash: e.acHash, at };
      else if (map[e.ac]?.state !== "written" || map[e.ac].acHash !== e.acHash) map[e.ac] = { state: "held", heads: e.heads, acHash: e.acHash, at, ...(e.reason ? { reason: e.reason } : {}) };
    }
    for (const ev of patch.evidence ?? []) rec.acEvidence[ev.id] = { status: ev.status, at, runId: ev.runId };
    if (patch.clearConflict) delete rec.conflict; // the branch took the main branch: any earlier conflict is over
    if (patch.conflict) rec.conflict = { ...patch.conflict, at };
    rec.updatedAt = at;
    await store.save(rec);
  });
}

async function recordStoryRun(store: RecordStore, story: string, i: Parameters<typeof storyRecordPatch>[0] & { branch: string }): Promise<void> {
  try {
    await applyRecordPatch(store, story, storyRecordPatch(i));
  } catch (e) {
    log.warn(`could not update the story record for ${story}: ${(e as Error).message}`);
  }
}

/** The story's test branch starts again: what the record says was written on the old one no longer holds. */
async function resetWrittenRecords(store: RecordStore, story: string): Promise<void> {
  try {
    await store.locked(story, async () => {
      const rec = await store.load(story);
      if (!rec || (!Object.keys(rec.crossService).length && !Object.keys(rec.singleService).length && !rec.agentMr)) return;
      rec.crossService = {};
      rec.singleService = {};
      delete rec.agentMr;
      rec.updatedAt = new Date().toISOString();
      await store.save(rec);
    });
  } catch (e) {
    log.warn(`could not reset the story record for ${story}: ${(e as Error).message}`);
  }
}

/**
 * The story's test branch cannot take the main branch: remembered in the story record (the status comment's pending
 * section shows it until a run goes through) and the people who asked to know are told, again when the branch or main has
 * moved on since (the notification key holds both tips). Best effort; the run itself is already blocked.
 */
/** The notification key of a conflict: the branch and both tips, so a branch or main that moved on is told again. */
export function conflictKey(cwd: string, c: Config, branch: string): string {
  const tip = (ref: string) => {
    try {
      return git(cwd, ["rev-parse", "-q", "--verify", ref]).slice(0, 10);
    } catch {
      return "?";
    }
  };
  return `${branch}@${tip(`origin/${branch}`)}+${tip(`origin/${c.ci.targetBranch}`)}`;
}

/** Remember the conflict in the story record and show it in the status comment's pending section. Best effort. */
export async function showConflict(c: Config, story: string, branch: string, message: string, key: string, env: NodeJS.ProcessEnv, st: RecordStore): Promise<void> {
  try {
    await applyRecordPatch(st, story, { entries: [], evidence: [], conflict: { branch, message: message.slice(0, 300), key } });
    const ctx = jiraContext(c.requirements.jira, env);
    const rec = await st.load(story);
    if (ctx && rec && jiraMode(c) !== "legacy") await refreshStaleness(ctx, story, { pending: pendingWiki(rec, {}), visibility: c.reporting.jira.visibility, basis: rec.basis, rec });
  } catch (e) {
    log.warn(`could not show the merge conflict on ${story}: ${(e as Error).message.split("\n")[0]}`);
  }
}

async function reportConflict(cwd: string, c: Config, story: string, branch: string, message: string, env: NodeJS.ProcessEnv, store: RecordStore | undefined): Promise<void> {
  const key = conflictKey(cwd, c, branch);
  const st = store ?? openStore(cwd, c, env);
  await showConflict(c, story, branch, message, key, env, st);
  await notifyStory(cwd, c, story, "merge-conflict", `the test branch ${branch} cannot take ${c.ci.targetBranch}: ${message}`, key, env, st);
}

export async function recordAgentMr(store: RecordStore, story: string, mr: { branch: string; iid: number; url: string; headSha: string }): Promise<void> {
  const at = new Date().toISOString();
  try {
    await store.locked(story, async () => {
      const rec = (await store.load(story)) ?? emptyRecord(story);
      rec.agentMr = { branch: mr.branch, iid: mr.iid, url: mr.url, state: "opened", headSha: mr.headSha, updatedAt: at };
      rec.updatedAt = at;
      await store.save(rec);
    });
  } catch (e) {
    log.warn(`could not update the story record for ${story}: ${(e as Error).message}`);
  }
}
