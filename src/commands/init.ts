import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { KB_README } from "../kb.js";
import { confirm, input, select } from "@inquirer/prompts";
import { CONFIG_FILE, type Config, ConfigSchema, configPath, writeConfig } from "../config.js";
import { defaultRunCommand, detectProject, discoverServices, type Detection } from "../detect.js";
import { ensureDir, readJson, writeFileSafe } from "../fsutil.js";
import { listTemplateDir, readTemplate, render, type TemplateVars } from "../templates.js";
import { log } from "../log.js";

export interface InitOptions {
  cwd: string;
  mode?: "existing" | "scratch";
  level?: "intelligence" | "maintenance";
  workspace?: string;
  ci?: "gitlab" | "jenkins";
  apiFramework?: Config["tests"]["api"]["framework"];
  name?: string;
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
  if (mode === "scratch") mergePackageJson(cwd);

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
  for (const f of listTemplateDir("skills")) put(`.claude/skills/${f}`, render(readTemplate(`skills/${f}`), vars));

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
  const wanted = [".qa-sentinel/runs/", "qa-sentinel-summary.md", "qa-gap-report.md", "test-results/", "playwright-report/", "node_modules/", ".env"];
  const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const have = new Set(current.split(/\r?\n/).map((l) => l.trim()));
  const missing = wanted.filter((l) => !have.has(l));
  if (missing.length) fs.writeFileSync(file, current + (current && !current.endsWith("\n") ? "\n" : "") + missing.join("\n") + "\n");
}

function mergePackageJson(cwd: string) {
  const file = path.join(cwd, "package.json");
  const fragment = JSON.parse(readTemplate("scaffold/playwright-api/package.fragment.json"));
  const pkg = readJson<any>(file) ?? { name: path.basename(cwd), version: "0.1.0", private: true };
  pkg.scripts = { ...fragment.scripts, ...(pkg.scripts ?? {}) };
  pkg.devDependencies = { ...fragment.devDependencies, ...(pkg.devDependencies ?? {}) };
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
