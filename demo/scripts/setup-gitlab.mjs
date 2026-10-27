#!/usr/bin/env node
// One-time setup of the demo on YOUR GitLab test group.   COSTS NO AI.  WRITES TO GITLAB (with --yes).
//
// Before: create EMPTY GitLab projects (see demo/README.md) and fill demo/demo.config.json.
//   export GITLAB_TOKEN=…        # personal access token, scope: api
//   node demo/scripts/setup-gitlab.mjs                  # dry run: shows what it would push
//   node demo/scripts/setup-gitlab.mjs --yes            # pushes the template, tags `demo-baseline`, cuts the release branch
//   node demo/scripts/setup-gitlab.mjs --build-only --out /tmp/demo-work    # builds the three folders locally; no network, no GitLab
//
// It records the projects and the baseline commits in demo/.demo-state.json. Every other script only works on the
// projects listed there.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_CONFIG, DEFAULT_STATE, DEMO_DIR, HERE, TEMPLATE_DIR, enc, fail, isMain, loadConfig, loadState, makeGitLab, redact, runCli, saveState, say } from "./lib.mjs";

const GIT_ENV = { GIT_AUTHOR_NAME: "ShopLite Demo", GIT_AUTHOR_EMAIL: "demo@shoplite.test", GIT_COMMITTER_NAME: "ShopLite Demo", GIT_COMMITTER_EMAIL: "demo@shoplite.test", GIT_TERMINAL_PROMPT: "0" };
const git = (cwd, args, secrets = []) => {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...GIT_ENV }, stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (e) {
    throw new Error(redact(`git ${args[0]} failed: ${String(e.stderr || e.message).trim().slice(0, 300)}`, secrets));
  }
};

/** The qa-sentinel settings the demo needs, on top of what `qa-sentinel init` writes. Placeholders in, plain object out. */
export function configOverlay({ gitlabUrl, testsProject, services, jira }) {
  return {
    workspace: {
      services: services.map((s) => ({
        name: s.name,
        path: `../${s.name}`,
        openapi: "openapi.yaml",
        kind: "api",
        gitlabProject: s.project,
        dependsOn: s.name === "orders-service" ? services.filter((x) => x.name === "payments-service").map((x) => x.name) : [],
        version: { path: `/${s.name.replace(/-service$/, "")}/version`, field: "commit" },
      })),
    },
    ci: { gitlabUrl, testRepoProject: testsProject },
    requirements: {
      source: "jira",
      jira: {
        baseUrl: jira.baseUrl,
        projectKeys: [jira.project],
        ...(jira.auth && jira.auth !== "auto" ? { auth: jira.auth } : {}),
        approvedStatuses: ["In Progress", "Selected for Development", "Ready for Development", "In Review", "Done"],
        // A bug is "Relates" to its story: follow that link so a bug fix re-runs the story's tests.
        hierarchy: { links: [{ name: "Relates", from: ["Bug"] }] },
      },
    },
    reporting: { targets: ["gitlab-mr", "jira"] },
    bugs: { mode: "suggest" },
    environments: { local: { baseUrl: "http://127.0.0.1:8080", description: "Demo environment started by qa-env/start.sh" } },
  };
}

/** Deep merge: objects merge, arrays and values are replaced. */
function merge(a, b) {
  if (Array.isArray(b) || typeof b !== "object" || b === null) return b;
  const out = { ...(a && typeof a === "object" && !Array.isArray(a) ? a : {}) };
  for (const [k, v] of Object.entries(b)) out[k] = merge(out[k], v);
  return out;
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

const replaceIn = (file, pairs) => {
  let t = fs.readFileSync(file, "utf8");
  for (const [k, v] of pairs) t = t.split(k).join(v);
  fs.writeFileSync(file, t);
};

function qaSentinel(env = process.env) {
  if (env.QA_SENTINEL_BIN) return env.QA_SENTINEL_BIN.split(" ");
  const local = path.resolve(DEMO_DIR, "..", "dist", "cli.js");
  return fs.existsSync(local) ? ["node", local] : ["qa-sentinel"];
}

/** Build the working folders (services and test repo) from the template. Needs `qa-sentinel` (built) for `init`. Makes no network call. */
export async function buildWorkFolders({ config, out, env = process.env, log = say, install = false }) {
  const YAML = (await import("yaml")).default;
  fs.mkdirSync(out, { recursive: true });
  const dirs = {};
  for (const s of config.services) {
    const dir = path.join(out, s.name);
    fs.rmSync(dir, { recursive: true, force: true });
    copyDir(path.join(TEMPLATE_DIR, s.template ?? (s.name === "payments-service" ? "service-payments" : "service-orders")), dir);
    replaceIn(path.join(dir, ".gitlab-ci.yml"), [["__TESTS_PROJECT__", config.testsProject]]);
    dirs[s.name] = dir;
  }
  const tdir = path.join(out, "shoplite-tests");
  fs.rmSync(tdir, { recursive: true, force: true });
  fs.mkdirSync(tdir, { recursive: true });
  const [cmd, ...pre] = qaSentinel(env);
  log("  running qa-sentinel init for the test repo");
  execFileSync(cmd, [...pre, "init", "--yes", "--mode", "scratch", "--ci", "gitlab", "--level", "maintenance", "--workspace", "..", "--name", "shoplite-demo-tests"], { cwd: tdir, stdio: ["ignore", "pipe", "pipe"], env: { ...env, ...GIT_ENV } });
  fs.rmSync(path.join(tdir, "tests/api/example"), { recursive: true, force: true });
  copyDir(path.join(TEMPLATE_DIR, "tests"), tdir);
  replaceIn(path.join(tdir, ".gitlab-ci.yml"), [["__QA_ENV_SERVICES__", config.services.map((s) => `${s.name}=${s.project}`).join(" ")]]);
  // Services other than orders are listed in the map with no tests yet (the agent fills them in).
  for (const s of config.services.filter((x) => x.name !== "orders-service")) {
    fs.appendFileSync(path.join(tdir, "test-map.yaml"), `  ${s.name}:\n    path: ../${s.name}\n    openapi: openapi.yaml\n    endpoints: {}\n    screens: {}\n`);
  }
  // Settings init cannot know: services, GitLab, Jira, environment.
  const file = path.join(tdir, "qa-sentinel.config.yaml");
  const base = YAML.parse(fs.readFileSync(file, "utf8"));
  const merged = merge(base, configOverlay({ gitlabUrl: config.gitlabUrl, testsProject: config.testsProject, services: config.services, jira: config.jira ?? {} }));
  merged.tests = merge(merged.tests ?? {}, { api: { baseUrlEnv: "QA_BASE_URL" } });
  merged.guardrails = merge(merged.guardrails ?? {}, { allowedHosts: ["localhost", "127.0.0.1", "example.com", "example.test", "shoplite.test"] });
  fs.writeFileSync(file, "# qa-sentinel configuration for the demo. Secrets are NOT here: they are CI/CD variables.\n" + YAML.stringify(merged, { lineWidth: 100 }));
  if (install) {
    // CI runs `npm ci`, which needs a lockfile. Lockfile download addresses must be public ones (a company mirror is not reachable from CI).
    log("  npm install in the test repo (makes package-lock.json)");
    execFileSync("npm", ["install", "--no-audit", "--no-fund", "--silent"], { cwd: tdir, stdio: ["ignore", "pipe", "pipe"] });
    const lock = path.join(tdir, "package-lock.json");
    const bad = fs.existsSync(lock) ? (fs.readFileSync(lock, "utf8").match(/"resolved": "https?:\/\/(?!registry\.npmjs\.org\/)[^"]+"/g) ?? []) : [];
    if (bad.length) fail(`package-lock.json has ${bad.length} download address(es) outside registry.npmjs.org (a private npm mirror?). CI could not install them. Run setup on a machine with the public registry.`);
  }
  git(tdir, ["init", "-q", "-b", config.defaultBranch]);
  git(tdir, ["add", "-A"]);
  git(tdir, ["commit", "-q", "-m", "Demo: test repo set up with qa-sentinel"]);
  dirs["shoplite-tests"] = tdir;
  for (const s of config.services) {
    git(dirs[s.name], ["init", "-q", "-b", config.defaultBranch]);
    git(dirs[s.name], ["add", "-A"]);
    git(dirs[s.name], ["commit", "-q", "-m", "Demo: initial service"]);
  }
  return dirs;
}

export async function setupGitlab({ args = {}, env = process.env, configFile = DEFAULT_CONFIG, stateFile = DEFAULT_STATE, log = say } = {}) {
  const config = loadConfig(configFile);
  if (args["build-only"]) {
    const out = path.resolve(typeof args.out === "string" ? args.out : path.join(DEMO_DIR, ".work"));
    const dirs = await buildWorkFolders({ config, out, env, log });
    log(`Built ${Object.keys(dirs).length} folders in ${out}. Nothing was sent anywhere.`);
    return { dirs };
  }
  const writing = Boolean(args.yes);
  const projects = [config.testsProject, ...config.services.map((s) => s.project)];
  log(`GitLab: ${config.gitlabUrl}  ${writing ? "(WRITING)" : "(dry run: nothing is written; add --yes to write)"}`);
  for (const p of projects) log(`  project ${p}: push the template to ${config.defaultBranch}, tag demo-baseline${p === config.services[0].project ? `, create ${config.releaseBranch}` : ""}`);
  if (!writing) return { dryRun: true };

  const gl = makeGitLab(config.gitlabUrl, env);
  const token = env.GITLAB_TOKEN ?? env.QA_SENTINEL_GITLAB_TOKEN;
  const me = await gl.api("GET", "/user");
  log(`  logged in as ${me.username}`);
  for (const p of projects) {
    const info = await gl.api("GET", `/projects/${enc(p)}`).catch((e) => (e.status === 404 ? fail(`GitLab project ${p} does not exist (or the token cannot see it). Create it empty first.`) : Promise.reject(e)));
    if (info.empty_repo === false) fail(`${p} already has commits. Setup only fills EMPTY projects (it never overwrites). To start again, use reset.mjs, or create a new empty project.`);
  }

  const out = path.resolve(typeof args.out === "string" ? args.out : path.join(DEMO_DIR, ".work"));
  const dirs = await buildWorkFolders({ config, out, env, log, install: true });
  const state = loadState(stateFile);
  state.gitlab = { url: config.gitlabUrl, testsProject: config.testsProject, projects, defaultBranch: config.defaultBranch, releaseBranch: config.releaseBranch, baselines: {}, setupAt: new Date().toISOString() };
  const remote = (p) => `${new URL(config.gitlabUrl).protocol}//oauth2:${enc(token)}@${new URL(config.gitlabUrl).host}${new URL(config.gitlabUrl).pathname.replace(/\/$/, "")}/${p}.git`;
  const push = (dir, p, ref) => git(dir, ["push", "-q", "-o", "ci.skip", remote(p), ref], [token]);

  // The test repo goes first: the service pipelines include a file from it.
  const order = [{ dir: dirs["shoplite-tests"], project: config.testsProject, name: "shoplite-tests" }, ...config.services.map((s) => ({ dir: dirs[s.name], project: s.project, name: s.name }))];
  for (const o of order) {
    git(o.dir, ["tag", "-f", "demo-baseline"]);
    push(o.dir, o.project, `HEAD:refs/heads/${config.defaultBranch}`);
    push(o.dir, o.project, "refs/tags/demo-baseline");
    state.gitlab.baselines[o.project] = git(o.dir, ["rev-parse", "HEAD"]);
    log(`  pushed ${o.project} (tag demo-baseline = ${state.gitlab.baselines[o.project].slice(0, 8)})`);
  }
  // The hotfix card is fixed on the release branch of the first service.
  const first = order[1];
  push(first.dir, first.project, `HEAD:refs/heads/${config.releaseBranch}`);
  log(`  created ${config.releaseBranch} in ${first.project}`);
  saveState(stateFile, state);

  // Best effort, like the sandbox setup: tell the owner what to do by hand if it fails.
  await gl.api("PUT", `/projects/${enc(config.testsProject)}`, { ci_pipeline_variables_minimum_override_role: "developer" }).then(
    () => log("  pipeline variables allowed for Developer+ on the test repo (the generation trigger needs it)"),
    (e) => log(`  WARNING could not allow pipeline variables: ${e.message}. Set it in Settings > CI/CD > Variables > Minimum role to use pipeline variables.`),
  );
  const t = await gl.api("GET", `/projects/${enc(config.testsProject)}`);
  for (const s of config.services) {
    const sp = await gl.api("GET", `/projects/${enc(s.project)}`);
    for (const [from, to, label] of [[sp.id, t.id, `${s.name} -> tests`], [t.id, sp.id, `tests -> ${s.name}`]]) {
      await gl.api("POST", `/projects/${from}/job_token_scope/allowlist`, { target_project_id: to }).then(
        () => log(`  job-token access: ${label}`),
        (e) => log(e.status === 422 || e.status === 409 ? `  job-token access already set: ${label}` : `  WARNING could not set job-token access (${label}): ${e.message}. Set it in Settings > CI/CD > Job token permissions.`),
      );
    }
  }
  log("\nSetup done. Next: add the CI/CD variables (demo/README.md, step 5), then run a pipeline on the test repo once.");
  return { dryRun: false, state };
}

if (isMain(import.meta.url)) await runCli((args) => setupGitlab({ args }));
void HERE;
