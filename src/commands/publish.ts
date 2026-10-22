import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { loadConfig, type Config } from "../config.js";
import { git, changesBetween, repoPrefix } from "../git.js";
import { matchesAny } from "../fsutil.js";
import { ARTIFACT_GLOBS } from "../run.js";
import { checkContent, checkPaths, findingsMarkdown, generatePolicy, violations } from "../guardrails.js";
import { layers } from "../layers.js";
import { createOrUpdateMergeRequest, gitlabContext } from "../scm/gitlab.js";
import { jiraContext } from "../scm/jira.js";
import { remoteFor, redact } from "../generation/storyBranch.js";
import { publish } from "../reporting/publish.js";
import { generationSummary } from "../reporting/jiraSummary.js";
import { notifyStory, type NotifyEvent } from "../reporting/notify.js";
import { BUNDLE_FILE, PUBLISHED_FILE, PUBLISH_FILE, type MergeRequestStep, type PublishFile } from "../reporting/deferred.js";
import { recordMrSeen } from "../stories/sweep.js";
import { openStore } from "../stories/start.js";
import { bugsFromPlan, fileBugs } from "../bugs/bugs.js";
import { recordAgentMr } from "./generate.js";
import { log } from "../log.js";

/**
 * `qa-sentinel publish`: do the writing that `gap-report --defer-publish` and `generate --defer-publish` left in a run
 * folder (publish.json, branch.bundle). It uses the GitLab write token and the Jira publishing login, and no model
 * credentials: it never starts an agent. This is the second half of the split CI jobs (README, "Split CI jobs").
 */

export type PublishTarget = "gitlab-mr" | "jira" | "mr-create";

export interface PublishOptions {
  cwd: string;
  /** A run id (folder name in .qa-sentinel/runs), a folder, or "all" (default): every run with a publish.json that was not published yet. */
  run?: string;
  target?: PublishTarget;
  /** The environment (tokens, CI variables). Default: the process environment. Tests pass their own. */
  env?: NodeJS.ProcessEnv;
}

const MODEL_VARS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX"];

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
  return { dirs: names.map((n) => path.join(root, n)).filter((d) => fs.existsSync(path.join(d, PUBLISH_FILE)) && !fs.existsSync(path.join(d, PUBLISHED_FILE))), explicit: false };
}

export async function publishCommand(o: PublishOptions): Promise<number> {
  const cwd = path.resolve(o.cwd);
  const c = loadConfig(cwd);
  const env = o.env ?? process.env;
  const held = MODEL_VARS.filter((k) => env[k]);
  if (held.length) log.warn(`this job holds model credentials (${held.join(", ")}) that publishing never uses. In the split CI jobs they belong to the analysis job only (README, "Split CI jobs").`);
  const { dirs, explicit } = runDirs(cwd, o.run);
  if (!dirs.length) {
    log.ok("nothing to publish: no run with a publish.json that is still waiting");
    return 0;
  }
  let exit = 0;
  for (const dir of dirs) {
    const doc = JSON.parse(fs.readFileSync(path.join(dir, PUBLISH_FILE), "utf8")) as PublishFile;
    if (doc.version !== 1) throw new Error(`${path.basename(dir)}: unknown publish.json version ${doc.version}`);
    log.step(`publishing ${path.basename(dir)} (${doc.kind}, ${doc.steps.length} step(s))`);
    const results: { step: string; ok: boolean; note?: string }[] = [];
    for (const [i, step] of doc.steps.entries()) {
      const label = `${i + 1}. ${step.type}`;
      try {
        if (step.type === "merge-request") {
          if (o.target && o.target !== "mr-create" && o.target !== "jira") continue;
          const r = await publishMergeRequest(cwd, c, dir, doc.runId, step, env, o.target);
          results.push({ step: label, ok: true, note: r });
        } else if (step.type === "report") {
          if (o.target === "mr-create") continue;
          const wanted = (step.targets ?? c.reporting.targets).filter((t) => !o.target || t === o.target);
          if (!wanted.length) continue;
          const done = await publish(c, { report: step.report, jiraSummary: step.jiraSummary, cwd, service: step.service, storyKey: step.storyKey, stamp: step.stamp, mr: step.mr, targets: wanted }, env);
          const missing = wanted.filter((t) => !done.includes(t));
          results.push({ step: label, ok: !missing.length, note: missing.length ? `not published: ${missing.join(", ")}` : `published: ${done.join(", ")}` });
          if (missing.length && o.target) exit = 1;
        } else if (step.type === "mr-seen") {
          if (o.target === "gitlab-mr" || o.target === "mr-create") continue;
          await recordMrSeen(openStore(cwd, c, env), step.args);
          results.push({ step: label, ok: true });
        } else if (step.type === "bugs") {
          if (o.target === "gitlab-mr" || o.target === "mr-create") continue;
          const jira = jiraContext(c.requirements.jira, env);
          if (!jira) {
            results.push({ step: label, ok: false, note: "no Jira login in this job" });
            continue;
          }
          const r = await fileBugs(jira, c, step.story, step.candidates as ReturnType<typeof bugsFromPlan>, cwd);
          results.push({ step: label, ok: true, note: `${r?.created.length ?? 0} bug(s) raised, ${r?.suggested ?? 0} proposed` });
        }
      } catch (e) {
        const msg = redact((e as Error).message.split("\n")[0]);
        log.fail(`${path.basename(dir)} ${label}: ${msg}`);
        results.push({ step: label, ok: false, note: msg });
        exit = 1;
      }
    }
    for (const r of results) (r.ok ? log.ok : log.warn)(`${r.step}${r.note ? `: ${r.note}` : ""}`);
    // A failed step leaves the run open (publish can be run again); a finished one is marked, so "all" skips it next time.
    if (!results.some((r) => !r.ok) && !o.target) fs.writeFileSync(path.join(dir, PUBLISHED_FILE), JSON.stringify({ at: new Date().toISOString(), results }, null, 2) + "\n");
    else if (explicit && !results.length) log.warn("nothing matched --target in this run");
  }
  return exit;
}

/** Check the bundle against the write policy, push the branch, open or update the merge request, then the record, the notification and Jira. */
async function publishMergeRequest(cwd: string, c: Config, runDir: string, runId: string, s: MergeRequestStep, env: NodeJS.ProcessEnv, target: PublishTarget | undefined): Promise<string> {
  const notes: string[] = [];
  let mr: { web_url: string; iid: number; action: string } | undefined;
  if (target !== "jira") {
    const bundle = path.join(runDir, BUNDLE_FILE);
    if (!fs.existsSync(bundle)) throw new Error(`${BUNDLE_FILE} is missing in ${path.basename(runDir)} (the analysis job's artifacts must include the run folder)`);
    const ref = `refs/qa-sentinel/publish/${runId}`;
    git(cwd, ["fetch", "-q", bundle, `+refs/heads/${s.branch}:${ref}`]);
    const tip = git(cwd, ["rev-parse", ref]);
    if (tip !== s.headSha) throw new Error(`the bundle holds ${tip.slice(0, 8)} for ${s.branch} but publish.json says ${s.headSha.slice(0, 8)}; not pushed`);
    // The agent's output is checked again here, in the job that holds the write token: the same write policy `verify --policy` applies.
    const bad = policyFindings(cwd, c, s, tip, env);
    if (bad.length) {
      log.info(findingsMarkdown(bad));
      throw new Error(`${bad.length} guardrail violation(s) in the bundle; nothing was pushed`);
    }
    const remote = remoteFor(c, env);
    const push = (args: string[]) => execFileSync("git", ["push", "-q", ...args, remote, `${tip}:refs/heads/${s.branch}`], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    try {
      if (s.pushMode === "story") push([`--force-with-lease=refs/heads/${s.branch}:${s.expectSha ?? ""}`]);
      else push(["--force"]);
    } catch (e) {
      // git's own words, without the command line (it carries the one-off URL with the token).
      const why = redact(String((e as { stderr?: string }).stderr ?? (e as Error).message).split("\n").map((l) => l.trim()).filter((l) => /rejected|stale|denied|declined|protected|fatal|error/i.test(l))[0] ?? "see the git message");
      throw new Error(s.pushMode === "story" ? `${s.branch} could not be pushed: it changed on the server since the analysis (or was refused). Nothing was overwritten; run the analysis job again. (${why})` : `push of ${s.branch} failed: ${why}`);
    }
    notes.push(`pushed ${s.branch}`);
    const ctx = gitlabContext(c.ci.gitlabUrl, env);
    const project = s.project ?? c.ci.testRepoProject ?? env.CI_PROJECT_ID;
    if (!ctx || project === undefined) throw new Error("pushed, but the merge request can't be opened: set QA_SENTINEL_GITLAB_TOKEN and ci.testRepoProject (or CI_PROJECT_ID)");
    mr = await createOrUpdateMergeRequest(ctx, project, { source: s.branch, target: s.target, title: s.title, description: s.description, labels: s.labels });
    notes.push(`merge request ${mr.action}: ${mr.web_url}`);
    if (s.storyMode && s.storyKey) await recordAgentMr(openStore(cwd, c, env), s.storyKey, { branch: s.branch, iid: mr.iid, url: mr.web_url, headSha: s.headSha });
  }
  if (target !== "mr-create") {
    const url = mr?.web_url ?? "";
    if (s.notify) await notifyStory(cwd, c, s.notify.story, s.notify.event as NotifyEvent, s.notify.text.replace("{mr}", url), s.notify.key.replace("{iid}", String(mr?.iid ?? "")), env);
    if (s.jira && c.reporting.targets.includes("jira")) {
      const j = s.jira;
      const jiraSummary = generationSummary({ service: j.service, risk: j.risk as Parameters<typeof generationSummary>[0]["risk"], verification: j.verification, environment: j.environment, mrUrl: url || undefined, trace: j.trace as Parameters<typeof generationSummary>[0]["trace"], acText: new Map(j.acText), discrepancies: j.discrepancies, weakTests: j.weakTests });
      fs.writeFileSync(path.join(runDir, "jira-summary.md"), jiraSummary);
      const done = await publish(c, { report: j.report, jiraSummary, cwd, service: j.service, storyKey: j.storyKey, mr: {}, targets: ["jira"] }, env);
      notes.push(done.includes("jira") ? "Jira updated" : "Jira not updated");
    }
  }
  return notes.join("; ");
}

/** The write policy for the bundle's commits, checked in a throw-away checkout of the tip (the working tree is not touched). */
function policyFindings(cwd: string, c: Config, s: MergeRequestStep, tip: string, env: NodeJS.ProcessEnv) {
  const changes = changesBetween(cwd, s.baseSha, tip).filter((x) => !matchesAny(x.path, ARTIFACT_GLOBS));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "qa-publish-"));
  const wt = path.join(tmp, "wt");
  try {
    git(cwd, ["worktree", "add", "-q", "--detach", wt, tip]);
    const prefix = repoPrefix(cwd);
    return [
      ...checkPaths(changes, generatePolicy(c)),
      ...checkContent(changes, {
        repo: prefix ? path.join(wt, prefix) : wt,
        ref: s.baseSha,
        allowedHosts: c.guardrails.allowedHosts,
        baseUrl: env[c.tests.api.baseUrlEnv],
        extraBaseUrls: [...layers(c).map((l) => env[l.baseUrlEnv]), ...(s.baseUrls ?? [])].filter((u): u is string => Boolean(u)),
        assertionRemoval: c.guardrails.assertionRemoval,
      }),
    ].filter((f) => violations([f]).length);
  } finally {
    try {
      git(cwd, ["worktree", "remove", "--force", wt]);
    } catch {
      /* removed with the folder below */
    }
    fs.rmSync(tmp, { recursive: true, force: true });
    try {
      git(cwd, ["worktree", "prune"]);
    } catch {
      /* best effort */
    }
  }
}
