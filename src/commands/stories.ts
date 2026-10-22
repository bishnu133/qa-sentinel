import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../config.js";
import { log } from "../log.js";
import { type Assessment, assessStory, storiesMarkdown, storiesText } from "../stories/assess.js";
import { gatherFacts, inputsFromDir, inputsFromJira, jiraFor, sharedFacts, type StoryInput } from "../stories/gather.js";
import { jobPolicy } from "../stories/jobs.js";
import { type RecordStore, type StoryRecord, SAFE_KEY, emptyRecord } from "../stories/record.js";
import { openStore } from "../stories/start.js";
import { acHash } from "../expected/format.js";
import { gitlabContext } from "../scm/gitlab.js";
import { jiraContext, type JiraContext } from "../scm/jira.js";
import { jiraMode } from "../config.js";
import { notify } from "../reporting/notify.js";
import { pendingWiki } from "../reporting/pending.js";
import { refreshStaleness } from "../reporting/statusComment.js";
import { storyBasis } from "../stories/parts.js";
import { cloneServices } from "../stories/cloneServices.js";
import { sweepMrs, sweepSince, writeSweepState } from "../stories/sweep.js";
import { generateCommand, type GenerateOptions } from "./generate.js";
import { specCommand, type SpecOptions } from "./spec.js";
import { git } from "../git.js";
import { EXIT_LIMIT } from "../stories/start.js";

export interface StoriesOptions {
  cwd: string;
  /** Check these Jira stories instead of searching. */
  story?: string[];
  /** Read stories from markdown files in this folder instead of Jira. */
  storiesDir?: string;
  /** Print JSON (one object per story) instead of the table. */
  json?: boolean;
  /** Also list the stories that are left alone (opted out, not approved, not a feature). */
  all?: boolean;
  out?: string;
  /** Don't update the story records. */
  noRecord?: boolean;
  /** Don't look at merge requests first (automation.sweep.enabled: false does the same). */
  noSweep?: boolean;
  /** Fill the story records again from GitLab and Jira: the sweep looks back 365 days. */
  rebuild?: boolean;
  /** Start the AI steps that are due (expected behaviour, tests, end-to-end tests): at most automation.act.maxJobsPerCheck, each through the normal job keys, locks and budgets. */
  act?: boolean;
  /** With `act`: say what would be started and start nothing. */
  dryRun?: boolean;
  /** Clone the service repositories that are not here yet (workspace.services[].gitlabProject) before looking at the code: a CI job starts with the test repo only. */
  cloneServices?: boolean;
  /** The commands `act` runs (replaced in tests). */
  runners?: { spec: (o: SpecOptions) => Promise<number>; generate: (o: GenerateOptions) => Promise<number> };
  env?: NodeJS.ProcessEnv;
  now?: Date;
}

/** What `stories --act` does for one story: the command to run in-process. Undefined: nothing to start. */
export interface ActJob {
  key: string;
  what: "spec" | "generate";
  acs?: string[];
  describe: string;
}

export function actJobs(list: Assessment[], crossReady: Map<string, string[]>): ActJob[] {
  const out: ActJob[] = [];
  for (const a of list) {
    const t = a.todo[0];
    if (!t || t.who !== "ai" || t.blocked) continue;
    if (a.next === "spec") {
      // With merged code the story's generate run does the requirements pass itself and commits it on the story branch; before that the file can only be written locally.
      if (a.code === "merged" || a.code === "unknown") out.push({ key: a.key, what: "generate", describe: `generate --story ${a.key} --push --once (the expected behaviour first, then the tests, on the story branch)` });
      else out.push({ key: a.key, what: "spec", describe: `spec --story ${a.key} --once` });
    } else if (a.next === "generate") {
      const acs = a.state === "needs-cross-service-tests" ? crossReady.get(a.key) : undefined;
      out.push({ key: a.key, what: "generate", ...(acs?.length ? { acs } : {}), describe: `generate --story ${a.key}${acs?.length ? ` --acs ${acs.join(",")}` : ""} --push --once` });
    }
  }
  return out;
}

/**
 * Run the due jobs one after the other. A job that turns out to be nothing to do (the same work is done or running,
 * nothing is ready) does not use up `automation.act.maxJobsPerCheck`: only jobs that really started AI work count.
 * Exit code: 0 all done (or none), 1 if any failed, 4 if a limit (budget, too many failures) stopped one.
 */
async function act(o: StoriesOptions, c: ReturnType<typeof loadConfig>, cwd: string, jobs: ActJob[], env: NodeJS.ProcessEnv, recordKind: string): Promise<number> {
  const max = c.automation.act.maxJobsPerCheck;
  if (!jobs.length) {
    log.ok("nothing to start");
    return 0;
  }
  if (o.dryRun) {
    for (const j of jobs.slice(0, max)) log.info(`would start: qa-sentinel ${j.describe}`);
    if (jobs.length > max) log.info(`${jobs.length - max} more are due; at most ${max} start per check (automation.act.maxJobsPerCheck)`);
    return 0;
  }
  const runners = o.runners ?? { spec: specCommand, generate: generateCommand };
  if (recordKind !== "jira" && env.CI) log.warn("the story records are kept in files on this runner: cache the records folder between runs (when: always), or set automation.record: jira, or budgets and failure counts are lost after every check");
  // Where the check started: a branch name, or the commit in a detached checkout (CI). Every story starts from there.
  const home = (() => {
    try {
      return git(cwd, ["symbolic-ref", "-q", "--short", "HEAD"]);
    } catch {
      try {
        return git(cwd, ["rev-parse", "HEAD"]);
      } catch {
        return undefined;
      }
    }
  })();
  let failed = 0;
  let limited = 0;
  let started = 0;
  let skipped = 0;
  for (const j of jobs) {
    if (started >= max) break;
    log.step(`starting: qa-sentinel ${j.describe}`);
    let counted = false;
    const onStarted = () => {
      counted = true;
    };
    try {
      const code = j.what === "spec" ? await runners.spec({ cwd, story: j.key, once: true, onStarted }) : await runners.generate({ cwd, service: "", story: j.key, ...(j.acs ? { acs: j.acs } : {}), push: true, once: true, processEnv: env, onStarted });
      if (counted) started++;
      else skipped++;
      if (code === EXIT_LIMIT) limited++;
      else if (code !== 0) failed++;
      log[code === 0 ? "ok" : code === EXIT_LIMIT ? "warn" : "fail"](`${j.key}: ${code === 0 ? (counted ? "done" : "nothing to do") : code === EXIT_LIMIT ? "stopped by a limit (budget, or failed too often with these exact inputs)" : `exit ${code}`}`);
    } catch (e) {
      if (counted) started++;
      failed++;
      log.fail(`${j.key}: ${(e as Error).message.split("\n")[0]}`);
    }
    // A generate run leaves the test repo on the story's branch: back to where the check started, for the next story.
    if (home) {
      try {
        git(cwd, ["checkout", "-q", home]);
      } catch {
        /* leave it */
      }
    }
  }
  const left = jobs.length - started - skipped - failed - limited;
  if (started >= max && left > 0) log.warn(`${max} job(s) started (automation.act.maxJobsPerCheck); the rest wait for the next check.`);
  return failed ? 1 : limited ? EXIT_LIMIT : 0;
}


/** What changed in the ACs since the record was last written, in words. */
export function acChanges(prev: StoryRecord["acs"], now: { id: string; hash: string }[]): string[] {
  if (!prev.length) return [];
  const before = new Map(prev.map((a) => [a.id, a.hash]));
  const after = new Map(now.map((a) => [a.id, a.hash]));
  return [
    ...now.filter((a) => before.has(a.id) && before.get(a.id) !== a.hash).map((a) => `${a.id} changed since the last check`),
    ...now.filter((a) => !before.has(a.id)).map((a) => `${a.id} is new since the last check`),
    ...prev.filter((a) => !after.has(a.id)).map((a) => `${a.id} is gone since the last check`),
  ];
}

/** Store what this check saw, only when something differs (a scheduled check must not rewrite every story's record every time). */
async function remember(store: RecordStore, key: string, input: StoryInput, a: Assessment, acs: { id: string; hash: string }[], now: Date): Promise<{ before?: StoryRecord; after: StoryRecord } | undefined> {
  if (!SAFE_KEY.test(key)) return undefined;
  return store.locked(key, async () => {
    const existing = await store.load(key);
    const rec = existing ?? emptyRecord(key, now);
    const jira = input.source === "jira" ? { status: input.status, issueType: input.issueType, url: input.url, labels: input.labels, ...(rec.jira?.updated ? { updated: rec.jira.updated } : {}) } : rec.jira;
    const lastCheck = { at: now.toISOString(), state: a.state, next: a.next, reasons: a.reasons };
    const nextAcs = acs.length ? acs : rec.acs;
    const basis = rec.parts.length ? storyBasis(rec, nextAcs.map((x) => x.hash)) : rec.basis;
    const unchanged = JSON.stringify([rec.jira, rec.acs, rec.lastCheck && { ...rec.lastCheck, at: "" }, rec.basis]) === JSON.stringify([jira, acs, { ...lastCheck, at: "" }, basis]);
    if (unchanged) return { before: existing, after: rec };
    // The ACs are only replaced when the story was readable; an unreadable story keeps the last good copy.
    const next = { ...rec, jira, acs: nextAcs, lastCheck, ...(basis ? { basis } : {}), updatedAt: now.toISOString() };
    await store.save(next);
    return { before: existing, after: next };
  });
}

/**
 * After a check: the status comment is drawn again against the story's basis now (out-of-date marks, the pending
 * section), and people are told about a mismatch. No AI. Only when something that shows there changed, only an
 * existing status comment is edited, and only the token user's own.
 */
async function reportOnJira(c: ReturnType<typeof loadConfig>, jira: JiraContext, store: RecordStore, a: Assessment, seen: { before?: StoryRecord; after: StoryRecord }): Promise<void> {
  const { before, after } = seen;
  const facts = { jiraReady: a.jiraReady, jiraStatus: a.status, state: a.state };
  if (jiraMode(c) !== "legacy") {
    const pending = pendingWiki(after, facts);
    if (before?.basis !== after.basis || pending !== (before ? pendingWiki(before, facts) : null)) {
      try {
        const r = await refreshStaleness(jira, a.key, { basis: after.basis, rec: after, pending, visibility: c.reporting.jira.visibility });
        if (r === "updated") log.info(`${a.key}: status comment redrawn (out-of-date marks / waiting list)`);
      } catch (e) {
        log.warn(`${a.key}: status comment not refreshed: ${(e as Error).message.split("\n")[0]}`);
      }
    }
  }
  if (a.jiraReady)
    for (const [ac, e] of Object.entries(after.acEvidence))
      if (e.status === "not-found") await notify({ c, ctx: jira, store, story: a.key, event: "ac-not-built-but-ready", key: ac, text: `${ac} does not look built, but the story status is ${a.status ?? "ready"}. Please check it before it goes to testing.` });
}

/**
 * `qa-sentinel stories`: the background check. For each story (given, found by the Jira search, or read from
 * files) it works out where the story stands (expected behaviour, tests, QA tasks) and what comes next, with no AI
 * and no changes to the repo. A scheduled job can run it and act on `--json`; people read the table.
 */
export async function storiesCommand(o: StoriesOptions): Promise<number> {
  if (o.dryRun && !o.act) throw new Error("--dry-run goes with --act (it says what --act would start)");
  if (!o.json) return storiesRun(o);
  // JSON goes to stdout alone, so a pipeline can parse it; progress and warnings go to stderr.
  const out = console.log;
  console.log = console.error;
  try {
    return await storiesRun(o);
  } finally {
    console.log = out;
  }
}

async function storiesRun(o: StoriesOptions): Promise<number> {
  const cwd = path.resolve(o.cwd);
  const c = loadConfig(cwd);
  const env = o.env ?? process.env;
  const now = o.now ?? new Date();
  const store = openStore(cwd, c, env);
  const gitlab = gitlabContext(c.ci.gitlabUrl, env);
  if (o.cloneServices) {
    const r = cloneServices(c, cwd, env);
    if (r.cloned.length) log.step(`cloned ${r.cloned.join(", ")}`);
    r.failed.forEach((f) => log.warn(`could not clone ${f}`));
  }

  // First the merge requests: one paged call per repository (no clones, no AI). They fill the story records and tell which stories to look at.
  let touched: string[] = [];
  let sweepMark: string | undefined;
  if (!o.storiesDir && !o.noSweep && !o.noRecord && c.automation.sweep.enabled && gitlab && c.workspace.services.some((x) => x.gitlabProject)) {
    try {
      const since = sweepSince(cwd, c, now, { rebuild: o.rebuild });
      log.step(`looking at merge requests updated since ${since.slice(0, 16)}Z`);
      const sw = await sweepMrs(c, gitlab, jiraContext(c.requirements.jira.baseUrl, env), store, { since, now });
      touched = sw.touched;
      sw.notes.forEach((n) => log.warn(n));
      if (sw.noKey.length) log.warn(`MRs with no story key: ${sw.noKey.map((m) => `!${m.iid} ${m.service}`).join(", ")}`);
      // The check time moves only once the story check below has its stories (a run that stops with "Nothing to check" leaves it).
      // A listing cut by the page cap moves it only as far as the merge requests that were looked at.
      if (sw.complete) sweepMark = sw.truncated && sw.resumeAt ? sw.resumeAt : now.toISOString();
      if (store.kind === "jira") log.warn(`the merge request check time is kept in the local records folder on this runner (the records themselves are in Jira): cache that folder between runs, or each run looks back ${c.requirements.jira.search.mrLookbackDays} days`);
    } catch (e) {
      log.warn(`merge request sweep failed (${(e as Error).message.split("\n")[0]}); the story check goes on without it`);
    }
  }

  let inputs: StoryInput[];
  if (o.storiesDir) {
    const dir = path.resolve(cwd, o.storiesDir);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`--stories-dir ${o.storiesDir} is not a folder`);
    inputs = inputsFromDir(c, dir);
  } else if (o.story?.length || c.requirements.source === "jira") {
    const ctx = jiraFor(c, env);
    log.step(o.story?.length ? `checking ${o.story.join(", ")} in Jira` : "searching Jira for stories (requirements.jira.search)");
    inputs = await inputsFromJira(c, ctx, { keys: o.story });
    // Stories whose merge requests changed since the last check are looked at even when the search did not list them.
    const more = o.story?.length ? [] : touched.filter((k) => !inputs.some((x) => x.key.toLowerCase() === k.toLowerCase()));
    // One key at a time: a card that cannot be read leaves the others alone.
    for (const k of more) {
      try {
        inputs.push(...(await inputsFromJira(c, ctx, { keys: [k] })).filter((x) => !inputs.some((y) => y.key === x.key)));
      } catch (e) {
        log.warn(`${k} (from a merge request) not read: ${(e as Error).message.split("\n")[0]}`);
      }
    }
  } else throw new Error('Nothing to check: set requirements.source: jira (and the Jira settings), pass --story KEY, or pass --stories-dir <folder> to read story files.');
  if (sweepMark) writeSweepState(cwd, { lastAt: sweepMark });
  if (!inputs.length) {
    log.ok("no stories found");
    return 0;
  }

  const records = await store.list();
  const shared = sharedFacts(cwd, c);
  const policy = jobPolicy(c, {}, env);
  // Jira for the stories' own comments: the /qa ready overrides are read and the status comment is kept current. Not with story files.
  const jira = o.storiesDir ? undefined : jiraContext(c.requirements.jira.baseUrl, env);
  const list: Assessment[] = [];
  const changes = new Map<string, string[]>();
  const crossReady = new Map<string, string[]>();
  const overridesOf = new Map<string, StoryRecord["overrides"]>();
  for (const input of inputs) {
    const facts = await gatherFacts({ cwd, c, store, policy, budgets: c.automation.budgets, records, gitlab, now, env, jira, noRecord: o.noRecord }, input, shared);
    const a = { ...assessStory(facts), ...(facts.jiraReady !== undefined ? { jiraReady: facts.jiraReady } : {}), ...(facts.services ? { services: facts.services } : {}), ...(facts.unmappedComponents ? { unmappedComponents: facts.unmappedComponents } : {}), ...(facts.resolvedFrom ? { resolvedFrom: facts.resolvedFrom } : {}), ...(facts.writeReadiness ? { writeReadiness: facts.writeReadiness } : {}) };
    list.push(a);
    if (facts.crossReady?.length) crossReady.set(a.key, facts.crossReady);
    const acs = facts.acs.map((x) => ({ id: x.id, hash: acHash(x.text) }));
    if (a.state !== "skipped") {
      changes.set(a.key, acChanges(records.find((r) => r.key === a.key)?.acs ?? [], acs));
      if (!o.noRecord) {
        const seen = await remember(store, a.key, input, a, acs, now).catch((e) => (log.warn(`story record for ${a.key} not updated: ${(e as Error).message}`), undefined));
        if (seen) overridesOf.set(a.key, seen.after.overrides);
        // "Before" is the record as it was when this check began: the overrides are already saved by now, and a change in them must redraw the comment.
        if (seen && jira) await reportOnJira(c, jira, store, a, { before: records.find((r) => r.key === a.key), after: seen.after });
      }
    }
  }
  const shown = o.all ? list : list.filter((a) => a.state !== "skipped");
  const hidden = list.length - shown.length;
  const md = storiesMarkdown(shown, now);
  const outFile = path.resolve(cwd, o.out ?? "qa-stories.md");
  fs.writeFileSync(outFile, md + "\n");
  if (o.json) {
    process.stdout.write(JSON.stringify(shown.map((a) => ({ ...a, changes: changes.get(a.key) ?? [], overrides: overridesOf.get(a.key) ?? [] })), null, 2) + "\n");
    return o.act ? act(o, c, cwd, actJobs(list, crossReady), env, store.kind) : 0;
  }
  log.title(`Stories: ${list.length} looked at${hidden ? `, ${hidden} left alone (--all lists them)` : ""}`);
  if (shown.length) log.info(storiesText(shown, changes));
  const count = (s: Assessment["state"]) => list.filter((a) => a.state === s).length;
  log.info(`\n${count("covered")} covered · ${count("needs-expectations")} need expected behaviour · ${count("needs-tests")} need tests · ${count("needs-cross-service-tests")} need end-to-end tests · ${count("needs-triage")} need QA triage · ${count("needs-attention")} need attention`);
  log.dim(`written to ${path.relative(cwd, outFile)}${store.kind === "jira" || o.noRecord ? "" : `; story records in ${store.where}`}`);
  return o.act ? act(o, c, cwd, actJobs(list, crossReady), env, store.kind) : 0;
}
