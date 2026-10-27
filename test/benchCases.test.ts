import { describe, expect, it } from "vitest";
import { FEATURE_CASES, featureMarkdown, runFeatureCase } from "../bench/cases.js";

describe("feature-three-services (B2)", () => {
  it("qa-sentinel's rules give the expected state of every AC at each step of a feature across orders, payments and notifications", () => {
    const fc = FEATURE_CASES.find((c) => c.id === "feature-three-services")!;
    const results = runFeatureCase(fc);
    expect(results.map((r) => r.pass)).toEqual([true, true, true, true]);
    // The cross-service ACs are held until all three services have merged and the card is ready, then planned.
    expect(results[0].planned).toEqual(["AC-1"]);
    expect(results[3].planned).toEqual(["AC-1", "AC-2", "AC-3"]);
    expect(featureMarkdown(results)).toContain("AC-2 waiting-status");
  });

  it("a wrong expectation fails the case and says which AC", () => {
    const fc = structuredClone(FEATURE_CASES[0]);
    fc.steps[0].expect["AC-2"] = "ready";
    fc.steps[3].planned = ["AC-1"];
    const results = runFeatureCase(fc);
    expect(results[0]).toMatchObject({ pass: false, problems: ["AC-2: expected ready, got waiting-merge"] });
    expect(results[3].problems[0]).toMatch(/planned \[AC-1, AC-2, AC-3\], expected \[AC-1\]/);
  });
});
