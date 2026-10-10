import { describe, expect, it } from "vitest";
import { indexSource } from "../src/analysis/testIndex.js";
import { normEndpoint, regressionMarkdown, selectRegression } from "../src/analysis/regression.js";

const orders = indexSource(
  "tests/api/orders/orders.spec.ts",
  `test("creates an order @service:orders-service @endpoint:POST_/orders", async () => { expect(1).toBe(1); });
test("gets an order @service:orders-service @endpoint:GET_/orders/{id}", async () => {});
test.fixme("slot cap @service:orders-service @endpoint:POST_/orders @ac:AC-3", async () => {});`,
);
const notif = indexSource("tests/api/notifications/n.spec.ts", `test("queues @service:notifications-service @endpoint:POST_/notifications", async () => {});`);
const index = [...orders, ...notif];
const c: any = {
  workspace: {
    services: [
      { name: "orders-service", dependsOn: ["notifications-service"] },
      { name: "notifications-service", dependsOn: [] },
    ],
  },
};
const change = (o: any) => ({ id: "c1", type: "validation-change", summary: "s", observable: true, requirementIds: [], oracleStatus: "approved", riskFactors: [], evidence: [], ...o });
const plan = (changes: any[], extra: any = {}): any => ({ changes, decisions: [], impactedTests: [], ...extra });

describe("regression selection", () => {
  it("normalises endpoints", () => {
    expect(normEndpoint("post /payments/{id}/refund/")).toBe("POST /payments/{}/refund");
  });
  it("selects tests on the changed endpoint, never fixme tests", () => {
    const sel = selectRegression({ c, service: "orders-service", plan: plan([change({ endpoint: "POST /orders" })]), index, map: undefined });
    expect(sel.args).toEqual(["tests/api/orders/orders.spec.ts:1"]);
    expect(sel.tests[0].reasons).toEqual(["changed-endpoint"]);
  });
  it("adds consumer tests for breaking changes", () => {
    const risked = [{ ...change({ endpoint: "POST /notifications" }), factors: ["breaking-contract"], risk: "high" }];
    const sel = selectRegression({ c, service: "notifications-service", plan: plan([risked[0]]), risked: risked as any, index, map: undefined });
    expect(sel.args).toContain("tests/api/notifications/n.spec.ts:1");
    expect(sel.args).toContain("tests/api/orders/orders.spec.ts:1");
    expect(sel.tests.find((s) => s.test.file.includes("orders"))!.reasons).toEqual(["consumer"]);
  });
  it("falls back to the whole service for changes without an endpoint", () => {
    const sel = selectRegression({ c, service: "orders-service", plan: plan([change({ type: "internal", observable: false })]), index, map: undefined });
    expect(sel.serviceWide).toBe(true);
    expect(sel.args).toEqual(["tests/api/orders/orders.spec.ts:1", "tests/api/orders/orders.spec.ts:2"]);
  });
  it("uses tests named by the plan and the contract diff", () => {
    const sel = selectRegression({
      c,
      service: "orders-service",
      plan: plan([], { impactedTests: [{ file: "tests/api/orders/orders.spec.ts:2", reason: "schema", stillValid: false }] }),
      contract: { status: "compared", changes: [{ endpoint: "POST /orders", kind: "field-added", where: "x", breaking: false } as any] },
      index,
      map: undefined,
    });
    expect(sel.args).toEqual(["tests/api/orders/orders.spec.ts:1", "tests/api/orders/orders.spec.ts:2"]);
    expect(regressionMarkdown(sel, "npx playwright test")).toContain("npx playwright test tests/api/orders/orders.spec.ts:1 tests/api/orders/orders.spec.ts:2");
  });
  it("asks for the full suite when nothing can be selected", () => {
    expect(selectRegression({ c, service: "ghost", plan: plan([change({ endpoint: "GET /nope" })]), index, map: undefined }).runFullSuite).toBe(true);
  });
});
