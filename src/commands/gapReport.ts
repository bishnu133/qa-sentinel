import { type ExpectedFile, expectedPath, readExpected } from "../expected/format.js";
import { expectedDirOf } from "../expected/lock.js";
import { readManualCards } from "../manualTests.js";
import { requirementItems } from "../requirements.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../config.js";
import { changeSet, commitMessages, ensureAtCommit, git, isGitRepo } from "../git.js";
import { matchesAny } from "../fsutil.js";
import { formatUsage } from "../claude.js";
import { ARTIFACT_GLOBS, createRunDir, findService, startManifest, writeManifest } from "../run.js";
import { checkServiceUntouched, diffSnapshots, findingsMarkdown, snapshotTree, type Finding } from "../guardrails.js";
import { extractStoryKeys, jiraKeyPattern, requirementsLine, resolveRequirements, skippedBranch, storyMarkdown } from "../requirements.js";
import { type IssueCache, type KeyResolution, resolveKeysCached } from "../stories/resolve.js";
import { getMrNoteBody, gitlabContext, gitlabMrFromEnv, mrIsDraft, upsertMrNote } from "../scm/gitlab.js";
import { gapFingerprint, parseStamp, relevantDiffDigest, stampOf, updatedLine } from "../plan/fingerprint.js";
import { assembleFeature, type MrScanCache } from "../feature/manifest.js";
import { publish } from "../reporting/publish.js";
import { engineFor } from "../engines/ClaudeCodeEngine.js";
import type { AgentEngine } from "../engines/AgentEngine.js";
import { openStore, withSpend } from "../stories/start.js";
import { recordMrSeen } from "../stories/sweep.js";
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
import { deferInNewRun, deferSteps } from "../reporting/deferred.js";
import type { Config, ServiceConfig } from "../config.js";
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
  /** Internal, for a merge request that names several stories: the key to resolve (a bug or task key, or the story's own), the feature it belongs to, and whether this run may write the MR comment. */
  forKey?: string;
  forFeature?: string;
  noMrNote?: boolean;
  /** Internal: facts about the keys the MR names that the report should say (a key that is not in Jira, stories left out). */
  notes?: string[];
  /** Internal: what the first look at the keys already learned (cards and their features), so the cards are not read from Jira again. */
  resolved?: KeyResolution[];
  /** Internal: the Jira reads and the recent-MR scans of this run, shared by the reports of one merge request. */
  issueCache?: IssueCache;
  scanCache?: MrScanCache;
  /**
   * Do not publish: write what would be published to publish.json in the run folder (qa-sentinel publish does it, with
   * write tokens and no model key). Implies --post.
   */
  deferPublish?: boolean;
}

/** `reason`: why nothing was run (a budget or limit stopped it). */
type GapResult = { report: string; skipped: boolean; exitCode: number; reason?: string };

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
  if (o.deferPublish) o = { ...o, post: true };
  // A draft is still changing: this comes first, so it costs nothing (no Jira read) and covers every story the merge request names.
  const waiting = await draftGate(o, c, cwd);
  if (waiting) return waiting;
  // A merge request that names several stories gets one report for each (requirements.multiKey).
  const named = await storiesNamedByMr(o, c);
  if (named && named.items.length > 1) return gapReportEach(o, c, cwd, named);
  if (named?.items.length === 1) o = { ...o, forKey: named.items[0].work, forFeature: named.items[0].feature, resolved: named.items[0].resolved, issueCache: named.cache, notes: [...(o.notes ?? []), ...named.notes] };
  // The checks that need no AI come first, so an unchanged push costs nothing and never trips a budget.
  const pre = await gapReportPrepare(o, c, cwd);
  if (pre.done) return pre.done;
  return runPrepared(o, c, cwd, pre.s!);
}

/** The AI part of one report, counted against the story's budget. */
function runPrepared(o: GapReportOptions, c: ReturnType<typeof loadConfig>, cwd: string, s: Prepared): Promise<GapResult> {
  return withSpend(
    { cwd, c, story: o.story ?? o.forFeature, label: "gap-report", skip: o.dryRun, local: o.deferPublish },
    (exitCode, message) => ({ report: "", skipped: true, exitCode, ...(message ? { reason: message } : {}) }),
    (wrap) => gapReportBody(o, wrap, s),
    (r) => r.exitCode,
  );
}

interface NamedStories {
  /** `resolved`: every card of the merge request that leads to this feature (the first is the one the report resolves; the others are shown as work cards). */
  items: { work: string; feature: string; explain: string; resolved: KeyResolution[] }[];
  /** Keys that are not in Jira, stories left out because of the limit, cards that could not be read. */
  notes: string[];
  cache: IssueCache;
}

/**
 * The stories a merge request names (title, source branch, description), each resolved to its feature, when it names
 * more than one key. Undefined when there is nothing to decide: story mode, a story file, no Jira, or fewer than two keys.
 */
async function storiesNamedByMr(o: GapReportOptions, c: ReturnType<typeof loadConfig>): Promise<NamedStories | undefined> {
  if (o.story || o.storyFile || o.forKey || c.requirements.source !== "jira") return undefined;
  const jctx = jiraContext(c.requirements.jira);
  if (!jctx) return undefined;
  const mr = gitlabMrFromEnv();
  const keys = extractStoryKeys(jiraKeyPattern(c), mr.title, mr.sourceBranch, mr.description);
  if (keys.length < 2) return undefined;
  const notes: string[] = [];
  const items: NamedStories["items"] = [];
  const cache: IssueCache = new Map();
  for (const r of await resolveKeysCached(c, jctx, c.requirements.multiKey === "first" ? keys.slice(0, 1) : keys, { hasCode: true, cache })) {
    if (r.via === "not-found" || r.via === "error") {
      notes.push(r.explain);
      continue;
    }
    // A card that is attached to no feature (or to two) is analysed under its own key; two cards of one feature are one story.
    const feature = r.feature ?? r.work;
    const same = items.find((x) => x.feature.toLowerCase() === feature.toLowerCase());
    if (same) same.resolved.push(r);
    else items.push({ work: r.work, feature, explain: r.via === "self" ? `${feature}` : r.explain, resolved: [r] });
  }
  const max = c.requirements.maxKeysPerMr;
  if (items.length > max) {
    notes.push(`This merge request names ${items.length} stories; only the first ${max} are analysed (requirements.maxKeysPerMr): left out ${items.slice(max).map((x) => x.feature).join(", ")}`);
    items.length = max;
  }
  return { items, notes, cache };
}

/** A draft merge request gets a waiting note instead of a report (automation.gapReport.when: ready). Written to the report file too, so the job's artifact is never missing. */
async function draftGate(o: GapReportOptions, c: ReturnType<typeof loadConfig>, cwd: string): Promise<GapResult | undefined> {
  const mr = gitlabMrFromEnv();
  if (o.story || o.evenIfDraft || o.dryRun || c.automation.gapReport.when !== "ready" || !mr.mrIid) return undefined;
  if (!(await mrIsDraft(gitlabContext(c.ci.gitlabUrl), mr.project, mr.mrIid, mr.title))) return undefined;
  const out = path.resolve(cwd, o.out ?? "qa-gap-report.md");
  const report = `### QA impact · waiting\n**Verdict:** this merge request is a draft. The gap report is made once it is marked ready for review (automation.gapReport.when: ready; --even-if-draft overrides).\n`;
  fs.writeFileSync(out, report);
  // Say so on the MR: marking it ready does not start a pipeline by itself, and nobody should think a report exists.
  if (o.deferPublish && o.post && c.reporting.targets.includes("gitlab-mr") && mr.project) {
    deferInNewRun(cwd, "gap-report", "gap-waiting", [{ type: "report", report, service: o.service, targets: ["gitlab-mr"] }]);
    log.ok("merge request is a draft; the waiting note is left for `qa-sentinel publish`");
    return { report, skipped: true, exitCode: 0 };
  }
  const gl = o.post && c.reporting.targets.includes("gitlab-mr") ? gitlabContext(c.ci.gitlabUrl) : undefined;
  if (gl && mr.project) await upsertMrNote(gl, mr.project, mr.mrIid, report).catch((e) => log.warn(`could not post the waiting note: ${(e as Error).message}`));
  log.ok("merge request is a draft; the gap report waits until it is ready for review");
  return { report, skipped: true, exitCode: 0 };
}

/** The stamp of the report already on the merge request, when this run may compare with it (a real post to GitLab, no --refresh). */
async function lastStamp(c: ReturnType<typeof loadConfig>, o: GapReportOptions, mr: ReturnType<typeof gitlabMrFromEnv>): Promise<{ fp: string; head: string } | undefined> {
  if (o.noMrNote || !o.post || o.dryRun || o.refresh || !c.reporting.targets.includes("gitlab-mr") || !mr.project || !mr.mrIid) return undefined;
  const gl = gitlabContext(c.ci.gitlabUrl);
  return gl ? parseStamp(await getMrNoteBody(gl, mr.project, mr.mrIid).catch(() => undefined)) : undefined;
}

/** The risk settings and the team's history file: a change in either can change the report, so it counts for "unchanged". (Flaky runs do not: they are not kept in CI.) */
export const riskInputs = (c: Config, cwd: string): string => {
  let hist = "";
  try {
    hist = fs.readFileSync(path.join(cwd, c.knowledge.dir, c.risk.history.file), "utf8");
  } catch {
    // no history file
  }
  return JSON.stringify(c.risk) + "\u0003" + hist;
};

const unchangedReport = (head: string) =>
  `### QA impact · unchanged\n**Verdict:** nothing the gap report depends on changed since the report for ${head.slice(0, 8)} (the diff of the relevant files, the acceptance criteria, the expected behaviour, the scope, the risk settings and the history file are the same). The comment on the merge request still stands; --refresh makes a new one.\n`;

/**
 * One gap report per story the merge request names, joined in one MR comment. Each report is posted to its own story
 * in Jira, and its cost is counted on that story. Like a one-story report, the joined comment carries a stamp (a digest
 * of every story's fingerprint), so a push that changes nothing the reports depend on costs no AI run.
 */
async function gapReportEach(o: GapReportOptions, c: ReturnType<typeof loadConfig>, cwd: string, named: NamedStories): Promise<GapResult> {
  const out = path.resolve(cwd, o.out ?? "qa-gap-report.md");
  const mr = gitlabMrFromEnv();
  const scanCache: MrScanCache = new Map();
  const kids = named.items.map((it, i) => {
    const dir = path.join(cwd, ".qa-sentinel", "gap", it.feature.toUpperCase().replace(/[^A-Z0-9-]/g, "-"));
    fs.mkdirSync(dir, { recursive: true });
    // A selection left by an earlier run must never be read as this run's.
    fs.rmSync(path.join(dir, "qa-regression.txt"), { force: true });
    const opts: GapReportOptions = { ...o, out: path.join(dir, "qa-gap-report.md"), forKey: it.work, forFeature: it.feature, resolved: it.resolved, issueCache: named.cache, scanCache, noMrNote: true, notes: i === 0 ? named.notes : undefined };
    return { it, dir, opts, pre: undefined as Prepared | undefined, error: undefined as string | undefined };
  });

  // The free checks of every story first: one fingerprint for the whole merge request, compared before any AI run.
  for (const k of kids) {
    try {
      const p = await gapReportPrepare(k.opts, c, cwd);
      if (p.done) {
        // Nothing to analyse (no test-relevant change, a bot branch): the same for every story.
        fs.writeFileSync(out, p.done.report);
        return p.done;
      }
      k.pre = p.s;
    } catch (e) {
      k.error = (e as Error).message;
    }
  }
  const head = kids.find((k) => k.pre)?.pre?.cs.head;
  const combined = kids.every((k) => k.pre?.fp) ? crypto.createHash("sha256").update(kids.map((k) => `${k.it.feature.toUpperCase()}:${k.pre!.fp}`).sort().join("\n")).digest("hex").slice(0, 16) : undefined;
  let previousHead: string | undefined;
  if (combined) {
    const last = await lastStamp(c, o, mr);
    if (last?.fp === combined) {
      const report = unchangedReport(last.head);
      fs.writeFileSync(out, report);
      log.ok(`nothing changed since the report for ${last.head.slice(0, 8)}; no new gap reports`);
      return { report, skipped: true, exitCode: 0 };
    }
    previousHead = last?.head;
  }

  const sections: string[] = [];
  const selections: (string[] | "all")[] = [];
  let exitCode = 0;
  let skipped = true;
  let allOk = true;
  for (const [i, k] of kids.entries()) {
    const heading = `#### Story ${k.it.feature}${k.it.work !== k.it.feature ? ` · ${k.it.explain}` : ""}`;
    let r: GapResult | undefined;
    let why = k.error;
    if (!why) {
      log.step(`merge request names ${kids.length} stories: report ${i + 1} for ${k.it.feature}${k.it.work !== k.it.feature ? ` (via ${k.it.work})` : ""}`);
      try {
        r = await runPrepared(k.opts, c, cwd, k.pre!);
        if (!r.report.trim() && !o.dryRun) why = r.reason ?? (r.exitCode ? `the run stopped (exit ${r.exitCode})` : "no report was made");
      } catch (e) {
        why = (e as Error).message;
      }
    }
    if (why) {
      why = why.split("\n")[0].slice(0, 300);
      log.warn(`${k.it.feature} not analysed: ${why}`);
      sections.push(`${heading}\n\n> ⚠️ not analysed: ${why}`);
      exitCode = Math.max(exitCode, r?.exitCode || 1);
      allOk = false;
      skipped = false;
    } else {
      sections.push(`${heading}\n\n${r!.report.trim()}`);
      exitCode = Math.max(exitCode, r!.exitCode);
      skipped = skipped && r!.skipped;
      if (r!.exitCode !== 0) allOk = false;
    }
    try {
      const txt = fs.readFileSync(path.join(k.dir, "qa-regression.txt"), "utf8");
      selections.push(txt.trim() ? txt.split("\n").filter(Boolean) : "all");
    } catch {
      // This story had test-relevant changes but made no valid selection: its tests are unknown, so the whole suite runs.
      selections.push("all");
    }
  }
  const body = [`### QA impact · ${kids.length} stories in this merge request`, ...named.notes.map((n) => `\n> ⚠️ ${n}`), "", sections.join("\n\n---\n\n"), ""].join("\n");
  const report = previousHead && head ? `${updatedLine(head, previousHead)}\n\n${body}` : body;
  fs.writeFileSync(out, report);
  if (!o.dryRun) fs.writeFileSync(path.join(path.dirname(out), "qa-regression.txt"), selections.includes("all") ? "" : [...new Set(selections.flat())].join("\n") + "\n");
  // The stamp goes on only when every story was analysed: a failed or refused one must be tried again on the next push.
  if (o.post && !o.dryRun && c.reporting.targets.includes("gitlab-mr")) {
    const stamp = allOk && combined && head ? stampOf(combined, head) : undefined;
    if (o.deferPublish) deferInNewRun(cwd, "gap-report", "gap-joined", [{ type: "report", report, service: o.service, targets: ["gitlab-mr"], ...(stamp ? { stamp } : {}) }]);
    else await publish(c, { report, service: o.service, mr, targets: ["gitlab-mr"], ...(stamp ? { stamp } : {}) });
  }
  return { report, skipped, exitCode };
}

async function gapReportPrepare(o: GapReportOptions, c: ReturnType<typeof loadConfig>, cwd: string): Promise<{ done?: GapResult; s?: Prepared }> {
  const mr = gitlabMrFromEnv();
  let service: ServiceConfig, repo: string, cs: ChangeSet, relevant: string[];
  let parts: StoryPart[] | undefined;
  if (o.story) {
    const record = await openStore(cwd, c).load(o.story).catch(() => undefined);
    const sp = await storyParts({ c, cwd, story: o.story, gitlab: c.workspace.services.some((x) => x.gitlabProject) ? gitlabContext(c.ci.gitlabUrl) : undefined, record });
    sp.notes.forEach((n) => log.warn(n));
    if (!sp.parts.length) throw new Error(`No service changes found for ${o.story}: no branch or commit message mentions it in the service repos`);
    parts = sp.parts;
    for (const p of parts) for (const h of p.heads) atLeast(p.repo, h, Boolean(o.checkout), cwd);
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
    hasCode: true,
    ...(o.forKey ? { storyKey: o.forKey } : {}),
    ...(o.resolved ? { resolved: o.resolved } : {}),
    ...(o.issueCache ? { cache: o.issueCache } : {}),
  });
  if (o.notes?.length) req.resolveNote = [req.resolveNote, ...o.notes].filter(Boolean).join("; ");
  // One comment per MR, refreshed only when the code that matters (or the ACs, the expected behaviour, the scope) changed since the report on it.
  let fp: string | undefined;
  let previousHead: string | undefined;
  if (!o.story) {
    const range = `${cs.base}...${cs.head}`;
    const digest = relevantDiffDigest((f) => { try { return git(repo, ["-c", "core.quotePath=false", "diff", "--relative", "--binary", "--full-index", range, "--", f]); } catch { return ""; } }, relevant);
    let expectedText = "";
    if (req.storyKey) try { expectedText = fs.readFileSync(path.join(cwd, expectedPath(expectedDirOf(c.tests.expectedDir), req.storyKey.toUpperCase())), "utf8"); } catch { /* none yet */ }
    fp = gapFingerprint(digest, req.acceptanceCriteria.map((a) => `${a.id}:${acHash(a.text)}`), [expectedText, JSON.stringify(req.scopeItems ?? []), JSON.stringify(req.outOfScope ?? []), riskInputs(c, cwd)]);
  }
  if (fp) {
    const last = await lastStamp(c, o, mr);
    if (last?.fp === fp) {
      const report = unchangedReport(last.head);
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
    const select = (svc: string) => selectRegression({ c, service: svc, plan: outcome.plan!, risked: outcome.risked!.changes, changeKinds: outcome.risked!.changeKinds, contract: outcome.contract, index, map: readTestMap(cwd) });
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
        const m = await assembleFeature({ c, cwd, story: req.storyKey, gitlab: c.workspace.services.some((x) => x.gitlabProject) ? gitlabContext(c.ci.gitlabUrl) : undefined, scanCache: o.scanCache });
        const others = m.parts.filter((p) => p.service !== service.name);
        featureServices.push(...new Set(others.map((p) => p.service)));
        if (others.length) {
          featureLine = `**Feature ${req.storyKey} also changes:** ${others.map((p) => `${p.service} (${p.mr ? `[!${p.mr.iid}](${p.mr.url}), ` : ""}${p.merged ? "merged" : "not merged yet"})`).join(", ")}. Acceptance criteria that need several services are checked with \`qa-sentinel feature ${req.storyKey}\` once every part is deployed.`;
          report = report.replace(footer, `${featureLine}\n\n${footer}`);
        }
        // Facts about the lookup itself (a scan that was cut off) change how far "also changes" can be trusted.
        if (m.notes.length) report = report.replace(footer, `${m.notes.map((n) => `> ℹ️ ${n}`).join("\n")}\n\n${footer}`);
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
  const hotBranch = [mr.sourceBranch, mr.targetBranch].find((b) => b && matchesAny(b, c.ci.hotfixBranches));
  if (hotBranch) report = `> 🩹 **Hotfix or release branch** (\`${hotBranch}\` matches ci.hotfixBranches). If this is a hotfix: tests are written once, when the change reaches \`${c.ci.targetBranch}\` by cherry-pick. Until then, run the regression selection below against the hotfix environment. \`qa-sentinel hotfix --service ${service.name} --commit <sha>\` shows where the cherry-pick stands.\n\n${report}`;
  fs.writeFileSync(out, report);
  fs.writeFileSync(path.join(run.dir, "report.md"), report);
  writeManifest(run, manifest);
  log.ok(`report written to ${path.relative(cwd, out)}${u ? ` (${u})` : ""}`);

  // The record keeps the merge request from the moment it is first seen, so later steps know it without a key in a commit message.
  const seen = !o.dryRun && !o.story && req.storyKey && mr.mrIid ? { feature: req.storyKey, workKey: req.workKey, service: service.name, mrIid: mr.mrIid, url: mr.url, title: mr.title, branch: mr.sourceBranch, headSha: process.env.CI_MERGE_REQUEST_SOURCE_BRANCH_SHA ?? cs.head, keys: extractStoryKeys(jiraKeyPattern(c), mr.title, mr.sourceBranch, mr.description) } : undefined;
  const postTargets = o.noMrNote ? c.reporting.targets.filter((t) => t !== "gitlab-mr") : undefined;
  const stampNow = !fp || exitCode !== 0 ? undefined : stampOf(fp, cs.head);
  // Story mode with every part merged: requirements nothing builds (or builds differently) become (suspected) bugs.
  const bugCandidates = o.post && parts && parts.every((p) => p.merged) && c.bugs.mode !== "off" && req.storyKey && outcome.plan ? bugsFromPlan(req.storyKey, requirementItems(req), outcome.plan) : undefined;
  if (o.deferPublish && o.post) {
    // The write steps wait for `qa-sentinel publish` (write tokens, no model key); this run needs none of them.
    deferSteps(run.dir, "gap-report", run.id, [
      ...(seen ? [{ type: "mr-seen" as const, args: { feature: seen.feature, ...(seen.workKey ? { workKey: seen.workKey } : {}), service: seen.service, ...(seen.headSha ? { headSha: seen.headSha } : {}), keys: seen.keys } }] : []),
      { type: "report" as const, report, jiraSummary, service: service.name, ...(req.storyKey ? { storyKey: req.storyKey } : {}), ...(postTargets ? { targets: postTargets } : {}), ...(stampNow ? { stamp: stampNow } : {}) },
      ...(bugCandidates && req.storyKey ? [{ type: "bugs" as const, story: req.storyKey, candidates: JSON.parse(JSON.stringify(bugCandidates)) as Record<string, unknown>[] }] : []),
    ]);
    log.ok(`publishing deferred: ${path.relative(cwd, path.join(run.dir, "publish.json"))} (run \`qa-sentinel publish --run ${run.id}\`)`);
    return { report, skipped: false, exitCode };
  }
  if (seen) await recordMrSeen(openStore(cwd, c), seen).catch((e) => log.warn(`story record: merge request not recorded (${(e as Error).message.split("\n")[0]})`));
  // A merge request that names several stories gets one joined comment (written by gapReportEach); each story still gets its own Jira section here.
  if (o.post) await publish(c, { report, jiraSummary, cwd, service: service.name, storyKey: req.storyKey, mr, ...(postTargets ? { targets: postTargets } : {}), ...(stampNow ? { stamp: stampNow } : {}) });
  if (bugCandidates && req.storyKey) {
    const jira = jiraContext(c.requirements.jira);
    if (jira) {
      const r = await fileBugs(jira, c, req.storyKey, bugCandidates, cwd).catch((e) => (log.warn(`bugs: ${(e as Error).message}`), undefined));
      if (r?.created.length) log.ok(`bug(s) raised on ${req.storyKey}: ${r.created.join(", ")}`);
      if (r?.suggested) log.ok(`${r.suggested} bug(s) proposed on ${req.storyKey}`);
    }
  }
  return { report, skipped: false, exitCode };
}
