import { describe, expect, it } from "vitest";
import { accessProblem } from "../src/claude.js";

describe("accessProblem", () => {
  it("flags a missing login", () => {
    expect(accessProblem({ is_error: true, terminal_reason: "api_error", result: "Not logged in · Please run /login" })).toMatch(/ANTHROPIC_API_KEY/);
  });
  it("flags a workspace rate limit", () => {
    const json = { is_error: true, api_error_status: 429, terminal_reason: "api_error", result: "API Error: Request rejected (429) · would exceed the rate limit" };
    expect(accessProblem(json)).toMatch(/rate limit/);
  });
  it("leaves normal agent failures alone", () => {
    expect(accessProblem({ is_error: true, subtype: "error_max_turns", num_turns: 30, total_cost_usd: 0.4, result: "" })).toBeUndefined();
    expect(accessProblem({ is_error: false, subtype: "success", result: "done" })).toBeUndefined();
  });
});
