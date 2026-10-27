import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { loadConfig, type Config } from "../config.js";
import { findingsMarkdown, violations } from "../guardrails.js";
import { createOrUpdateMergeRequest, gitlabContext, gitlabMrFromEnv, latestMrForBranch, upsertMarkedNote } from "../scm/gitlab.js";
import { jiraContext } from "../scm/jira.js";
import { remoteFor, redact, storyBranchName } from "../generation/storyBranch.js";
import { publish } from "../reporting/publish.js";
import { generationSummary } from "../reporting/jiraSummary.js";
import { notifyStory } from "../reporting/notify.js";
import { BUNDLE_FILE, PUBLISHED_FILE, PUBLISH_FILE, parsePublishFile, type BranchNoteStep, type MergeRequestStep, type PublishFile } from "../reporting/deferred.js";
import { recordMrSeen } from "../stories/sweep.js";
import { openStore } from "../stories/start.js";
import { fileBugs, type BugCandidate } from "../bugs/bugs.js";
import { recordAgentMr } from "./generate.js";
import { bundleFindings } from "./bundlePolicy.js";
import { log } from "../log.js";

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
    const s = JSON.parse(fs.readFileSync(path.join(dir, PUBLISHED_FILE), "utf8")) as State;
    if (s && typeof s === "object" && s.done && typeof s.done === "object") return { version: 1, done: s.done, ...(s.mr ? { mr: s.mr } : {}), ...(s.complete ? { complete: true } : {}) };
  } catch {
    /* none yet */
  }
  return { version: 1, done: {} };
}
const writeState = (dir: string, s: State) => fs.writeFileSync(path.join(dir, PUBLISHED_FILE), JSON.stringify(s, null, 2) + "\n");

function runDirs(cwd: string, run: string | undefined): { dirs: string[]; explicit: boolean } {
  const root = path.join(cwd, ".qa-sentinel", "runs");
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

/** Claim a run for this process (the lock file is created exclusively, so two publishes of one folder cannot both start). */
function claim(dir: string): (() => void) | undefined {
  const file = path.join(dir, LOCK_FILE);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.closeSync(fs.openSync(file, "wx"));
      fs.writeFileSync(file, `${process.pid} ${new Date().toISOString()}\n`);
      return () => fs.rmSync(file, { force: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      let old = false;
      try {
        old = Date.now() - fs.statSync(file).mtimeMs > LOCK_STALE_MS;
      } catch {
        /* gone meanwhile: try again */
        old = true;
      }
      if (!old) return undefined;
      fs.rmSync(file, { force: true });
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

const validKey = (k: string | undefined) => (k ? /^[A-Za-z][A-Za-z0-9]*-\d+$/.test(k) : false);

async function publishRun(cwd: string, c: Config, dir: string, env: NodeJS.ProcessEnv, o: PublishOptions): Promise<number> {
  const doc: PublishFile = parsePublishFile(fs.readFileSync(path.join(dir, PUBLISH_FILE), "utf8"));
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
  const mrEnv = gitlabMrFromEnv(env);
  for (const [i, step] of doc.steps.entries()) {
    const label = `${i + 1}. ${step.type}`;
    try {
      if (step.type === "merge-request") {
        const needMr = wanted(`${i}:mr`, "mr-create") && (!o.target || o.target === "mr-create");
        const needPost = wanted(`${i}:post`, "jira") && (!o.target || o.target === "jira");
        if (needMr) {
          const r = await pushAndOpen(cwd, c, dir, doc.runId, step, env);
          state.mr = r.mr;
          mark(`${i}:mr`, `${label} (branch and merge request)`, r.note);
        }
        if (needPost) {
          if (!state.done[`${i}:mr`] && !o.target) throw new Error("the merge request was not made, so there is nothing to announce");
          const note = await announce(cwd, c, dir, step, state.mr, env);
          mark(`${i}:post`, `${label} (notes and Jira)`, note);
        }
      } else if (step.type === "report") {
        const targets = (step.targets ?? c.reporting.targets).filter((t, k, a) => a.indexOf(t) === k);
        for (const t of targets) {
          if (!wanted(`${i}:${t}`, t)) continue;
          if (t === "jira" && !step.storyKey) {
            mark(`${i}:${t}`, `${label} (${t})`, "no story key: nothing to comment on in Jira");
            continue;
          }
          // The merge request is this job's own (CI_PROJECT_ID, CI_MERGE_REQUEST_IID), never one named in the run folder.
          if (t === "gitlab-mr" && (!mrEnv.project || !mrEnv.mrIid)) throw new Error("no merge request in this job (CI_PROJECT_ID and CI_MERGE_REQUEST_IID are not set)");
          const done = await publish(c, { report: step.report, jiraSummary: step.jiraSummary, cwd, service: step.service, storyKey: step.storyKey, stamp: step.stamp, mr: mrEnv, targets: [t] }, env);
          if (!done.includes(t)) throw new Error(`${t} was not published (missing token, login or merge request; see the warning above)`);
          mark(`${i}:${t}`, `${label} (${t})`);
        }
      } else if (step.type === "mr-seen") {
        if (!wanted(`${i}`, "jira")) continue;
        if (!mrEnv.mrIid) throw new Error("no merge request in this job (CI_MERGE_REQUEST_IID is not set)");
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
        const sent = await notifyStory(cwd, c, step.story, step.event, step.text, step.key, env);
        mark(`${i}`, label, sent ? "sent" : "not sent (notifications off for this event, or no Jira login)");
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
  const expected = doc.steps.flatMap((s, i) => (s.type === "merge-request" ? [`${i}:mr`, `${i}:post`] : s.type === "report" ? (s.targets ?? c.reporting.targets).map((t) => `${i}:${t}`) : [`${i}`]));
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

/** Which branch may be pushed: only `qa-sentinel/...`; a story branch only as the config names it for the story. */
export function allowedBranch(c: Config, s: Pick<MergeRequestStep, "branch" | "storyKey">): { story: boolean } {
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
  return { story: false };
}

const LABEL_OK = /^(?:qa-agent|story::[A-Za-z][A-Za-z0-9]*-\d+|service::[A-Za-z0-9._-]{1,60}|qa-sentinel::[a-z0-9_-]{1,40}|risk::[a-z]{1,20})$/;
const cleanLabels = (labels: string[], storyKey: string | undefined) => [...new Set(["qa-agent", ...labels.filter((l) => LABEL_OK.test(l) && (!l.startsWith("story::") || l.toUpperCase() === `STORY::${storyKey ?? ""}`.toUpperCase()))])];

async function pushAndOpen(cwd: string, c: Config, runDir: string, runId: string, s: MergeRequestStep, env: NodeJS.ProcessEnv): Promise<{ note: string; mr: { url: string; iid: number } }> {
  const { story } = allowedBranch(c, s);
  const bundle = path.join(runDir, BUNDLE_FILE);
  if (!fs.existsSync(bundle)) throw new Error(`${BUNDLE_FILE} is missing in ${path.basename(runDir)} (the analysis job's artifacts must include the run folder)`);
  const project = c.ci.testRepoProject ?? env.CI_PROJECT_ID;
  const ctx = gitlabContext(c.ci.gitlabUrl, env);
  if (!ctx || project === undefined) throw new Error("set QA_SENTINEL_GITLAB_TOKEN and ci.testRepoProject (or CI_PROJECT_ID): there is nowhere to push or no merge request can be opened");
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
  const mr = await createOrUpdateMergeRequest(ctx, project, { source: s.branch, target, title: s.title.slice(0, 150), description: s.description, labels: cleanLabels(s.labels, story ? s.storyKey : undefined) });
  if (story && s.storyKey) await recordAgentMr(openStore(cwd, c, env), s.storyKey, { branch: s.branch, iid: mr.iid, url: mr.web_url, headSha: s.headSha });
  return { note: `pushed ${s.branch}; merge request ${mr.action}: ${mr.web_url}`, mr: { url: mr.web_url, iid: mr.iid } };
}

async function announce(cwd: string, c: Config, runDir: string, s: MergeRequestStep, mr: { url: string; iid: number } | undefined, env: NodeJS.ProcessEnv): Promise<string> {
  const notes: string[] = [];
  const url = mr?.url ?? "";
  if (s.notify) {
    if (s.notify.story.toUpperCase() !== (s.storyKey ?? "").toUpperCase()) throw new Error("the notification is for another story than the branch's; refused");
    await notifyStory(cwd, c, s.notify.story, s.notify.event, s.notify.text.replace("{mr}", url), s.notify.key.replace("{iid}", String(mr?.iid ?? "")), env);
    notes.push("story notified");
  }
  if (s.jira && c.reporting.targets.includes("jira")) {
    const j = s.jira;
    if (s.storyKey && (j.storyKey ?? "").toUpperCase() !== s.storyKey.toUpperCase()) throw new Error("the Jira summary is for another story than the branch's; refused");
    const jiraSummary = generationSummary({ service: j.service, risk: j.risk as Parameters<typeof generationSummary>[0]["risk"], verification: j.verification, environment: j.environment, mrUrl: url || undefined, trace: j.trace as Parameters<typeof generationSummary>[0]["trace"], acText: new Map(j.acText), discrepancies: j.discrepancies, weakTests: j.weakTests });
    fs.writeFileSync(path.join(runDir, "jira-summary.md"), jiraSummary);
    const done = await publish(c, { report: j.report, jiraSummary, cwd, service: j.service, storyKey: j.storyKey, mr: {}, targets: ["jira"] }, env);
    if (!done.includes("jira")) throw new Error("Jira was not updated (no login, or no story key)");
    notes.push("Jira updated");
  }
  return notes.join("; ") || "nothing to announce";
}

async function branchNote(c: Config, s: BranchNoteStep, env: NodeJS.ProcessEnv): Promise<string> {
  const branch = storyBranchName(c, s.story);
  if (!BRANCH_RE.test(branch)) throw new Error("generation.branchPrefix must start with qa-sentinel/ for the split jobs");
  const project = c.ci.testRepoProject ?? env.CI_PROJECT_ID;
  const ctx = gitlabContext(c.ci.gitlabUrl, env);
  if (!ctx || project === undefined) throw new Error("set QA_SENTINEL_GITLAB_TOKEN and ci.testRepoProject (or CI_PROJECT_ID) to leave the note");
  const mr = await latestMrForBranch(ctx, project, branch, c.ci.targetBranch);
  if (mr?.state !== "opened") return "no open merge request for the story branch; no note";
  await upsertMarkedNote(ctx, project, mr.iid, s.marker, s.text);
  return `note left on !${mr.iid}`;
}
