import fs from "node:fs";
import path from "node:path";
import { loadConfig, type Config } from "../config.js";
import { assembleFeature, featureMarkdown, type FeatureManifest } from "../feature/manifest.js";
import { indexTests, type IndexedTest } from "../analysis/testIndex.js";
import { git, isGitRepo } from "../git.js";
import { createRunDir, findService, testEnv, useEnvironment } from "../run.js";
import { verificationMarkdown, verifyChanges, type VerificationReport } from "../verification.js";
import { applyDeploymentGate, deploymentStates, needsFromCommits } from "../deployment.js";
import { call, createOrUpdateMergeRequest, getAll, gitlabContext, mergeRequestsForCommit, pushUrl, type GitLabContext } from "../scm/gitlab.js";
import { jiraContext, markdownToJiraWiki, type JiraContext } from "../scm/jira.js";
import { extractStoryKeys, jiraKeyPattern } from "../requirements.js";
import { resolveKeysCached } from "../stories/resolve.js";
import { storyBasis } from "../stories/parts.js";
import { type StoryRecord, SAFE_KEY, emptyRecord } from "../stories/record.js";
import { openStore } from "../stories/start.js";
import { postToStory } from "../reporting/statusComment.js";
import { log } from "../log.js";

export interface PostDeployOptions {
  cwd: string;
  /** Environment from `environments:` the services were deployed to (required: that's where tests run). */
  env: string;
  stories?: string[];
  /** The service just deployed and its commit (CI): its stories are found from its commits. */
  service?: string;
  servicePath?: string;
  sha?: string;
  /** The commit deployed before (CI_COMMIT_BEFORE_SHA): only stories in before..sha count. */
  before?: string;
  /** Keep checking for this many minutes while a part of a story isn't deployed yet. */
  waitMinutes?: number;
  /** Re-verify open agent MRs that were waiting for deployment (GitLab). */
  mrs?: boolean;
  post?: boolean;
  out?: string;
  /** Tests only: how long to sleep between checks. */
  pollMs?: number;
}

export const EXIT_STILL_WAITING = 75; // EX_TEMPFAIL: run again later

export const WAITING_LABEL = "qa-sentinel::waiting_for_deployment";

/** The commits a deployment brought: before..sha, or without `before` the last 20. */
function deployedCommits(repo: string, sha: string, before?: string): { sha: string; message: string }[] {
  const range = before && !/^0+$/.test(before) ? [`${before}..${sha}`] : ["-n", "20", sha];
  const read = (args: string[]) =>
    git(repo, ["log", "--format=%H%x09%B%x1e", ...args])
      .split("\x1e")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => ({ sha: l.slice(0, l.indexOf("\t")), message: l.slice(l.indexOf("\t") + 1) }));
  try {
    return read(range);
  } catch {
    try {
      return read(["-n", "20", sha]); // `before` unknown here: fall back
    } catch {
      return [];
    }
  }
}

/**
 * Every story key named in the commits this deployment brought (before..sha; without `before`, the last 20 commits).
 * Not only keys that have tests: a bug fix with no tests of its own is how its feature gets checked again.
 */
export function storiesFromService(c: Config, repo: string, sha: string, before?: string): string[] {
  if (!isGitRepo(repo)) return [];
  return extractStoryKeys(jiraKeyPattern(c), ...deployedCommits(repo, sha, before).map((x) => x.message));
}

/**
 * Keys for the deployed commits that the commit messages do not give: a commit that a recorded merge request merged
 * (the record knows its commit), else the merge request GitLab lists for the commit (title, source branch, description).
 */
async function keysBehindCommits(c: Config, svc: { name: string; gitlabProject?: string }, commits: { sha: string; message: string }[], records: StoryRecord[], gitlab: GitLabContext | undefined): Promise<string[]> {
  const pattern = jiraKeyPattern(c);
  const out: string[] = [];
  let calls = 0;
  for (const cm of commits) {
    if (extractStoryKeys(pattern, cm.message).length) continue;
    const viaRecord = records.filter((r) => r.parts.some((p) => p.service === svc.name && [p.mergeSha, p.squashSha, p.headSha].some((x) => x && (x === cm.sha || cm.sha.startsWith(x)))));
    if (viaRecord.length) {
      out.push(...viaRecord.map((r) => r.key));
      continue;
    }
    if (gitlab && svc.gitlabProject && calls++ < 20) {
      const mrs = await mergeRequestsForCommit(gitlab, svc.gitlabProject, cm.sha).catch(() => []);
      for (const m of mrs) out.push(...extractStoryKeys(pattern, m.title, m.source_branch, m.description));
    }
  }
  return [...new Set(out)];
}

export interface FeatureTarget {
  feature: string;
  /** The deployed bug, task or sub-task cards that led to this feature. */
  bugs: { key: string; issueType?: string; via: "parent" | "link" }[];
}

/**
 * Deployed keys → the features to check. A bug, task or sub-task is its story's change: its feature's tests run again
 * (strict Jira rules, see stories/resolve.ts). A key Jira does not know is dropped with a note; without Jira the keys are used as they are.
 */
export async function featuresForKeys(c: Config, jira: JiraContext | undefined, keys: string[]): Promise<{ targets: FeatureTarget[]; notes: string[] }> {
  const targets = new Map<string, FeatureTarget>();
  const notes: string[] = [];
  const add = (feature: string, bug?: FeatureTarget["bugs"][number]) => {
    const k = [...targets.keys()].find((x) => x.toLowerCase() === feature.toLowerCase()) ?? feature;
    const t = targets.get(k) ?? { feature: k, bugs: [] };
    if (bug && !t.bugs.some((b) => b.key === bug.key)) t.bugs.push(bug);
    targets.set(k, t);
  };
  if (!jira) for (const k of keys) add(k);
  else
    for (const r of await resolveKeysCached(c, jira, keys, { hasCode: true })) {
      if (r.via === "not-found") notes.push(r.explain);
      else if (r.via === "error") {
        notes.push(`${r.explain}; its key is used as it is`);
        add(r.work);
      } else if (r.feature && (r.via === "parent" || r.via === "link")) add(r.feature, { key: r.work, issueType: r.workIssue?.issueType, via: r.via });
      else add(r.feature ?? r.work);
    }
  return { targets: [...targets.values()], notes };
}

/** The Playwright --grep for a feature's tests and its bug fixes' tests. */
export function featureGrep(feature: string, bugs: string[]): string {
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [feature, ...bugs].map((k, i) => `@${i === 0 ? "story" : "bug"}:(?:\\S*,)?${esc(k)}(?![\\w-])`).join("|");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface StoryOutcome {
  story: string;
  status: "passed" | "failed" | "waiting" | "no-tests" | "not-merged" | "reverted" | "blocked" | "bdd-only";
  /** Why it was checked, when it was not named itself: "fix SHOP-210 (Bug → SHOP-12) deployed". */
  reason?: string;
  manifest: FeatureManifest;
  report?: VerificationReport;
}

/**
 * `qa-sentinel post-deploy --env sit`: after a deployment, for each story it touches: are all the services it needs
 * deployed? Then run the story's tests there and report per story (and on Jira). Parts not deployed yet are checked
 * again (--wait); still missing at the end means exit 75, so a schedule or the next deployment checks again. Agent MRs
 * that were waiting for deployment are verified again and updated (--mrs).
 */
export async function postDeployCommand(o: PostDeployOptions): Promise<number> {
  const cwd = path.resolve(o.cwd);
  const c = loadConfig(cwd);
  const environment = useEnvironment(c, o.env);
  if (!environment) throw new Error("post-deploy needs --env (an environment from `environments:`)");
  const baseUrl = process.env[c.tests.api.baseUrlEnv]!;
  const index = indexTests(cwd, c);
  const gl = c.workspace.services.some((s) => s.gitlabProject) || o.mrs ? gitlabContext(c.ci.gitlabUrl) : undefined;
  const store = openStore(cwd, c);
  const keys = new Set((o.stories ?? []).map((s) => s.toUpperCase()));
  if (o.service && o.sha) {
    const svc = findService(c, o.service, cwd, o.servicePath);
    const repo = path.resolve(cwd, svc.path);
    for (const k of storiesFromService(c, repo, o.sha, o.before)) keys.add(k);
    // Commits that name no key: the record or GitLab knows the merge request they came from.
    const records = await store.list().catch(() => [] as StoryRecord[]);
    for (const k of await keysBehindCommits(c, svc, isGitRepo(repo) ? deployedCommits(repo, o.sha, o.before) : [], records, gl)) keys.add(k);
  }
  const { targets, notes: keyNotes } = await featuresForKeys(c, jiraContext(c.requirements.jira), [...keys]);
  keyNotes.forEach((n) => log.warn(n));
  const stories = new Set(targets.map((t) => t.feature));
  const targetOf = new Map(targets.map((t) => [t.feature, t]));
  const deadline = Date.now() + (o.waitMinutes ?? 0) * 60_000;
  const poll = o.pollMs ?? 60_000;
  const outcomes: StoryOutcome[] = [];

  for (const story of stories) {
    const target = targetOf.get(story)!;
    // A key can be the bug fix itself: its own @bug:KEY tests count, with or without Jira.
    const bugKeys = [story, ...target.bugs.map((b) => b.key)];
    const reason = target.bugs.length ? `re-run: fix ${target.bugs.map((b) => `${b.key}${b.issueType ? ` (${b.issueType} → ${story})` : ""}`).join(", ")} deployed` : undefined;
    const tests = index.filter((t) => (t.stories.includes(story) || t.bugs.some((b) => bugKeys.includes(b))) && t.status === "active" && !t.bdd);
    const bddOnly = !tests.length && index.some((t) => t.stories.includes(story) && t.status === "active" && t.bdd);
    let manifest = await assembleFeature({ c, cwd, story, gitlab: gl, environment, baseUrl });
    // Waiting for deployment only matters when there is something to run afterwards.
    while (tests.length && manifest.status === "waiting-for-deployment" && Date.now() + poll <= deadline) {
      log.dim(`  ${story}: waiting for deployment (${manifest.parts.filter((p) => p.merged && !p.deployed?.includesChange).map((p) => p.service).join(", ")}); checking again in ${Math.round(poll / 1000)} s`);
      await sleep(poll);
      manifest = await assembleFeature({ c, cwd, story, gitlab: gl, environment, baseUrl });
    }
    // A deployed bug fix is checked even while its feature has another MR open: the fix itself is deployed.
    const fixDeployed = target.bugs.length > 0 && manifest.status === "in-development";
    if (!tests.length && !bddOnly) outcomes.push({ story, status: "no-tests", manifest, reason });
    else if (manifest.status === "waiting-for-deployment") outcomes.push({ story, status: "waiting", manifest, reason });
    else if (manifest.status === "in-development" && !fixDeployed) outcomes.push({ story, status: "not-merged", manifest, reason });
    else if (manifest.status === "reverted") outcomes.push({ story, status: "reverted", manifest, reason });
    else if (bddOnly) outcomes.push({ story, status: "bdd-only", manifest, reason });
    else {
      log.step(`${story}: every part is deployed on ${environment}; running ${tests.length} test(s)`);
      const run = createRunDir(cwd, `post-deploy-${story}`);
      const files = [...new Set(tests.map((t) => t.file))].map((p) => ({ path: p, status: "M" }));
      // Only this story's tests: other tests in the same files are not what this check is about.
      const grep = featureGrep(story, bugKeys);
      const report = await verifyChanges({ cwd, c, changes: files, runDir: run.dir, env: testEnv(c, process.env, { healing: true }), environment, grep });
      const status = report.status === "VERIFIED" ? "passed" : report.status === "FAILED" ? "failed" : "blocked";
      outcomes.push({ story, status, manifest, report, reason });
      await rememberResult(store, story, { environment, status, tests: tests.length }).catch((e) => log.warn(`story record for ${story} not updated: ${(e as Error).message.split("\n")[0]}`));
    }
  }

  const md = ["# After deployment", "", `Environment: **${environment}**`, ""];
  for (const x of outcomes) {
    const head = { passed: "✅ tests passed", failed: "❌ tests failed", waiting: "⏳ waiting for deployment", "no-tests": "⬜ no tests tagged", "not-merged": "🚧 not merged yet", blocked: "⛔ tests could not run", reverted: "↩️ reverted: tests held back", "bdd-only": "🥒 deployed; its tests are Cucumber scenarios: run them with your BDD job" }[x.status];
    const body = [`## ${x.story}: ${head}`, ...(x.reason ? ["", `_${x.reason}_`] : []), "", featureMarkdown(x.manifest).replace(/^#+ .*\n/, ""), ...(x.report ? ["", verificationMarkdown(x.report)] : [])].join("\n");
    md.push(body, "");
    if (o.post && (x.status === "passed" || x.status === "failed" || x.status === "waiting")) {
      const jira = jiraContext(c.requirements.jira);
      if (jira) await postToStory(c, jira, x.story, { name: "post-deploy", wiki: markdownToJiraWiki(body), legacyKind: "post-deploy", legacyMarker: "qa-sentinel:post-deploy", cwd, parts: x.manifest.parts }).catch((e) => log.warn(`  Jira ${x.story}: ${(e as Error).message}`));
    }
    log[x.status === "passed" ? "ok" : x.status === "failed" ? "fail" : "warn"](`${x.story}: ${head}`);
  }
  for (const n of keyNotes) md.push(`> ${n}`, "");
  if (!stories.size) {
    md.push("_No story with tests found for this deployment._");
    log.info("no story with tests found for this deployment (pass --story, or --service with --sha)");
  }

  let mrWaiting = 0;
  let mrFailed = 0;
  if (o.mrs) {
    const r = await recheckAgentMrs(cwd, c, environment, baseUrl, o.post);
    md.push("", ...r.lines);
    mrWaiting = r.waiting;
    mrFailed = r.failed;
  }

  const out = path.resolve(cwd, o.out ?? "qa-post-deploy.md");
  fs.writeFileSync(out, md.join("\n") + "\n");
  log.dim(`report: ${path.relative(cwd, out)}`);
  if (outcomes.some((x) => x.status === "failed" || x.status === "blocked") || mrFailed) return 1;
  if (outcomes.some((x) => x.status === "waiting") || mrWaiting) {
    log.info("Some changes aren't deployed yet: run post-deploy again after the next deployment (or let the scheduled re-check do it).");
    return EXIT_STILL_WAITING;
  }
  return 0;
}

/** What this check found goes into the story record: the environment, when, against which basis, and how it ended. */
async function rememberResult(store: ReturnType<typeof openStore>, story: string, r: { environment: string; status: string; tests: number }): Promise<void> {
  if (!SAFE_KEY.test(story)) return;
  const now = new Date();
  await store.locked(story, async () => {
    const rec = (await store.load(story)) ?? emptyRecord(story, now);
    const basis = rec.basis ?? storyBasis(rec, rec.acs.map((a) => a.hash));
    await store.save({ ...rec, results: [...rec.results, { environment: r.environment, at: now.toISOString(), basis, status: r.status, tests: r.tests }], updatedAt: now.toISOString() });
  });
}

/**
 * Open agent MRs labelled waiting-for-deployment: when every service commit they were written for is deployed,
 * verify the branch again and update the MR (ready when VERIFIED). The test repo's working tree must be clean.
 */
async function recheckAgentMrs(cwd: string, c: Config, environment: string, baseUrl: string, post?: boolean): Promise<{ lines: string[]; waiting: number; failed: number }> {
  const lines = ["## Agent merge requests waiting for deployment", ""];
  const ctx = gitlabContext(c.ci.gitlabUrl);
  const project = c.ci.testRepoProject ?? process.env.CI_PROJECT_ID;
  if (!ctx || !project) {
    lines.push("_Skipped: set QA_SENTINEL_GITLAB_TOKEN and ci.testRepoProject._");
    return { lines, waiting: 0, failed: 0 };
  }
  const mrs = await getAll(ctx, `/projects/${encodeURIComponent(project)}/merge_requests?state=opened&labels=${encodeURIComponent(WAITING_LABEL)}`);
  if (!mrs.length) lines.push("_None._");
  // Return to where we started: the branch, or the commit on a detached CI checkout.
  const startRef = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const start = startRef === "HEAD" ? git(cwd, ["rev-parse", "HEAD"]) : startRef;
  // Fetch with a one-off token URL (CI removes the job token from origin), into explicit remote-tracking refs.
  const projectPath = c.ci.testRepoProject && !/^\d+$/.test(c.ci.testRepoProject) ? c.ci.testRepoProject : process.env.CI_PROJECT_PATH;
  const remote = pushUrl(c.ci.gitlabUrl, projectPath) ?? "origin";
  let waiting = 0;
  let failed = 0;
  for (const mr of mrs) {
    const branch = String(mr.source_branch);
    try {
      if (!/^[\w./-]+$/.test(branch) || branch.includes("..")) throw new Error("unexpected branch name");
      git(cwd, ["fetch", "-q", remote, `+refs/heads/${branch}:refs/remotes/origin/${branch}`, `+refs/heads/${c.ci.targetBranch}:refs/remotes/origin/${c.ci.targetBranch}`]);
      const base = git(cwd, ["merge-base", `origin/${c.ci.targetBranch}`, `origin/${branch}`]);
      const needs = needsFromCommits(c, cwd, base, `origin/${branch}`);
      const states = await deploymentStates(needs, environment, baseUrl, ctx);
      if (states.some((s) => s.includesChange === false)) {
        waiting++;
        lines.push(`- !${mr.iid} ${branch}: still waiting (${states.filter((s) => !s.includesChange).map((s) => s.service).join(", ")})`);
        continue;
      }
      git(cwd, ["checkout", "-q", "-B", branch, `origin/${branch}`]);
      const run = createRunDir(cwd, `post-deploy-mr-${mr.iid}`);
      const changes = git(cwd, ["diff", "--name-status", base, "HEAD"]).split("\n").filter(Boolean).map((l) => ({ status: l[0], path: l.split("\t").at(-1)! }));
      const report = applyDeploymentGate(await verifyChanges({ cwd, c, changes, runDir: run.dir, env: testEnv(c), environment }), states);
      const ok = report.status === "VERIFIED";
      if (report.status === "FAILED") failed++;
      else if (!ok) waiting++; // blocked, not run: check again next time
      lines.push(`- !${mr.iid} ${branch}: ${report.status}`);
      if (post) await updateMr(ctx, project, mr, report, environment);
    } catch (e) {
      failed++;
      lines.push(`- !${mr.iid} ${branch}: could not be checked (${(e as Error).message.split("\n")[0]})`);
    } finally {
      try {
        git(cwd, ["checkout", "-q", start]);
      } catch {
        // stay where we are
      }
    }
  }
  return { lines, waiting, failed };
}

async function updateMr(ctx: GitLabContext, project: string, mr: any, report: VerificationReport, environment: string): Promise<void> {
  const ok = report.status === "VERIFIED";
  // Only a real answer (verified or failed) ends the wait; blocked or not run keeps the MR on the re-check list.
  const settled = ok || report.status === "FAILED";
  const current: string[] = Array.isArray(mr.labels) ? mr.labels : String(mr.labels ?? "").split(",");
  const labels = current.filter((l) => l && (!settled || l !== WAITING_LABEL) && !/^qa-sentinel::(verified|failed|blocked|not_run)$/.test(l));
  const title = ok ? String(mr.title).replace(/^Draft:\s*/i, "").replace(/\s*\((waiting for deployment|WAITING_FOR_DEPLOYMENT)\)$/, "") : String(mr.title);
  await createOrUpdateMergeRequest(ctx, project, {
    source: mr.source_branch,
    target: mr.target_branch,
    title,
    description: mr.description ?? "",
    labels: [...new Set([...labels, `qa-sentinel::${report.status.toLowerCase()}`])],
  });
  await call(ctx, "POST", `/projects/${encodeURIComponent(project)}/merge_requests/${mr.iid}/notes`, {
    body: `**After deployment to ${environment}:** ${verificationMarkdown(report)}`,
  });
  // A fresh MR pipeline, so its checks (qa-agent-mr-checks) run again now that the change is deployed.
  if (settled) await call(ctx, "POST", `/projects/${encodeURIComponent(project)}/merge_requests/${mr.iid}/pipelines`).catch((e) => log.warn(`  !${mr.iid}: could not start an MR pipeline (${(e as Error).message.split("\n")[0]})`));
}
