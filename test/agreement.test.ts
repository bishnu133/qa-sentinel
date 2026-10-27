import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { agreementMarkdown, summariseAgreement, type RunSample } from "../bench/agreement.js";
import { score, uniqueDataChecks } from "../bench/run.js";
import { SCENARIOS } from "../bench/scenarios.js";

const saved = JSON.parse(fs.readFileSync("test/fixtures/bench-consistency.json", "utf8")) as { results: RunSample[] };

describe("consistency across runs (B3)", () => {
  const rows = summariseAgreement(saved.results);
  const by = (id: string) => rows.find((r) => r.id === id)!;

  it("a scenario that gave the same answer three times is identical; a scenario run once is left out", () => {
    expect(rows.map((r) => r.id)).toEqual(["new-validation", "ac-conflict"]);
    expect(by("new-validation")).toMatchObject({ runs: 3, validRuns: 3, planValidityChanged: false, identical: true, scenarioCount: { min: 3, max: 3 }, unstableChecks: [] });
    expect(by("new-validation").decisions[0].agreement).toMatchObject({ agreement: 1, values: [{ value: "update", runs: 3 }] });
    expect(by("new-validation").risk).toMatchObject({ agreement: 1 });
  });

  it("shows where runs differ: a decision that flipped, a plan that became invalid, the scenario count range, a check that passed only sometimes", () => {
    const a = by("ac-conflict");
    expect(a.identical).toBe(false);
    expect(a.planValidityChanged).toBe(true);
    expect(a.validRuns).toBe(2);
    expect(a.scenarioCount).toEqual({ min: 4, max: 5 });
    // The invalid run counts as "no plan" for every expected change, so a flip to invalid is visible as lost agreement.
    expect(a.decisions.find((d) => d.label.startsWith("WELCOME"))!.agreement).toMatchObject({ values: [{ value: "review", runs: 2 }, { value: "no plan", runs: 1 }] });
    expect(a.decisions.find((d) => d.label === "no code")!.agreement.agreement).toBeCloseTo(1 / 3);
    expect(a.risk).toMatchObject({ agreement: 1, values: [{ value: "critical", runs: 2 }] });
    expect(a.unstableChecks).toEqual(["risk ≥ medium"]);
  });

  it("writes a table with the lowest decision agreement and lists the decisions that differed", () => {
    const md = agreementMarkdown(rows).join("\n");
    expect(md).toContain("## Consistency across runs");
    expect(md).toMatch(/\| new-validation \| 3 \(3\) \| 100% \| 100% \(high×3\) \| 3–3 \| same \| none \|/);
    expect(md).toMatch(/\| ac-conflict \| 3 \(2\) \| 33% .* \| 4–5 \| changed between runs \| risk ≥ medium \|/);
    expect(md).toContain("- **ac-conflict** · no code: create×1, no plan×1, update×1");
    expect(md).toContain("1 of 2 scenario(s) gave identical results in every run.");
    expect(agreementMarkdown(summariseAgreement(saved.results.slice(-1)))).toEqual([]);
  });
});

describe("benchmark scenarios added for the review's list", () => {
  it("test-data-collision is a scenario with the unique-data check, and its change differs from the base", () => {
    const s = SCENARIOS.find((x) => x.id === "test-data-collision")!;
    expect(s.checks?.uniqueData).toBe(true);
    expect(s.change["src/server.js"]).toContain("reference already used");
  });

  const plan = (setup: string[], reason: string) => ({ verdict: "tests for reference", recommendedAction: "write", changes: [], decisions: [{ decision: "create", reason, proposedScenarios: [{ title: "dup", setup, assertions: ["409"] }] }] });
  it("unique-data checks read the wording of the setup and of the plan: fixed ids and silence fail, unique values and a named clash pass", () => {
    const good = uniqueDataChecks(plan(["create an order with a unique reference (uuid) per test"], "two tests would collide on a fixed reference when run in parallel"));
    expect(good.every((c) => c.pass)).toBe(true);
    const bad = uniqueDataChecks(plan(["create an order with reference REF-1"], "covers the 409"));
    expect(bad.map((c) => c.pass)).toEqual([false, false]);
  });

  it("the wording check accepts more ways to name the clash, but the story's own word 'unique' is not enough", () => {
    expect(uniqueDataChecks(plan(["create a unique reference"], "tests must not share data between runs: re-runs would leave leftovers"))[1].pass).toBe(true);
    expect(uniqueDataChecks(plan(["create a unique reference"], "covers the rule that a reference is unique"))[1].pass).toBe(false);
  });

  it("score() adds the checks, records the decision per expected change and counts proposed scenarios", () => {
    const s = SCENARIOS.find((x) => x.id === "test-data-collision")!;
    const p = {
      verdict: "v",
      recommendedAction: "r",
      risk: { overall: "medium" },
      corrections: [],
      acMismatches: [],
      suspicious: [],
      impactedTests: [],
      changes: [{ id: "c1", type: "business-rule", summary: "duplicate reference rejected with 409", endpoint: "POST /orders", oracleStatus: "approved" }],
      decisions: [{ changeId: "c1", decision: "create", reason: "parallel runs would collide on a shared reference", proposedScenarios: [{ title: "a", setup: ["unique reference per test"], assertions: ["x"] }, { title: "b", setup: [], assertions: ["y"] }] }],
    };
    const r = score(s, p, { id: s.id, run: 1, planValid: true, status: "valid", expectedGaps: 0, foundGaps: 0, reportedGaps: 0, truePositiveGaps: 0, decisionsCorrect: 0, decisionsExpected: 1, checks: [], corrections: 0, repairRounds: 0 });
    expect(r.perExpected).toEqual([{ label: "unique reference", decision: "create" }]);
    expect(r.scenarioCount).toBe(2);
    expect(r.checks.filter((c) => c.name.includes("unique") || c.name.includes("collision")).every((c) => c.pass)).toBe(true);
  });
});
