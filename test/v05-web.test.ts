import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { indexSource, normPage, checkNewTests, checkTestMap } from "../src/analysis/testIndex.js";
import { selectRegression } from "../src/analysis/regression.js";
import { SNAPSHOT_SCRIPT, pagesToExplore, slug } from "../src/web/explore.js";
import { spawnSync } from "node:child_process";
import { groupBySite, healedFromResults, healedMarkdown, readHealed } from "../src/web/healed.js";
import { healedCommand } from "../src/commands/healed.js";
import { addWebCommand, initCommand } from "../src/commands/init.js";
import { render } from "../src/templates.js";
import { agentEnv } from "../src/run.js";
import { generatePolicy, checkPaths } from "../src/guardrails.js";
import { verifyChanges } from "../src/verification.js";
import { loadConfig } from "../src/config.js";
import { renderGapReport } from "../src/plan/render.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "qas-web-"));
/** A test repo inside its own workspace folder, so init's service discovery never scans the shared temp dir. */
const repoDir = () => {
  const r = path.join(tmp(), "qa-tests");
  fs.mkdirSync(r);
  return r;
};

describe("web tests in the index", () => {
  const web = indexSource(
    "tests/web/orders/order-page.spec.ts",
    `test("shows the payment @service:storefront @page:/orders/{orderId} @story:SHOP-107 @ac:AC-2", async () => { await expect(x).toHaveText("a"); });
test("not found @service:storefront @page:/orders/:id", async () => {});`,
  );
  it("reads @page tags in one spelling", () => {
    expect(normPage("orders/{orderId}/")).toBe("/orders/:id");
    expect(normPage("/")).toBe("/");
    expect(web[0].pages).toEqual(["/orders/:id"]);
    expect(web[0].acs).toEqual(["AC-2"]);
  });
  it("accepts @page instead of @endpoint for new tests, and checks screens in test-map.yaml", () => {
    expect(checkNewTests(web, ["tests/web/orders/order-page.spec.ts"], "SHOP-107", ["AC-2"])).toEqual([]);
    const map = { services: { storefront: { screens: { "/orders/new": ["tests/web/orders/new-order.spec.ts"] } } } };
    expect(checkTestMap(web, map).map((f) => f.message).join()).toContain("does not list tests/web/orders/order-page.spec.ts under screens for /orders/:id");
  });
  it("selects web tests on a changed page", () => {
    const c: any = { workspace: { services: [{ name: "storefront", dependsOn: [] }] } };
    const change = { id: "c1", type: "ui-change", page: "/orders/:orderId", summary: "s", observable: true, requirementIds: [], oracleStatus: "approved", riskFactors: ["ui-visible"], evidence: [] };
    const sel = selectRegression({ c, service: "storefront", plan: { changes: [change], decisions: [], impactedTests: [] } as any, index: web, map: undefined });
    expect(sel.args).toEqual(["tests/web/orders/order-page.spec.ts:1", "tests/web/orders/order-page.spec.ts:2"]);
    expect(sel.tests[0].reasons).toEqual(["changed-page"]);
    expect(sel.serviceWide).toBe(false);
  });
});

describe("page exploration", () => {
  it("explores the pages of web scenarios, else the service's routes", () => {
    const plan: any = {
      changes: [{ id: "c1", page: "/orders/:id" }, { id: "c2", page: "/orders/new" }],
      decisions: [
        { changeId: "c1", decision: "create", proposedScenarios: [{ layer: "web", page: "/orders/:id" }] },
        { changeId: "c2", decision: "reuse", proposedScenarios: [] },
      ],
    };
    expect(pagesToExplore(plan, ["/"])).toEqual(["/orders/:id"]);
    expect(pagesToExplore({ changes: [], decisions: [] } as any, ["/", "/orders/new"])).toEqual(["/", "/orders/new"]);
    expect(slug("/orders/:id")).toBe("orders_id");
    expect(slug("/")).toBe("home");
  });
  it("writes a snapshot script that parses (it is generated from a template literal)", () => {
    const f = path.join(tmp(), "s.mjs");
    fs.writeFileSync(f, SNAPSHOT_SCRIPT);
    const r = spawnSync(process.execPath, ["--check", f], { encoding: "utf8" });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  });
});

describe("healed steps", () => {
  const step = (o: object) => ({ test: "places an order @page:/orders/new", file: "tests/web/a.spec.ts", at: "src/pages/new-order-page.ts:20", intent: "Click Place order button", failedLocator: "getByRole('button', { name: 'Place order' })", status: "recovered", healedTo: "button#checkout", confidence: 0.92, ...o });
  const results = (steps: object[]) => ({
    suites: [{ specs: [{ tests: [{ results: [{ attachments: steps.map((s) => ({ name: "healed-step", contentType: "application/json", body: Buffer.from(JSON.stringify(s)).toString("base64") })) }] }] }] }],
  });

  it("reads healed steps from the Playwright report and groups them by page-object call site", () => {
    const dir = tmp();
    const f = path.join(dir, "results.json");
    fs.writeFileSync(f, JSON.stringify(results([step({}), step({ test: "second test" }), step({ at: "src/pages/order-page.ts:9", status: "failed", healedTo: undefined })])));
    const steps = healedFromResults(f);
    expect(steps).toHaveLength(3);
    const groups = groupBySite(steps);
    expect(groups.map((g) => [g.site, g.tests.length, g.healed])).toEqual([["src/pages/new-order-page.ts:20", 2, true], ["src/pages/order-page.ts:9", 1, false]]);
    const md = healedMarkdown(steps);
    expect(md).toContain("1 page-object locator(s) to fix, 1 Bubblegum could not heal");
    expect(md).toContain("`button#checkout` (92%)");
  });

  it("writes qa-healed.json for the next generation and fails only when asked", async () => {
    const repo = repoDir();
    await initCommand({ cwd: repo, yes: true, mode: "scratch", web: true, ci: "gitlab", level: "maintenance", name: "w" });
    fs.mkdirSync(path.join(repo, "test-results"));
    fs.writeFileSync(path.join(repo, "test-results/results.json"), JSON.stringify(results([step({})])));
    expect(healedCommand({ cwd: repo })).toBe(0);
    expect(readHealed(repo)).toHaveLength(1);
    expect(fs.readFileSync(path.join(repo, "qa-healed.md"), "utf8")).toContain("src/pages/new-order-page.ts:20");
    expect(healedCommand({ cwd: repo, failOnHeal: true })).toBe(1);
  });
});

describe("init --web", () => {
  it("writes the web layer: config, page objects, ui helper with the healing hook, fixtures, skill, Playwright project, CI", async () => {
    const repo = repoDir();
    const c = await initCommand({ cwd: repo, yes: true, mode: "scratch", web: true, ci: "gitlab", level: "maintenance", name: "w" });
    expect(c.tests.web.enabled).toBe(true);
    for (const f of ["src/web/ui.ts", "src/web/healing.ts", "src/pages/base-page.ts", "src/fixtures/web.ts", "tests/web/example/home.spec.ts", ".claude/skills/write-web-test/SKILL.md"]) expect(fs.existsSync(path.join(repo, f)), f).toBe(true);
    expect(fs.readFileSync(path.join(repo, "src/web/healing.ts"), "utf8")).toContain("[\\\\/]src[\\\\/]pages[\\\\/]");
    expect(fs.readFileSync(path.join(repo, "src/web/healing.ts"), "utf8")).toContain('"@bubblegum-ai/node"');
    const pw = fs.readFileSync(path.join(repo, "playwright.config.ts"), "utf8");
    expect(pw).toContain('name: "web"');
    expect(pw).toContain("process.env.QA_WEB_URL");
    const ci = fs.readFileSync(path.join(repo, "ci/qa-sentinel/tests.gitlab-ci.yml"), "utf8");
    expect(ci).toContain("npx playwright test --project=api --project=web");
    expect(ci).toContain('QA_HEALING: "off"');
    expect(ci).not.toContain("qa-healed:");
    expect(ci).not.toMatch(/\{\{/);
  });
  it("without --web nothing web is written", async () => {
    const repo = repoDir();
    await initCommand({ cwd: repo, yes: true, mode: "scratch", ci: "gitlab", level: "maintenance", name: "a" });
    expect(fs.existsSync(path.join(repo, "src/web/ui.ts"))).toBe(false);
    expect(fs.existsSync(path.join(repo, ".claude/skills/write-web-test"))).toBe(false);
    expect(fs.readFileSync(path.join(repo, "playwright.config.ts"), "utf8")).not.toContain('name: "web"');
    expect(fs.readFileSync(path.join(repo, "ci/qa-sentinel/tests.gitlab-ci.yml"), "utf8")).not.toMatch(/\{\{|QA_HEALING/);
  });
});

describe("verification per layer", () => {
  it("runs each layer's changed specs with its own command and base URL, healing off", async () => {
    const repo = repoDir();
    await initCommand({ cwd: repo, yes: true, mode: "scratch", web: true, ci: "gitlab", level: "maintenance", name: "w" });
    // Fake runners: write a JUnit file to $PLAYWRIGHT_JUNIT_OUTPUT_NAME and record what they saw.
    const runner = (layer: string) =>
      `node -e "const fs=require('fs');fs.appendFileSync('${repo}/seen.log','${layer} '+process.env.QA_HEALING+' '+process.argv.slice(1).filter(a=>a.endsWith('.ts')).join(',')+'\\\\n');fs.writeFileSync(process.env.PLAYWRIGHT_JUNIT_OUTPUT_NAME,'<testsuite><testcase name=\\"t\\" file=\\"f\\"/></testsuite>')"`;
    const cfg = path.join(repo, "qa-sentinel.config.yaml");
    let text = fs.readFileSync(cfg, "utf8");
    text = text.replace(/runCommand: npx playwright test --project=api/, `runCommand: ${JSON.stringify(runner("api"))}`).replace(/runCommand: npx playwright test --project=web/, `runCommand: ${JSON.stringify(runner("web"))}`);
    fs.writeFileSync(cfg, text);
    const c = loadConfig(repo);
    expect(c.tests.web.runCommand).toContain("web");
    fs.writeFileSync(path.join(repo, "tests/web/a.spec.ts"), "x");
    fs.writeFileSync(path.join(repo, "tests/api/b.spec.ts"), "x");
    const runDir = tmp();
    const r = await verifyChanges({
      cwd: repo,
      c: { ...c, verification: { ...c.verification, preflight: false, typecheck: "never" } },
      changes: [{ status: "A", path: "tests/web/a.spec.ts" }, { status: "A", path: "tests/api/b.spec.ts" }],
      runDir,
      env: { PATH: process.env.PATH, QA_HEALING: "off" },
    });
    expect(r.status).toBe("VERIFIED");
    expect(r.checks.filter((x) => x.name === "tests").map((x) => [x.layer, x.status])).toEqual([["api", "passed"], ["web", "passed"]]);
    const seen = fs.readFileSync(path.join(repo, "seen.log"), "utf8").trim().split("\n").sort();
    expect(seen).toEqual(["api off tests/api/b.spec.ts", "web off tests/web/a.spec.ts"]);
  });
});

describe("gap report", () => {
  it("shows pages and the setup workflow of web scenarios", () => {
    const plan: any = {
      verdict: "v",
      recommendedAction: "a",
      changes: [{ id: "c1", type: "ui-change", page: "/orders/:id", summary: "payment status", observable: true, requirementIds: ["AC-2"], oracleStatus: "approved", riskFactors: ["ui-visible"], evidence: [{ source: "source-code", reference: "x" }] }],
      decisions: [{ changeId: "c1", coverage: "missing", decision: "create", existingTests: [], proposedScenarios: [{ title: "shows payment", requirementIds: ["AC-2"], layer: "web", page: "/orders/:id", setup: [{ id: "s1", via: "api", action: "create an order", helper: "api.post('/orders')", dependsOn: [] }], assertions: ["a"] }], evidence: [], reason: "r" }],
      impactedTests: [],
      acMismatches: [],
      specDrift: [],
      suspicious: [],
      openQuestions: [],
      skipReason: null,
    };
    const md = renderGapReport({ service: "storefront", plan, risked: { changes: [{ ...plan.changes[0], factors: ["ui-visible"], risk: "medium" }], overall: "medium" }, contract: { changes: [], hasSpec: false } as any, requirementsLine: "", corrections: [], warnings: [], oracle: "provided" });
    expect(md).toContain("page /orders/:id – payment status");
    expect(md).toContain("🖥️ shows payment (AC-2) – create");
    expect(md).toContain("flow: create an order _(api: api.post('/orders'))_ → **web** `/orders/:id`");
  });
});

describe("add-web and healing safety", () => {
  it("renders nested blocks", () => {
    expect(render("{{#if a}}A{{#if b}}B{{/if}}C{{/if}}", { a: true, b: false })).toBe("AC");
    expect(render("{{#if a}}A{{#unless b}}B{{/unless}}C{{/if}}", { a: true, b: false })).toBe("ABC");
  });

  it("adds the web layer to an API-only project, with healing wired into CI", async () => {
    const repo = repoDir();
    await initCommand({ cwd: repo, yes: true, mode: "scratch", ci: "gitlab", level: "maintenance", name: "a" });
    const c = addWebCommand({ cwd: repo, healing: "bubblegum" });
    expect(c.tests.web.enabled).toBe(true);
    expect(c.tests.web.healing).toBe("bubblegum");
    expect(fs.existsSync(path.join(repo, "src/web/ui.ts"))).toBe(true);
    const ci = fs.readFileSync(path.join(repo, "ci/qa-sentinel/tests.gitlab-ci.yml"), "utf8");
    expect(ci).toContain("qa-healed:");
    expect(ci).toContain("jobs/artifacts/main/raw/qa-healed.json?job=qa-healed");
    expect(ci).toContain('QA_HEALING: "bubblegum"');
    expect(ci).toContain("qa-generate:");
    expect(ci).not.toMatch(/\{\{/);
    expect(fs.readFileSync(path.join(repo, ".claude/qa-sentinel.md"), "utf8")).toContain("page objects in `src/pages`");
  });

  it("never lets the agent heal or change the healing switch", async () => {
    const repo = repoDir();
    const c = await initCommand({ cwd: repo, yes: true, mode: "scratch", web: true, ci: "gitlab", level: "maintenance", name: "w" });
    const h = { ...c, tests: { ...c.tests, web: { ...c.tests.web, healing: "bubblegum" as const } } };
    expect(agentEnv(h, { PATH: "/bin", QA_HEALING: "bubblegum" }).QA_HEALING).toBe("off");
    const findings = checkPaths([{ status: "M", path: "src/web/healing.ts" }, { status: "M", path: "src/fixtures/web.ts" }, { status: "M", path: "src/pages/order-page.ts" }], generatePolicy(h));
    expect(findings.map((f) => [f.file, f.rule])).toEqual([["src/web/healing.ts", "blocked-path"], ["src/fixtures/web.ts", "blocked-path"]]);
  });
});

describe("flaky retry", () => {
  it("re-runs failed specs once and reports a pass on retry as flaky, not failed", async () => {
    const repo = repoDir();
    await initCommand({ cwd: repo, yes: true, mode: "scratch", ci: "gitlab", level: "maintenance", name: "f" });
    // Fails on the first run, passes on the second (a counter file), like a timing-dependent test.
    const runner = `node -e "const fs=require('fs');const n='${repo}/count';const k=fs.existsSync(n)?+fs.readFileSync(n,'utf8'):0;fs.writeFileSync(n,String(k+1));const ok=k>0;fs.writeFileSync(process.env.PLAYWRIGHT_JUNIT_OUTPUT_NAME,'<testsuite><testcase name=\\"t\\" file=\\"tests/api/a.spec.ts\\">'+(ok?'':'<failure message=\\"boom\\"/>')+'</testcase></testsuite>');process.exit(ok?0:1)"`;
    const cfg = path.join(repo, "qa-sentinel.config.yaml");
    fs.writeFileSync(cfg, fs.readFileSync(cfg, "utf8").replace(/runCommand: npx playwright test --project=api/, `runCommand: ${JSON.stringify(runner)}`));
    const c = loadConfig(repo);
    fs.writeFileSync(path.join(repo, "tests/api/a.spec.ts"), "x");
    const r = await verifyChanges({ cwd: repo, c: { ...c, verification: { ...c.verification, preflight: false, typecheck: "never" } }, changes: [{ status: "A", path: "tests/api/a.spec.ts" }], runDir: tmp(), env: { PATH: process.env.PATH } });
    expect(r.status).toBe("VERIFIED");
    expect(r.flaky).toEqual(["t"]);
    expect(r.checks.find((x) => x.name === "tests")!.detail).toContain("1 only on retry (flaky)");
  });
});
