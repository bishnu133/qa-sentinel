import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { KB_README } from "../kb.js";
import { confirm, input, select } from "@inquirer/prompts";
import { CONFIG_FILE, type Config, ConfigSchema, configPath, loadConfig, writeConfig } from "../config.js";
import { defaultRunCommand, detectProject, discoverServices, type Detection } from "../detect.js";
import { ensureDir, readJson, writeFileSafe } from "../fsutil.js";
import { listTemplateDir, readTemplate, render, type TemplateVars } from "../templates.js";
import { log } from "../log.js";
import { suiteRunCommand } from "../layers.js";

export interface InitOptions {
  cwd: string;
  mode?: "existing" | "scratch";
  level?: "intelligence" | "maintenance";
  workspace?: string;
  ci?: "gitlab" | "jenkins";
  apiFramework?: Config["tests"]["api"]["framework"];
  name?: string;
  /** Also set up the web (Playwright UI) layer: config, page objects, ui helper, fixtures, example spec. */
  web?: boolean;
  /** Also set up the mobile (WebdriverIO + Appium) layer: config, screen objects, ui helper, evidence hooks, example spec. */
  mobile?: boolean;
  yes?: boolean;
  force?: boolean;
}

export async function initCommand(opts: InitOptions): Promise<Config> {
  const cwd = path.resolve(opts.cwd);
  const interactive = !opts.yes && process.stdin.isTTY;
  log.title("qa-sentinel init");

  if (fs.existsSync(configPath(cwd)) && !opts.force) {
    throw new Error(`${CONFIG_FILE} already exists. Use --force to regenerate (your edits to agents/skills will be kept unless --force).`);
  }

  const det = detectProject(cwd);
  reportDetection(det);

  // 1. Mode
  const suggestedMode = det.apiTestFiles.length > 0 ? "existing" : "scratch";
  const mode =
    opts.mode ??
    (interactive
      ? await select({
          message: "Project mode",
          default: suggestedMode,
          choices: [
            { name: "existing – learn from the tests already in this repo", value: "existing" as const },
            { name: "scratch – scaffold a new TypeScript API test framework", value: "scratch" as const },
          ],
        })
      : suggestedMode);

  // 2. API framework
  let apiFramework = opts.apiFramework ?? (mode === "scratch" ? "playwright" : det.apiFramework ?? "playwright");
  if (interactive && !opts.apiFramework && mode === "existing") {
    apiFramework = await select({
      message: "API test framework",
      default: apiFramework,
      choices: (["playwright", "supertest", "axios", "pactum", "jest", "vitest", "mocha", "other"] as const).map((v) => ({
        name: v,
        value: v,
      })),
    });
  }

  // 3. Workspace / services
  const workspaceDir = path.resolve(cwd, opts.workspace ?? "..");
  const discovered = discoverServices(workspaceDir, cwd);
  let services = discovered;
  if (interactive && discovered.length) {
    const keep = await confirm({
      message: `Found ${discovered.length} service repo(s) in ${workspaceDir}: ${discovered.map((s) => s.name).join(", ")}. Include all?`,
      default: true,
    });
    if (!keep) services = [];
  }
  if (!services.length) log.warn("No service repos added. Edit workspace.services in the config later.");

  // 4. CI
  // 4b. Operating level: start read-only unless the team opts into generation.
  const level =
    opts.level ??
    (interactive
      ? await select({
          message: "Operating level",
          default: "intelligence" as const,
          choices: [
            { name: "1 · QA intelligence – read-only gap reports, risk and requirement conflicts on every MR (recommended start)", value: "intelligence" as const },
            { name: "2 · Assisted test maintenance – also generate/update API tests through reviewed MRs", value: "maintenance" as const },
          ],
        })
      : "intelligence");

  const ci =
    opts.ci ??
    (interactive
      ? await select({
          message: "CI platform",
          default: det.ci.jenkins && !det.ci.gitlab ? "jenkins" : "gitlab",
          choices: [
            { name: "GitLab CI", value: "gitlab" as const },
            { name: "Jenkins", value: "jenkins" as const },
          ],
        })
      : det.ci.jenkins && !det.ci.gitlab
        ? "jenkins"
        : "gitlab");

  const projectName =
    opts.name ??
    (interactive
      ? await input({ message: "Project name", default: readJson<any>(path.join(cwd, "package.json"))?.name ?? path.basename(cwd) })
      : readJson<any>(path.join(cwd, "package.json"))?.name ?? path.basename(cwd));

  const apiDir = mode === "existing" ? det.apiDir ?? "tests/api" : "tests/api";
  // Parse through the schema so every default (guardrails, limits, verification) is written out explicitly.
  const config: Config = ConfigSchema.parse({
    version: 1,
    mode,
    level,
    project: { name: projectName },
    workspace: {
      services: services.map((s) => ({ name: s.name, path: s.path, openapi: s.openapi, dependsOn: [] })),
    },
    tests: {
      language: mode === "scratch" ? "typescript" : det.language,
      api: {
        framework: apiFramework,
        dir: apiDir,
        helpersDir: mode === "scratch" ? "src/api" : guessHelpersDir(cwd),
        runCommand: defaultRunCommand(apiFramework),
        baseUrlEnv: "QA_BASE_URL",
        extraWritePaths: mode === "scratch" ? ["src/fixtures/**", "src/data/**", "src/schemas/**"] : guessExtraWritePaths(cwd),
      },
      web: { enabled: Boolean(opts.web) },
      mobile: { enabled: Boolean(opts.mobile) },
    },
    ci: { platform: ci },
  });

  writeConfig(cwd, config);
  log.ok(`wrote ${CONFIG_FILE}`);

  const vars = templateVars(config);
  const written = writeTemplates(cwd, config, vars, Boolean(opts.force));
  for (const [file, status] of written) {
    if (status === "skipped") log.dim(`  kept     ${file}`);
    else log.dim(`  ${status.padEnd(8)} ${file}`);
  }

  writeTestMap(cwd, config, det);

  writeKbReadme(cwd, config);
  ensureGitignore(cwd);
  if (mode === "scratch") mergePackageJson(cwd, config.tests.web.enabled, config.tests.mobile.enabled);

  printNextSteps(config);
  return config;
}

function reportDetection(det: Detection) {
  const fw = Object.entries(det.frameworks)
    .filter(([, v]) => v)
    .map(([k]) => k);
  log.step(`frameworks: ${fw.length ? fw.join(", ") : "none detected"}`);
  log.step(`test files: ${det.testFiles.length} (API: ${det.apiTestFiles.length}${det.apiDir ? ` in ${det.apiDir}` : ""})`);
  if (det.ci.gitlab || det.ci.jenkins) log.step(`CI: ${[det.ci.gitlab && "GitLab", det.ci.jenkins && "Jenkins"].filter(Boolean).join(", ")}`);
}

/** Fixture / data / schema folders that exist in an existing project; the agent may write there too. */
function guessExtraWritePaths(cwd: string): string[] {
  const candidates = ["fixtures", "src/fixtures", "test/fixtures", "tests/fixtures", "data", "src/data", "test-data", "factories", "src/factories", "schemas", "src/schemas"];
  return candidates.filter((d) => fs.existsSync(path.join(cwd, d))).map((d) => `${d}/**`);
}

function guessHelpersDir(cwd: string): string {
  for (const d of ["src/api", "src/helpers", "helpers", "src/utils", "utils", "support", "src/support", "lib"]) {
    if (fs.existsSync(path.join(cwd, d))) return d;
  }
  return "src/api";
}

export function templateVars(c: Config): TemplateVars {
  return {
    projectName: c.project.name,
    mode: c.mode,
    isScratch: c.mode === "scratch",
    level: c.level,
    isMaintenance: c.level === "maintenance",
    isExisting: c.mode === "existing",
    apiFramework: c.tests.api.framework,
    isPlaywright: c.tests.api.framework === "playwright",
    apiDir: c.tests.api.dir,
    helpersDir: c.tests.api.helpersDir,
    runCommand: c.tests.api.runCommand,
    baseUrlEnv: c.tests.api.baseUrlEnv,
    ciPlatform: c.ci.platform,
    isGitlab: c.ci.platform === "gitlab",
    isJenkins: c.ci.platform === "jenkins",
    targetBranch: c.ci.targetBranch,
    maxFixAttempts: c.agent.maxFixAttempts,
    webEnabled: c.tests.web.enabled,
    webDir: c.tests.web.dir,
    pagesDir: c.tests.web.pagesDir,
    pagesDirRe: c.tests.web.pagesDir.split("/").map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[\\\\/]"),
    webRunCommand: c.tests.web.runCommand,
    webBaseUrlEnv: c.tests.web.baseUrlEnv,
    healing: c.tests.web.healing,
    a11y: c.tests.web.accessibility !== "off",
    healingBubblegum: c.tests.web.enabled && c.tests.web.healing === "bubblegum",
    healingVar: c.tests.web.healing === "bubblegum" ? "bubblegum" : "off",
    suiteRunCommand: suiteRunCommand(c),
    cdpPort: c.tests.web.bubblegum.cdpPort,
    bubblegumPackage: c.tests.web.bubblegum.package,
    mobileEnabled: c.tests.mobile.enabled,
    mobileDir: c.tests.mobile.dir,
    screensDir: c.tests.mobile.screensDir,
    mobileRunCommand: c.tests.mobile.runCommand,
    mobilePlatform: c.tests.mobile.platform,
    appiumUrl: c.tests.mobile.appiumUrl,
    serviceList: c.workspace.services.map((s) => `- **${s.name}** – \`${s.path}\`${s.openapi ? ` (OpenAPI: \`${s.openapi}\`)` : ""}`).join("\n") || "- _(none yet – add them to qa-sentinel.config.yaml)_",
  };
}

/** Copies agents, skills, CLAUDE.md fragment, CI files and (scratch) the scaffold. */
export function writeTemplates(cwd: string, c: Config, vars: TemplateVars, force: boolean): [string, string][] {
  const results: [string, string][] = [];
  const put = (rel: string, content: string, overwrite = force) => {
    results.push([rel, writeFileSafe(path.join(cwd, rel), content, overwrite)]);
  };

  for (const f of listTemplateDir("agents")) put(`.claude/agents/${f}`, render(readTemplate(`agents/${f}`), vars));
  for (const f of listTemplateDir("skills")) {
    if (!skillWanted(c, f)) continue;
    put(`.claude/skills/${f}`, render(readTemplate(`skills/${f}`), vars));
  }

  // Project context: our own file, imported from CLAUDE.md so we never clobber the team's.
  put(".claude/qa-sentinel.md", render(readTemplate("claude/qa-sentinel.md"), vars), true);
  const claudeMd = path.join(cwd, "CLAUDE.md");
  const importLine = "@.claude/qa-sentinel.md";
  if (!fs.existsSync(claudeMd)) {
    put("CLAUDE.md", render(readTemplate("claude/CLAUDE.md"), vars));
  } else if (!fs.readFileSync(claudeMd, "utf8").includes(importLine)) {
    fs.appendFileSync(claudeMd, `\n\n## QA agents\n${importLine}\n`);
    results.push(["CLAUDE.md", "appended import"]);
  }

  const ciDir = `ci/${c.ci.platform}`;
  for (const f of listTemplateDir(ciDir)) {
    if (c.level === "intelligence" && f === "Jenkinsfile.generate") continue; // generation is off at level 1
    put(`ci/qa-sentinel/${f}`, render(readTemplate(`${ciDir}/${f}`), vars));
  }

  if (c.mode === "scratch") {
    for (const f of listTemplateDir("scaffold/playwright-api")) {
      if (f === "package.fragment.json") continue;
      put(f.replace(/\.tmpl$/, ""), render(readTemplate(`scaffold/playwright-api/${f}`), vars), false);
    }
  }
  if (c.tests.web.enabled) results.push(...writeWebScaffold(cwd, c, vars));
  if (c.tests.mobile.enabled) results.push(...writeMobileScaffold(cwd, c, vars));
  return results;
}

/** Layer skills are only installed when their layer is on. */
function skillWanted(c: Config, f: string): boolean {
  if (f.startsWith("write-web-test/")) return c.tests.web.enabled;
  if (f.startsWith("write-mobile-test/")) return c.tests.mobile.enabled;
  return true;
}

/**
 * Mobile layer files: wdio.conf.ts, the ui helper, evidence hooks (recording, screenshot, results for qa-sentinel),
 * screen objects base, fixture, example spec. Never overwrites; paths follow tests.mobile (dir, screensDir).
 */
export function writeMobileScaffold(cwd: string, c: Config, vars: TemplateVars): [string, string][] {
  const results: [string, string][] = [];
  const target = (f: string) =>
    f
      .replace(/\.tmpl$/, "")
      .replace(/^src\/screens\//, `${c.tests.mobile.screensDir}/`)
      .replace(/^tests\/mobile\//, `${c.tests.mobile.dir}/`);
  for (const f of listTemplateDir("scaffold/wdio-mobile")) {
    const rel = target(f);
    const content = render(readTemplate(`scaffold/wdio-mobile/${f}`), vars);
    results.push([rel, writeFileSafe(path.join(cwd, rel), content, false)]);
  }
  return results;
}

/**
 * Web layer files: ui helper (with the optional Bubblegum hook), page objects base, fixtures, example spec.
 * Never overwrites; paths follow tests.web (dir, pagesDir).
 */
export function writeWebScaffold(cwd: string, c: Config, vars: TemplateVars): [string, string][] {
  const results: [string, string][] = [];
  const target = (f: string) =>
    f
      .replace(/\.tmpl$/, "")
      .replace(/^src\/pages\//, `${c.tests.web.pagesDir}/`)
      .replace(/^tests\/web\//, `${c.tests.web.dir}/`);
  for (const f of listTemplateDir("scaffold/playwright-web")) {
    const rel = target(f);
    // Relative imports in the templates assume the default layout (src/pages, tests/web/<area>/).
    const content = render(readTemplate(`scaffold/playwright-web/${f}`), vars);
    results.push([rel, writeFileSafe(path.join(cwd, rel), content, false)]);
  }
  return results;
}

function writeTestMap(cwd: string, c: Config, det: Detection) {
  const file = path.join(cwd, "test-map.yaml");
  if (fs.existsSync(file)) {
    log.dim("  kept     test-map.yaml");
    return;
  }
  const services: Record<string, unknown> = {};
  for (const s of c.workspace.services) {
    services[s.name] = { path: s.path, openapi: s.openapi ?? null, endpoints: {}, screens: {} };
  }
  const doc = {
    version: 1,
    services,
    unmapped: det.apiTestFiles,
  };
  const header =
    "# Traceability map: service → endpoint/screen → test files.\n" +
    "# Draft it with `qa-sentinel learn`, then review. Agents read and update this file.\n" +
    '# Example endpoint entry:  "POST /orders": [tests/api/orders/create-order.spec.ts]\n';
  fs.writeFileSync(file, header + YAML.stringify(doc));
  log.dim("  created  test-map.yaml");
}

function writeKbReadme(cwd: string, c: Config) {
  const file = path.join(cwd, c.knowledge.dir, "README.md");
  if (fs.existsSync(file)) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, KB_README);
  log.dim(`  created  ${c.knowledge.dir}/README.md (add domain rules here; agents read them)`);
}

function ensureGitignore(cwd: string) {
  const file = path.join(cwd, ".gitignore");
  const wanted = [".qa-sentinel/runs/", "qa-sentinel-summary.md", "qa-gap-report.md", "qa-regression.txt", "qa-feature-*", "qa-showcase.md", "qa-showcase/", "qa-verify.md", "qa-healed.md", "qa-healed.json", "qa-story-review.md", "test-results/", "playwright-report/", "node_modules/", ".env"];
  const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const have = new Set(current.split(/\r?\n/).map((l) => l.trim()));
  const missing = wanted.filter((l) => !have.has(l));
  if (missing.length) fs.writeFileSync(file, current + (current && !current.endsWith("\n") ? "\n" : "") + missing.join("\n") + "\n");
}

export const MOBILE_DEV_DEPENDENCIES: Record<string, string> = {
  "@wdio/cli": "^9.5.0",
  "@wdio/local-runner": "^9.5.0",
  "@wdio/mocha-framework": "^9.5.0",
  "@wdio/spec-reporter": "^9.5.0",
  "@wdio/junit-reporter": "^9.5.0",
  "@wdio/globals": "^9.5.0",
  webdriverio: "^9.5.0",
  "@types/mocha": "^10.0.10",
};

export function mergePackageJson(cwd: string, web = false, mobile = false) {
  const file = path.join(cwd, "package.json");
  const fragment = JSON.parse(readTemplate("scaffold/playwright-api/package.fragment.json"));
  const pkg = readJson<any>(file) ?? { name: path.basename(cwd), version: "0.1.0", private: true };
  pkg.scripts = { ...fragment.scripts, ...(pkg.scripts ?? {}) };
  pkg.devDependencies = { ...fragment.devDependencies, ...(pkg.devDependencies ?? {}) };
  if (web) {
    pkg.scripts["test:web"] ??= "playwright test --project=web";
    pkg.devDependencies["@axe-core/playwright"] ??= "^4.10.0";
  }
  if (mobile) {
    pkg.scripts["test:mobile"] ??= "wdio run wdio.conf.ts";
    for (const [k, v] of Object.entries(MOBILE_DEV_DEPENDENCIES)) pkg.devDependencies[k] ??= v;
  }
  ensureDir(cwd);
  fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
  log.dim("  updated  package.json (scripts, devDependencies)");
}

function printNextSteps(c: Config) {
  log.title("Next steps");
  log.info(
    c.level === "intelligence"
      ? "  Level 1 (QA intelligence): read-only reports on every MR. Switch to level: maintenance when the team trusts them."
      : "  Level 2 (assisted test maintenance): reports on every MR, and generated tests through reviewed MRs.",
  );
  const steps = [
    c.mode === "scratch" ? "npm install && npx playwright install --with-deps chromium" : undefined,
    c.tests.web.enabled ? `Set ${c.tests.web.baseUrlEnv} to your front end (no browser download? QA_BROWSER_CHANNEL=chrome uses installed Chrome)` : undefined,
    c.tests.mobile.enabled ? `Mobile: start Appium (npx appium, with the uiautomator2/xcuitest driver) and a device, then set QA_APP (or QA_APP_PACKAGE/QA_BUNDLE_ID) and QA_MOBILE_PLATFORM` : undefined,
    "Review qa-sentinel.config.yaml (services, run command, GitLab project)",
    c.mode === "existing"
      ? "qa-sentinel learn   # agent drafts your conventions + test-map.yaml; review the diff"
      : "qa-sentinel learn   # agent fills test-map.yaml from your service specs",
    "qa-sentinel doctor  # checks access, keys and readiness",
    c.ci.platform === "gitlab"
      ? "Add ci/qa-sentinel/*.gitlab-ci.yml to your pipelines (see ci/qa-sentinel/README.md)"
      : "Create Jenkins jobs from ci/qa-sentinel/Jenkinsfile.* (see ci/qa-sentinel/README.md)",
  ].filter(Boolean) as string[];
  steps.forEach((s, i) => log.info(`  ${i + 1}. ${s}`));
}

/**
 * Add the web layer to a project that already runs qa-sentinel: turns tests.web on (keeping the rest of the
 * config and its comments), writes the web scaffold and the write-web-test skill, and prints the Playwright
 * project to add (playwright.config.* is a human-owned file).
 */
export function addWebCommand(o: { cwd: string; healing?: "none" | "bubblegum" }): Config {
  const cwd = path.resolve(o.cwd);
  const file = configPath(cwd);
  const doc = YAML.parseDocument(fs.readFileSync(file, "utf8"));
  doc.setIn(["tests", "web", "enabled"], true);
  if (o.healing) doc.setIn(["tests", "web", "healing"], o.healing);
  fs.writeFileSync(file, doc.toString());
  const c = loadConfig(cwd);
  const vars = templateVars(c);
  const results = writeWebScaffold(cwd, c, vars);
  for (const f of listTemplateDir("skills")) {
    if (f.startsWith("write-web-test/")) results.push([`.claude/skills/${f}`, writeFileSafe(path.join(cwd, ".claude/skills", f), render(readTemplate(`skills/${f}`), vars), false)]);
  }
  // qa-sentinel-owned files that depend on the layers: project context and the CI templates.
  results.push([".claude/qa-sentinel.md", writeFileSafe(path.join(cwd, ".claude/qa-sentinel.md"), render(readTemplate("claude/qa-sentinel.md"), vars), true)]);
  const ciDir = `ci/${c.ci.platform}`;
  for (const f of listTemplateDir(ciDir)) {
    if (c.level === "intelligence" && f === "Jenkinsfile.generate") continue;
    results.push([`ci/qa-sentinel/${f}`, writeFileSafe(path.join(cwd, "ci/qa-sentinel", f), render(readTemplate(`${ciDir}/${f}`), vars), true)]);
  }
  for (const [f, status] of results) log.dim(`  ${status === "skipped" ? "kept    " : status.padEnd(8)} ${f}`);
  log.ok("web layer enabled in qa-sentinel.config.yaml");
  log.title("Add this project to playwright.config.ts");
  log.info(
    [
      "    {",
      '      name: "web",',
      `      testDir: "./${c.tests.web.dir}",`,
      "      use: {",
      `        baseURL: process.env.${c.tests.web.baseUrlEnv}?.replace(/\\/?$/, "/"),`,
      '        video: "on",          // evidence for the showcase stage',
      '        screenshot: "on",',
      '        trace: "retain-on-failure",',
      "        launchOptions: process.env.QA_BROWSER_CHANNEL ? { channel: process.env.QA_BROWSER_CHANNEL } : {},",
      "      },",
      "    },",
    ].join("\n"),
  );
  log.info(`Then: npx playwright install chromium (or QA_BROWSER_CHANNEL=chrome), set ${c.tests.web.baseUrlEnv}, and run qa-sentinel doctor.`);
  if (c.tests.web.healing === "bubblegum") log.info(`Healing: npm i -D ${c.tests.web.bubblegum.package} && pip install "bubblegum-ai[web]".`);
  return c;
}

/**
 * Upgrades: write agents and skills a newer qa-sentinel ships but this repo doesn't have yet (never overwrites a
 * team's edited copy). Called by the commands that rely on them.
 */
export function ensureAgentFiles(cwd: string, c: Config): string[] {
  const vars = templateVars(c);
  const added: string[] = [];
  const put = (rel: string, tpl: string) => {
    if (fs.existsSync(path.join(cwd, rel))) return;
    fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true });
    fs.writeFileSync(path.join(cwd, rel), render(readTemplate(tpl), vars));
    added.push(rel);
  };
  for (const f of listTemplateDir("agents")) put(`.claude/agents/${f}`, `agents/${f}`);
  for (const f of listTemplateDir("skills")) {
    if (!skillWanted(c, f)) continue;
    put(`.claude/skills/${f}`, `skills/${f}`);
  }
  if (added.length) log.dim(`  added ${added.join(", ")} (new in this qa-sentinel version)`);
  return added;
}

/**
 * `qa-sentinel upgrade`: refresh the files qa-sentinel owns after updating the package: agents, skills (except the
 * write-*-test skills, which hold your learned conventions; those are only added when missing), the CI templates
 * in ci/qa-sentinel/ and .claude/qa-sentinel.md. Review with git diff and commit.
 */
export function upgradeCommand(o: { cwd: string }): number {
  const cwd = path.resolve(o.cwd);
  const c = loadConfig(cwd);
  const vars = templateVars(c);
  const changed: string[] = [];
  const write = (rel: string, content: string, overwrite: boolean) => {
    const abs = path.join(cwd, rel);
    const before = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : undefined;
    if (before !== undefined && (!overwrite || before === content)) return;
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    changed.push(`${before === undefined ? "added  " : "updated"} ${rel}`);
  };
  for (const f of listTemplateDir("agents")) write(`.claude/agents/${f}`, render(readTemplate(`agents/${f}`), vars), true);
  for (const f of listTemplateDir("skills")) {
    if (!skillWanted(c, f)) continue;
    write(`.claude/skills/${f}`, render(readTemplate(`skills/${f}`), vars), !/^write-(api|web|mobile)-test\//.test(f));
  }
  write(".claude/qa-sentinel.md", render(readTemplate("claude/qa-sentinel.md"), vars), true);
  const ciDir = `ci/${c.ci.platform}`;
  for (const f of listTemplateDir(ciDir)) {
    if (c.level === "intelligence" && f === "Jenkinsfile.generate") continue;
    write(`ci/qa-sentinel/${f}`, render(readTemplate(`${ciDir}/${f}`), vars), true);
  }
  ensureGitignore(cwd);
  if (!changed.length) log.ok("everything qa-sentinel owns is up to date");
  else {
    changed.forEach((x) => log.dim(`  ${x}`));
    log.ok(`${changed.length} file(s) refreshed. Review with git diff, then commit. Your write-*-test skills (learned conventions) were kept.`);
  }
  return 0;
}

/**
 * Add the mobile layer (WebdriverIO + Appium) to a project that already runs qa-sentinel: turns tests.mobile on,
 * writes the mobile scaffold and the write-mobile-test skill, refreshes the project context and CI templates, and
 * adds the WebdriverIO packages to package.json.
 */
export function addMobileCommand(o: { cwd: string; platform?: "android" | "ios" }): Config {
  const cwd = path.resolve(o.cwd);
  const file = configPath(cwd);
  const doc = YAML.parseDocument(fs.readFileSync(file, "utf8"));
  doc.setIn(["tests", "mobile", "enabled"], true);
  if (o.platform) doc.setIn(["tests", "mobile", "platform"], o.platform);
  fs.writeFileSync(file, doc.toString());
  const c = loadConfig(cwd);
  const vars = templateVars(c);
  const results = writeMobileScaffold(cwd, c, vars);
  for (const f of listTemplateDir("skills")) {
    if (f.startsWith("write-mobile-test/")) results.push([`.claude/skills/${f}`, writeFileSafe(path.join(cwd, ".claude/skills", f), render(readTemplate(`skills/${f}`), vars), false)]);
  }
  results.push([".claude/qa-sentinel.md", writeFileSafe(path.join(cwd, ".claude/qa-sentinel.md"), render(readTemplate("claude/qa-sentinel.md"), vars), true)]);
  const ciDir = `ci/${c.ci.platform}`;
  for (const f of listTemplateDir(ciDir)) {
    if (c.level === "intelligence" && f === "Jenkinsfile.generate") continue;
    results.push([`ci/qa-sentinel/${f}`, writeFileSafe(path.join(cwd, "ci/qa-sentinel", f), render(readTemplate(`${ciDir}/${f}`), vars), true)]);
  }
  if (fs.existsSync(path.join(cwd, "package.json"))) {
    const pkg = readJson<any>(path.join(cwd, "package.json"));
    pkg.devDependencies ??= {};
    pkg.scripts ??= {};
    pkg.scripts["test:mobile"] ??= "wdio run wdio.conf.ts";
    for (const [k, v] of Object.entries(MOBILE_DEV_DEPENDENCIES)) pkg.devDependencies[k] ??= v;
    fs.writeFileSync(path.join(cwd, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
    results.push(["package.json", "updated"]);
  }
  for (const [f, status] of results) log.dim(`  ${status === "skipped" ? "kept    " : status.padEnd(8)} ${f}`);
  log.ok("mobile layer enabled in qa-sentinel.config.yaml");
  log.info(
    [
      "Next:",
      "  1. npm install",
      "  2. Add wdio.conf.ts to tsconfig.json's include (and \"@wdio/globals/types\" is picked up from src/mobile/globals.d.ts)",
      "  3. Start Appium (npm i -g appium && appium driver install uiautomator2 | xcuitest; appium) and an emulator or device",
      "  4. Set QA_APP (or QA_APP_PACKAGE + QA_APP_ACTIVITY / QA_BUNDLE_ID), QA_MOBILE_PLATFORM, and QA_APPIUM_URL if not local",
      `  5. ${c.tests.mobile.runCommand} --spec ${c.tests.mobile.dir}/example/home.spec.ts, then qa-sentinel doctor`,
    ].join("\n"),
  );
  return c;
}
