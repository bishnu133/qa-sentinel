#!/usr/bin/env node
// Create the ShopLite sandbox on GitLab: 3 service projects + qa-tests, CI variables, job-token access, first push.
//
//   export GITLAB_TOKEN=glpat-…            # personal access token: api + write_repository scopes
//   export GITLAB_GROUP=my-shoplite         # a group you created in the GitLab UI (top-level groups can't be created by API on gitlab.com)
//   export ANTHROPIC_API_KEY=sk-ant-…       # stored as a masked group CI/CD variable for the agents
//   node sandbox/shoplite/setup-gitlab.mjs [--level intelligence|maintenance] [--package github:bishnu133/qa-sentinel#main] [--work ./shoplite-gitlab] [--dry-run]
//
// Optional: GITLAB_URL (default https://gitlab.com); JIRA_BASE_URL + JIRA_EMAIL + JIRA_API_TOKEN + JIRA_PROJECT (after jira-seed.mjs).
//
//   node sandbox/shoplite/setup-gitlab.mjs level maintenance   # later: switch the sandbox to level 2 and push the new pipelines
import fs from "node:fs";
import path from "node:path";
import { SERVICES, TEST_REPO, buildServices, buildTests, CLI, configure, commitAll, die, flags, git, gitlab, loadState, log, saveState, sh, testsCi } from "./lib.mjs";

const f = flags(process.argv.slice(2));
const env = process.env;
const group = env.GITLAB_GROUP || die("Set GITLAB_GROUP to the path of a GitLab group you own (create it in the UI first).");
const work = path.resolve(typeof f.work === "string" ? f.work : "shoplite-gitlab");
const pkg = typeof f.package === "string" ? f.package : "github:bishnu133/qa-sentinel#main";
const dry = Boolean(f["dry-run"]);
const gl = dry ? null : gitlab(env);
const jira = env.JIRA_BASE_URL ? { baseUrl: env.JIRA_BASE_URL, project: env.JIRA_PROJECT || "SHOP" } : undefined;

const api = async (method, route, body) => {
  if (dry) {
    log(`[dry-run] ${method} ${route}`);
    return method === "GET" && route.startsWith("/groups/") ? { id: 0, full_path: group } : { id: 0 };
  }
  return gl.api(method, route, body);
};
const enc = encodeURIComponent;

async function ensureProject(groupId, name) {
  try {
    return await api("GET", `/projects/${enc(`${group}/${name}`)}`);
  } catch (e) {
    if (e.status !== 404) throw e;
  }
  log(`creating project ${group}/${name}`);
  return api("POST", "/projects", { name, path: name, namespace_id: groupId, visibility: "private", initialize_with_readme: false });
}

async function setGroupVar(groupId, key, value, masked = true) {
  if (!value) return log(`skipping variable ${key} (not set)`);
  const body = { key, value, masked, protected: false, variable_type: "env_var" };
  try {
    await api("POST", `/groups/${groupId}/variables`, body);
  } catch (e) {
    if (e.status === 400 && /already been taken/.test(JSON.stringify(e.data))) await api("PUT", `/groups/${groupId}/variables/${key}`, body);
    else throw e;
  }
  log(`group variable ${key}${masked ? " (masked)" : ""}`);
}

async function allow(projectId, targetId, label) {
  try {
    await api("POST", `/projects/${projectId}/job_token_scope/allowlist`, { target_project_id: targetId });
    log(`job-token access: ${label}`);
  } catch (e) {
    if (e.status === 422 || e.status === 409 || /already in the job token allowlist/i.test(e.message)) return log(`job-token access already set: ${label}`);
    log(`⚠ could not set job-token access (${label}): ${e.message}. Set it in the UI: Settings › CI/CD › Job token permissions.`);
  }
}

/**
 * Push main. gitlab.com protects main against force pushes; with --force we allow it for this one push and
 * restore the protection afterwards (the sandbox repos are yours, and --force means "replace what's there").
 */
async function push(dir, projectPath, { skipCi = true, force = false } = {}) {
  if (dry) return log(`[dry-run] git push ${projectPath}`);
  const args = ["push", ...(force ? ["--force"] : []), ...(skipCi ? ["-o", "ci.skip"] : []), gl.remote(projectPath), "HEAD:refs/heads/main"];
  const route = `/projects/${enc(projectPath)}/protected_branches/main`;
  let restore;
  if (force) {
    const prot = await api("GET", route).catch((e) => (e.status === 404 ? undefined : Promise.reject(e)));
    if (prot && !prot.allow_force_push) {
      await api("PATCH", `${route}?allow_force_push=true`);
      restore = () => api("PATCH", `${route}?allow_force_push=false`);
    }
  }
  try {
    git(dir, ...args);
  } finally {
    if (restore) await restore().catch((e) => log(`⚠ could not restore force-push protection on ${projectPath}/main: ${e.message}`));
  }
  log(`pushed ${projectPath}${force ? " (replaced main)" : ""}${skipCi ? " (CI skipped)" : ""}`);
}

/**
 * The service repos trigger qa-tests with variables (QA_SERVICE_NAME, QA_SERVICE_SHA, …). New gitlab.com projects
 * don't allow pipeline variables by default ("Minimum role to use pipeline variables: No one allowed"), and the
 * downstream pipeline then fails to start. Allow Developer and up on the test repo.
 */
async function allowPipelineVariables(projectPath) {
  try {
    await api("PUT", `/projects/${enc(projectPath)}`, { ci_pipeline_variables_minimum_override_role: "developer" });
    log(`pipeline variables allowed for Developer+ on ${projectPath} (needed by the generation trigger)`);
  } catch (e) {
    log(`⚠ could not allow pipeline variables on ${projectPath}: ${e.message}. Set it in the UI: Settings › CI/CD › Variables › Minimum role to use pipeline variables › Developer.`);
  }
}

async function setup() {
  if (!fs.existsSync(CLI)) die("Build qa-sentinel first: npm install && npm run build");
  if (!env.ANTHROPIC_API_KEY && !dry) die("Set ANTHROPIC_API_KEY (it becomes a masked group CI/CD variable).");
  const level = f.level === "maintenance" ? "maintenance" : "intelligence";
  const g = await api("GET", `/groups/${enc(group)}`);
  log(`group ${group} (id ${g.id})`);

  const projects = {};
  for (const name of [TEST_REPO, ...SERVICES]) projects[name] = await ensureProject(g.id, name);
  for (const name of [TEST_REPO, ...SERVICES]) {
    if (!dry && projects[name].empty_repo === false && !f.force) die(`${group}/${name} already has commits. Re-run with --force to overwrite it, or use a new group.`);
  }

  fs.mkdirSync(work, { recursive: true });
  buildServices(work, { group });
  buildTests(work, { level, group, gitlabUrl: gl?.url ?? "https://gitlab.com", jira });

  // Variables first, so the very first pipelines have them.
  await setGroupVar(g.id, "ANTHROPIC_API_KEY", env.ANTHROPIC_API_KEY);
  await setGroupVar(g.id, "QA_SENTINEL_GITLAB_TOKEN", env.GITLAB_TOKEN);
  await setGroupVar(g.id, "QA_SENTINEL_PACKAGE", pkg, false);
  if (jira) {
    await setGroupVar(g.id, "JIRA_EMAIL", env.JIRA_EMAIL, false);
    await setGroupVar(g.id, "JIRA_API_TOKEN", env.JIRA_API_TOKEN);
  }

  // qa-tests must exist before services include its CI file.
  await push(path.join(work, TEST_REPO), `${group}/${TEST_REPO}`, { force: Boolean(f.force) });
  for (const svc of SERVICES) await push(path.join(work, svc), `${group}/${svc}`, { force: Boolean(f.force) });

  await allowPipelineVariables(`${group}/${TEST_REPO}`);

  // Job tokens: services clone qa-tests (gap report); qa-tests clones services (generation, QA env).
  const t = projects[TEST_REPO];
  for (const svc of SERVICES) {
    await allow(t.id, projects[svc].id, `${svc} → ${TEST_REPO}`);
    await allow(projects[svc].id, t.id, `${TEST_REPO} → ${svc}`);
  }

  saveState(work, { group, gitlabUrl: gl?.url, level, projects: Object.fromEntries(Object.entries(projects).map(([k, v]) => [k, { id: v.id, web_url: v.web_url }])) });
  const base = gl?.url ?? "https://gitlab.com";
  if (dry) {
    console.log(`\n✓ Dry run complete: nothing was changed on GitLab. Run again without --dry-run to create ${base}/${group}.`);
    return;
  }
  console.log(`
✓ ShopLite is on GitLab (level ${level}).
  ${base}/${group}

Next:
  1. Open ${base}/${group}/${TEST_REPO}/-/pipelines and run a pipeline on main (Build › Pipelines › Run pipeline)
     to see the API tests pass against the ephemeral environment.
  2. Simulate a developer:  node sandbox/shoplite/dev.mjs open SHOP-101
     Watch the merge request: the "qa-gap-report" job posts a QA impact comment.
  3. Merge it (node sandbox/shoplite/dev.mjs merge SHOP-101). At level maintenance this triggers test generation
     in ${TEST_REPO}, which opens a "QA agent" merge request.
`);
}

async function setLevel(level) {
  if (!["intelligence", "maintenance"].includes(level)) die("level must be intelligence or maintenance");
  const st = loadState(work);
  const dir = path.join(work, TEST_REPO);
  if (!fs.existsSync(dir)) die(`no ${dir}; run setup first (same --work)`);
  git(dir, "checkout", "-q", "main");
  sh("node", [CLI, "init", "--yes", "--force", "--mode", "scratch", "--ci", "gitlab", "--level", level, "--workspace", "..", "--name", "shoplite-tests"], { cwd: dir });
  fs.rmSync(path.join(dir, "tests/api/example"), { recursive: true, force: true });
  configure(dir, { level, group, gitlabUrl: st.gitlabUrl, jira });
  fs.writeFileSync(path.join(dir, ".gitlab-ci.yml"), testsCi(group));
  git(dir, "checkout", "-q", "--", "tests", "src", "package.json", "playwright.config.ts", "tsconfig.json");
  commitAll(dir, `ShopLite: switch qa-sentinel to level ${level}`);
  await push(dir, `${group}/${TEST_REPO}`, { skipCi: true, force: true });
  if (level === "maintenance") await allowPipelineVariables(`${group}/${TEST_REPO}`);
  saveState(work, { ...st, level });
  log(`level is now ${level}; service pipelines pick up the new jobs from ${TEST_REPO} automatically`);
}

const [cmd, arg] = f._;
(cmd === "level" ? setLevel(arg) : setup()).catch((e) => die(e.message));
