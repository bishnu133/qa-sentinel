import fs from "node:fs";
import os from "node:os";
import { describe, expect, it } from "vitest";
import { acHash, type ExpectedFile } from "../src/expected/format.js";
import { validatePlan } from "../src/plan/validate.js";

const repo = fs.mkdtempSync(`${os.tmpdir()}/qas-acfirst-`);
const expected: ExpectedFile = {
  version: 1,
  story: "SHOP-101",
  acs: [
    {
      id: "AC-1",
      hash: acHash("A slot takes at most 3 orders."),
      text: "A slot takes at most 3 orders.",
      services: [],
      behaviours: [
        { id: "B1", kind: "main", statement: "third accepted", expect: { max: 3 }, state: "ready", source: "ac" },
        { id: "B2", kind: "boundary", statement: "fourth rejected", expect: { max: 3 }, state: "ready", source: "ac" },
      ],
    },
    { id: "AC-2", hash: acHash("Orders are capped per customer."), text: "Orders are capped per customer.", services: [], behaviours: [{ id: "B3", kind: "main", statement: "cap", expect: {}, state: "unspecified", question: "What cap?", source: "ac" }] },
    { id: "AC-3", hash: acHash("The email names the slot."), text: "The email names the slot.", services: [], behaviours: [{ id: "B4", kind: "main", statement: "slot in email", expect: {}, state: "ready", source: "ac" }] },
  ],
};

const ev = [{ source: "source-code", file: "src/server.js", line: 1, reference: "x" }];
const plan = (scenarios: Record<string, unknown>[], status: Record<string, unknown>[] = []) => ({
  schemaVersion: 1,
  verdict: "v",
  recommendedAction: "a",
  changes: [{ id: "c1", type: "business-rule", summary: "slot cap", observable: true, requirementIds: ["AC-1"], oracleStatus: "approved", riskFactors: ["business-rule"], evidence: ev }],
  decisions: [{ changeId: "c1", coverage: "missing", decision: "create", reason: "r", existingTests: [], proposedScenarios: scenarios, evidence: ev }],
  requirementStatus: [
    { id: "AC-1", status: "implemented", evidence: ev },
    { id: "AC-2", status: "not-found" },
    { id: "AC-3", status: "not-found" },
  ].map((r) => ({ ...r, ...(status.find((x) => x.id === r.id) ?? {}) })),
});
const ctx = { acIds: ["AC-1", "AC-2", "AC-3"], requirementsMissing: false, testRepo: repo, serviceRepo: repo, expected, requireAcCoverage: true };
const sc = (requirementIds: string[], behaviourIds: string[]) => ({ title: "t", requirementIds, behaviourIds, assertions: ["a"] });

describe("AC-first planning", () => {
  it("needs a scenario or a reason for every AC with ready behaviour (unspecified ones are skipped)", () => {
    const v = validatePlan(plan([sc(["AC-1"], ["B1", "B2"])]), ctx);
    expect(v.errors).toEqual([expect.stringMatching(/^AC-3 has no scenario for its expected behaviour \(B4\)/)]);
    const ok = validatePlan(plan([sc(["AC-1"], ["B1", "B2"])], [{ id: "AC-3", noScenario: "proved by tests/api/email.spec.ts" }]), ctx);
    expect(ok.errors).toEqual([]);
    const elsewhere = validatePlan(plan([sc(["AC-1"], ["B1", "B2"])], [{ id: "AC-3", status: "elsewhere", where: "notifications-service" }]), ctx);
    expect(elsewhere.errors).toEqual([]);
  });

  it("checks cited behaviour ids: known, of a cited AC, and ready", () => {
    const v = validatePlan(plan([sc(["AC-1"], ["B9", "B3", "B4"]), sc(["AC-3"], ["B4"])]), ctx);
    const all = v.errors.join("\n");
    expect(all).toMatch(/behaviour B9 isn't in expected\/SHOP-101.md/);
    expect(all).toMatch(/behaviour B3 belongs to AC-2/);
    expect(all).toMatch(/behaviour B4 belongs to AC-3/);
  });

  it("rejects an unspecified behaviour and warns about ready ones nobody cites", () => {
    const v = validatePlan(plan([sc(["AC-1"], ["B1"]), sc(["AC-2", "AC-3"], ["B3", "B4"])]), ctx);
    expect(v.errors.join()).toMatch(/B3 is unspecified/);
    expect(v.warnings.join()).toMatch(/AC-1: expected behaviour B2 has no scenario/);
  });

  it("still requires coverage without an expected file, and leaves old callers alone", () => {
    const noExp = { ...ctx, expected: undefined };
    expect(validatePlan(plan([sc(["AC-1"], [])]), noExp).errors.join()).toMatch(/AC-2 has no scenario: plan one/);
    expect(validatePlan(plan([sc(["AC-1"], ["B1"])]), noExp).errors.join()).toMatch(/no expected-behaviour file/);
    expect(validatePlan(plan([sc(["AC-1"], [])]), { ...noExp, requireAcCoverage: false }).errors).toEqual([]);
  });
});
