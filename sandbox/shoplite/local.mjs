#!/usr/bin/env node
// ShopLite on your laptop – no GitLab needed.
//
//   node sandbox/shoplite/local.mjs setup [--level maintenance] [--mobile] [--work ./shoplite-local]
//   node sandbox/shoplite/local.mjs list
//   node sandbox/shoplite/local.mjs run SHOP-101 [--generate]     # make the dev change, gap report (+ generate tests)
//   node sandbox/shoplite/local.mjs run SHOP-101 --regression     # also run the existing tests qa-sentinel selected, against the change
//   node sandbox/shoplite/local.mjs run SHOP-105 --generate --showcase   # then run the suite and attach evidence if every AC passed
//   node sandbox/shoplite/local.mjs run SHOP-108 --generate --showcase   # web: storefront change, page objects + web tests, video evidence
//   node sandbox/shoplite/local.mjs run SHOP-106 --change-only    # just make the developer change (no agent, no cost)
//   node sandbox/shoplite/local.mjs merge SHOP-106                 # merge a scenario's branch into main (like merging the MR)
//   node sandbox/shoplite/local.mjs feature SHOP-106 [--run]       # one story across services: merged? deployed? AC tests? (then run them)
//   node sandbox/shoplite/local.mjs story SHOP-106 [--generate]    # one gap report (and one test branch) for the whole story, all services
//   node sandbox/shoplite/local.mjs reset                          # every service back to main, env stopped
//   node sandbox/shoplite/local.mjs env start|stop
//   node sandbox/shoplite/local.mjs app build                      # (setup --mobile) build the Android app → shoplite-app/build/shoplite.apk
//   node sandbox/shoplite/local.mjs run SHOP-109 --generate --showcase   # mobile: app change, screen objects + app tests (emulator + Appium running)
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { APP, CLI, HERE, TEST_REPO, buildServices, buildTests, die, flags, git, log, makeChange, scenario, servicesIn } from "./lib.mjs";
import { SCENARIOS } from "./scenarios.mjs";

const f = flags(process.argv.slice(2));
// Where the QA environment answers: the API gateway and the storefront (qa-env/start.sh).
const QA_URLS = { QA_BASE_URL: "http://127.0.0.1:8080", QA_WEB_URL: "http://127.0.0.1:8081/" };
const [cmd, arg] = f._;
const work = path.resolve(typeof f.work === "string" ? f.work : "shoplite-local");
const tests = path.join(work, TEST_REPO);
const run = (cmdline, args, opts = {}) => {
  const r = spawnSync(cmdline, args, { stdio: "inherit", ...opts });
  return r.status ?? 1;
};

// Jira mode: with JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN set, stories come from Jira (seeded by jira-seed.mjs),
// gap reports are posted on the story and the showcase attaches evidence there. Otherwise stories are local files.
const JIRA = process.env.JIRA_BASE_URL && process.env.JIRA_EMAIL && process.env.JIRA_API_TOKEN ? { baseUrl: process.env.JIRA_BASE_URL, project: process.env.JIRA_PROJECT || "SHOP" } : undefined;
function jiraKeys() {
  const file = path.join(work, ".jira-keys.json");
  if (!fs.existsSync(file)) die(`Jira is configured but the stories aren't in Jira yet. Run: node sandbox/shoplite/jira-seed.mjs --work ${path.relative(process.cwd(), work) || "."}`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
/** The story key qa-sentinel sees: the real Jira key in Jira mode, else the scenario id (SHOP-106b → SHOP-106). */
function storyKeyOf(id) {
  if (!JIRA) return id;
  const key = jiraKeys()[id];
  if (!key) die(`${id} has no Jira issue in .jira-keys.json; run jira-seed.mjs again (new scenarios are added, existing ones kept)`);
  return key;
}
/** Requirements: from Jira in Jira mode, else the local story file. */
const storyArgs = (file) => (JIRA ? [] : ["--story-file", file]);

/**
 * Put qa-tests back on main without losing the user's config edits (bugs.mode, showcase.notify, …): a forced
 * checkout would silently discard them. Edits to qa-sentinel.config.yaml are carried over and committed on main.
 */
function testsToMain() {
  const cfg = path.join(tests, "qa-sentinel.config.yaml");
  const dirty = spawnSync("git", ["diff", "--quiet", "HEAD", "--", "qa-sentinel.config.yaml"], { cwd: tests }).status === 1;
  const edited = dirty ? fs.readFileSync(cfg, "utf8") : undefined;
  git(tests, "checkout", "-q", "-f", "main");
  if (edited !== undefined && edited !== fs.readFileSync(cfg, "utf8")) {
    fs.writeFileSync(cfg, edited);
    git(tests, "add", "qa-sentinel.config.yaml");
    git(tests, "-c", "user.name=sandbox", "-c", "user.email=sandbox@shoplite.test", "commit", "-q", "-m", "config: your edits (kept by local.mjs)");
    log("kept your qa-sentinel.config.yaml edits (committed on main)");
  }
}

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
    buildServices(work, { mobile: Boolean(f.mobile) });
    buildTests(work, { level: f.level === "maintenance" ? "maintenance" : "intelligence", jira: JIRA, mobile: Boolean(f.mobile) });
    if (JIRA) log(`Jira mode: stories from ${JIRA.baseUrl} (project ${JIRA.project}); seed them with jira-seed.mjs --work ${path.relative(process.cwd(), work) || "."}`);
    fs.mkdirSync(path.join(work, "stories"), { recursive: true });
    for (const s of SCENARIOS) fs.writeFileSync(path.join(work, "stories", `${s.id}.md`), `# ${s.title}\n\n${s.story}\n`);
    installBrowser();
    log(`ShopLite ready in ${work}`);
    if (f.mobile) log("mobile: start an Android emulator and Appium, then: node sandbox/shoplite/local.mjs app build && node sandbox/shoplite/local.mjs run SHOP-109");
    log(`next: node sandbox/shoplite/local.mjs run SHOP-101`);
    break;
  }
  case "list":
    for (const s of SCENARIOS) console.log(`${s.id.padEnd(9)} ${s.service.padEnd(22)} ${s.title.replace(/^SHOP-\d+:\s*/, "")}\n          expect: ${s.expect}\n`);
    break;
  case "env":
    arg === "stop" ? envStop() : envStart();
    break;
  case "app":
    if (arg !== "build") die("usage: local.mjs app build");
    buildApp();
    break;
  case "reset":
    envStop(true);
    for (const svc of servicesIn(work)) git(path.join(work, svc), "checkout", "-q", "-f", "main");
    testsToMain();
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
    const id = String(arg ?? "").toUpperCase();
    if (!id) die("usage: local.mjs feature SHOP-106 [--run]");
    const key = storyKeyOf(id);
    for (const svc of servicesIn(work)) git(path.join(work, svc), "checkout", "-q", "-f", "main");
    envStart();
    const storyFile = path.join(work, "stories", `${id}.md`);
    const code = run("node", [CLI, "feature", key, "--env", "local", ...(fs.existsSync(storyFile) ? storyArgs(storyFile) : []), ...(f.run ? ["--run"] : []), ...(JIRA && f.post ? ["--post"] : [])], {
      cwd: tests,
      env: { ...process.env, ...QA_URLS },
    });
    envStop(true);
    log(`feature summary: ${path.join(tests, `qa-feature-${key}.md`)}`);
    process.exitCode = code;
    break;
  }
  case "story": {
    // One analysis (and with --generate one test branch) for everything a story changed, across services.
    const id = String(arg ?? "").toUpperCase();
    if (!id) die("usage: local.mjs story SHOP-106 [--generate]");
    const key = storyKeyOf(id);
    for (const svc of servicesIn(work)) git(path.join(work, svc), "checkout", "-q", "-f", "main");
    testsToMain();
    const storyFile = path.join(work, "stories", `${id}.md`);
    const gap = run("node", [CLI, "gap-report", "--story", key, "--checkout", ...(fs.existsSync(storyFile) ? storyArgs(storyFile) : []), ...(JIRA ? ["--post"] : []), "-o", `../${id}-story-gap-report.md`], { cwd: tests });
    if (gap === 3) noClaude();
    log(`story gap report: ${path.join(work, `${id}-story-gap-report.md`)}`);
    if (f.generate) {
      envStart();
      const code = run("node", [CLI, "generate", "--story", key, "--checkout", ...(fs.existsSync(storyFile) ? storyArgs(storyFile) : [])], { cwd: tests, env: { ...process.env, ...QA_URLS } });
      envStop(true);
      if (code === 3) noClaude();
      log(`generation exit ${code}; branch: ${git(tests, "branch", "--show-current")}`);
      process.exitCode = code;
    } else process.exitCode = gap;
    break;
  }
  case "run": {
    if (!fs.existsSync(tests)) die(`no sandbox in ${work}; run: node sandbox/shoplite/local.mjs setup`);
    const s = scenario(arg);
    const svcDir = path.join(work, s.service);
    for (const svc of servicesIn(work)) git(path.join(work, svc), "checkout", "-q", "-f", "main");
    const prev = git(tests, "branch", "--show-current");
    if (prev.startsWith("qa-sentinel/")) log(`generated tests stay on branch ${prev} (review: git -C ${tests} diff main ${prev})`);
    testsToMain();
    const key = storyKeyOf(s.storyKey ?? s.id);
    log(`${s.id}${key !== s.id ? ` (Jira ${key})` : ""}: developer change on ${s.service} (${s.branch})`);
    // The commit message carries the story key, as a developer's would: that's how qa-sentinel finds the story.
    const mobile = s.service === APP;
    if (mobile && !fs.existsSync(svcDir)) die(`${s.id} is a mobile scenario: run setup with --mobile first (node sandbox/shoplite/local.mjs setup --mobile --level maintenance)`);
    makeChange(svcDir, s, { storyKey: key });
    console.log(`  expect: ${s.expect}\n`);
    if (f["change-only"]) {
      log(`change committed on ${s.service} branch ${s.branch}; no qa-sentinel run (--change-only)`);
      break;
    }
    const story = path.join(work, "stories", `${s.id}.md`);
    // Jira mode: the plain-language summary is posted on the story (--post); the full report stays in the file.
    const gap = run("node", [CLI, "gap-report", "-s", s.service, "--base", "main", "--head", "HEAD", ...storyArgs(story), ...(JIRA ? ["--post"] : []), "-o", `../${s.id}-gap-report.md`], { cwd: tests });
    if (gap === 3) noClaude();
    log(`gap report: ${path.join(work, `${s.id}-gap-report.md`)}`);
    // Mobile: the app under test is the one built from this change, on the running emulator.
    const testEnv = { ...process.env, ...QA_URLS, ...(mobile ? mobileEnv() : {}) };
    if (mobile && (f.regression || f.generate)) {
      buildApp();
      appiumCheck();
    }
    if (f.regression) {
      // Run the existing tests qa-sentinel selected, against the developer's change: do the predicted breaks happen?
      const selected = fs.existsSync(path.join(work, "qa-regression.txt")) ? fs.readFileSync(path.join(work, "qa-regression.txt"), "utf8").split("\n").filter(Boolean) : [];
      const app = selected.filter((x) => x.startsWith("tests/mobile/"));
      const rest = selected.filter((x) => !x.startsWith("tests/mobile/"));
      envStart();
      log(`running ${selected.length || "all"} selected existing test(s) against ${s.service} with the change`);
      if (rest.length || !selected.length) run("npx", ["playwright", "test", ...(selected.length ? [] : ["--project=api", "--project=web"]), "--reporter=list", ...rest], { cwd: tests, env: testEnv });
      if (app.length) run("npx", ["wdio", "run", "wdio.conf.ts", ...[...new Set(app.map((x) => x.replace(/:\d+$/, "")))].flatMap((x) => ["--spec", x])], { cwd: tests, env: testEnv });
      envStop(true);
    }
    if (f.generate) {
      envStart();
      const code = run("node", [CLI, "generate", "-s", s.service, "--base", "main", "--head", "HEAD", ...storyArgs(story)], {
        cwd: tests,
        env: testEnv,
      });
      envStop(true);
      if (code === 3) noClaude();
      const branch = git(tests, "branch", "--show-current");
      if (f.showcase) {
        // Showcase: run the whole suite on the generated branch (json reporter keeps evidence), then attach evidence
        // for the story if every acceptance criterion passed. Without JIRA_* it only assesses (--dry-run).
        // The environment stays up for the showcase: it re-records the chosen web tests in showcase mode.
        envStart();
        run("npx", ["playwright", "test", "--project=api", "--project=web"], { cwd: tests, env: testEnv });
        if (mobile) {
          fs.rmSync(path.join(tests, "test-results/mobile"), { recursive: true, force: true });
          run("npx", ["wdio", "run", "wdio.conf.ts"], { cwd: tests, env: testEnv });
        }
        run("node", [CLI, "showcase", "--story", key, ...storyArgs(story), ...(JIRA ? [] : ["--dry-run"]), "-o", `../${s.id}-showcase.md`], { cwd: tests, env: testEnv });
        envStop(true);
        log(`showcase summary: ${path.join(work, `${s.id}-showcase.md`)}`);
      }
      log(`generation exit ${code}; MR description: ${path.join(tests, "qa-sentinel-summary.md")}; branch: ${branch}`);
      if (branch.startsWith("qa-sentinel/")) log(`review the generated tests: git -C ${tests} diff main ${branch}`);
      process.exitCode = code;
    } else process.exitCode = gap;
    break;
  }
  default:
    console.log(fs.readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1).filter((l, i, all) => all.slice(0, i + 1).every((x) => x.startsWith("//"))).join("\n").replace(/^\/\/ ?/gm, ""));
}

/**
 * Web tests need a browser (and ffmpeg for the showcase videos). Playwright downloads both from its CDN; on a
 * locked-down laptop that may be blocked, so fall back to the installed Google Chrome without video.
 */
function installBrowser() {
  if (process.env.QA_BROWSER_CHANNEL || process.env.QA_BROWSER_PATH || process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD) {
    log(`browser: ${process.env.QA_BROWSER_CHANNEL ?? process.env.QA_BROWSER_PATH ?? "PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD set"} (no download)`);
    return;
  }
  log("qa-tests: npx playwright install chromium (browser + ffmpeg for videos)");
  if (run("npx", ["playwright", "install", "chromium"], { cwd: tests }) === 0) return;
  console.log(`
! Could not download Playwright's Chromium (a proxy or company policy may block cdn.playwright.dev).
  Web tests can use your installed Google Chrome instead; videos need Playwright's ffmpeg, so turn them off:
    export QA_BROWSER_CHANNEL=chrome QA_VIDEO=off
  The API tests are not affected.`);
}

/** Build the Android app from the app repo's current checkout (the developer's change included). */
function buildApp() {
  const dir = path.join(work, APP);
  if (!fs.existsSync(dir)) die("no app in this sandbox: run setup with --mobile");
  log(`${APP}: building the app (Android SDK tools)`);
  const code = run("bash", [path.join(dir, "build.sh")], { cwd: dir });
  if (code !== 0) die(`the app did not build (exit ${code}); see above`);
}

/** Device and app for the mobile tests: the emulator via Appium, the APK just built. */
function mobileEnv() {
  return { QA_MOBILE_PLATFORM: "android", QA_APP: path.join(work, APP, "build/shoplite.apk") };
}

/** Appium must be up (and an emulator running) before the mobile tests; say so clearly instead of failing later. */
function appiumCheck() {
  const url = (process.env.QA_APPIUM_URL ?? "http://127.0.0.1:4723").replace(/\/+$/, "");
  const r = spawnSync("curl", ["-s", "-m", "5", "-o", "/dev/null", "-w", "%{http_code}", `${url}/status`], { encoding: "utf8" });
  if (r.stdout?.trim() !== "200")
    die(`Appium is not answering at ${url}. Start the emulator (emulator -avd <name> &) and Appium (appium) in other terminals, then rerun.`);
  const adb = spawnSync("adb", ["devices"], { encoding: "utf8" });
  if (adb.status === 0 && !/\tdevice\b/.test(adb.stdout)) log("! adb lists no running device; start the emulator first");
}

/** qa-sentinel exits 3 when Claude can't be used at all; nothing after that step would mean anything. */
function noClaude() {
  die(
    "stopped: Claude Code can't run (see the error above). In this terminal:\n" +
      "  read -s ANTHROPIC_API_KEY && export ANTHROPIC_API_KEY   # paste the key, press Enter (nothing is shown)\n" +
      "  echo ${#ANTHROPIC_API_KEY}                                 # should print a number above 100\n" +
      '  claude -p "reply with OK"                                  # should print OK\n' +
      "then rerun this command.",
  );
}
