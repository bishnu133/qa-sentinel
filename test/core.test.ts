import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it, beforeEach } from "vitest";
import YAML from "yaml";
import { globToRegExp, matchesAny } from "../src/fsutil.js";
import { render, listTemplateDir, readTemplate } from "../src/templates.js";
import { commonDir, detectProject, discoverServices } from "../src/detect.js";
import { initCommand } from "../src/commands/init.js";
import { loadConfig } from "../src/config.js";
import { runChecks } from "../src/commands/doctor.js";
import { buildClaudeArgs } from "../src/claude.js";
import { gapReportCommand } from "../src/commands/gapReport.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "qas-"));
const write = (root: string, rel: string, content: string) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), content);
};
const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
const gitInit = (dir: string) => {
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "user.email", "t@t");
  sh(dir, "config", "user.name", "t");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-qm", "init", "--allow-empty");
};

describe("globs", () => {
  it("matches ** and *", () => {
    expect(globToRegExp("**/*.md").test("README.md")).toBe(true);
    expect(globToRegExp("**/*.md").test("a/b/c.md")).toBe(true);
    expect(globToRegExp("docs/**").test("docs/x/y.ts")).toBe(true);
    expect(globToRegExp("src/*.ts").test("src/a/b.ts")).toBe(false);
    expect(matchesAny("src/orders/dto.ts", ["**/*.md", "docs/**"])).toBe(false);
  });
});

describe("render", () => {
  it("substitutes, keeps unknown vars visible, handles if/unless", () => {
    const t = "A {{x}} {{missing}}\n{{#if on}}yes\n{{/if}}{{#unless on}}no\n{{/unless}}";
    expect(render(t, { x: 1, on: true })).toBe("A 1 {{missing}}\nyes\n");
    expect(render(t, { x: 1, on: false })).toBe("A 1 {{missing}}\nno\n");
  });

  it("every template renders with init vars and leaves no unknown placeholders", async () => {
    const root = tmp();
    const cfg = await initCommand({ cwd: root, yes: true, mode: "scratch", ci: "gitlab", workspace: root, name: "demo" });
    const { templateVars } = await import("../src/commands/init.js");
    const vars = templateVars(cfg);
    for (const dir of ["agents", "skills", "claude", "ci/gitlab", "ci/jenkins", "scaffold/playwright-api"]) {
      for (const f of listTemplateDir(dir)) {
        const out = render(readTemplate(`${dir}/${f}`), vars);
        expect(out.match(/\{\{[#/]?\w+/g), `${dir}/${f}`).toBeNull();
      }
    }
  });
});

describe("detection", () => {
  let root: string;
  beforeEach(() => {
    root = tmp();
    write(root, "package.json", JSON.stringify({ devDependencies: { "@playwright/test": "1", typescript: "5" } }));
    write(root, "tests/api/orders/create.spec.ts", "test('x', async ({ request }) => { await request.post('/orders') })");
    write(root, "tests/api/users/get.spec.ts", "const r = await request.get('/users')");
    write(root, "tests/web/login.spec.ts", "await page.goto('/'); await page.click('x')");
  });

  it("finds framework, API tests and their folder", () => {
    const d = detectProject(root);
    expect(d.frameworks.playwright).toBe(true);
    expect(d.apiFramework).toBe("playwright");
    expect(d.apiTestFiles.sort()).toEqual(["tests/api/orders/create.spec.ts", "tests/api/users/get.spec.ts"]);
    expect(d.apiDir).toBe("tests/api");
    expect(d.language).toBe("typescript");
  });

  it("commonDir", () => {
    expect(commonDir(["a/b/c.ts", "a/b/d/e.ts"])).toBe("a/b");
    expect(commonDir(["x.ts"])).toBeUndefined();
  });

  it("discovers service repos with OpenAPI specs", () => {
    const ws = tmp();
    const tests = path.join(ws, "qa-tests");
    fs.mkdirSync(tests);
    write(ws, "orders-service/package.json", "{}");
    write(ws, "orders-service/api/openapi.yaml", "openapi: 3.0.0");
    write(ws, "billing-service/pom.xml", "<project/>");
    write(ws, "notes/readme.txt", "not a service");
    const s = discoverServices(ws, tests);
    expect(s.map((x) => x.name)).toEqual(["billing-service", "orders-service"]);
    expect(s[1]).toMatchObject({ path: "../orders-service", openapi: "api/openapi.yaml" });
  });
});

describe("init", () => {
  it("existing mode writes config, agents, skills, CI and keeps CLAUDE.md", async () => {
    const ws = tmp();
    const root = path.join(ws, "qa-tests");
    write(root, "package.json", JSON.stringify({ name: "shop-tests", devDependencies: { supertest: "6", jest: "29" } }));
    write(root, "specs/api/orders.test.ts", "import request from 'supertest'");
    write(root, "CLAUDE.md", "# Our rules\n");
    write(ws, "orders-service/package.json", "{}");

    const cfg = await initCommand({ cwd: root, yes: true, ci: "jenkins", workspace: ws });
    expect(cfg.mode).toBe("existing");
    expect(cfg.tests.api.framework).toBe("supertest");
    expect(cfg.tests.api.dir).toBe("specs/api");
    expect(cfg.workspace.services.map((s) => s.name)).toEqual(["orders-service"]);
    expect(loadConfig(root).ci.platform).toBe("jenkins");

    for (const f of [
      ".claude/agents/change-analyzer.md",
      ".claude/agents/api-test-author.md",
      ".claude/skills/qa-gap-report/SKILL.md",
      ".claude/skills/write-api-test/SKILL.md",
      ".claude/qa-sentinel.md",
      "ci/qa-sentinel/Jenkinsfile.gap-report",
      "test-map.yaml",
    ]) {
      expect(fs.existsSync(path.join(root, f)), f).toBe(true);
    }
    const claudeMd = fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8");
    expect(claudeMd.startsWith("# Our rules")).toBe(true);
    expect(claudeMd).toContain("@.claude/qa-sentinel.md");
    expect(fs.readFileSync(path.join(root, ".claude/skills/write-api-test/SKILL.md"), "utf8")).toContain("conventions:pending");
    const map = YAML.parse(fs.readFileSync(path.join(root, "test-map.yaml"), "utf8"));
    expect(map.unmapped).toEqual(["specs/api/orders.test.ts"]);
    expect(fs.existsSync(path.join(root, "playwright.config.ts"))).toBe(false);
  });

  it("scratch mode scaffolds a Playwright API framework", async () => {
    const root = tmp();
    await initCommand({ cwd: root, yes: true, mode: "scratch", ci: "gitlab", workspace: root });
    for (const f of ["playwright.config.ts", "src/api/client.ts", "src/fixtures/index.ts", "tests/api/example/health.spec.ts", ".env.example", "ci/qa-sentinel/tests.gitlab-ci.yml"]) {
      expect(fs.existsSync(path.join(root, f)), f).toBe(true);
    }
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    expect(pkg.devDependencies["@playwright/test"]).toBeDefined();
    expect(pkg.scripts["test:api"]).toBeDefined();
    expect(fs.readFileSync(path.join(root, ".gitignore"), "utf8")).toContain(".qa-sentinel/runs/");
  });

  it("refuses to overwrite an existing config without --force", async () => {
    const root = tmp();
    await initCommand({ cwd: root, yes: true, mode: "scratch", ci: "gitlab", workspace: root });
    await expect(initCommand({ cwd: root, yes: true, mode: "scratch", ci: "gitlab", workspace: root })).rejects.toThrow(/already exists/);
  });
});

describe("doctor", () => {
  it("fails without config, warns on missing env", async () => {
    const root = tmp();
    expect(runChecks(root)[0].level).toBe("fail");
    await initCommand({ cwd: root, yes: true, mode: "scratch", ci: "gitlab", workspace: root });
    gitInit(root);
    const checks = runChecks(root, {});
    expect(checks.find((c) => c.label.includes("config.yaml valid"))?.level).toBe("ok");
    expect(checks.find((c) => c.label.includes("QA_BASE_URL"))?.level).toBe("warn");
    expect(checks.find((c) => c.label.includes("test repo is a git"))?.level).toBe("ok");
  });
});

describe("claude args", () => {
  it("builds headless args", () => {
    const args = buildClaudeArgs({ cwd: ".", prompt: "hi", maxTurns: 5, allowedTools: ["Read", "Bash(npx playwright test:*)"], addDirs: ["/svc"], model: "m" });
    expect(args).toEqual(["-p", "hi", "--output-format", "json", "--max-turns", "5", "--allowedTools", "Read,Bash(npx playwright test:*)", "--add-dir", "/svc", "--model", "m"]);
  });
});

describe("gap-report", () => {
  it("skips the agent for docs-only changes and dry-runs real ones", async () => {
    const ws = tmp();
    const tests = path.join(ws, "qa-tests");
    const svc = path.join(ws, "orders-service");
    write(svc, "package.json", "{}");
    write(svc, "src/orders.ts", "export const max = 3;\n");
    gitInit(svc);
    fs.mkdirSync(tests);
    await initCommand({ cwd: tests, yes: true, mode: "scratch", ci: "gitlab", workspace: ws });

    write(svc, "README.md", "docs");
    sh(svc, "add", "-A");
    sh(svc, "commit", "-qm", "docs");
    const docs = await gapReportCommand({ cwd: tests, service: "orders-service", base: "HEAD~1", head: "HEAD", out: "r.md" });
    expect(docs.skipped).toBe(true);

    write(svc, "src/orders.ts", "export const max = 5;\n");
    sh(svc, "add", "-A");
    sh(svc, "commit", "-qm", "rule");
    const real = await gapReportCommand({ cwd: tests, service: "orders-service", base: "HEAD~1", head: "HEAD", out: "r.md", dryRun: true });
    expect(real.skipped).toBe(false);
    const runs = fs.readdirSync(path.join(tests, ".qa-sentinel/runs"));
    const diff = fs.readFileSync(path.join(tests, ".qa-sentinel/runs", runs[0], "change.diff"), "utf8");
    expect(diff).toContain("+export const max = 5;");
  });
});

describe("generate helpers", () => {
  it("changedFiles keeps the first character of every path and skips artifacts", async () => {
    const { changedFiles } = await import("../src/git.js");
    const { ARTIFACT_GLOBS } = await import("../src/run.js");
    const r = tmp();
    write(r, "src/a.ts", "1");
    gitInit(r);
    write(r, "src/a.ts", "2");
    write(r, "tests/api/new.spec.ts", "x");
    write(r, "test-results/out.json", "{}");
    write(r, ".qa-sentinel/runs/x/report.md", "r");
    const files = changedFiles(r).filter((f) => !matchesAny(f, ARTIFACT_GLOBS)).sort();
    expect(files).toEqual(["src/a.ts", "tests/api/new.spec.ts"]);
  });

  it("cleanAgentAnswer drops preamble before the first heading", async () => {
    const { cleanAgentAnswer } = await import("../src/run.js");
    expect(cleanAgentAnswer("Done, writing it now.\n\n## QA agent: x\nbody")).toBe("## QA agent: x\nbody");
    expect(cleanAgentAnswer("### QA impact\nok")).toBe("### QA impact\nok");
  });
});
