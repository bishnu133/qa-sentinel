#!/usr/bin/env node
// ShopLite on your laptop – no GitLab needed.
//
//   node sandbox/shoplite/local.mjs setup [--level maintenance] [--work ./shoplite-local]
//   node sandbox/shoplite/local.mjs list
//   node sandbox/shoplite/local.mjs run SHOP-101 [--generate]     # make the dev change, gap report (+ generate tests)
//   node sandbox/shoplite/local.mjs run SHOP-101 --regression     # also run the existing tests qa-sentinel selected, against the change
//   node sandbox/shoplite/local.mjs run SHOP-105 --generate --showcase   # then run the suite and attach evidence if every AC passed
//   node sandbox/shoplite/local.mjs run SHOP-106 --change-only    # just make the developer change (no agent, no cost)
//   node sandbox/shoplite/local.mjs merge SHOP-106                 # merge a scenario's branch into main (like merging the MR)
//   node sandbox/shoplite/local.mjs feature SHOP-106 [--run]       # one story across services: merged? deployed? AC tests? (then run them)
//   node sandbox/shoplite/local.mjs reset                          # every service back to main, env stopped
//   node sandbox/shoplite/local.mjs env start|stop
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { CLI, HERE, SERVICES, TEST_REPO, buildServices, buildTests, die, flags, git, log, makeChange, scenario } from "./lib.mjs";
import { SCENARIOS } from "./scenarios.mjs";

const f = flags(process.argv.slice(2));
const [cmd, arg] = f._;
const work = path.resolve(typeof f.work === "string" ? f.work : "shoplite-local");
const tests = path.join(work, TEST_REPO);
const run = (cmdline, args, opts = {}) => {
  const r = spawnSync(cmdline, args, { stdio: "inherit", ...opts });
  return r.status ?? 1;
};

function envStart() {
  envStop(true);
  const code = run("bash", ["-c", `source "${path.join(tests, "qa-env/start.sh")}"`], {
    env: { ...process.env, QA_ENV_LOCAL_SERVICES: work, QA_ENV_DIR: path.join(work, ".qa-env") },
  });
  if (code !== 0) die("QA environment did not start");
}
function envStop(quiet = false) {
  run("bash", [path.join(HERE, "tests-extra/qa-env/stop.sh")], { stdio: quiet ? "ignore" : "inherit" });
}

switch (cmd) {
  case "setup": {
    fs.mkdirSync(work, { recursive: true });
    buildServices(work);
    buildTests(work, { level: f.level === "maintenance" ? "maintenance" : "intelligence" });
    fs.mkdirSync(path.join(work, "stories"), { recursive: true });
    for (const s of SCENARIOS) fs.writeFileSync(path.join(work, "stories", `${s.id}.md`), `# ${s.title}\n\n${s.story}\n`);
    log(`ShopLite ready in ${work}`);
    log(`next: node sandbox/shoplite/local.mjs run SHOP-101`);
    break;
  }
  case "list":
    for (const s of SCENARIOS) console.log(`${s.id.padEnd(9)} ${s.service.padEnd(22)} ${s.title.replace(/^SHOP-\d+:\s*/, "")}\n          expect: ${s.expect}\n`);
    break;
  case "env":
    arg === "stop" ? envStop() : envStart();
    break;
  case "reset":
    envStop(true);
    for (const svc of SERVICES) git(path.join(work, svc), "checkout", "-q", "-f", "main");
    git(tests, "checkout", "-q", "-f", "main");
    log("all repos back on main; environment stopped");
    break;
  case "merge": {
    // Play the developer merging a scenario's branch into main (local stand-in for an MR merge).
    const s = scenario(arg);
    const dir = path.join(work, s.service);
    git(dir, "checkout", "-q", "-f", "main");
    git(dir, "merge", "-q", "--no-ff", s.branch, "-m", `Merge branch '${s.branch}' into 'main'`);
    log(`${s.service}: merged ${s.branch} into main`);
    break;
  }
  case "feature": {
    // Story across services: deploy main of every service locally, then ask qa-sentinel where the feature stands.
    const key = String(arg ?? "").toUpperCase();
    if (!key) die("usage: local.mjs feature SHOP-106 [--run]");
    for (const svc of SERVICES) git(path.join(work, svc), "checkout", "-q", "-f", "main");
    envStart();
    const storyFile = path.join(work, "stories", `${key}.md`);
    const code = run("node", [CLI, "feature", key, "--env", "local", ...(fs.existsSync(storyFile) ? ["--story-file", storyFile] : []), ...(f.run ? ["--run"] : [])], {
      cwd: tests,
      env: { ...process.env, QA_BASE_URL: "http://127.0.0.1:8080" },
    });
    envStop(true);
    log(`feature summary: ${path.join(tests, `qa-feature-${key}.md`)}`);
    process.exitCode = code;
    break;
  }
  case "run": {
    if (!fs.existsSync(tests)) die(`no sandbox in ${work}; run: node sandbox/shoplite/local.mjs setup`);
    const s = scenario(arg);
    const svcDir = path.join(work, s.service);
    for (const svc of SERVICES) git(path.join(work, svc), "checkout", "-q", "-f", "main");
    const prev = git(tests, "branch", "--show-current");
    if (prev.startsWith("qa-sentinel/")) log(`generated tests stay on branch ${prev} (review: git -C ${tests} diff main ${prev})`);
    git(tests, "checkout", "-q", "-f", "main");
    log(`${s.id}: developer change on ${s.service} (${s.branch})`);
    makeChange(svcDir, s);
    console.log(`  expect: ${s.expect}\n`);
    if (f["change-only"]) {
      log(`change committed on ${s.service} branch ${s.branch}; no qa-sentinel run (--change-only)`);
      break;
    }
    const story = path.join(work, "stories", `${s.id}.md`);
    const gap = run("node", [CLI, "gap-report", "-s", s.service, "--base", "main", "--head", "HEAD", "--story-file", story, "-o", `../${s.id}-gap-report.md`], { cwd: tests });
    log(`gap report: ${path.join(work, `${s.id}-gap-report.md`)}`);
    if (f.regression) {
      // Run the existing tests qa-sentinel selected, against the developer's change: do the predicted breaks happen?
      const selected = fs.existsSync(path.join(work, "qa-regression.txt")) ? fs.readFileSync(path.join(work, "qa-regression.txt"), "utf8").split("\n").filter(Boolean) : [];
      envStart();
      log(`running ${selected.length || "all"} selected existing test(s) against ${s.service} with the change`);
      run("npx", ["playwright", "test", "--project=api", "--reporter=list", ...selected], { cwd: tests, env: { ...process.env, QA_BASE_URL: "http://127.0.0.1:8080" } });
      envStop(true);
    }
    if (f.generate) {
      envStart();
      const code = run("node", [CLI, "generate", "-s", s.service, "--base", "main", "--head", "HEAD", "--story-file", story], {
        cwd: tests,
        env: { ...process.env, QA_BASE_URL: "http://127.0.0.1:8080" },
      });
      envStop(true);
      const branch = git(tests, "branch", "--show-current");
      if (f.showcase) {
        // Showcase: run the whole suite on the generated branch (json reporter keeps evidence), then attach evidence
        // for the story if every acceptance criterion passed. Without JIRA_* it only assesses (--dry-run).
        envStart();
        run("npx", ["playwright", "test", "--project=api"], { cwd: tests, env: { ...process.env, QA_BASE_URL: "http://127.0.0.1:8080" } });
        envStop(true);
        const jira = process.env.JIRA_BASE_URL && process.env.JIRA_API_TOKEN;
        run("node", [CLI, "showcase", "--story", s.id, "--story-file", story, ...(jira ? [] : ["--dry-run"]), "-o", `../${s.id}-showcase.md`], { cwd: tests });
        log(`showcase summary: ${path.join(work, `${s.id}-showcase.md`)}`);
      }
      log(`generation exit ${code}; MR description: ${path.join(tests, "qa-sentinel-summary.md")}; branch: ${branch}`);
      if (branch.startsWith("qa-sentinel/")) log(`review the generated tests: git -C ${tests} diff main ${branch}`);
      process.exitCode = code;
    } else process.exitCode = gap;
    break;
  }
  default:
    console.log(fs.readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1, 14).join("\n").replace(/^\/\/ ?/gm, ""));
}
