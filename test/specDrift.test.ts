import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { validatePlan } from "../src/plan/validate.js";
import { renderGapReport } from "../src/plan/render.js";
import { applyRisk } from "../src/plan/risk.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "qas-drift-"));
fs.mkdirSync(path.join(root, "src"), { recursive: true });
fs.writeFileSync(path.join(root, "src/server.js"), "x");
const ctx = { acIds: [], requirementsMissing: true, testRepo: root, serviceRepo: root };
const ev = [{ source: "source-code", file: "src/server.js", line: 14, reference: "deliverySlot check" }];
const drift = (o: any = {}) => ({ endpoint: "POST /orders", spec: "deliverySlot is optional", code: "deliverySlot is required", evidence: ev, ...o });
const plan = (specDrift: any[], decision = "review", scenarios: any[] = [{ title: "slot is optional per the spec", setup: [], assertions: ["201 without deliverySlot"] }]): any => ({
  schemaVersion: 1,
  verdict: "v",
  recommendedAction: "a",
  changes: [{ id: "c1", type: "validation-change", endpoint: "post /orders/", summary: "slot required", observable: true, requirementIds: [], oracleStatus: "missing", riskFactors: ["validation"], evidence: [...ev, { source: "openapi", file: "openapi.yaml", line: 3, reference: "POST /orders" }] }],
  decisions: [{ changeId: "c1", coverage: "missing", decision, existingTests: [], proposedScenarios: scenarios, evidence: ev, reason: "r" }],
  impactedTests: [],
  acMismatches: [],
  specDrift,
  requirementStatus: [],
  suspicious: [],
  openQuestions: [],
  skipReason: null,
});

describe("A8 spec drift as a gap", () => {
  it("still accepts the old string form", () => {
    const v = validatePlan(plan(["deliverySlot is required in code but absent from openapi.yaml"]), ctx);
    expect(v.errors).toEqual([]);
    expect(v.plan!.specDrift).toEqual(["deliverySlot is required in code but absent from openapi.yaml"]);
  });

  it("accepts a structured item that cites code and maps to a review decision (endpoints compare normalised)", () => {
    const v = validatePlan(plan([drift()]), ctx);
    expect(v.errors).toEqual([]);
    expect(v.warnings.join("\n")).not.toContain("specDrift");
  });

  it("needs source-code evidence with file and line", () => {
    const noLine = validatePlan(plan([drift({ evidence: [{ source: "source-code", file: "src/server.js", reference: "x" }] })]), ctx);
    expect(noLine.errors.join("\n")).toContain('needs "source-code" evidence with the file and line');
    const wrongSource = validatePlan(plan([drift({ evidence: [{ source: "openapi", file: "openapi.yaml", line: 3, reference: "x" }] })]), ctx);
    expect(wrongSource.errors.join("\n")).toContain("source-code");
    expect(validatePlan(plan([drift({ evidence: [] })]), ctx).ok).toBe(false);
  });

  it("needs a change for the endpoint and a review decision", () => {
    expect(validatePlan(plan([drift({ endpoint: "GET /health" })]), ctx).errors.join("\n")).toContain("no observable change in this plan has endpoint GET /health");
    const update = validatePlan(plan([drift()], "create"), ctx);
    expect(update.errors.join("\n")).toContain('the decision for c1 must be "review"');
  });

  it("warns when the review decision proposes no scenario", () => {
    const v = validatePlan(plan([drift()], "review", []), ctx);
    expect(v.ok).toBe(true);
    expect(v.warnings.join("\n")).toContain("no test is written to the spec");
  });

  it("rejects unknown keys", () => {
    expect(validatePlan(plan([drift({ extra: 1 })]), ctx).ok).toBe(false);
  });

  it("renders the gap with the developer's job and says it is not a bug", () => {
    const v = validatePlan(plan([drift(), "old style note"]), ctx);
    const md = renderGapReport({ service: "o", plan: v.plan!, risked: applyRisk(v.plan!, { breakingEndpoints: new Set(), crossService: false }), contract: { status: "no-spec", changes: [] }, requirementsLine: "", corrections: [], warnings: [], oracle: "missing" });
    expect(md).toContain("**Spec drift: the spec and the code disagree. The developer fixes one of them.**");
    expect(md).toContain("`POST /orders`: spec says deliverySlot is optional; code does deliverySlot is required (`src/server.js:14` – deliverySlot check)");
    expect(md).toContain("- old style note");
    expect(md).toContain("not raised as a product bug");
  });

  it("the label is added to the merge request by generate", () => {
    expect(fs.readFileSync(path.resolve(__dirname, "../src/commands/generate.ts"), "utf8")).toContain('"qa-sentinel::spec-drift"');
  });
});
