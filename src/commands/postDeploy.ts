import fs from "node:fs";
import path from "node:path";
import { loadConfig, type Config } from "../config.js";
import { assembleFeature, featureMarkdown, type FeatureManifest } from "../feature/manifest.js";
import { indexTests, type IndexedTest } from "../analysis/testIndex.js";
import { git, isGitRepo } from "../git.js";
import { createRunDir, findService, testEnv, useEnvironment } from "../run.js";
import { verificationMarkdown, verifyChanges, type VerificationReport } from "../verification.js";
import { applyDeploymentGate, deploymentStates, needsFromCommits } from "../deployment.js";
import { call, createOrUpdateMergeRequest, getAll, gitlabContext, pushUrl, type GitLabContext } from "../scm/gitlab.js";
import { jiraContext, markdownToJiraWiki } from "../scm/jira.js";
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

/**
 * Stories named in the commits this deployment brought (before..sha; without `before`, the last 20 commits), that
 * have tests.
 */
export function storiesFromService(c: Config, repo: string, sha: string, index: IndexedTest[], before?: string): string[] {
  if (!isGitRepo(repo)) return [];
  let log_ = "";
  const range = before && !/^0+$/.test(before) ? [`${before}..${sha}`] : ["-n", "20", sha];
  try {
    log_ = git(repo, ["log", "--format=%B%x1e", ...range]);
  } catch {
    try {
      log_ = git(repo, ["log", "--format=%B%x1e", "-n", "20", sha]); // `before` unknown here: fall back
    } catch {
      return [];
    }
  }
  const re = new RegExp(`\\b(${c.requirements.storyKeyPattern})\\b`, "g");
  const tagged = new Set(index.flatMap((t) => t.stories));
  return [...new Set([...log_.matchAll(re)].map((m) => m[1]))].filter((s) => tagged.has(s));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface StoryOutcome {
  story: string;
  status: "passed" | "failed" | "waiting" | "no-tests" | "not-merged" | "blocked" | "bdd-only";
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
  const stories = new Set((o.stories ?? []).map((s) => s.toUpperCase()));
  if (o.service && o.sha) {
    const svc = findService(c, o.service, cwd, o.servicePath);
    for (const s of storiesFromService(c, path.resolve(cwd, svc.path), o.sha, index, o.before)) stories.add(s);
  }
  const gl = c.workspace.services.some((s) => s.gitlabProject) || o.mrs ? gitlabContext(c.ci.gitlabUrl) : undefined;
  const deadline = Date.now() + (o.waitMinutes ?? 0) * 60_000;
  const poll = o.pollMs ?? 60_000;
  const outcomes: StoryOutcome[] = [];

  for (const story of stories) {
    let manifest = await assembleFeature({ c, cwd, story, gitlab: gl, environment, baseUrl });
    while (manifest.status === "waiting-for-deployment" && Date.now() + poll <= deadline) {
      log.dim(`  ${story}: waiting for deployment (${manifest.parts.filter((p) => p.merged && !p.deployed?.includesChange).map((p) => p.service).join(", ")}); checking again in ${Math.round(poll / 1000)} s`);
      await sleep(poll);
      manifest = await assembleFeature({ c, cwd, story, gitlab: gl, environment, baseUrl });
    }
    const tests = index.filter((t) => t.stories.includes(story) && t.status === "active" && !t.bdd);
    const bddOnly = !tests.length && index.some((t) => t.stories.includes(story) && t.status === "active" && t.bdd);
    if (manifest.status === "waiting-for-deployment") outcomes.push({ story, status: "waiting", manifest });
    else if (manifest.status === "in-development") outcomes.push({ story, status: "not-merged", manifest });
    else if (bddOnly) outcomes.push({ story, status: "bdd-only", manifest });
    else if (!tests.length) outcomes.push({ story, status: "no-tests", manifest });
    else {
      log.step(`${story}: every part is deployed on ${environment}; running ${tests.length} test(s)`);
      const run = createRunDir(cwd, `post-deploy-${story}`);
      const files = [...new Set(tests.map((t) => t.file))].map((p) => ({ path: p, status: "M" }));
      // Only this story's tests: other tests in the same files are not what this check is about.
      const grep = `@story:(?:\\S*,)?${story.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`;
      const report = await verifyChanges({ cwd, c, changes: files, runDir: run.dir, env: testEnv(c, process.env, { healing: true }), environment, grep });
      outcomes.push({ story, status: report.status === "VERIFIED" ? "passed" : report.status === "FAILED" ? "failed" : "blocked", manifest, report });
    }
  }

  const md = ["# After deployment", "", `Environment: **${environment}**`, ""];
  for (const x of outcomes) {
    const head = { passed: "✅ tests passed", failed: "❌ tests failed", waiting: "⏳ waiting for deployment", "no-tests": "⬜ no tests tagged", "not-merged": "🚧 not merged yet", blocked: "⛔ tests could not run", "bdd-only": "🥒 deployed; its tests are Cucumber scenarios: run them with your BDD job" }[x.status];
    const body = [`## ${x.story}: ${head}`, "", featureMarkdown(x.manifest).replace(/^#+ .*\n/, ""), ...(x.report ? ["", verificationMarkdown(x.report)] : [])].join("\n");
    md.push(body, "");
    if (o.post && (x.status === "passed" || x.status === "failed" || x.status === "waiting")) {
      const jira = jiraContext(c.requirements.jira.baseUrl);
      if (jira) await postToStory(c, jira, x.story, { name: "post-deploy", wiki: markdownToJiraWiki(body), legacyKind: "post-deploy", legacyMarker: "qa-sentinel:post-deploy" }).catch((e) => log.warn(`  Jira ${x.story}: ${(e as Error).message}`));
    }
    log[x.status === "passed" ? "ok" : x.status === "failed" ? "fail" : "warn"](`${x.story}: ${head}`);
  }
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
