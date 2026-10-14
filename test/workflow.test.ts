import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkWorkflow, normaliseSetup, topoOrder, workflowLine } from "../src/plan/workflow.js";
import { validatePlan } from "../src/plan/validate.js";
import { riskOf } from "../src/plan/risk.js";
import { layerOfFile, layers, primaryLayer } from "../src/layers.js";
import { ConfigSchema } from "../src/config.js";
import { generatePolicy } from "../src/guardrails.js";
import { testEnv } from "../src/run.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "qas-wf-"));
const testRepo = tmp();
const serviceRepo = tmp();
fs.mkdirSync(path.join(serviceRepo, "src"), { recursive: true });
fs.writeFileSync(path.join(serviceRepo, "src/app.js"), "x");
const ev = [{ source: "source-code", file: "src/app.js", reference: "button text" }];

const webPlan = (scenario: Record<string, unknown>, change: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  verdict: "v",
  recommendedAction: "a",
  changes: [{ id: "c1", type: "ui-change", page: "/orders/:id", summary: "order page shows payment", observable: true, requirementIds: ["AC-1"], oracleStatus: "approved", riskFactors: ["ui-visible"], evidence: ev, ...change }],
  decisions: [{ changeId: "c1", coverage: "missing", decision: "create", existingTests: [], proposedScenarios: [{ title: "shows payment status", requirementIds: ["AC-1"], assertions: ["payment shows authorised"], ...scenario }], evidence: [], reason: "new" }],
});
const ctx = { acIds: ["AC-1"], requirementsMissing: false, testRepo, serviceRepo, layers: ["api", "web"] as ("api" | "web")[], defaultLayer: "web" as const };

describe("workflow planner", () => {
  it("reads plain strings as ordered API steps", () => {
    const steps = normaliseSetup(["create an order", "authorise its payment"]);
    expect(steps.map((s) => [s.id, s.via, s.dependsOn])).toEqual([["s1", "api", []], ["s2", "api", ["s1"]]]);
  });

  it("orders steps by dependency and finds cycles", () => {
    const steps = normaliseSetup([
      { id: "s2", via: "api", action: "pay", dependsOn: ["s1"] },
      { id: "s1", via: "api", action: "order", dependsOn: [] },
    ]);
    expect(topoOrder(steps).map((s) => s.id)).toEqual(["s1", "s2"]);
    const cyc = checkWorkflow([{ id: "s1", via: "api", action: "a", dependsOn: ["s2"] }, { id: "s2", via: "api", action: "b", dependsOn: ["s1"] }], "web", "x");
    expect(cyc.errors.join()).toContain("cycle");
  });

  it("applies the test-data policy: API first, UI only for web tests with a reason", () => {
    expect(checkWorkflow([{ id: "s1", via: "ui", action: "sign up", dependsOn: [] }], "api", "x").errors.join()).toContain("this is an api test");
    expect(checkWorkflow([{ id: "s1", via: "ui", action: "sign up", dependsOn: [] }], "web", "x").errors.join()).toContain('say why in "why"');
    const ok = checkWorkflow([{ id: "s1", via: "ui", action: "accept cookies", why: "no API for consent", dependsOn: [] }], "web", "x");
    expect(ok.errors).toEqual([]);
    expect(ok.warnings[0]).toContain("uses the UI");
    expect(checkWorkflow([{ id: "s1", via: "db-helper", action: "seed", dependsOn: [] }], "api", "x").errors.join()).toContain("database");
    expect(checkWorkflow([{ id: "s1", via: "api", action: "a", dependsOn: ["s9"] }], "api", "x").errors.join()).toContain("unknown step s9");
  });

  it("validates web scenarios: layer default, page from the change, normalised setup", () => {
    const v = validatePlan(webPlan({ setup: ["create an order through the API"] }), ctx);
    expect(v.errors).toEqual([]);
    const sc = v.plan!.decisions[0].proposedScenarios[0];
    expect(sc.layer).toBe("web");
    expect(sc.page).toBe("/orders/:id");
    expect(sc.setup[0]).toMatchObject({ id: "s1", via: "api" });
    expect(workflowLine(sc)).toBe("create an order through the API _(api)_ → **web** `/orders/:id`");
  });

  it("rejects web scenarios when web is off, and web scenarios without a page", () => {
    expect(validatePlan(webPlan({ layer: "web" }), { ...ctx, layers: ["api"], defaultLayer: "api" }).errors.join()).toContain('layer "web" is not enabled');
    expect(validatePlan(webPlan({}, { page: undefined }), ctx).errors.join()).toContain("needs the page");
  });

  it("rates UI journeys high and visible UI changes medium", () => {
    expect(riskOf(["user-journey"])).toBe("high");
    expect(riskOf(["ui-visible"])).toBe("medium");
  });
});

describe("layers", () => {
  const c = ConfigSchema.parse({
    version: 1,
    mode: "scratch",
    project: { name: "p" },
    workspace: { services: [{ name: "storefront", path: "../storefront", kind: "web" }, { name: "orders", path: "../orders" }] },
    tests: { api: { framework: "playwright", runCommand: "npx playwright test --project=api" }, web: { enabled: true } },
    ci: { platform: "gitlab" },
  });

  it("knows each layer's files, the service's layer and what the agent may write", () => {
    expect(layers(c).map((l) => l.layer)).toEqual(["api", "web"]);
    expect(layerOfFile(c, "tests/web/orders/order-page.spec.ts")).toBe("web");
    expect(layerOfFile(c, "tests/api/orders/orders.spec.ts")).toBe("api");
    expect(layerOfFile(c, "src/pages/order-page.ts")).toBeUndefined();
    expect(primaryLayer(c, c.workspace.services[0])).toBe("web");
    expect(primaryLayer(c, c.workspace.services[1])).toBe("api");
    expect(generatePolicy(c).allowed).toEqual(expect.arrayContaining(["tests/web/**", "src/pages/**", "tests/api/**", "src/api/**"]));
  });

  it("turns healing off for runs qa-sentinel verifies unless allowed", () => {
    const h = { ...c, tests: { ...c.tests, web: { ...c.tests.web, healing: "bubblegum" as const } } };
    const env = { PATH: "/bin", QA_WEB_URL: "http://web", QA_HEALING: "bubblegum", GITLAB_TOKEN: "x" };
    expect(testEnv(h, env).QA_HEALING).toBe("off");
    expect(testEnv(h, env).QA_WEB_URL).toBe("http://web");
    expect(testEnv(h, env).GITLAB_TOKEN).toBeUndefined();
    expect(testEnv(h, env, { healing: true }).QA_HEALING).toBe("bubblegum");
  });
});

describe("run commands per layer", () => {
  const c = ConfigSchema.parse({
    version: 1,
    mode: "scratch",
    project: { name: "p" },
    tests: { api: { framework: "playwright", runCommand: "npx playwright test --project=api" }, web: { enabled: true } },
    ci: { platform: "gitlab" },
  });
  it("merges Playwright projects into one run", async () => {
    const { runCommandsFor } = await import("../src/layers.js");
    expect(runCommandsFor(c, ["tests/api/a.spec.ts:3", "tests/web/b.spec.ts:9"])).toEqual(["npx playwright test --project=api --project=web tests/api/a.spec.ts:3 tests/web/b.spec.ts:9"]);
    expect(runCommandsFor(c, ["tests/web/b.spec.ts:9"])).toEqual(["npx playwright test --project=web tests/web/b.spec.ts:9"]);
    const other = { ...c, tests: { ...c.tests, api: { ...c.tests.api, runCommand: "npx jest" } } };
    expect(runCommandsFor(other, ["tests/api/a.spec.ts", "tests/web/b.spec.ts"])).toEqual(["npx jest tests/api/a.spec.ts", "npx playwright test --project=web tests/web/b.spec.ts"]);
  });
});
