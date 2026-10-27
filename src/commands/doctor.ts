import { modelRoute } from "../modelRoute.js";
import { describeSource, loadContract } from "../contracts.js";
import { findUp, hasPackage } from "../fsutil.js";
import { safeUrl } from "../secrets.js";
import fs from "node:fs";
import os from "node:os";
import { spawnSync } from "node:child_process";
import path from "node:path";
import YAML from "yaml";
import { indexTests, checkTestMap, readTestMap } from "../analysis/testIndex.js";
import { CONFIG_FILE, type Config, configPath, loadConfig } from "../config.js";
import { extraCaps, platformOf } from "../mobile/caps.js";
import { CommandEngine } from "../engines/CommandEngine.js";
import { checkClaudeAccess, claudeAvailable, staticAccessProblem } from "../claude.js";
import { agentEnv } from "../run.js";
import { isGitRepo } from "../git.js";
import { log } from "../log.js";
import { SECRET_NAME } from "../env.js";
import { currentUser, getProject, gitlabContext } from "../scm/gitlab.js";
import { jiraContext, jiraAuthAmbiguous, projectStatuses, allIssueTypes, linkTypes, myself, serverInfo, jiraFlavour, searchStories, type JiraContext, type JiraServerInfo } from "../scm/jira.js";
import { statusSets } from "../stories/resolve.js";
import { junitReporter, layers, roleEnvNames, runCommandRunsEverything, runnerOf } from "../layers.js";
import { packageScripts } from "../verification.js";
import { wrapTestCommand } from "../wrapper.js";

type Level = "ok" | "warn" | "fail";
export interface Check {
  level: Level;
  label: string;
  hint?: string;
}

export function runChecks(cwd: string, env: NodeJS.ProcessEnv = process.env): Check[] {
  const checks: Check[] = [];
  const add = (level: Level, label: string, hint?: string) => checks.push({ level, label, hint });

  if (!fs.existsSync(configPath(cwd))) {
    add("fail", `${CONFIG_FILE} present`, "run `qa-sentinel init`");
    return checks;
  }
  let c;
  try {
    c = loadConfig(cwd);
    add("ok", `${CONFIG_FILE} valid`);
  } catch (e) {
    add("fail", `${CONFIG_FILE} valid`, (e as Error).message);
    return checks;
  }

  if (c.agent.engine === "command") {
    // An external engine: qa-sentinel cannot know its credentials; it can check that the program is there and that the safety settings fit.
    const eng = new CommandEngine({ command: c.agent.command ?? "" });
    eng.available().ok ? add("ok", `agent.engine: command (${(c.agent.command ?? "").trim().split(/\s+/)[0]} found)`, "its output is checked by guardrails after each run; see docs/ENGINE-COMMAND.md") : add("fail", `agent.command: ${(c.agent.command ?? "").trim().split(/\s+/)[0]} not found`, "the first word must be a program the shell can find (a path or on PATH)");
    if (!/\{taskFile\}/.test(c.agent.command ?? "")) add("ok", "agent.command reads the task on stdin", "it has no {taskFile}, so the task JSON comes only on stdin");
    if (c.agent.sandbox.enabled && c.agent.sandbox.failIfUnavailable && !c.verification.wrapCommand) add("fail", "agent.sandbox covers only Claude Code", "with agent.engine: command, the run is refused until verification.wrapCommand isolates the program (or agent.sandbox.failIfUnavailable is false)");
    else if (!c.verification.wrapCommand) add("warn", "the engine command runs unwrapped", "set verification.wrapCommand (a container or similar) if the program must be isolated; guardrails only check what it changed afterwards");
    else add("ok", "the engine command runs inside verification.wrapCommand");
    const claudeVars = Object.keys(env).filter((k) => /^(ANTHROPIC_|CLAUDE_)/.test(k) && c.guardrails.passEnv.includes(k));
    if (claudeVars.length) add("warn", `passEnv forwards Claude variables to the engine command: ${claudeVars.join(", ")}`, "only if that program is meant to use them");
    add("warn", "`qa-sentinel learn` still calls Claude Code", "it does not use the engine setting; every other agent command does");
  } else {
    const claude = claudeAvailable();
    if (claude.ok) add("ok", `Claude Code CLI (${claude.version})`);
    else add("fail", "Claude Code CLI installed", "npm i -g @anthropic-ai/claude-code");

    // Which way the agents reach the model: billing and data residency follow it, so say it plainly.
    const route = modelRoute(env);
    if (route.missing.length) add("fail", `model route: ${route.label}`, `missing ${route.missing.join("; ")}`);
    else if (route.unsure?.length) add("warn", `model route: ${route.label}`, route.unsure.join("; "))
    else if (route.kind === "login") add("warn", `model route: ${route.label}`, "fine locally; CI needs ANTHROPIC_API_KEY, Bedrock (CLAUDE_CODE_USE_BEDROCK) or Vertex (CLAUDE_CODE_USE_VERTEX)");
    else add("ok", `model route: ${route.label}`, route.managed ? `from ${route.managed}: runs are billed to whoever owns that setup` : undefined);

    const keyProblem = route.missing.length ? undefined : staticAccessProblem(env, route);
    if (keyProblem) add("fail", "Claude credentials look right", keyProblem);

  }

  isGitRepo(cwd) ? add("ok", "test repo is a git repository") : add("fail", "test repo is a git repository", "git init");

  for (const f of [".claude/agents/change-analyzer.md", ".claude/skills/qa-plan/SKILL.md", ".claude/skills/write-api-test/SKILL.md"]) {
    fs.existsSync(path.join(cwd, f)) ? add("ok", `${f}`) : add("fail", `${f}`, "rerun `qa-sentinel init --force`");
  }

  // How each layer's tests run: qa-sentinel adds spec paths (and a JUnit reporter it can switch on) to the run command.
  const scripts = packageScripts(cwd);
  for (const l of layers(c)) {
    const runner = runnerOf(l.runCommand, scripts);
    const script = l.runCommand.match(/\b(?:npm|pnpm|yarn)\s+(?:run\s+)?([\w:.-]+)/)?.[1];
    const full = `${l.runCommand} ${script && scripts[script] ? scripts[script] : ""}`;
    if (runCommandRunsEverything(full))
      add("warn", `${l.layer} run command runs only the tests asked for`, `\`${l.runCommand}\`${script && scripts[script] ? ` (script: \`${scripts[script]}\`)` : ""} contains a spec glob or file: qa-sentinel appends the spec paths to verify, so every run would include all tests. Point tests.${l.layer === "api" ? "api" : l.layer}.runCommand at the runner without the glob`);
    if (runner === "mocha") {
      const rc = [".mocharc.yml", ".mocharc.yaml", ".mocharc.json", ".mocharc.js", ".mocharc.cjs", ".mocharc.jsonc"].map((f) => path.join(cwd, f)).find((f) => fs.existsSync(f));
      if (rc && /^\s*["']?spec["']?\s*[:=]/m.test(fs.readFileSync(rc, "utf8")))
        add("warn", `${l.layer}: ${path.basename(rc)} has no \`spec\``, "mocha adds the configured spec to the files qa-sentinel passes, so every run includes all tests: move `spec` into the npm script instead");
    }
    if (!l.isPlaywright && !l.junitDirEnv && !c.verification.junitPath) {
      const auto = junitReporter(runner, l.runCommand, "junit.xml", (pkg) => hasPackage(cwd, pkg));
      if (auto) add("ok", `${l.layer} results: JUnit through ${runner}'s reporter (switched on by qa-sentinel)`);
      else
        add(
          "warn",
          `${l.layer} results readable`,
          runner === "jest"
            ? "install jest-junit (qa-sentinel switches it on), or set verification.junitPath"
            : `qa-sentinel can't see per-test results for \`${l.runCommand}\`: call the runner directly or end an npm command with \` --\`, or set verification.junitPath to the JUnit file your runner writes`,
        );
    }
  }

  const skill = path.join(cwd, ".claude/skills/write-api-test/SKILL.md");
  if (fs.existsSync(skill) && fs.readFileSync(skill, "utf8").includes("<!-- conventions:pending -->")) {
    add("warn", "conventions learned", "run `qa-sentinel learn` and review the result");
  }

  if (c.workspace.services.length === 0) add("warn", "services configured", "add workspace.services in the config");
  for (const s of c.workspace.services) {
    const dir = path.resolve(cwd, s.path);
    if (!fs.existsSync(dir)) add("fail", `service ${s.name}: ${s.path} exists`, "check the path or clone the repo into the workspace");
    else if (!isGitRepo(dir)) add("fail", `service ${s.name}: is a git repo`);
    else if (s.kind === "mobile") add(c.tests.mobile.enabled ? "ok" : "warn", `service ${s.name} (mobile app)`, c.tests.mobile.enabled ? undefined : "enable tests.mobile (`qa-sentinel add-mobile`) to test it through the app");
    else if (s.kind === "web") add(c.tests.web.enabled ? "ok" : "warn", `service ${s.name} (web front end${s.routes.length ? `, ${s.routes.length} routes` : ""})`, c.tests.web.enabled ? undefined : "enable tests.web (`qa-sentinel add-web`) to test it through the UI");
    else if (!s.openapi) add("warn", `service ${s.name}: OpenAPI spec`, "add one (or `openapi:` path, plus `openapiCommand:` if it's generated at build time) for much better API tests");
    else if (s.openapiCommand)
      add(
        findUp(dir, "node_modules") || !fs.existsSync(path.join(dir, "package.json")) ? "ok" : "warn",
        `service ${s.name} (OpenAPI generated by \`${s.openapiCommand}\` → ${s.openapi})`,
        findUp(dir, "node_modules") || !fs.existsSync(path.join(dir, "package.json")) ? undefined : "install the service's dependencies (npm ci) before qa-sentinel runs, so the generator is available",
      );
    else if (!fs.existsSync(path.join(dir, s.openapi))) add("warn", `service ${s.name}: ${s.openapi} found`);
    else add("ok", `service ${s.name} (OpenAPI: ${s.openapi})`);
    if (s.contract) {
      const k = s.contract;
      const where = describeSource(k);
      if (k.file || k.repo) {
        const p = path.resolve(cwd, (k.file ?? k.repo)!);
        add(fs.existsSync(p) ? "ok" : "fail", `service ${s.name}: agreed spec (${where})`, fs.existsSync(p) ? undefined : k.repo ? "clone the specs repository there, or use contract.gitlabProject" : "the file doesn't exist");
      } else add("ok", `service ${s.name}: agreed spec (${where})`, k.jiraAttachment ? "read from the story at run time" : "checked with `doctor --online`");
      if (!s.openapi) add("warn", `service ${s.name}: implemented spec to compare with the agreed one`, "set `openapi` (and `openapiCommand` if generated) so qa-sentinel can check the code field by field; without it only the tests check it");
    }
  }

  // Logging in: the helpers agents must reuse, and each role's credentials in the environment.
  const auth = c.tests.auth;
  if (auth.helpers) add(fs.existsSync(path.join(cwd, auth.helpers)) ? "ok" : "warn", `login helpers (${auth.helpers})`, fs.existsSync(path.join(cwd, auth.helpers)) ? undefined : "the path in tests.auth.helpers doesn't exist");
  for (const r of auth.roles) {
    const names = roleEnvNames(r).filter((n) => !/_TOTP_SEED$/.test(n));
    const missing = names.filter((n) => !env[n]);
    add(missing.length ? "warn" : "ok", `role ${r.name}: credentials in the environment`, missing.length ? `set ${missing.join(", ")} (masked CI variables)` : undefined);
  }

  const index = indexTests(cwd, c);
  const taggedCount = index.filter((t) => t.endpoints.length || t.pages.length).length;
  const mapFile = path.join(cwd, "test-map.yaml");
  if (!fs.existsSync(mapFile)) add("warn", "test-map.yaml present", "run `qa-sentinel learn`");
  else {
    const map = YAML.parse(fs.readFileSync(mapFile, "utf8")) ?? {};
    const entries = Object.entries<any>(map.services ?? {});
    const mapped = entries.filter(([, s]) => Object.keys(s?.endpoints ?? {}).length > 0 || Object.keys(s?.screens ?? {}).length > 0).length;
    const level: Level = entries.length && mapped === entries.length ? "ok" : "warn";
    // An empty map with tagged tests gets one line below, with the number of tests, not this one as well.
    if (!(mapped === 0 && taggedCount > 0)) add(level, `test-map: ${mapped}/${entries.length} services have endpoints or screens mapped`, level === "warn" ? "run `qa-sentinel learn`" : undefined);
    // The map and the config must name the same services (a service added to the config later is never in the map).
    const inConfig = c.workspace.services.map((s) => s.name);
    const notInMap = inConfig.filter((n) => !(n in (map.services ?? {})));
    const notInConfig = entries.map(([n]) => n).filter((n) => inConfig.length && !inConfig.includes(n));
    if (notInMap.length) add("warn", "test-map.yaml lists every service of the config", `not in test-map.yaml: ${notInMap.join(", ")}; add them (or run \`qa-sentinel learn\`)`);
    if (notInConfig.length) add("warn", "test-map.yaml lists only services of the config", `not in the config: ${notInConfig.join(", ")}; remove them from test-map.yaml or add them to workspace.services`);
  }
  if (index.length) {
    const tagged = index.filter((t) => t.endpoints.length || t.pages.length).length;
    add(tagged === index.length ? "ok" : "warn", `test tags: ${tagged}/${index.length} tests have @endpoint, @page or @screen`, tagged === index.length ? undefined : "tag tests so impact analysis and traceability can find them (`qa-sentinel trace`)");
    const map = readTestMap(cwd);
    const empty = !!map && !Object.values(map.services ?? {}).some((s) => Object.keys(s?.endpoints ?? {}).length || Object.keys(s?.screens ?? {}).length);
    const found = checkTestMap(index, map, cwd).filter((f) => f.level === "warning");
    if (empty && found.length) add("warn", "test-map.yaml agrees with test tags", `test-map.yaml is empty but ${taggedCount} test(s) are tagged: run \`qa-sentinel learn\` to fill it (this one line stands for ${found.length} separate mismatch(es))`);
    else if (found.length) add("warn", "test-map.yaml agrees with test tags", `${found.length} mismatch(es), e.g. ${found[0].message}; \`qa-sentinel trace\` lists all, \`qa-sentinel learn\` redrafts the map`);
  }

  if (env[c.tests.api.baseUrlEnv]) add("ok", `${c.tests.api.baseUrlEnv} set`);
  else add("warn", `${c.tests.api.baseUrlEnv} set`, "needed for the agent to run tests against your QA environment");

  // The story template: without an acceptance-criteria section (or a Jira AC field) no AC can be found.
  const tpl = c.requirements.template;
  if (!tpl.some((s) => s.role === "acceptance-criteria") && !c.requirements.jira.acceptanceCriteriaField)
    add("fail", "story template has an acceptance-criteria section", "add one to requirements.template, or set requirements.jira.acceptanceCriteriaField");
  else add("ok", `story template: ${tpl.length} section(s)${c.requirements.jira.acceptanceCriteriaField ? `, ACs from ${c.requirements.jira.acceptanceCriteriaField}` : ""}; check real stories with \`qa-sentinel story-check --story <KEY>\``);
  if (c.tests.web.enabled) checks.push(...webChecks(cwd, c, env));
  if (c.tests.mobile.enabled) checks.push(...mobileChecks(cwd, c, env));

  if (c.ci.scm === "gitlab") {
    if (env.QA_SENTINEL_GITLAB_TOKEN || env.GITLAB_TOKEN) add("ok", "GitLab token set");
    else add("warn", "GitLab token set", "QA_SENTINEL_GITLAB_TOKEN with api scope, to post MR comments and open MRs");
    if (!c.ci.testRepoProject) add("warn", "ci.testRepoProject configured", "e.g. my-group/qa-tests, used to open MRs");
  }

  if (c.requirements.source === "none") add("warn", "requirements source", "without stories/AC, tests only check what the code does");
  if (c.requirements.source === "jira") {
    if (!c.requirements.jira.baseUrl) add("fail", "requirements.jira.baseUrl set", "e.g. https://yourcompany.atlassian.net");
    else if (!jiraContext(c.requirements.jira, env)) add("warn", "Jira credentials set", `${c.requirements.jira.auth === "pat" ? "JIRA_PAT (auth: pat)" : c.requirements.jira.auth === "cloud" ? "JIRA_EMAIL + JIRA_API_TOKEN (auth: cloud)" : "JIRA_EMAIL + JIRA_API_TOKEN (Cloud) or JIRA_PAT (Server/DC)"}; without them, MR text is used`);
    else add("ok", `Jira configured (${c.requirements.jira.baseUrl})`);
    if (c.requirements.jira.auth === "auto" && jiraAuthAmbiguous(env)) add("warn", "Jira login: both JIRA_PAT and JIRA_EMAIL are set", "auto uses JIRA_EMAIL + JIRA_API_TOKEN (Cloud). On Data Center unset JIRA_EMAIL, or set requirements.jira.auth: pat");
    if (!c.requirements.jira.projectKeys.length) add("warn", "requirements.jira.projectKeys set", "limits story-key matching to your projects (avoids false keys like UTF-8)");
    else if (c.requirements.jira.projectKeys.some((k) => !new RegExp(`^(?:${c.requirements.storyKeyPattern})$`).test(`${k}-1`)))
      add("warn", "requirements.storyKeyPattern matches every project key", `${c.requirements.storyKeyPattern} doesn't match ${c.requirements.jira.projectKeys.filter((k) => !new RegExp(`^(?:${c.requirements.storyKeyPattern})$`).test(`${k}-1`)).join(", ")}`);
  }
  if (c.verification.wrapCommand) {
    // A command with spaces and quotes that exits 7: the wrapper must run it as one command, print its output, and pass the exit code through
    // (`true` would pass a wrapper that drops arguments or always exits 0). It does not prove that the wrapper isolates anything.
    const probe = `printf '%s' 'a b "c" d'"'"'e'; exit 7`;
    const want = `a b "c" d'e`;
    const shown = wrapTestCommand(c, probe);
    const r = spawnSync(shown, { shell: true, encoding: "utf8", timeout: 60_000 });
    if (r.status === 7 && (r.stdout ?? "").includes(want)) add("ok", "verification.wrapCommand runs a command", "a command with spaces and quotes ran, its output came back and its exit code (7) passed through; what the wrapper isolates is up to the wrapper (see SECURITY.md)");
    else add("fail", "verification.wrapCommand runs a command", r.error ? `failed to start: ${r.error.message}` : r.status !== 7 ? `a test command that exits 7 came back as exit ${r.status}: the wrapper must pass the exit code through (a failing test would look green)${r.stderr ? `: ${r.stderr.trim().slice(0, 160)}` : ""}` : "the command's output did not come back whole: check the quoting around {cmd} (use sh -c {cmd})");
  }
  if (c.agent.sandbox.enabled && c.agent.engine === "claude-code") {
    // Claude Code's Bash sandbox: on Linux it needs bubblewrap and socat (macOS has Seatbelt built in). Native Windows runs commands unsandboxed.
    if (process.platform === "linux") {
      const missing = ["bwrap", "socat"].filter((b) => spawnSync("sh", ["-c", `command -v ${b}`], { encoding: "utf8" }).status !== 0);
      if (missing.length) add(c.agent.sandbox.failIfUnavailable ? "fail" : "warn", `agent.sandbox: ${missing.join(" and ")} not found`, "apt-get install bubblewrap socat (the agent will not start without them while failIfUnavailable is true)");
      else add("ok", "agent.sandbox: bubblewrap and socat found");
    } else if (process.platform === "win32") add("warn", "agent.sandbox on native Windows", "Claude Code runs commands unsandboxed on native Windows; use WSL2");
    else add("ok", "agent.sandbox on", "macOS has the sandbox built in");
    if (!c.agent.sandbox.allowedDomains.length) add("warn", "agent.sandbox.allowedDomains is empty", "the agent's shell commands can reach no host, so it cannot run the tests against the QA environment: list its host");
  }
  add("ok", `operating level: ${c.level}${c.level === "intelligence" ? " (read-only; set level: maintenance to enable generation)" : ""}`);

  const leaked = Object.keys(env).filter((k) => c.guardrails.passEnv.includes(k) && SECRET_NAME.test(k));
  if (leaked.length) add("warn", `passEnv forwards credential-like variables to agents: ${leaked.join(", ")}`, "only list what generated tests truly need");
  if (c.guardrails.allowedWritePaths.some((g) => g === "**" || g === "**/*")) add("fail", "guardrails.allowedWritePaths is not a catch-all", "list the test, helper and fixture folders explicitly");
  if (c.workspace.services.length && c.ci.scm === "gitlab" && c.workspace.services.some((s) => !s.gitlabProject)) {
    add("warn", "services have gitlabProject set", "needed after merge to fetch the MR's acceptance criteria (or set QA_SERVICE_PROJECT in CI)");
  }
  return checks;
}

/** Web layer: base URL, page objects, a browser to run in, and (when healing is on) Bubblegum's two halves. */
export function webChecks(cwd: string, c: Config, env: NodeJS.ProcessEnv): Check[] {
  const out: Check[] = [];
  const add = (level: Level, label: string, hint?: string) => out.push({ level, label, hint });
  const w = c.tests.web;
  env[w.baseUrlEnv] ? add("ok", `${w.baseUrlEnv} set (web)`) : add("warn", `${w.baseUrlEnv} set`, "the front end the web tests open");
  fs.existsSync(path.join(cwd, w.pagesDir)) ? add("ok", `page objects in ${w.pagesDir}`) : add("warn", `page objects folder ${w.pagesDir}`, "run `qa-sentinel add-web` for the scaffold");
  fs.existsSync(path.join(cwd, ".claude/skills/write-web-test/SKILL.md")) ? add("ok", ".claude/skills/write-web-test/SKILL.md") : add("fail", ".claude/skills/write-web-test/SKILL.md", "run `qa-sentinel add-web`");
  const pw = path.join(cwd, "playwright.config.ts");
  if (fs.existsSync(pw) && !/name:\s*["']web["']/.test(fs.readFileSync(pw, "utf8"))) add("warn", "playwright.config.ts has a web project", "`qa-sentinel add-web` prints the project to add");
  if (env.QA_BROWSER_PATH) add(fs.existsSync(env.QA_BROWSER_PATH) ? "ok" : "fail", `browser: ${env.QA_BROWSER_PATH}`);
  else if (env.QA_BROWSER_CHANNEL) add("ok", `browser: installed ${env.QA_BROWSER_CHANNEL} (QA_BROWSER_CHANNEL)`);
  else {
    const cache = env.PLAYWRIGHT_BROWSERS_PATH ?? path.join(os.homedir(), process.platform === "darwin" ? "Library/Caches/ms-playwright" : ".cache/ms-playwright");
    const found = fs.existsSync(cache) && fs.readdirSync(cache).some((d) => d.startsWith("chromium"));
    found ? add("ok", "Playwright Chromium installed") : add("warn", "Playwright Chromium installed", "npx playwright install chromium; no download allowed? set QA_BROWSER_CHANNEL=chrome to use the installed Google Chrome");
  }
  if (w.healing === "bubblegum") {
    const pkg = w.bubblegum.package;
    const hasPkg = fs.existsSync(path.join(cwd, "node_modules", ...pkg.split("/"), "package.json"));
    hasPkg ? add("ok", `healing: ${pkg} installed`) : add("fail", `healing: ${pkg} installed`, `npm i -D ${pkg}`);
    const py = spawnSync(process.env.BUBBLEGUM_PYTHON || "python3", ["-c", "import bubblegum"], { encoding: "utf8" });
    py.status === 0 ? add("ok", "healing: Bubblegum engine importable (python3 -c 'import bubblegum')") : add("fail", "healing: Bubblegum engine installed", 'pip install "bubblegum-ai[web]" on the machine running the tests');
    add("ok", "healing runs only when QA_HEALING=bubblegum (scheduled/post-deploy jobs, feature --run); never while verifying agent-written tests");
  }
  return out;
}

/** Mobile layer: scaffold, WebdriverIO installed, an app to test, and where Appium is (reachability is checked at run time). */
export function mobileChecks(cwd: string, c: Config, env: NodeJS.ProcessEnv): Check[] {
  const out: Check[] = [];
  const add = (level: Level, label: string, hint?: string) => out.push({ level, label, hint });
  const m = c.tests.mobile;
  fs.existsSync(path.join(cwd, m.screensDir)) ? add("ok", `screen objects in ${m.screensDir}`) : add("warn", `screen objects folder ${m.screensDir}`, "run `qa-sentinel add-mobile` for the scaffold");
  fs.existsSync(path.join(cwd, ".claude/skills/write-mobile-test/SKILL.md")) ? add("ok", ".claude/skills/write-mobile-test/SKILL.md") : add("fail", ".claude/skills/write-mobile-test/SKILL.md", "run `qa-sentinel add-mobile`");
  fs.existsSync(path.join(cwd, "wdio.conf.ts")) ? add("ok", "wdio.conf.ts present") : add("warn", "wdio.conf.ts present", `run \`qa-sentinel add-mobile\` (or point tests.mobile.runCommand at your config)`);
  fs.existsSync(path.join(cwd, "node_modules/@wdio/cli/package.json")) ? add("ok", "WebdriverIO installed") : add("warn", "WebdriverIO installed", "npm install (add-mobile added the @wdio packages to package.json)");
  env.QA_APP || env.QA_APP_PACKAGE || env.QA_BUNDLE_ID
    ? add("ok", `app under test: ${env.QA_APP ?? env.QA_APP_PACKAGE ?? env.QA_BUNDLE_ID}`)
    : add("warn", "app under test (QA_APP, QA_APP_PACKAGE or QA_BUNDLE_ID)", "the .apk/.app to install, or the package/bundle id of an installed app");
  // Farm blocks and iOS. Values of QA_APPIUM_CAPS are never printed (they can hold a key).
  if (env.QA_APPIUM_CAPS?.trim()) {
    try {
      add("ok", `QA_APPIUM_CAPS: a JSON object with ${Object.keys(extraCaps(env)).length} key(s)`, "merged over the capabilities in wdio.conf.ts; it is given to qa-sentinel's own runs, not to the agent");
    } catch (e) {
      add("fail", "QA_APPIUM_CAPS is one JSON object", (e as Error).message);
    }
    if (fs.existsSync(path.join(cwd, "wdio.conf.ts")) && !fs.readFileSync(path.join(cwd, "wdio.conf.ts"), "utf8").includes("QA_APPIUM_CAPS")) add("warn", "wdio.conf.ts reads QA_APPIUM_CAPS", "this wdio.conf.ts is from an older scaffold and ignores it: add the merge shown in templates/scaffold/wdio-mobile/wdio.conf.ts.tmpl");
  }
  const targetsIos = Object.entries(m.targets).filter(([, t]) => (t.env.QA_MOBILE_PLATFORM ?? t.platform) === "ios");
  if (platformOf(env, m.platform) === "ios" || targetsIos.length) {
    add("warn", "iOS runs are not proven yet", "this code has not been run on a Mac or an iOS farm; try docs/TRY-PR9.md and report what fails");
    if (platformOf(env, m.platform) === "ios") {
      env.QA_BUNDLE_ID || env.QA_APP || env.QA_APPIUM_CAPS ? add("ok", "iOS app under test", `${env.QA_BUNDLE_ID ? "QA_BUNDLE_ID" : env.QA_APP ? "QA_APP" : "QA_APPIUM_CAPS"} is set`) : add("fail", "iOS app under test (QA_BUNDLE_ID or QA_APP)", "the bundle id of an installed app, or an .app/.ipa to install");
      if (process.platform !== "darwin" && !env[m.appiumUrlEnv]) add("warn", "iOS needs a Mac or a farm", `this machine is ${process.platform} and ${m.appiumUrlEnv} is not set, so there is no Appium server that can drive iOS`);
    }
    // Each iOS target on its own: it needs a Mac here, or an Appium URL of its own (set in the target or passed on from the environment).
    for (const [name, t] of targetsIos) {
      const hasUrl = Boolean(env[m.appiumUrlEnv] || t.env[m.appiumUrlEnv] || t.passEnv.includes(m.appiumUrlEnv));
      if (process.platform !== "darwin" && !hasUrl) add("warn", `mobile target ${name}: iOS needs a Mac or a farm`, `this machine is ${process.platform} and the target has no ${m.appiumUrlEnv} (set it in env, list it in passEnv, or run on a Mac)`);
    }
    if (m.explore === "snapshot" && m.deepLinkBase) add("warn", "mobile.explore on iOS", "deep links are not supported on iOS yet; only the screen the app opens on is saved");
  }
  for (const [name, t] of Object.entries(m.targets)) {
    const missing = t.passEnv.filter((n) => !env[n]);
    add(missing.length ? "warn" : "ok", `mobile target ${name}${t.platform ? ` (${t.platform})` : ""}`, missing.length ? `not set here: ${missing.join(", ")} (names only; set them before \`qa-sentinel mobile-run --target ${name}\`)` : "`qa-sentinel mobile-run --target " + name + " --dry-run` shows the command");
  }
  if (m.explore === "snapshot" && !(env.QA_APP || env.QA_APP_PACKAGE || env.QA_BUNDLE_ID || env.QA_APPIUM_CAPS)) add("warn", "tests.mobile.explore: snapshot needs an app", "set QA_APP, QA_APP_PACKAGE or QA_BUNDLE_ID where `generate` runs, and a device or emulator behind Appium: without them the snapshot step logs a warning and the agent works from the app's code");
  add(env[m.appiumUrlEnv] ? "ok" : "warn", `Appium: ${env[m.appiumUrlEnv] ? safeUrl(env[m.appiumUrlEnv]!) : `${m.appiumUrl} (default)`}`, env[m.appiumUrlEnv] ? undefined : `set ${m.appiumUrlEnv} for a remote Appium or device farm; qa-sentinel checks <url>/status before running mobile tests`);
  return out;
}

/** Calls GitLab to prove the token can reach the projects, rather than only checking a variable exists. */
export async function onlineChecks(cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<Check[]> {
  const checks: Check[] = [];
  const c = loadConfig(cwd);
  const ctx = gitlabContext(c.ci.gitlabUrl, env);
  if (!ctx) return [{ level: "fail", label: "GitLab token available for online checks", hint: "set QA_SENTINEL_GITLAB_TOKEN" }];
  try {
    const u = await currentUser(ctx);
    checks.push({ level: "ok", label: `GitLab token works (user ${u.username})` });
  } catch (e) {
    return [{ level: "fail", label: "GitLab token accepted", hint: (e as Error).message.slice(0, 200) }];
  }
  const targets = [
    ...(c.ci.testRepoProject ? [{ label: "test repo", project: c.ci.testRepoProject, needWrite: true }] : []),
    ...c.workspace.services.filter((s) => s.gitlabProject).map((s) => ({ label: `service ${s.name}`, project: s.gitlabProject!, needWrite: false })),
  ];
  for (const t of targets) {
    try {
      const p = await getProject(ctx, t.project);
      const level = Math.max(p.permissions?.project_access?.access_level ?? 0, p.permissions?.group_access?.access_level ?? 0);
      if (t.needWrite && level < 30) checks.push({ level: "fail", label: `${t.label} (${t.project}): Developer access to push branches and open MRs`, hint: `token has access level ${level}` });
      else checks.push({ level: "ok", label: `${t.label} (${t.project}) reachable` });
    } catch (e) {
      checks.push({ level: "fail", label: `${t.label} (${t.project}) reachable with the token`, hint: (e as Error).message.slice(0, 160) });
    }
  }
  for (const s of c.workspace.services.filter((x) => x.contract?.url || x.contract?.gitlabProject)) {
    const { contract, reason } = await loadContract(c, s.contract!, { cwd, env });
    let parses = false;
    try {
      parses = Boolean(contract && YAML.parse(contract.text)?.paths);
    } catch {
      // not YAML/JSON
    }
    checks.push(
      contract && parses
        ? { level: "ok", label: `service ${s.name}: agreed spec loads (${contract.from})` }
        : { level: "fail", label: `service ${s.name}: agreed spec loads`, hint: reason ?? "loaded, but it isn't an OpenAPI document with paths" },
    );
  }
  checks.push({
    level: "warn",
    label: "CI job-token allowlists cannot be checked from here",
    hint: "in each service project: Settings › CI/CD › Job token permissions › allow the test repo (and vice versa)",
  });
  return checks;
}

/** A real one-word call to Claude, the way a run would make it (costs a fraction of a cent). */
export async function claudeLiveCheck(cwd: string): Promise<Check> {
  const c = loadConfig(cwd);
  if (c.agent.engine === "command") return { level: "warn", label: "the engine command's credentials", hint: "agent.engine is command: qa-sentinel cannot test its access; run one cheap task (docs/ENGINE-COMMAND.md) to check" };
  const seconds = c.agent.accessCheckSeconds || 60;
  const r = await checkClaudeAccess({ cwd, env: agentEnv(c), model: c.agent.model, seconds });
  if (r.ok) return { level: r.warning ? "warn" : "ok", label: "Claude answers a test call", hint: r.warning ?? (r.durationMs !== undefined ? `${Math.round(r.durationMs / 100) / 10}s` : r.skipped) };
  return { level: "fail", label: "Claude answers a test call", hint: r.message };
}

export async function doctorCommand(cwd: string, o: { online?: boolean } = {}): Promise<number> {
  log.title("qa-sentinel doctor");
  const checks = runChecks(path.resolve(cwd));
  if (o.online && !checks.some((c) => c.level === "fail" && c.label.includes("valid"))) checks.push(await claudeLiveCheck(path.resolve(cwd)));
  if (o.online && !checks.some((c) => c.level === "fail" && c.label.includes("valid"))) checks.push(...(await onlineChecks(path.resolve(cwd))));
  if (o.online && !checks.some((c) => c.level === "fail" && c.label.includes("valid"))) {
    const c = loadConfig(path.resolve(cwd));
    const ctx = jiraContext(c.requirements.jira);
    if (ctx) {
      checks.push(await jiraIdentityCheck(ctx, c.reporting.targets.includes("jira")));
      checks.push(...(await jiraFlavourChecks(c, { serverInfo: () => serverInfo(ctx), search: (jql, api) => searchStories(ctx, jql, { max: 1, api }) })));
    }
    if (ctx && (c.requirements.jira.projectKeys.length || c.requirements.jira.hierarchy.links.length)) checks.push(...(await jiraConfigChecks(c, { statuses: (p) => projectStatuses(ctx, p), issueTypes: (p) => allIssueTypes(ctx, p), linkTypes: () => linkTypes(ctx) })));
  }
  for (const ch of checks) {
    const line = ch.hint ? `${ch.label}  — ${ch.hint}` : ch.label;
    if (ch.level === "ok") log.ok(line);
    else if (ch.level === "warn") log.warn(line);
    else log.fail(line);
  }
  const fails = checks.filter((c) => c.level === "fail").length;
  const warns = checks.filter((c) => c.level === "warn").length;
  log.info(`\n${fails} failing, ${warns} warning(s).`);
  return fails > 0 ? 1 : 0;
}

/**
 * Who the Jira credentials belong to (GET /rest/api/2/myself). qa-sentinel edits and deletes only comments written by
 * this user; without an answer it writes no comments at all. (A personal API token makes that person's own comments
 * qa-sentinel's own: use a service account.)
 */
export async function jiraIdentityCheck(ctx: JiraContext, writes: boolean): Promise<Check> {
  const me = await myself(ctx);
  if (me) return { level: "ok", label: `Jira user: ${me.displayName ?? me.accountId ?? me.name ?? me.key}`, hint: "qa-sentinel edits or deletes only comments written by this user; with a personal token that includes your own comments, so a service account is better" };
  return { level: writes ? "fail" : "warn", label: "Jira says who the credentials belong to (GET /rest/api/2/myself)", hint: "without it qa-sentinel cannot tell its own comments from other people's and writes no Jira comments; check the token and that the user may browse the site" };
}

/** What `doctor --online` can ask Jira, injectable so the checks can be tested. */
export interface JiraProbe {
  statuses(project: string): Promise<string[]>;
  issueTypes(project: string): Promise<string[]>;
  linkTypes(): Promise<{ name: string; inward: string; outward: string }[]>;
}

/** The Jira settings against the real Jira: do the status, issue type and link names exist? A wrong name fails silently otherwise. */
export async function jiraConfigChecks(c: ReturnType<typeof loadConfig>, probe: JiraProbe): Promise<Check[]> {
  const j = c.requirements.jira;
  const out: Check[] = [];
  const has = (list: string[], v: string) => list.some((x) => x.toLowerCase() === v.toLowerCase());
  for (const project of j.projectKeys) {
    const sets = statusSets(c, `${project}-1`);
    try {
      const known = await probe.statuses(project);
      for (const [label, names, setting] of [["ready", sets.ready, "requirements.jira.workflow.readyStatuses"], ["approved", sets.approved, "requirements.jira.approvedStatuses"]] as const) {
        const found = names.filter((n) => has(known, n));
        if (!found.length) out.push({ level: "warn", label: `${project}: some ${label} status exists in Jira`, hint: `none of ${names.join(", ")} is a status of ${project}; ${setting}${j.workflow.byProject[project] ? ` (byProject.${project})` : ""} should use: ${known.join(", ")}` });
        else out.push({ level: "ok", label: `${project}: ${label} statuses found in Jira (${found.join(", ")})${found.length < names.length ? `; not in this project: ${names.filter((n) => !has(known, n)).join(", ")}` : ""}` });
      }
    } catch (e) {
      out.push({ level: "warn", label: `${project}: workflow statuses readable`, hint: (e as Error).message.slice(0, 160) });
    }
    if (j.featureIssueTypes.length) {
      try {
        const types = await probe.issueTypes(project);
        const unknown = j.featureIssueTypes.filter((t) => !has(types, t));
        out.push(unknown.length ? { level: "warn", label: `${project}: feature issue types exist`, hint: `${unknown.join(", ")} not found; the project has ${types.join(", ")}` } : { level: "ok", label: `${project}: feature issue types exist (${j.featureIssueTypes.join(", ")})` });
      } catch (e) {
        out.push({ level: "warn", label: `${project}: issue types readable`, hint: (e as Error).message.slice(0, 160) });
      }
    }
  }
  if (j.hierarchy.links.length) {
    try {
      const types = await probe.linkTypes();
      for (const l of j.hierarchy.links) {
        const hit = types.some((t) => [t.name, t.inward, t.outward].some((w) => w.toLowerCase() === l.name.toLowerCase()));
        out.push(hit ? { level: "ok", label: `link type "${l.name}" exists` } : { level: "warn", label: `link type "${l.name}" exists in Jira`, hint: `available: ${types.map((t) => `${t.name} (${t.outward} / ${t.inward})`).join("; ")}` });
      }
    } catch (e) {
      out.push({ level: "warn", label: "Jira link types readable", hint: (e as Error).message.slice(0, 160) });
    }
  }
  if (j.hierarchy.links.length && !j.featureIssueTypes.length) out.push({ level: "warn", label: "requirements.jira.featureIssueTypes set", hint: "hierarchy.links is set but with no feature types every card is its own feature, so nothing is followed" });
  return out;
}

/** What the flavour check asks Jira, injectable so it can be tested. */
export interface JiraFlavourProbe {
  serverInfo(): Promise<JiraServerInfo>;
  search(jql: string, api: "cloud" | "server"): Promise<unknown[]>;
}

/** Cloud or Data Center (from serverInfo.deploymentType), and whether the search API of that flavour answers. */
export async function jiraFlavourChecks(c: ReturnType<typeof loadConfig>, probe: JiraFlavourProbe): Promise<Check[]> {
  const j = c.requirements.jira;
  const out: Check[] = [];
  let info: JiraServerInfo;
  try {
    info = await probe.serverInfo();
  } catch (e) {
    return [{ level: "warn", label: "Jira flavour (Cloud or Data Center) readable", hint: `${(e as Error).message.slice(0, 160)}; check requirements.jira.baseUrl and the login` }];
  }
  const flavour = jiraFlavour(info);
  out.push({ level: "ok", label: `Jira flavour: ${flavour === "cloud" ? "Cloud" : "Data Center"}${info.version ? ` (version ${info.version})` : ""}` });
  if (flavour === "cloud" && j.auth === "pat") out.push({ level: "warn", label: "Jira Cloud with auth: pat", hint: "Cloud does not take a Bearer token; use JIRA_EMAIL + JIRA_API_TOKEN" });
  if (flavour === "datacenter" && j.auth === "cloud") out.push({ level: "warn", label: "Jira Data Center with auth: cloud", hint: "Data Center takes a personal access token: JIRA_PAT with auth: auto or pat" });
  if (info.baseUrl && j.baseUrl && new URL(info.baseUrl).origin !== new URL(j.baseUrl).origin)
    out.push({ level: "warn", label: "requirements.jira.baseUrl differs from the URL Jira reports", hint: `Jira says ${info.baseUrl}; attachment links start with that, and qa-sentinel refuses attachments from another origin. Set baseUrl to it.` });
  const jql = j.projectKeys.length ? `project in (${j.projectKeys.map((k) => `"${k}"`).join(",")}) ORDER BY created DESC` : "ORDER BY created DESC";
  const api = flavour === "cloud" ? "cloud" : "server";
  try {
    await probe.search(jql, api);
    out.push({ level: "ok", label: `Jira search works (${api === "cloud" ? "/rest/api/3/search/jql" : "/rest/api/2/search"})` });
  } catch (e) {
    out.push({ level: "warn", label: `Jira search (${api === "cloud" ? "/rest/api/3/search/jql" : "/rest/api/2/search"}) answers`, hint: (e as Error).message.slice(0, 160) });
  }
  return out;
}
