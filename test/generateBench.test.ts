import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// A fake agent runtime for the generation benchmark: it writes the plan and the test the prompt asks for, never calls a model.
const fake = vi.hoisted(() => ({ author: `import { test, expect } from "@playwright/test";\ntest("duplicate reference is rejected @story:SHOP-67 @ac:AC-2", async () => { expect(409).toBe(409); });\n` }));
vi.mock("../src/engines/ClaudeCodeEngine.js", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  return {
    engineFor: () => ({
      name: "fake",
      available: () => ({ ok: true }),
      run: async (t: { kind: string; prompt: string; cwd: string }) => {
        const ctxRel = /Run context: (\S+?\/context\.json)/.exec(t.prompt)?.[1];
        const ctx = ctxRel ? JSON.parse(fs.readFileSync(path.join(t.cwd, ctxRel), "utf8")) : undefined;
        if (t.kind === "plan" && ctx) {
          const scope: string[] = ctx.acScope ?? ctx.acceptanceCriteriaIds;
          const ev = [{ source: "source-code", file: "src/server.js", line: 1, reference: "x" }];
          const plan = {
            schemaVersion: 1,
            verdict: "tests for the reference rule",
            recommendedAction: "write them",
            changes: [{ id: "c1", type: "business-rule", summary: "duplicate reference rejected", endpoint: "POST /orders", observable: true, requirementIds: scope, oracleStatus: "approved", riskFactors: ["business-rule"], evidence: ev }],
            decisions: [{ changeId: "c1", coverage: "missing", decision: "create", reason: "r", existingTests: [], targetFile: "tests/api/orders/reference.spec.ts", proposedScenarios: scope.map((ac) => ({ title: `${ac} reference rule`, requirementIds: [ac], setup: ["create an order with a unique reference"], assertions: ["409"] })), evidence: ev }],
            requirementStatus: scope.map((id) => ({ id, status: "implemented", evidence: ev })),
          };
          fs.writeFileSync(path.join(t.cwd, ctx.planPath), JSON.stringify(plan));
          return { ok: true, status: "ok", result: "done", costUsd: 0.4 };
        }
        if (t.kind === "author") {
          fs.mkdirSync(path.join(t.cwd, "tests/api/orders"), { recursive: true });
          fs.writeFileSync(path.join(t.cwd, "tests/api/orders/reference.spec.ts"), fake.author);
          return { ok: true, status: "ok", result: "Added tests.", costUsd: 0.6 };
        }
        return { ok: false, status: "error", result: "fake engine: nothing for " + t.kind };
      },
    }),
  };
});

import { loadConfig, writeConfig } from "../src/config.js";
import { GENERATION_DEFAULT, generationMarkdown, referenceChecks, runGenerationScenario, scoreGeneration } from "../bench/generateBench.js";
import { SCENARIOS } from "../bench/scenarios.js";
import { git, commitAll } from "../bench/workspace.js";
import { cleanTmp, tmp } from "./helpers/mocks.js";

afterEach(cleanTmp);
const scenario = (id: string) => SCENARIOS.find((s) => s.id === id)!;

describe("scoring a generation run (B2)", () => {
  const runDir = (files: Record<string, unknown>) => {
    const d = tmp("qas-genrun-");
    for (const [f, v] of Object.entries(files)) fs.writeFileSync(path.join(d, f), JSON.stringify(v));
    return d;
  };
  const clean = { "manifest.json": { outcome: "committed-verified", verification: { status: "VERIFIED" }, agent: { costUsd: 1.2, durationMs: 5000 } }, "guardrails.json": [], "test-review.result.json": { status: "reviewed", review: { tests: [{ verdict: "strong" }, { verdict: "adequate" }] } } };

  it("verified, expected values present, no weak test: every check passes", () => {
    const r = scoreGeneration(scenario("new-validation"), 1, runDir(clean), { "tests/a.spec.ts": "x" });
    expect(r).toMatchObject({ outcome: "committed-verified", verification: "VERIFIED", costUsd: 1.2, expectedValues: { violations: 0 }, review: { strong: 1, adequate: 1, weak: 0, wrongOracle: 0 } });
    expect(r.checks.every((c) => c.pass)).toBe(true);
  });

  it("failed verification, missing expected values and weak or wrong-oracle tests each fail their own check", () => {
    const r = scoreGeneration(
      scenario("new-validation"),
      1,
      runDir({
        "manifest.json": { outcome: "committed-failed", verification: { status: "FAILED" } },
        "guardrails.json": [{ level: "violation", rule: "expected-value-missing", message: '"cap" proves S/B1 but 10 does not appear' }, { level: "warning", rule: "traceability", message: "x" }],
        "test-review.result.json": { status: "reviewed", review: { tests: [{ verdict: "weak" }, { verdict: "wrong-oracle" }, { verdict: "strong" }] } },
      }),
      { "tests/a.spec.ts": "x" },
    );
    expect(r.expectedValues.violations).toBe(1);
    expect(Object.fromEntries(r.checks.map((c) => [c.name, c.pass]))).toEqual({ "tests were written and committed": true, "verification VERIFIED": false, "expected values present in the tests": false, "review: no weak or wrong-oracle test": false });
  });

  it("a run that wrote no test, or skipped the review, fails those checks instead of passing by default", () => {
    const r = scoreGeneration(scenario("new-validation"), 1, runDir({ "manifest.json": { outcome: "no-changes-made" } }), {});
    expect(r.verification).toBe("none");
    expect(r.checks.filter((c) => !c.pass).map((c) => c.name)).toEqual(["tests were written and committed", "verification VERIFIED", "review: no weak or wrong-oracle test"]);
  });

  it("the collision case: a fixed reference value in the tests fails; unique values pass; no reference at all fails", () => {
    const names = (files: Record<string, string>) => Object.fromEntries(referenceChecks(files).map((c) => [c.name, c.pass]));
    expect(names({ a: `await api.post("/orders", { item: "x", reference: "REF-1" });` })).toEqual({ "tests use a reference value": true, "tests do not use a fixed reference value": false });
    expect(names({ a: "await api.post('/orders', { item: 'x', reference: `ref-${Date.now()}` });" })).toEqual({ "tests use a reference value": true, "tests do not use a fixed reference value": true });
    expect(names({ a: `const ref = uniqueRef(); await api.post("/orders", { reference: ref });` })).toEqual({ "tests use a reference value": true, "tests do not use a fixed reference value": true });
    expect(names({ a: `await api.post("/orders", { item: "x" });` })["tests use a reference value"]).toBe(false);
  });

  it("the default generation scenarios exist, and the markdown sums the runs", () => {
    expect(GENERATION_DEFAULT.every((id) => SCENARIOS.some((s) => s.id === id))).toBe(true);
    const r = scoreGeneration(scenario("new-validation"), 1, runDir(clean), { "tests/a.spec.ts": "x" });
    const md = generationMarkdown([r, { ...r, run: 2, verification: "FAILED", checks: [{ name: "verification VERIFIED", pass: false, detail: "FAILED" }] }]);
    expect(md).toContain("**2 run(s)** · verified 1/2");
    expect(md).toContain("- **new-validation**: verification VERIFIED (FAILED)");
  });
});

describe("running generate on a bench scenario with a fake engine (no model, no network)", () => {
  // The test command is a stub that passes, so verification is VERIFIED without a service or a browser.
  const stubTests = async (w: { tests: string }) => {
    const c = loadConfig(w.tests);
    c.tests.api.runCommand = "node runner.js";
    c.verification.preflight = false;
    c.verification.requireVerifiedToPush = false;
    c.review.enabled = false;
    c.tests.expectations = "off";
    c.verification.typecheck = "never";
    c.guardrails.allowedHosts = [];
    writeConfig(w.tests, c);
    fs.writeFileSync(path.join(w.tests, "runner.js"), `require("fs").writeFileSync(process.env.PLAYWRIGHT_JUNIT_OUTPUT_NAME || "junit.xml", '<testsuites><testsuite name="s" tests="1"><testcase classname="tests/api/orders/reference.spec.ts" name="duplicate reference is rejected" file="tests/api/orders/reference.spec.ts"/></testsuite></testsuites>');\n`);
    git(w.tests, "config", "user.email", "bench@x");
    git(w.tests, "config", "user.name", "bench");
    commitAll(w.tests, "stub runner");
  };
  const options = { afterBuild: stubTests, prepare: async () => ({ env: {}, stop: () => {} }) };

  it("scores the written tests: a fixed reference value is caught, unique values pass", async () => {
    vi.stubEnv("CI", "");
    fake.author = `import { test, expect } from "@playwright/test";\ntest("duplicate reference is rejected @story:SHOP-67 @ac:AC-2", async ({ request }) => { await request.post("/orders", { data: { item: "a", qty: 1, reference: "REF-1" } }); expect(1).toBe(1); });\n`;
    const bad = await runGenerationScenario(scenario("test-data-collision"), 1, options);
    expect(bad.testFiles).toEqual(["tests/api/orders/reference.spec.ts"]);
    expect(bad.outcome).toMatch(/^committed-/);
    expect(bad.verification).toBe("VERIFIED");
    expect(bad.costUsd).toBeCloseTo(1.0);
    const fixed = bad.checks.find((c) => c.name === "tests do not use a fixed reference value")!;
    expect(fixed).toMatchObject({ pass: false, detail: "fixed: REF-1" });

    fake.author = `import { test, expect } from "@playwright/test";\ntest("duplicate reference is rejected @story:SHOP-67 @ac:AC-2", async ({ request }) => { const reference = \`ref-\${Date.now()}\`; await request.post("/orders", { data: { item: "a", qty: 1, reference } }); expect(1).toBe(1); });\n`;
    const good = await runGenerationScenario(scenario("test-data-collision"), 2, options);
    expect(good.checks.find((c) => c.name === "tests do not use a fixed reference value")!.pass).toBe(true);
    expect(good.checks.find((c) => c.name === "verification VERIFIED")!.pass).toBe(true);
    vi.unstubAllEnvs();
  }, 120_000);
});
