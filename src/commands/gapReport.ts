import { type ExpectedFile, expectedPath, readExpected } from "../expected/format.js";
import { expectedDirOf } from "../expected/lock.js";
import { readManualCards } from "../manualTests.js";
import { requirementItems } from "../requirements.js";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../config.js";
import { changeSet, commitMessages, ensureAtCommit, git, isGitRepo } from "../git.js";
import { matchesAny } from "../fsutil.js";
import { formatUsage } from "../claude.js";
import { ARTIFACT_GLOBS, createRunDir, findService, startManifest, writeManifest } from "../run.js";
import { checkServiceUntouched, diffSnapshots, findingsMarkdown, snapshotTree, type Finding } from "../guardrails.js";
import { requirementsLine, resolveRequirements, skippedBranch, storyMarkdown } from "../requirements.js";
import { getMrNoteBody, gitlabContext, gitlabMrFromEnv, mrIsDraft, upsertMrNote } from "../scm/gitlab.js";
import { gapFingerprint, parseStamp, relevantDiffDigest, stampOf, updatedLine } from "../plan/fingerprint.js";
import { assembleFeature } from "../feature/manifest.js";
import { publish } from "../reporting/publish.js";
import { engineFor } from "../engines/ClaudeCodeEngine.js";
import type { AgentEngine } from "../engines/AgentEngine.js";
import { withSpend } from "../stories/start.js";
import { addUsage } from "../engines/AgentEngine.js";
import { oracleOf, planChange } from "../plan/planner.js";
import { acHash } from "../expected/format.js";
import { renderGapReport } from "../plan/render.js";
import { gapSummary } from "../reporting/jiraSummary.js";
import { indexTests, readTestMap, traceMarkdown, traceStory } from "../analysis/testIndex.js";
import { mergeSelections, regressionCommands, regressionMarkdown, selectRegression } from "../analysis/regression.js";
import { contractDiffMarkdown } from "../analysis/contractDiff.js";
import { contractCheckMarkdown, deviationsIn } from "../contracts.js";
import { log } from "../log.js";
import { bugsFromPlan, fileBugs } from "../bugs/bugs.js";
import { jiraContext } from "../scm/jira.js";
import type { ServiceConfig } from "../config.js";
import type { ChangeSet } from "../git.js";
import { type StoryPart, combinedChange, storyParts } from "../story.js";
import { atLeast } from "../git.js";

export interface GapReportOptions {
  cwd: string;
  service: string;
  servicePath?: string;
  base?: string;
  head?: string;
  checkout?: boolean;
  storyFile?: string;
  /** Make the report even if the merge request is still a draft (automation.gapReport.when: ready skips drafts). */
  evenIfDraft?: boolean;
  /** Make a new report even if nothing the report depends on changed since the one on the MR. */
  refresh?: boolean;
  /** Story mode: analyse everything this story changed, across all its service repos. */
  story?: string;
  out?: string;
  post?: boolean;
  dryRun?: boolean;
}

type GapResult = { report: string; skipped: boolean; exitCode: number };

/** What the AI part of the run needs from the free checks before it. */
interface Prepared {
  c: ReturnType<typeof loadConfig>;
  cwd: string;
  mr: ReturnType<typeof gitlabMrFromEnv>;
  service: ServiceConfig;
  repo: string;
  cs: ChangeSet;
  relevant: string[];
  parts: StoryPart[] | undefined;
  out: string;
  req: Awaited<ReturnType<typeof resolveRequirements>>;
  fp: string | undefined;
  previousHead: string | undefined;
}

export async function gapReportCommand(o: GapReportOptions): Promise<GapResult> {
  const cwd = path.resolve(o.cwd);
  const c = loadConfig(cwd);
  // The checks that need no AI come first, so a draft or an unchanged push costs nothing and never trips a budget.
  const pre = await gapReportPrepare(o, c, cwd);
  if (pre.done) return pre.done;
  return withSpend(
    { cwd, c, story: o.story, label: "gap-report", skip: o.dryRun },
    (exitCode) => ({ report: "", skipped: true, exitCode }),
    (wrap) => gapReportBody(o, wrap, pre.s!),
    (r) => r.exitCode,
  );
}

async function gapReportPrepare(o: GapReportOptions, c: ReturnType<typeof loadConfig>, cwd: string): Promise<{ done?: GapResult; s?: Prepared }> {
  const mr = gitlabMrFromEnv();
  // One gap report per dev MR, when the author marks it ready for review: a draft is still changing.
  if (!o.story && !o.evenIfDraft && !o.dryRun && c.automation.gapReport.when === "ready" && mr.mrIid && (await mrIsDraft(gitlabContext(c.ci.gitlabUrl), mr.project, mr.mrIid, mr.title))) {
    const out = path.resolve(cwd, o.out ?? "qa-gap-report.md");
    const report = `### QA impact · waiting\n**Verdict:** this merge request is a draft. The gap report is made once it is marked ready for review (automation.gapReport.when: ready; --even-if-draft overrides).\n`;
    fs.writeFileSync(out, report);
    // Say so on the MR: marking it ready does not start a pipeline by itself, and nobody should think a report exists.
    const gl = o.post && c.reporting.targets.includes("gitlab-mr") ? gitlabContext(c.ci.gitlabUrl) : undefined;
    if (gl && mr.project) await upsertMrNote(gl, mr.project, mr.mrIid, report).catch((e) => log.warn(`could not post the waiting note: ${(e as Error).message}`));
    log.ok("merge request is a draft; the gap report waits until it is ready for review");
    return { done: { report, skipped: true, exitCode: 0 } };
  }
  let service: ServiceConfig, repo: string, cs: ChangeSet, relevant: string[];
  let parts: StoryPart[] | undefined;
  if (o.story) {
    const sp = await storyParts({ c, cwd, story: o.story });
    sp.notes.forEach((n) => log.warn(n));
    if (!sp.parts.length) throw new Error(`No service changes found for ${o.story}: no branch or commit message mentions it in the service repos`);
    parts = sp.parts;
    for (const p of parts) atLeast(p.repo, p.cs.head, Boolean(o.checkout), cwd);
    ({ service, cs, relevant } = combinedChange(o.story, parts));
    repo = parts[0].repo;
    log.step(`story ${o.story}: ${parts.map((p) => `${p.service.name} (${p.relevant.length} file(s)${p.merged ? "" : ", not merged"})`).join(", ")}`);
  } else {
    service = findService(c, o.service, cwd, o.servicePath);
    repo = path.resolve(cwd, service.path);
    if (!isGitRepo(repo)) throw new Error(`${repo} is not a git repository`);
    cs = changeSet(repo, o.base ?? mr.base ?? `origin/${c.ci.targetBranch}`, o.head ?? "HEAD");
    // The agent reads the working tree, so it must be exactly the commit whose diff it analyses.
    ensureAtCommit(repo, cs.head, Boolean(o.checkout), cwd);
    relevant = cs.files.filter((f) => !matchesAny(f, c.agent.skipPaths));
  }

  const out = path.resolve(cwd, o.out ?? "qa-gap-report.md");
  if (relevant.length === 0) {
    const report = `### QA impact – ${service.name} · 🟢 Low risk\n**Verdict:** no test-relevant changes (${cs.files.length} file(s) changed, all docs/config). Nothing to check.\n`;
    fs.writeFileSync(out, report);
    log.ok("no test-relevant changes; skipped agent run");
    return { done: { report, skipped: true, exitCode: 0 } };
  }

  const bot = o.story ? undefined : skippedBranch(c, mr.sourceBranch, process.env.CI_MERGE_REQUEST_SOURCE_BRANCH_NAME, process.env.gitlabSourceBranch);
  if (bot) {
    const report = `### QA impact – ${service.name} · skipped\n**Verdict:** changes from \`${bot}\` (listed in ci.skipBranches) get no gap report.\n`;
    fs.writeFileSync(out, report);
    log.ok(`${bot} is in ci.skipBranches; skipped`);
    return { done: { report, skipped: true, exitCode: 0 } };
  }
  const req = await resolveRequirements(c, {
    storyFile: o.storyFile,
    mr: { title: mr.title, description: mr.description, url: mr.url, sourceBranch: mr.sourceBranch },
    keyHints: o.story ? [o.story] : [mr.sourceBranch, ...commitMessages(repo, cs.base, cs.head)],
  });
  // One comment per MR, refreshed only when the code that matters (or the ACs, the expected behaviour, the scope) changed since the report on it.
  let fp: string | undefined;
  let previousHead: string | undefined;
  if (!o.story) {
    const range = `${cs.base}...${cs.head}`;
    const digest = relevantDiffDigest((f) => { try { return git(repo, ["-c", "core.quotePath=false", "diff", "--relative", "--binary", "--full-index", range, "--", f]); } catch { return ""; } }, relevant);
    let expectedText = "";
    if (req.storyKey) try { expectedText = fs.readFileSync(path.join(cwd, expectedPath(expectedDirOf(c.tests.expectedDir), req.storyKey.toUpperCase())), "utf8"); } catch { /* none yet */ }
    fp = gapFingerprint(digest, req.acceptanceCriteria.map((a) => `${a.id}:${acHash(a.text)}`), [expectedText, JSON.stringify(req.scopeItems ?? []), JSON.stringify(req.outOfScope ?? [])]);
  }
  if (fp && o.post && !o.dryRun && !o.refresh && c.reporting.targets.includes("gitlab-mr") && mr.project && mr.mrIid) {
    const gl = gitlabContext(c.ci.gitlabUrl);
    const last = gl ? parseStamp(await getMrNoteBody(gl, mr.project, mr.mrIid).catch(() => undefined)) : undefined;
    if (last?.fp === fp) {
      const report = `### QA impact · unchanged\n**Verdict:** nothing the gap report depends on changed since the report for ${last.head.slice(0, 8)} (the diff of the relevant files, the acceptance criteria, the expected behaviour and the scope are the same). The comment on the merge request still stands; --refresh makes a new one.\n`;
      fs.writeFileSync(out, report);
      log.ok(`nothing changed since the report for ${last.head.slice(0, 8)}; no new gap report`);
      return { done: { report, skipped: true, exitCode: 0 } };
    }
    previousHead = last?.head;
  }
  return { s: { c, cwd, mr, service, repo, cs, relevant, parts, out, req, fp, previousHead } };
}

async function gapReportBody(o: GapReportOptions, wrap: (e: AgentEngine) => AgentEngine, s: Prepared): Promise<GapResult> {
  const { c, cwd, mr, service, repo, cs, relevant, parts, out, req, fp, previousHead } = s;
  const run = createRunDir(cwd, `gap-${service.name}`);
  fs.writeFileSync(path.join(run.dir, "change.diff"), cs.diff);
  fs.writeFileSync(path.join(run.dir, "story.md"), storyMarkdown(req));
  fs.writeFileSync(path.join(run.dir, "requirements.json"), JSON.stringify(req, null, 2));
  const manifest = startManifest(cwd, c, run, "gap-report", { service, base: cs.base, head: cs.head, changedFiles: relevant, diff: cs.diff }, req);
  log.step(`${o.story ? `story ${o.story}` : `${service.name}@${cs.head.slice(0, 8)}`}: ${relevant.length} relevant file(s) changed; planning`);

  const testBefore = snapshotTree(cwd);
  const repos = parts ? parts.map((p) => ({ name: p.service.name, repo: p.repo })) : [{ name: service.name, repo }];
  const before = repos.map((r) => ({ ...r, snap: snapshotTree(r.repo) }));
  const engine = wrap(engineFor(c));
  // The story's stored expected behaviour (written before development, reviewed by QA), when it has one.
  let expected: ExpectedFile | undefined;
  if (req.storyKey) {
    try {
      expected = readExpected(cwd, expectedDirOf(c.tests.expectedDir), req.storyKey.toUpperCase());
    } catch (e) {
      log.warn(`${(e as Error).message}; planning without it`);
    }
  }
  const expectedRel = expected ? expectedPath(expectedDirOf(c.tests.expectedDir), expected.story) : undefined;
  const outcome = await planChange({ cwd, c, service, repo, cs, relevant, req, run, engine, dryRun: o.dryRun, context: { kind: "gap-report", ...(expectedRel ? { expectedBehaviour: expectedRel } : {}) }, parts, expected });
  const usage = addUsage(...outcome.runs);
  const denials = outcome.runs.flatMap((r) => r.denials ?? []);
  manifest.agent = { status: outcome.runs.at(-1)?.status ?? "not-run", ...usage, deniedToolCalls: denials.length };
  if (denials.length) fs.writeFileSync(path.join(run.dir, "permission-denials.json"), JSON.stringify(denials, null, 2));

  // Read-only means read-only: nothing outside the run directory may change, in either repo.
  const findings: Finding[] = [
    ...before.flatMap((b) => checkServiceUntouched(b.repo, b.name, b.snap)),
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
  let jiraSummary: string | undefined;
  let exitCode = 0;
  if (outcome.status === "valid" && outcome.plan && outcome.risked) {
    // Facts computed in code from the test repo: which existing tests to run, and what already proves the story.
    const index = indexTests(cwd, c);
    const select = (svc: string) => selectRegression({ c, service: svc, plan: outcome.plan!, risked: outcome.risked!.changes, contract: outcome.contract, index, map: readTestMap(cwd) });
    // Story mode: each service's own fallbacks and consumers count, merged into one selection.
    const selection = parts ? mergeSelections(parts.map((p) => select(p.service.name))) : select(service.name);
    fs.writeFileSync(path.join(run.dir, "regression.json"), JSON.stringify(selection, null, 2));
    fs.writeFileSync(path.join(path.dirname(out), "qa-regression.txt"), selection.runFullSuite ? "" : selection.args.join("\n") + "\n");
    const trace = traceStory(index, req.storyKey, requirementItems(req), readManualCards(cwd, c.tests.manualDir));
    const traced = trace.acs.some((r) => r.status !== "not-traced");
    log.step(`regression selection: ${selection.runFullSuite ? "full suite" : `${selection.tests.length} test(s)`}`);
    report =
      renderGapReport({
        service: parts ? `story ${o.story} (${parts.map((p) => p.service.name).join(", ")})` : service.name,
        plan: outcome.plan,
        risked: outcome.risked,
        contract: outcome.contract,
        specPath: service.openapi,
        requirementsLine: requirementsLine(req),
        corrections: outcome.validation?.corrections ?? [],
        warnings: outcome.validation?.warnings ?? [],
        oracle: oracleOf(req),
        regression: regressionMarkdown(selection, regressionCommands(c, selection)),
        rules: outcome.validation?.rules,
        items: requirementItems(req),
        traceability: traced ? traceMarkdown(req.storyKey, trace) : undefined,
      }) + `\n\n${footer}`;
    // The same story in other services (one feature, many services): say so, so nobody tests half a feature.
    let featureLine = "";
    const featureServices: string[] = [];
    if (req.storyKey && !o.story) {
      try {
        const m = await assembleFeature({ c, cwd, story: req.storyKey, gitlab: c.workspace.services.some((x) => x.gitlabProject) ? gitlabContext(c.ci.gitlabUrl) : undefined });
        const others = m.parts.filter((p) => p.service !== service.name);
        featureServices.push(...others.map((p) => p.service));
        if (others.length) {
          featureLine = `**Feature ${req.storyKey} also changes:** ${others.map((p) => `${p.service} (${p.mr ? `[!${p.mr.iid}](${p.mr.url}), ` : ""}${p.merged ? "merged" : "not merged yet"})`).join(", ")}. Acceptance criteria that need several services are checked with \`qa-sentinel feature ${req.storyKey}\` once every part is deployed.`;
          report = report.replace(footer, `${featureLine}\n\n${footer}`);
        }
      } catch (e) {
        log.dim(`feature lookup skipped: ${(e as Error).message}`);
      }
    }
    jiraSummary = gapSummary({
      service: service.name,
      plan: outcome.plan,
      risk: outcome.risked.overall,
      req,
      mrUrl: mr.url,
      reportUrl: process.env.CI_JOB_URL ? `${process.env.CI_JOB_URL}/artifacts/file/qa-gap-report.md` : undefined,
      regressionTests: selection.runFullSuite ? undefined : selection.tests.length,
    });
    if (featureLine) jiraSummary += `\n\n${featureLine}`;
    // Only what this MR touches: old deviations elsewhere are for `contract-check`, not for every story.
    const touched = new Set(outcome.contract.changes.map((x) => x.endpoint));
    const mismatched = (outcome.contract.agreed ?? []).map((k) => ({ k, n: deviationsIn(k, touched).filter((d) => d.severity === "mismatch").length })).filter((x) => x.n);
    if (mismatched.length)
      jiraSummary += `\n\n**The code differs from the agreed API spec on endpoints this change touches:** ${mismatched.map((x) => `${x.k.service} (${x.n} mismatch${x.n === 1 ? "" : "es"})`).join(", ")}. Details in the gap report.`;
    // The story names services (tech notes) that have no change for it: not started, or commits without the key.
    const changedServices = parts ? parts.map((p) => p.service.name) : [service.name, ...featureServices];
    const silent = (req.servicesNamed ?? []).filter((n) => !changedServices.includes(n));
    if (silent.length) {
      const line = `**The story names ${silent.join(", ")}${o.story ? "" : " too"}, but no change for ${req.storyKey ?? "it"} was found there** (not started yet, or its commits and branch don't carry the story key).`;
      report = report.replace(footer, `${line}\n\n${footer}`);
      jiraSummary += `\n\n${line}`;
    }
    fs.writeFileSync(path.join(run.dir, "jira-summary.md"), jiraSummary);
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
      ...(outcome.contract.agreed?.length ? ["", contractCheckMarkdown(outcome.contract.agreed, new Set(outcome.contract.changes.map((x) => x.endpoint)))] : []),
      "",
      requirementsLine(req),
      "",
      footer,
    ].join("\n");
    manifest.outcome = `plan-${outcome.status}`;
    exitCode = 1;
    log.fail(`no valid plan: ${outcome.message ?? outcome.status}`);
  }
  if (previousHead) report = `${updatedLine(cs.head, previousHead)}\n\n${report}`;
  fs.writeFileSync(out, report);
  fs.writeFileSync(path.join(run.dir, "report.md"), report);
  writeManifest(run, manifest);
  log.ok(`report written to ${path.relative(cwd, out)}${u ? ` (${u})` : ""}`);

  if (o.post) await publish(c, { report, jiraSummary, service: service.name, storyKey: req.storyKey, mr, ...(!fp || exitCode !== 0 ? {} : { stamp: stampOf(fp, cs.head) }) });
  // Story mode with every part merged: requirements nothing builds (or builds differently) become (suspected) bugs.
  if (o.post && parts && parts.every((p) => p.merged) && c.bugs.mode !== "off" && req.storyKey && outcome.plan) {
    const jira = jiraContext(c.requirements.jira.baseUrl);
    if (jira) {
      const r = await fileBugs(jira, c, req.storyKey, bugsFromPlan(req.storyKey, requirementItems(req), outcome.plan)).catch((e) => (log.warn(`bugs: ${(e as Error).message}`), undefined));
      if (r?.created.length) log.ok(`bug(s) raised on ${req.storyKey}: ${r.created.join(", ")}`);
      if (r?.suggested) log.ok(`${r.suggested} bug(s) proposed on ${req.storyKey}`);
    }
  }
  return { report, skipped: false, exitCode };
}
