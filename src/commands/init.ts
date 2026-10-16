import { isGitRepo, repoPrefix } from "../git.js";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { KB_README } from "../kb.js";
import { checkbox, confirm, input, select } from "@inquirer/prompts";
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
  /** Where stories come from: jira | mr-description | none. */
  requirements?: "jira" | "mr-description" | "none";
  /** Jira site, e.g. https://yourco.atlassian.net (or a Server/DC URL). */
  jiraUrl?: string;
  /** Jira project keys whose stories this test repo covers, e.g. ["PAY", "CARD"]. */
  jiraProjects?: string[];
  /** GitLab URL (self-hosted or gitlab.com). */
  gitlabUrl?: string;
  /** This test repo's GitLab project path, e.g. group/qa-tests. */
  testRepoProject?: string;
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

  // 5. Test layers (API is always on).
  let web = Boolean(opts.web);
  let mobile = Boolean(opts.mobile);
  if (interactive && opts.web === undefined && opts.mobile === undefined) {
    const picked = await checkbox({
      message: "Test layers besides API",
      choices: [
        { name: "Web UI (Playwright, page objects)", value: "web", checked: web },
        { name: "Mobile app (WebdriverIO + Appium, screen objects)", value: "mobile", checked: mobile },
      ],
    });
    web = picked.includes("web");
    mobile = picked.includes("mobile");
  }

  // 6. Where stories (acceptance criteria) come from, and where the code lives.
  const reqSource =
    opts.requirements ??
    (opts.jiraUrl
      ? "jira"
      : interactive
        ? await select({
            message: "Where are your stories and acceptance criteria?",
            default: "jira" as const,
            choices: [
              { name: "Jira", value: "jira" as const },
              { name: "In the merge request description", value: "mr-description" as const },
              { name: "Nowhere yet (tests are checked against the API contract and code only)", value: "none" as const },
            ],
          })
        : "mr-description");
  let jiraUrl = opts.jiraUrl;
  let jiraProjects = opts.jiraProjects ?? [];
  if (reqSource === "jira" && interactive) {
    jiraUrl ??= (await input({ message: "Jira URL (e.g. https://yourco.atlassian.net)", validate: (v) => /^https?:\/\/\S+$/.test(v.trim()) || "a URL starting with https://" })).trim();
    if (!jiraProjects.length)
      jiraProjects = (await input({ message: "Jira project keys this test repo covers (comma-separated, e.g. PAY,CARD)" }))
        .split(/[\s,]+/)
        .map((k) => k.trim().toUpperCase())
        .filter(Boolean);
  }
  let gitlabUrl = opts.gitlabUrl;
  let testRepoProject = opts.testRepoProject;
  if (ci === "gitlab" && interactive) {
    gitlabUrl ??= (await input({ message: "GitLab URL", default: "https://gitlab.com" })).trim();
    testRepoProject ??= (await input({ message: "This test repo's GitLab project path (e.g. group/qa-tests; empty to fill in later)" })).trim() || undefined;
  }

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
      web: { enabled: web },
      mobile: { enabled: mobile },
    },
    // A new framework gets the data ledger; existing projects keep their own cleanup (`qa-sentinel add-data-ledger`).
    testData: { cleanup: mode === "scratch" ? "ledger" : "project" },
    requirements: {
      source: reqSource,
      ...(jiraProjects.length ? { storyKeyPattern: `(?:${jiraProjects.join("|")})-\\d+` } : {}),
      jira: { ...(jiraUrl ? { baseUrl: jiraUrl.replace(/\/+$/, "") } : {}), projectKeys: jiraProjects },
    },
    ci: { platform: ci, ...(gitlabUrl ? { gitlabUrl: gitlabUrl.replace(/\/+$/, "") } : {}), ...(testRepoProject ? { testRepoProject } : {}) },
  });

  writeConfig(cwd, config);
  log.ok(`wrote ${CONFIG_FILE}`);

  const vars = templateVars(config, cwd);
  const written = writeTemplates(cwd, config, vars, Boolean(opts.force));
  for (const [file, status] of written) {
    if (status === "skipped") log.dim(`  kept     ${file}`);
    else log.dim(`  ${status.padEnd(8)} ${file}`);
  }

  writeTestMap(cwd, config, det);

  writeKbReadme(cwd, config);
  ensureGitignore(cwd);
  if (mode === "scratch") mergePackageJson(cwd, config.tests.web.enabled, config.tests.mobile.enabled);
  else addLayerDependencies(cwd, config);

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

export function templateVars(c: Config, cwd?: string): TemplateVars {
  // A test repo that is a folder of a larger repository (a monorepo package): CI runs from that folder.
  const testsSubdir = cwd && isGitRepo(cwd) ? repoPrefix(cwd) : "";
  return {
    testsSubdir,
    testsSubdirNone: !testsSubdir,
    testsPrefix: testsSubdir ? `${testsSubdir}/` : "",
    // GitLab rules take /regex/ literals: slashes inside are escaped.
    skipBranchesRe: c.ci.skipBranches.map((r) => r.replace(/(?<!\\)\//g, "\\/")).join("|"),
    // In a merge commit the branch is followed by "' into …": no ^ or $ anchors there.
    skipBranchesMergeRe: c.ci.skipBranches.map((r) => r.replace(/^\^/, "").replace(/\$$/, "").replace(/(?<!\\)\//g, "\\/")).join("|"),
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
    ledgerDir: c.testData.ledgerDir,
    sweepAuthEnv: c.testData.sweepAuthEnv,
    ledgerCleanup: c.testData.cleanup === "ledger",
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

/**
 * Relative imports between scaffold files, rewritten for where the files actually go: each import is resolved
 * at the template's default location, moved with the same mapping as the files, and made relative again.
 */
export function rebaseImports(content: string, defaultFile: string, actualFile: string, move: (f: string) => string): string {
  return content.replace(/(from\s+["'])(\.{1,2}\/[^"']+)(["'])/g, (_m, pre: string, spec: string, post: string) => {
    const defaultTarget = path.posix.normalize(path.posix.join(path.posix.dirname(defaultFile), spec));
    const actualTarget = move(`${defaultTarget}.ts`).replace(/\.ts$/, "");
    let rel = path.posix.relative(path.posix.dirname(actualFile), actualTarget);
    if (!rel.startsWith(".")) rel = `./${rel}`;
    return `${pre}${rel}${post}`;
  });
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
    const content = rebaseImports(render(readTemplate(`scaffold/wdio-mobile/${f}`), vars), f.replace(/\.tmpl$/, ""), rel, target);
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
    // The templates import each other assuming the default layout; follow pagesDir / dir when they differ.
    const content = rebaseImports(render(readTemplate(`scaffold/playwright-web/${f}`), vars), f.replace(/\.tmpl$/, ""), rel, target);
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
  const wanted = [".qa-sentinel/runs/", "qa-sentinel-summary.md", "qa-gap-report.md", "qa-regression.txt", "qa-feature-*", "qa-showcase.md", "qa-showcase/", "qa-verify.md", "qa-healed.md", "qa-healed.json", "qa-story-review.md", "qa-story-check.md", "qa-metrics.md", "qa-lessons.md", ".qa-data/", "qa-contract-check.md", "qa-coverage.md", "qa-coverage.json", "qa-services.draft.*", "test-results/", "playwright-report/", "node_modules/", ".env", ".DS_Store", "Thumbs.db"];
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

/** Existing projects: add only the packages the web/mobile scaffold imports (never touching versions already there). */
export function addLayerDependencies(cwd: string, c: Config): string[] {
  const file = path.join(cwd, "package.json");
  if (!fs.existsSync(file)) return [];
  const pkg = readJson<any>(file);
  if (!pkg) return [];
  pkg.devDependencies ??= {};
  const want: Record<string, string> = {
    ...(c.tests.web.enabled && c.tests.web.accessibility !== "off" ? { "@axe-core/playwright": "^4.10.0" } : {}),
    ...(c.tests.mobile.enabled ? MOBILE_DEV_DEPENDENCIES : {}),
  };
  const added = Object.keys(want).filter((k) => !pkg.devDependencies[k] && !pkg.dependencies?.[k]);
  if (!added.length) return [];
  for (const k of added) pkg.devDependencies[k] = want[k];
  fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
  log.dim(`  updated  package.json (added ${added.join(", ")}; run npm install)`);
  return added;
}

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
    "Review qa-sentinel.config.yaml (services and their kind: api | web | mobile, run commands, GitLab project)",
    c.requirements.source === "jira"
      ? "qa-sentinel story-check --story <KEY> --fields   # how your stories are read; set the AC field and story template (docs/ONBOARDING.md)"
      : undefined,
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
  const vars = templateVars(c, cwd);
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
  addLayerDependencies(cwd, c);
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
 * Existing projects: switch test data to the ledger. Writes ledger.ts (Playwright, TypeScript) next to the data
 * helpers, sets testData.cleanup: ledger, and prints how to hook it into the project's own fixture (a human-owned file).
 */
export function addDataLedgerCommand(o: { cwd: string; dir?: string }): Config {
  const cwd = path.resolve(o.cwd);
  const file = configPath(cwd);
  const before = loadConfig(cwd);
  if (before.tests.api.framework !== "playwright" || before.tests.language !== "typescript")
    log.warn("the ledger template is for Playwright + TypeScript; for another stack, use it as a reference and keep the same file format (.qa-data/*.jsonl), so `qa-sentinel data sweep` works");
  const doc = YAML.parseDocument(fs.readFileSync(file, "utf8"));
  doc.setIn(["testData", "cleanup"], "ledger");
  fs.writeFileSync(file, doc.toString());
  const c = loadConfig(cwd);
  const folders = c.tests.api.extraWritePaths.map((p) => p.replace(/\/\*.*$/, ""));
  const dir = o.dir ?? [/data/i, /factor/i, /fixture/i].map((re) => folders.find((f) => re.test(f))).find(Boolean) ?? c.tests.api.helpersDir;
  const rel = path.join(dir, "ledger.ts");
  const status = writeFileSafe(path.join(cwd, rel), render(readTemplate("scaffold/playwright-api/src/data/ledger.ts.tmpl"), templateVars(c, cwd)), false);
  log.dim(`  ${status === "skipped" ? "kept    " : status.padEnd(8)} ${rel}`);
  ensureGitignore(cwd);
  log.ok("testData.cleanup: ledger in qa-sentinel.config.yaml");
  log.title("Hook it into your fixture (once)");
  log.info(
    [
      `    import { DataLedger } from "<relative path to>/${rel.replace(/\\/g, "/").replace(/\.ts$/, "")}";`,
      "    data: async ({ request }, use, testInfo) => {",
      "      const ledger = new DataLedger(request, testInfo.titlePath.join(\" › \"), `${testInfo.testId}-${testInfo.retry}`);",
      "      await use(/* your data helper, with access to */ ledger);",
      "      const failed = await ledger.cleanup();   // newest first, pass or fail",
      "      if (failed.length) testInfo.annotations.push({ type: \"data-cleanup-failed\", description: failed.join(\"; \") });",
      "    },",
    ].join("\n"),
  );
  log.info("Then every helper that creates data calls ledger.track(kind, id, { path: <delete path> }); generated tests do this from now on. Leftovers from killed runs: qa-sentinel data sweep.");
  return c;
}

/**
 * Upgrades: write agents and skills a newer qa-sentinel ships but this repo doesn't have yet (never overwrites a
 * team's edited copy). Called by the commands that rely on them.
 */
export function ensureAgentFiles(cwd: string, c: Config): string[] {
  const vars = templateVars(c, cwd);
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
  const vars = templateVars(c, cwd);
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
  const vars = templateVars(c, cwd);
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
  if (addLayerDependencies(cwd, c).length) results.push(["package.json", "updated"]);
  const tsc = includeInTsconfig(cwd, "wdio.conf.ts");
  if (tsc) results.push(["tsconfig.json", tsc]);
  for (const [f, status] of results) log.dim(`  ${status === "skipped" ? "kept    " : status.padEnd(8)} ${f}`);
  log.ok("mobile layer enabled in qa-sentinel.config.yaml");
  log.info(
    [
      "Next:",
      "  - npm install",
      ...(tsc === "manual" ? ["  - Add wdio.conf.ts to tsconfig.json's include (it has comments, so qa-sentinel didn't rewrite it)"] : []),
      "  - Start Appium (npm i -g appium && appium driver install uiautomator2 | xcuitest; appium) and an emulator or device",
      "  - Set QA_APP (or QA_APP_PACKAGE + QA_APP_ACTIVITY / QA_BUNDLE_ID), QA_MOBILE_PLATFORM, and QA_APPIUM_URL if not local",
      `  - ${c.tests.mobile.runCommand} --spec ${c.tests.mobile.dir}/example/home.spec.ts, then qa-sentinel doctor`,
    ].join("\n"),
  );
  return c;
}

/**
 * Add a file to tsconfig.json's "include" so the type-check covers it. Returns "updated", "kept" (already there or no
 * include list), "manual" (the file has comments or isn't plain JSON: say so instead of rewriting it), or undefined
 * when there is no tsconfig.json.
 */
export function includeInTsconfig(cwd: string, file: string): "updated" | "kept" | "manual" | undefined {
  const p = path.join(cwd, "tsconfig.json");
  if (!fs.existsSync(p)) return undefined;
  let j: any;
  try {
    j = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return "manual";
  }
  if (!Array.isArray(j.include) || j.include.includes(file)) return "kept";
  j.include.push(file);
  fs.writeFileSync(p, JSON.stringify(j, null, 2) + "\n");
  return "updated";
}
