import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { loadConfig, type Config } from "../config.js";
import { findingsMarkdown, violations } from "../guardrails.js";
import { markMrOpened, patchManifest } from "../run.js";
import { getAll, gitlabContext, mergeRequestsForCommit } from "../scm/gitlab.js";
import { scmFor } from "../scm/provider.js";
import { fetchIssue, jiraContext } from "../scm/jira.js";
import { resolveFeature } from "../stories/resolve.js";
import { remoteFor, redact, storyBranchName } from "../generation/storyBranch.js";
import { publish } from "../reporting/publish.js";
import { generationSummary } from "../reporting/jiraSummary.js";
import { notifyStoryOutcome } from "../reporting/notify.js";
import { BUNDLE_FILE, PUBLISHED_FILE, PUBLISH_FILE, parsePublishFile, type BranchNoteStep, type MergeRequestStep, type PublishFile } from "../reporting/deferred.js";
import { recordMrSeen } from "../stories/sweep.js";
import { openStore } from "../stories/start.js";
import { fileBugs, type BugCandidate } from "../bugs/bugs.js";
import { applyRecordPatch, conflictKey, recordAgentMr, showConflict } from "./generate.js";
import { bundleFindings } from "./bundlePolicy.js";
import { log } from "../log.js";
import { assertNoLinks, readFileNoFollow, writeFileNoFollow } from "../noLinks.js";

/**
 * `qa-sentinel publish`: do the writing that `gap-report --defer-publish` and `generate --defer-publish` left in a run
 * folder (publish.json, branch.bundle). It uses the GitLab write token and the Jira publishing login, and no model
 * credentials: it never starts an agent. This is the second half of the split CI jobs (README, "Split CI jobs").
 *
 * The run folder comes from the analysis job, which runs generated code: it is treated as untrusted data. Where this
 * job writes (project, merge request, target branch, remote), which commits the policy looks at, and which branch may be
 * pushed all come from this job's own configuration, CI variables and the server, never from the run folder.
 */

export type PublishTarget = "gitlab-mr" | "jira" | "mr-create";

export interface PublishOptions {
  cwd: string;
  /** A run id (folder name in .qa-sentinel/runs), a folder, or "all" (default): every run with a publish.json that is not finished. */
  run?: string;
  target?: PublishTarget;
  /** Which job's files this publish accepts: a gap-report job's run folder may only hold gap-report steps, a generate job's only generate steps. */
  kind?: PublishFile["kind"];
  /** The environment (tokens, CI variables). Default: the process environment. Tests pass their own. */
  env?: NodeJS.ProcessEnv;
}

const MODEL_VARS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX"];
const LOCK_FILE = "publish.lock";
const LOCK_STALE_MS = 2 * 60 * 60 * 1000;

interface State {
  version: 1;
  /** One entry per finished part: `<step>`, `<step>:<target>`, `<step>:mr`, `<step>:post`. */
  done: Record<string, { at: string; note?: string }>;
  mr?: { url: string; iid: number };
  complete?: boolean;
}

function readState(dir: string): State {
  try {
    const s = JSON.parse(readFileNoFollow(path.join(dir, PUBLISHED_FILE))) as State;
    if (s && typeof s === "object" && s.done && typeof s.done === "object") return { version: 1, done: s.done, ...(s.mr ? { mr: s.mr } : {}), ...(s.complete ? { complete: true } : {}) };
  } catch {
    /* none yet */
  }
  return { version: 1, done: {} };
}
const writeState = (dir: string, s: State) => writeFileNoFollow(path.join(dir, PUBLISHED_FILE), JSON.stringify(s, null, 2) + "\n");

function runDirs(cwd: string, run: string | undefined): { dirs: string[]; explicit: boolean } {
  const root = path.join(cwd, ".qa-sentinel", "runs");
  // A link on the way to the run folders would lead the reads and writes below somewhere else.
  for (const p of [path.join(cwd, ".qa-sentinel"), root]) {
    let st: fs.Stats | undefined;
    try {
      st = fs.lstatSync(p);
    } catch {
      /* not there: no runs */
    }
    if (st?.isSymbolicLink()) throw new Error(`${path.relative(cwd, p)} is a symbolic link; refused`);
  }
  if (run && run !== "all") {
    const asPath = path.resolve(cwd, run);
    const dir = fs.existsSync(path.join(asPath, PUBLISH_FILE)) ? asPath : path.join(root, run);
    if (!fs.existsSync(path.join(dir, PUBLISH_FILE))) throw new Error(`no ${PUBLISH_FILE} in ${path.relative(cwd, dir) || dir}: it must be a run made with --defer-publish`);
    return { dirs: [dir], explicit: true };
  }
  let names: string[] = [];
  try {
    names = fs.readdirSync(root).sort();
  } catch {
    /* no runs */
  }
  return { dirs: names.map((n) => path.join(root, n)).filter((d) => fs.existsSync(path.join(d, PUBLISH_FILE)) && !readState(d).complete), explicit: false };
}

/**
 * Claim a run for this process (the lock file is created exclusively, so two publishes of one folder cannot both start).
 * A lock older than two hours is taken over by renaming it to a name only this process uses: of two processes that find the
 * same stale lock, only one rename succeeds, and the other starts over and finds the winner's fresh lock. A process that renamed a lock
 * which turned out to be fresh puts it back. A small window remains (the fresh lock is missing for the moment between rename and link);
 * publishes are scheduled per merge request (resource_group), so two publishes of one run folder are not expected in practice.
 */
function claim(dir: string): (() => void) | undefined {
  const file = path.join(dir, LOCK_FILE);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.writeFileSync(file, `${process.pid} ${new Date().toISOString()}\n`, { flag: "wx" });
      return () => fs.rmSync(file, { force: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      let old = false;
      try {
        old = Date.now() - fs.statSync(file).mtimeMs > LOCK_STALE_MS;
      } catch {
        continue; // gone meanwhile: try again
      }
      if (!old) return undefined;
      const mine = `${file}.stale-${process.pid}-${Date.now()}`;
      try {
        fs.renameSync(file, mine);
        // What was renamed may not be the lock that was seen to be old: another process may have taken the old one over and made a fresh one in between.
        // If it is fresh, put it back (link fails when a newer lock already exists, then that one is the live one) and leave this run alone.
        if (Date.now() - fs.statSync(mine).mtimeMs <= LOCK_STALE_MS) {
          try {
            fs.linkSync(mine, file);
          } catch {
            /* a lock exists again: it is the live one */
          }
          fs.rmSync(mine, { force: true });
          return undefined;
        }
        fs.rmSync(mine, { force: true });
      } catch {
        /* another process took it over first */
      }
    }
  }
  return undefined;
}

/** The Jira login used for writing: the QA_JIRA_PUBLISH_* variables when any is set (and then only those), else the job's own JIRA_* login. */
export function publishEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { QA_JIRA_PUBLISH_PAT: pat, QA_JIRA_PUBLISH_EMAIL: email, QA_JIRA_PUBLISH_API_TOKEN: token } = env;
  if (!pat && !email && !token) return env;
  const out = { ...env };
  delete out.JIRA_PAT;
  delete out.JIRA_EMAIL;
  delete out.JIRA_API_TOKEN;
  if (pat) out.JIRA_PAT = pat;
  if (email) out.JIRA_EMAIL = email;
  if (token) out.JIRA_API_TOKEN = token;
  return out;
}

export async function publishCommand(o: PublishOptions): Promise<number> {
  const cwd = path.resolve(o.cwd);
  const c = loadConfig(cwd);
  const env = publishEnv(o.env ?? process.env);
  const held = MODEL_VARS.filter((k) => env[k]);
  if (held.length) log.warn(`this job holds model credentials (${held.join(", ")}) that publishing never uses. In the split CI jobs they belong to the analysis job only (README, "Split CI jobs").`);
  const { dirs, explicit } = runDirs(cwd, o.run);
  if (!dirs.length) {
    log.ok("nothing to publish: no run with a publish.json that is still waiting");
    return 0;
  }
  let exit = 0;
  for (const dir of dirs) {
    // One bad run (malformed file, a refused bundle) must not stop the others.
    try {
      const release = claim(dir);
      if (!release) {
        log.warn(`${path.basename(dir)}: another publish is working on this run (${LOCK_FILE}); skipped`);
        if (explicit) exit = 1;
        continue;
      }
      try {
        if ((await publishRun(cwd, c, dir, env, o)) !== 0) exit = 1;
      } finally {
        release();
      }
    } catch (e) {
      log.fail(`${path.basename(dir)}: ${redact((e as Error).message.split("\n")[0])}`);
      exit = 1;
    }
  }
  return exit;
}

/** What each job may ask publish to do. A run folder of one kind holding the other kind's steps is refused (it is untrusted data). */
const STEPS_OF: Record<PublishFile["kind"], readonly string[]> = {
  "gap-report": ["report", "mr-seen", "bugs", "notify"],
  generate: ["merge-request", "bugs", "notify", "branch-note", "record"],
};

const KEY_IN_TEXT = /\b[A-Za-z][A-Za-z0-9]*-\d+\b/g;
const keysIn = (t: string | undefined) => (t ?? "").match(KEY_IN_TEXT)?.map((k) => k.toUpperCase()) ?? [];

/**
 * The stories this publish job is for. The run folder is untrusted, so it cannot say which story a step belongs to: that comes from what the
 * pipeline itself carries:
 *  - QA_STORY_KEY / QA_STORY_KEYS (set by whoever starts the pipeline); always trusted;
 *  - Jira keys in text the pipeline carries: the title, message and branch of the service commit (QA_SERVICE_COMMIT_TITLE, QA_SERVICE_COMMIT_MESSAGE,
 *    QA_SERVICE_BRANCH), the merge request the job runs on (CI_MERGE_REQUEST_TITLE, _DESCRIPTION, _SOURCE_BRANCH_NAME), and from GitLab the merge
 *    request of the service commit and the titles of a merge request's commits. These count only when requirements.jira.projectKeys is set (without
 *    it any word like UTF-8 or SHA-256 looks like a key);
 *  - the feature a trusted card leads to: a bug named in that text is read through Jira with the configured links (the same strict rules as
 *    generation: one hop, a feature type, a configured project), so a bug-fix run may write to its story.
 */
export async function trustedStories(c: Config, env: NodeJS.ProcessEnv): Promise<Set<string>> {
  const explicit = new Set<string>();
  for (const v of [env.QA_STORY_KEY, env.QA_STORY_KEYS]) keysIn(v).forEach((k) => explicit.add(k));
  const text = new Set<string>();
  for (const v of [env.QA_SERVICE_COMMIT_TITLE, env.QA_SERVICE_COMMIT_MESSAGE, env.QA_SERVICE_BRANCH, env.CI_MERGE_REQUEST_TITLE, env.CI_MERGE_REQUEST_DESCRIPTION, env.CI_MERGE_REQUEST_SOURCE_BRANCH_NAME]) keysIn(v).forEach((k) => text.add(k));
  // The merge request or pull request this job runs on (GitLab CI_MERGE_REQUEST_*, GitHub's pull request event): its author wrote the title, text and branch.
  const own = scmFor(c, env).mrFromEnv(env);
  for (const v of [own.title, own.description, own.sourceBranch]) keysIn(v).forEach((k) => text.add(k));
  const ctx = gitlabContext(c.ci.gitlabUrl, env);
  if (ctx && env.QA_SERVICE_PROJECT && env.QA_SERVICE_SHA) {
    try {
      for (const mr of await mergeRequestsForCommit(ctx, env.QA_SERVICE_PROJECT, env.QA_SERVICE_SHA)) for (const v of [mr.title, mr.description, mr.source_branch]) keysIn(v).forEach((k) => text.add(k));
    } catch (e) {
      log.warn(`could not ask GitLab which merge request made ${env.QA_SERVICE_SHA.slice(0, 8)} (${(e as Error).message.split("\n")[0]}); only the pipeline's own variables name the stories`);
    }
  }
  if (ctx && env.CI_PROJECT_ID && env.CI_MERGE_REQUEST_IID) {
    try {
      for (const cm of await getAll(ctx, `/projects/${encodeURIComponent(env.CI_PROJECT_ID)}/merge_requests/${encodeURIComponent(env.CI_MERGE_REQUEST_IID)}/commits`, 5)) for (const v of [cm.title, cm.message]) keysIn(v).forEach((k) => text.add(k));
    } catch {
      /* the merge request's own title and branch above still count */
    }
  }
  const only = c.requirements.jira?.projectKeys?.map((k) => k.toUpperCase()) ?? [];
  if (!only.length && text.size) log.warn("requirements.jira.projectKeys is empty: Jira keys found in commit and merge request text are not trusted (set it, or set QA_STORY_KEY)");
  const fromText = only.length ? [...text].filter((k) => only.includes(k.split("-")[0])) : [];
  const out = new Set([...explicit, ...fromText]);
  // A bug (or task) named in that text leads to its story through Jira, by the configured links.
  const jira = jiraContext(c.requirements.jira, env);
  if (jira && out.size) {
    const lookup = async (k: string) => fetchIssue(jira, k).catch(() => undefined);
    for (const k of [...out].slice(0, 10)) {
      const card = await lookup(k);
      if (!card) continue;
      const r = await resolveFeature(c, card, lookup).catch(() => undefined);
      if (r?.kind === "resolved") out.add(r.feature.toUpperCase());
    }
  }
  return out;
}

/** The stories a step would write to (Jira, the record, a story branch). */
const storiesOf = (s: PublishFile["steps"][number]): string[] =>
  s.type === "merge-request"
    ? [s.storyKey, s.jira?.storyKey, s.notify?.story].filter((k): k is string => Boolean(k))
    : s.type === "report"
      ? [s.storyKey].filter((k): k is string => Boolean(k))
      : s.type === "mr-seen"
        ? [s.args.feature, s.args.workKey].filter((k): k is string => Boolean(k))
        : s.type === "record" || s.type === "notify" || s.type === "bugs" || s.type === "branch-note"
          ? [s.story]
          : [];

const validKey = (k: string | undefined) => (k ? /^[A-Za-z][A-Za-z0-9]*-\d+$/.test(k) : false);

async function publishRun(cwd: string, c: Config, dir: string, env: NodeJS.ProcessEnv, o: PublishOptions): Promise<number> {
  assertNoLinks(dir);
  const doc: PublishFile = parsePublishFile(readFileNoFollow(path.join(dir, PUBLISH_FILE)));
  if (o.kind && doc.kind !== o.kind) throw new Error(`this run is a ${doc.kind} run, but this publish job takes only ${o.kind} runs; refused`);
  const odd = doc.steps.find((s) => !STEPS_OF[doc.kind].includes(s.type));
  if (odd) throw new Error(`a ${doc.kind} run may not hold a "${odd.type}" step; refused`);
  const state = readState(dir);
  const name = path.basename(dir);
  log.step(`publishing ${name} (${doc.kind}, ${doc.steps.length} step(s))`);
  const wanted = (key: string, target?: PublishTarget) => !state.done[key] && (!o.target || !target || o.target === target);
  const results: { step: string; ok: boolean; note?: string }[] = [];
  const mark = (key: string, label: string, note?: string) => {
    state.done[key] = { at: new Date().toISOString(), ...(note ? { note } : {}) };
    writeState(dir, state);
    results.push({ step: label, ok: true, ...(note ? { note } : {}) });
  };
  const fail = (label: string, e: unknown) => {
    const msg = redact((e instanceof Error ? e.message : String(e)).split("\n")[0]);
    log.fail(`${name} ${label}: ${msg}`);
    results.push({ step: label, ok: false, note: msg });
  };
  const mrEnv = scmFor(c, env).mrFromEnv(env);
  let trusted: Set<string> | undefined;
  for (const [i, step] of doc.steps.entries()) {
    const label = `${i + 1}. ${step.type}`;
    try {
      // Generate runs write to stories (Jira, the record, a story branch): only to the ones this job is for, never to one the run folder names.
      const asked = storiesOf(step);
      let untrustedStory = false;
      if (asked.length) {
        trusted ??= await trustedStories(c, env);
        const stranger = asked.find((k) => !trusted!.has(k.toUpperCase()));
        if (stranger && step.type === "report") {
          // The note goes to this job's own merge request whatever the story is; only the Jira comment and the story key are dropped.
          log.warn(`${stranger} is not a story this job is for (QA_STORY_KEY, or the commit / merge request names it): the report is posted on the merge request without it, and nothing is written to Jira`);
          untrustedStory = true;
        } else if (stranger && step.type === "mr-seen") {
          log.warn(`${stranger} is not a story this job is for: the merge request is not recorded on it`);
          mark(`${i}`, label, `${stranger} is not a story this job is for: nothing recorded`);
          continue;
        } else if (stranger) throw new Error(`${stranger} is not a story this job is for (QA_STORY_KEY, or the service commit / merge request names it); the ${step.type} step is refused`);
      }
      if (step.type === "merge-request") {
        const needMr = wanted(`${i}:mr`, "mr-create") && (!o.target || o.target === "mr-create");
        const needPost = wanted(`${i}:post`, "jira") && (!o.target || o.target === "jira");
        if (needMr) {
          const r = await pushAndOpen(cwd, c, dir, doc.runId, step, env);
          state.mr = r.mr;
          mark(`${i}:mr`, `${label} (branch and merge request)`, r.note);
        }
        // The Jira summary and the story notice have a state each: a notice that keeps failing must not hold back the summary.
        const needNotice = Boolean(step.notify) && wanted(`${i}:notice`, "jira") && (!o.target || o.target === "jira");
        let blocked: unknown;
        if (needPost) {
          if (!state.done[`${i}:mr`] && !o.target) throw new Error("the merge request was not made, so there is nothing to announce");
          const note = await announceJira(cwd, c, dir, step, state.mr, env);
          mark(`${i}:post`, `${label} (Jira)`, note);
        }
        if (needNotice) {
          if (!state.done[`${i}:mr`] && !o.target) throw new Error("the merge request was not made, so there is nothing to announce");
          try {
            mark(`${i}:notice`, `${label} (story notice)`, await announceNotice(cwd, c, step, state.mr, env));
          } catch (e) {
            blocked = e;
          }
        }
        if (blocked) throw blocked;
      } else if (step.type === "report") {
        const targets = (step.targets ?? c.reporting.targets).filter((t, k, a) => a.indexOf(t) === k);
        for (const t of targets) {
          if (!wanted(`${i}:${t}`, t)) continue;
          const storyKey = untrustedStory ? undefined : step.storyKey;
          if (t === "jira" && !storyKey) {
            mark(`${i}:${t}`, `${label} (${t})`, untrustedStory ? "the story is not one this job is for: nothing written to Jira" : "no story key: nothing to comment on in Jira");
            continue;
          }
          // The merge request is this job's own (CI_PROJECT_ID, CI_MERGE_REQUEST_IID), never one named in the run folder.
          if (t === "gitlab-mr" && (!mrEnv.project || !mrEnv.mrIid)) throw new Error(scmFor(c, env).kind === "github" ? "no pull request in this job (GITHUB_REPOSITORY and the pull request event are not set)" : "no merge request in this job (CI_PROJECT_ID and CI_MERGE_REQUEST_IID are not set)");
          const done = await publish(c, { onMrNote: (n) => patchManifest(dir, { mr: n }), report: step.report, jiraSummary: step.jiraSummary, cwd, service: step.service, storyKey, stamp: step.stamp, mr: mrEnv, targets: [t] }, env);
          if (!done.includes(t)) throw new Error(`${t} was not published (missing token, login or merge request; see the warning above)`);
          mark(`${i}:${t}`, `${label} (${t})`);
        }
      } else if (step.type === "mr-seen") {
        if (!wanted(`${i}`, "jira")) continue;
        if (!mrEnv.mrIid) throw new Error(scmFor(c, env).kind === "github" ? "no pull request in this job (the pull request event is not set)" : "no merge request in this job (CI_MERGE_REQUEST_IID is not set)");
        await recordMrSeen(openStore(cwd, c, env), { ...step.args, mrIid: mrEnv.mrIid, url: mrEnv.url, title: mrEnv.title, branch: mrEnv.sourceBranch });
        mark(`${i}`, label);
      } else if (step.type === "bugs") {
        if (!wanted(`${i}`, "jira")) continue;
        const jira = jiraContext(c.requirements.jira, env);
        if (!jira) throw new Error("no Jira login in this job");
        const bad = step.candidates.find((b) => b.story !== step.story || typeof b.title !== "string" || (b.kind !== "not-working" && b.kind !== "not-built"));
        if (bad) throw new Error("a bug in publish.json is not for this story or is malformed; none were filed");
        const r = await fileBugs(jira, c, step.story, step.candidates as unknown as BugCandidate[], cwd);
        mark(`${i}`, label, `${r.created.length} bug(s) raised, ${r.suggested} proposed`);
      } else if (step.type === "notify") {
        if (!wanted(`${i}`, "jira")) continue;
        const sent = await notifyStoryOutcome(cwd, c, step.story, step.event, step.text, step.key, env);
        if (sent === "failed") throw new Error("the Jira notice could not be sent; it stays pending for the next publish");
        mark(`${i}`, label, sent === "sent" ? "sent" : `not sent (${sent})`);
      } else if (step.type === "record") {
        if (!wanted(`${i}`, "jira")) continue;
        const store = openStore(cwd, c, env);
        const same = (k: string | undefined) => (k ?? "").toUpperCase() === step.story.toUpperCase();
        if (step.conflict) {
          // A conflict-only step: the story's own branch, no AC entries, no reset. Checked before anything is written.
          if (step.entries.length || step.evidence.length || step.reset || step.clearConflict) throw new Error("a conflict step may hold nothing but the conflict; refused");
          if (step.conflict.branch !== storyBranchName(c, step.story)) throw new Error("the conflict is not for this story's branch; refused");
          await applyRecordPatch(store, step.story, { entries: [], evidence: [], conflict: { branch: step.conflict.branch, message: step.conflict.message, key: step.conflict.key } });
          await showConflict(c, step.story, step.conflict.branch, step.conflict.message, step.conflict.key, env, store);
          mark(`${i}`, label, "story record updated (conflict)");
          continue;
        }
        if (step.reset) throw new Error("a record step may not reset the record: that is done with the merge request step, after the push; refused");
        // Which story this run is about is what its merge-request step says (the run folder cannot name another story's record).
        const mrs = doc.steps.flatMap((x, j) => (x.type === "merge-request" ? [{ x, j }] : []));
        const mine = mrs.find(({ x }) => same(x.storyKey));
        if (mrs.length && !mine) throw new Error(`this run's merge request is not for ${step.story}; the record step is refused`);
        let patch = step;
        if (mine) {
          // "written" and "held" describe what is on the branch: only once that branch was pushed, by a step before this one.
          const wroteAny = step.entries.some((e) => e.state === "written");
          if (wroteAny && (mine.j > i || !state.done[`${mine.j}:mr`])) throw new Error("the branch was not pushed, so the story record is left as it was");
        } else {
          // No merge request in the run (the existing tests were enough): the story is a trusted one (checked above), so its ACs may be recorded
          // as written or held; no branch started again, so no reset.
          patch = { ...step, reset: undefined };
        }
        await applyRecordPatch(store, step.story, patch);
        mark(`${i}`, label, "story record updated");
      } else if (step.type === "branch-note") {
        if (!wanted(`${i}`, "gitlab-mr")) continue;
        mark(`${i}`, label, await branchNote(c, step, env));
      }
    } catch (e) {
      fail(label, e);
    }
  }
  for (const r of results) (r.ok ? log.ok : log.warn)(`${r.step}${r.note ? `: ${r.note}` : ""}`);
  const failed = results.some((r) => !r.ok);
  if (!failed && !results.length) log.warn("nothing matched in this run (already published, or not what --target asks for)");
  // The run is finished when every part is recorded; "all" skips it from then on.
  const expected = doc.steps.flatMap((s, i) => (s.type === "merge-request" ? [`${i}:mr`, `${i}:post`, ...(s.notify ? [`${i}:notice`] : [])] : s.type === "report" ? (s.targets ?? c.reporting.targets).map((t) => `${i}:${t}`) : [`${i}`]));
  if (expected.every((k) => state.done[k])) {
    state.complete = true;
    writeState(dir, state);
  }
  return failed ? 1 : 0;
}

/** git, with the one-off remote URL (it carries the token) kept out of every message. */
function sh(cwd: string, args: string[]): string {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (e) {
    const err = e as { stderr?: string; message: string };
    const why = String(err.stderr ?? err.message).split("\n").map((l) => l.trim()).filter((l) => /rejected|stale|denied|declined|protected|fatal|error|not found|unable/i.test(l))[0] ?? "see the git message";
    throw new Error(redact(why));
  }
}
const tryGit = (cwd: string, args: string[]) => {
  try {
    return sh(cwd, args);
  } catch {
    return undefined;
  }
};

const BRANCH_RE = /^qa-sentinel\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

/**
 * Which branch may be pushed: only `qa-sentinel/...`. A story branch only as the config names it for the story. Any other
 * branch only as THIS job's per-merge branch, rebuilt from its own QA_SERVICE_NAME and QA_SERVICE_SHA (`qa-sentinel/<service>-<sha8>`):
 * the run folder cannot pick another qa-sentinel branch (another service's, or a shared one such as qa-sentinel/review-lessons).
 */
export function allowedBranch(c: Config, s: Pick<MergeRequestStep, "branch" | "storyKey">, env: NodeJS.ProcessEnv = process.env): { story: boolean } {
  const b = s.branch;
  if (!BRANCH_RE.test(b) || b.includes("..") || b.endsWith(".lock") || b.endsWith(".") || b.split("/").some((p) => p.startsWith(".") || p.endsWith(".lock"))) throw new Error(`branch "${b.slice(0, 80)}" is not a qa-sentinel/... branch; refused`);
  if (s.storyKey) {
    const expected = storyBranchName(c, s.storyKey);
    if (b === expected) {
      if (!BRANCH_RE.test(expected)) throw new Error(`generation.branchPrefix must start with qa-sentinel/ for the split jobs (it is "${c.generation.branchPrefix}")`);
      return { story: true };
    }
  }
  // Another name may not look like a story branch: that one belongs to its story.
  if (b.startsWith(c.generation.branchPrefix)) throw new Error(`${b} is named like a story branch but is not the one for ${s.storyKey ?? "any story in this run"}; refused`);
  const service = env.QA_SERVICE_NAME;
  const sha = env.QA_SERVICE_SHA;
  if (!service || !sha || !/^[0-9a-f]{8,64}$/i.test(sha)) throw new Error(`${b} is not this job's branch: QA_SERVICE_NAME and QA_SERVICE_SHA are needed to name it; refused`);
  const expected = `qa-sentinel/${service}-${sha.slice(0, 8).toLowerCase()}`; // generate names the branch from git's lowercase sha
  if (b !== expected) throw new Error(`${b} is not this job's branch (${expected}); refused`);
  return { story: false };
}

const LABEL_OK = /^(?:qa-agent|story::[A-Za-z][A-Za-z0-9]*-\d+|service::[A-Za-z0-9._-]{1,60}|qa-sentinel::[a-z0-9_-]{1,40}|risk::[a-z]{1,20})$/;
const cleanLabels = (labels: string[], storyKey: string | undefined) => [...new Set(["qa-agent", ...labels.filter((l) => LABEL_OK.test(l) && (!l.startsWith("story::") || l.toUpperCase() === `STORY::${storyKey ?? ""}`.toUpperCase()))])];

async function pushAndOpen(cwd: string, c: Config, runDir: string, runId: string, s: MergeRequestStep, env: NodeJS.ProcessEnv): Promise<{ note: string; mr: { url: string; iid: number } }> {
  const { story } = allowedBranch(c, s, env);
  const bundle = path.join(runDir, BUNDLE_FILE);
  if (!fs.existsSync(bundle)) throw new Error(`${BUNDLE_FILE} is missing in ${path.basename(runDir)} (the analysis job's artifacts must include the run folder)`);
  const scm = scmFor(c, env);
  const project = scm.testProject(env);
  if (!scm.hasToken || project === undefined) throw new Error(scm.kind === "github" ? "set QA_SENTINEL_GITHUB_TOKEN and ci.testRepoProject (or GITHUB_REPOSITORY): there is nowhere to push or no pull request can be opened" : "set QA_SENTINEL_GITLAB_TOKEN and ci.testRepoProject (or CI_PROJECT_ID): there is nowhere to push or no merge request can be opened");
  const remote = remoteFor(c, env);
  const id = crypto.createHash("sha256").update(path.resolve(runDir)).digest("hex").slice(0, 12);
  const ref = (what: string) => `refs/qa-sentinel/publish/${id}-${what}`;
  const target = c.ci.targetBranch;

  // What the server has NOW decides the base of the check and the lease of the push; the run folder is not asked.
  const listed = sh(cwd, ["ls-remote", remote, `refs/heads/${s.branch}`]).split("\n").filter(Boolean)[0];
  const observed = listed ? listed.split(/\s+/)[0] : undefined;
  // A per-merge branch belongs to qa-sentinel (named after the source commit) and may be replaced; a story branch only if it is still where the analysis found it.
  if (story && (s.expectSha ?? "") !== (observed ?? "")) throw new Error(`${s.branch} changed on the server since the analysis (${(observed ?? "absent").slice(0, 8)} now, ${(s.expectSha ?? "absent").slice(0, 8)} then). Nothing was overwritten; run the analysis job again.`);
  sh(cwd, ["fetch", "-q", remote, `+refs/heads/${target}:${ref("target")}`]);
  if (observed) sh(cwd, ["fetch", "-q", remote, `+refs/heads/${s.branch}:${ref("server")}`]);
  sh(cwd, ["fetch", "-q", bundle, `+refs/heads/${s.branch}:${ref("tip")}`]);
  const tip = sh(cwd, ["rev-parse", ref("tip")]);
  if (tip !== s.headSha) throw new Error(`the bundle holds ${tip.slice(0, 8)} for ${s.branch} but publish.json says ${s.headSha.slice(0, 8)}; not pushed`);

  let base: string;
  if (story && observed) {
    // A story branch is built on, never rebuilt: the new work must sit on top of what the server has.
    if (tryGit(cwd, ["merge-base", "--is-ancestor", observed, tip]) === undefined) throw new Error(`${s.branch} in the bundle does not build on the server's ${s.branch}; refused (a story branch is never rewritten)`);
    base = observed;
  } else {
    base = tryGit(cwd, ["merge-base", ref("target"), tip]) ?? "";
    if (!base) throw new Error(`the bundle's ${s.branch} shares no history with ${target}; refused`);
  }
  const findings = await bundleFindings(cwd, c, { base, tip, targetRef: ref("target"), env });
  if (findings.length) log.info(findingsMarkdown(findings));
  const bad = violations(findings);
  if (bad.length) throw new Error(`${bad.length} guardrail violation(s) in the bundle; nothing was pushed`);

  try {
    // Lease on this branch only, with what the server has now (empty: the branch must not exist). No plain --force, no other branch.
    sh(cwd, ["push", "-q", `--force-with-lease=refs/heads/${s.branch}:${observed ?? ""}`, remote, `${tip}:refs/heads/${s.branch}`]);
  } catch (e) {
    throw new Error(story ? `${s.branch} could not be pushed: it changed on the server meanwhile (or was refused). Nothing was overwritten; run the analysis job again. (${(e as Error).message})` : `push of ${s.branch} failed: ${(e as Error).message}`);
  }
  const mr = await scm.createOrUpdateChangeRequest(project, { source: s.branch, target, title: s.title.slice(0, 150), description: s.description, labels: cleanLabels(s.labels, story ? s.storyKey : undefined) });
  markMrOpened(runDir);
  if (story && s.storyKey && s.resetRecord) await applyRecordPatch(openStore(cwd, c, env), s.storyKey, { entries: [], evidence: [], reset: true } as Parameters<typeof applyRecordPatch>[2]);
  if (story && s.storyKey) await recordAgentMr(openStore(cwd, c, env), s.storyKey, { branch: s.branch, iid: mr.iid, url: mr.web_url, headSha: s.headSha });
  return { note: `pushed ${s.branch}; merge request ${mr.action}: ${mr.web_url}`, mr: { url: mr.web_url, iid: mr.iid } };
}

async function announceNotice(cwd: string, c: Config, s: MergeRequestStep, mr: { url: string; iid: number } | undefined, env: NodeJS.ProcessEnv): Promise<string> {
  if (!s.notify) return "no notice";
  if (s.notify.story.toUpperCase() !== (s.storyKey ?? "").toUpperCase()) throw new Error("the notification is for another story than the branch's; refused");
  const sent = await notifyStoryOutcome(cwd, c, s.notify.story, s.notify.event, s.notify.text.replace("{mr}", mr?.url ?? ""), s.notify.key.replace("{iid}", String(mr?.iid ?? "")), env);
  if (sent === "failed") throw new Error("the Jira notice could not be sent; it stays pending for the next publish");
  return sent === "sent" ? "story notified" : `story not notified (${sent})`;
}

async function announceJira(cwd: string, c: Config, runDir: string, s: MergeRequestStep, mr: { url: string; iid: number } | undefined, env: NodeJS.ProcessEnv): Promise<string> {
  const url = mr?.url ?? "";
  if (s.jira && c.reporting.targets.includes("jira")) {
    const j = s.jira;
    if (s.storyKey && (j.storyKey ?? "").toUpperCase() !== s.storyKey.toUpperCase()) throw new Error("the Jira summary is for another story than the branch's; refused");
    const jiraSummary = generationSummary({ service: j.service, risk: j.risk as Parameters<typeof generationSummary>[0]["risk"], verification: j.verification, environment: j.environment, mrUrl: url || undefined, trace: j.trace as Parameters<typeof generationSummary>[0]["trace"], acText: new Map(j.acText), discrepancies: j.discrepancies, weakTests: j.weakTests });
    writeFileNoFollow(path.join(runDir, "jira-summary.md"), jiraSummary);
    const done = await publish(c, { report: j.report, jiraSummary, cwd, service: j.service, storyKey: j.storyKey, mr: {}, targets: ["jira"] }, env);
    if (!done.includes("jira")) throw new Error("Jira was not updated (no login, or no story key)");
    return "Jira updated";
  }
  return "nothing to announce in Jira";
}

async function branchNote(c: Config, s: BranchNoteStep, env: NodeJS.ProcessEnv): Promise<string> {
  const branch = storyBranchName(c, s.story);
  if (!BRANCH_RE.test(branch)) throw new Error("generation.branchPrefix must start with qa-sentinel/ for the split jobs");
  const scm = scmFor(c, env);
  const project = scm.testProject(env);
  if (!scm.hasToken || project === undefined) throw new Error(scm.kind === "github" ? "set QA_SENTINEL_GITHUB_TOKEN and ci.testRepoProject (or GITHUB_REPOSITORY) to leave the note" : "set QA_SENTINEL_GITLAB_TOKEN and ci.testRepoProject (or CI_PROJECT_ID) to leave the note");
  const mr = await scm.latestForBranch(project, branch, c.ci.targetBranch);
  if (mr?.state !== "opened") return "no open merge request for the story branch; no note";
  await scm.upsertMarkedNote(project, mr.iid, s.marker, s.text);
  return `note left on !${mr.iid}`;
}
