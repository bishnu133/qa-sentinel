import { describe, expect, it } from "vitest";
import { acStandings, gapSummary, generationSummary } from "../src/reporting/jiraSummary.js";
import { markdownToJiraWiki } from "../src/scm/jira.js";
import { useEnvironment } from "../src/run.js";
import { ConfigSchema } from "../src/config.js";

const plan: any = {
  verdict: "Delivery slot added; cap is 5 in code, 3 in the story",
  recommendedAction: "Update order tests and ask the PO about the cap",
  changes: [
    { id: "c1", requirementIds: ["AC-1"], oracleStatus: "approved" },
    { id: "c2", requirementIds: ["AC-3"], oracleStatus: "conflicting" },
    { id: "c3", requirementIds: ["AC-4"], oracleStatus: "approved" },
  ],
  decisions: [
    { changeId: "c1", decision: "update", proposedScenarios: [{ requirementIds: ["AC-1"] }] },
    { changeId: "c2", decision: "review", proposedScenarios: [] },
    { changeId: "c3", decision: "reuse", proposedScenarios: [] },
  ],
  acMismatches: [{ requirementId: "AC-3", requirement: "max 3 per slot", observed: "MAX_ORDERS_PER_SLOT = 5" }],
  openQuestions: ["Is the cap 3 or 5?"],
};
const req: any = { acceptanceCriteria: ["AC-1", "AC-2", "AC-3", "AC-4"].map((id) => ({ id, text: `text of ${id}` })) };

describe("Jira summaries", () => {
  it("places every AC", () => {
    expect([...acStandings(plan, ["AC-1", "AC-2", "AC-3", "AC-4"]).values()]).toEqual(["needs-tests", "not-affected", "conflict", "covered"]);
  });
  it("writes a plain gap summary that converts to Jira markup", () => {
    const md = gapSummary({ service: "orders-service", plan, risk: "high", req, mrUrl: "https://gl/mr/1", regressionTests: 6 });
    expect(md).toContain("| AC-3: text of AC-3 | ⚠️ Code and story disagree, needs a decision |");
    expect(md).toContain('AC-3: story says "max 3 per slot", the code does: MAX_ORDERS_PER_SLOT = 5');
    expect(md).toContain("Existing tests to re-run for this change: 6.");
    const wiki = markdownToJiraWiki(md);
    expect(wiki).toContain("h3. QA check · orders-service · 🟠 High risk");
    expect(wiki).toContain("[merge request|https://gl/mr/1]");
    expect(wiki).toContain("|| Acceptance criterion || Status ||");
  });
  it("writes a generation summary with environment and AC status", () => {
    const md = generationSummary({
      service: "payments-service",
      risk: "critical",
      verification: "VERIFIED",
      environment: "sit",
      mrUrl: "https://gl/mr/2",
      trace: [
        { ac: "AC-1", status: "covered", active: [{}] as any, pending: [] },
        { ac: "AC-2", status: "discrepancy", active: [{}] as any, pending: [{}, {}] as any },
      ],
      discrepancies: [{ test: "cumulative refunds over the amount", note: "server.js:26 checks each refund alone" }],
      weakTests: 1,
    });
    expect(md).toContain("Stage: *tests written and run on SIT* · ✅ all passed");
    expect(md).toContain("| AC-2 | ⚠️ Tested; product doesn't match the story yet | 1 passing, 2 waiting |");
    expect(md).toContain("flagged 1 test(s)");
  });
});

describe("environments", () => {
  const c = ConfigSchema.parse({
    version: 1, mode: "existing", project: { name: "t" },
    tests: { api: { framework: "playwright", dir: "tests/api", helpersDir: "src/api", runCommand: "npx playwright test", baseUrlEnv: "QA_BASE_URL" } },
    ci: { platform: "gitlab" },
    environments: { dev: { baseUrl: "https://dev.example.test" }, sit: { baseUrl: "https://sit.example.test" } },
    verification: { defaultEnvironment: "dev" },
  } as any);
  it("sets the base URL from the named or default environment", () => {
    const env: any = {};
    expect(useEnvironment(c, "sit", env)).toBe("sit");
    expect(env.QA_BASE_URL).toBe("https://sit.example.test");
    expect(useEnvironment(c, undefined, env)).toBe("dev");
    expect(env.QA_BASE_URL).toBe("https://dev.example.test");
    expect(() => useEnvironment(c, "prod", env)).toThrow(/Unknown environment "prod". Configured: dev, sit/);
  });
});
