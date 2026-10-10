import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { describe, expect, it } from "vitest";
import { validatePlan, actionable } from "../src/plan/validate.js";
import { applyRisk, normaliseEndpoint, riskOf, riskOfChange } from "../src/plan/risk.js";
import { renderGapReport } from "../src/plan/render.js";
import { breakingEndpoints, contractDiffMarkdown, diffSpecs } from "../src/analysis/contractDiff.js";
import { toText, wikiToMarkdown } from "../src/scm/jira.js";
import { resolveRequirements } from "../src/requirements.js";
import { ConfigSchema } from "../src/config.js";
import { initCommand } from "../src/commands/init.js";
import { generateCommand } from "../src/commands/generate.js";
import { addUsage } from "../src/engines/AgentEngine.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "qas-"));
const write = (root: string, rel: string, content: string) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), content);
};

const testRepo = tmp();
write(testRepo, "tests/api/orders/create-order.spec.ts", "test()");
const serviceRepo = tmp();
write(serviceRepo, "src/server.js", "x");
const ctx = { acIds: ["AC-1", "AC-2", "AC-3"], requirementsMissing: false, testRepo, serviceRepo };

const ev = (reference = "x") => [{ source: "source-code", file: "src/server.js", line: 1, reference }];
const basePlan = () => ({
  schemaVersion: 1,
  verdict: "v",
  recommendedAction: "a",
  changes: [
    { id: "c1", type: "validation-change", endpoint: "POST /orders", summary: "slot required", observable: true, requirementIds: ["AC-1"], oracleStatus: "approved", riskFactors: ["validation"], evidence: ev() },
    { id: "c2", type: "business-rule", endpoint: "POST /orders", summary: "cap 5", observable: true, requirementIds: ["AC-3"], oracleStatus: "conflicting", riskFactors: ["business-rule"], evidence: ev("MAX=5") },
    { id: "c3", type: "internal", summary: "log tweak", observable: false, requirementIds: [], oracleStatus: "missing", riskFactors: ["internal"], evidence: ev() },
  ],
  decisions: [
    { changeId: "c1", coverage: "outdated", decision: "update", existingTests: ["tests/api/orders/create-order.spec.ts"], proposedScenarios: [{ title: "400 without slot", requirementIds: ["AC-1"], setup: [], assertions: ["status 400"] }], evidence: [], reason: "r" },
    { changeId: "c2", coverage: "missing", decision: "create", existingTests: [], proposedScenarios: [{ title: "4th order 409", requirementIds: ["AC-3"], setup: [], assertions: ["status 409"] }], evidence: [], reason: "r" },
    { changeId: "c3", coverage: "unknown", decision: "skip", existingTests: [], proposedScenarios: [], evidence: ev("only logging"), reason: "no behaviour" },
  ],
  impactedTests: [{ file: "tests/api/orders/create-order.spec.ts", reason: "no slot", stillValid: false }],
  acMismatches: [{ requirementId: "AC-3", requirement: "max 3", observed: "5", evidence: ev("MAX=5") }],
  specDrift: [],
  suspicious: [],
  openQuestions: [],
  skipReason: null,
});

describe("TestPlan validation", () => {
  it("accepts a good plan and forces conflicting oracles to review", () => {
    const v = validatePlan(basePlan(), ctx);
    expect(v.errors).toEqual([]);
    expect(v.ok).toBe(true);
    expect(v.plan!.decisions[1].decision).toBe("review");
    expect(v.corrections[0]).toContain('changed to "review"');
    expect(actionable(v.plan!).map((d) => d.changeId)).toEqual(["c1", "c2"]);
  });

  it("rejects schema violations and unknown keys", () => {
    const p: any = basePlan();
    p.changes[0].type = "made-up";
    p.extra = 1;
    const v = validatePlan(p, ctx);
    expect(v.ok).toBe(false);
    expect(v.errors.join("\n")).toMatch(/changes\.0\.type/);
    expect(v.errors.join("\n")).toMatch(/Unrecognized key/);
  });

  it("enforces cross-field rules", () => {
    const p: any = basePlan();
    p.decisions[0] = { ...p.decisions[0], decision: "reuse", coverage: "partial" }; // reuse needs covered
    p.decisions[2] = { ...p.decisions[2], evidence: [] }; // skip needs evidence
    p.decisions.push({ changeId: "c9", coverage: "missing", decision: "create", existingTests: [], proposedScenarios: [], evidence: [], reason: "r" });
    p.changes[0].requirementIds = ["AC-7"];
    p.impactedTests.push({ file: "tests/api/nope.spec.ts", reason: "x", stillValid: true });
    const errs = validatePlan(p, ctx).errors.join("\n");
    expect(errs).toMatch(/"reuse" requires coverage "covered"/);
    expect(errs).toMatch(/"skip" needs evidence/);
    expect(errs).toMatch(/c9: no change with that id/);
    expect(errs).toMatch(/unknown requirement id AC-7/);
    expect(errs).toMatch(/not found: tests\/api\/nope.spec.ts/);
  });

  it("requires exactly one decision per observable change and no fake approvals without requirements", () => {
    const p: any = basePlan();
    p.decisions = p.decisions.filter((d: any) => d.changeId !== "c1");
    const missing = validatePlan(p, ctx).errors.join("\n");
    expect(missing).toMatch(/c1: observable change has no decision/);
    const none = validatePlan(basePlan(), { ...ctx, acIds: [], requirementsMissing: true }).errors.join("\n");
    expect(none).toMatch(/oracle cannot be "approved"/);
    expect(none).toMatch(/no requirements were provided/);
  });

  it("treats internal changes as non-observable and refuses new tests for them", () => {
    const p: any = basePlan();
    p.changes[2] = { ...p.changes[2], observable: true, riskFactors: ["money"] };
    const v = validatePlan(p, ctx);
    expect(v.corrections.join()).toContain('typed "internal" so marked non-observable');
    expect(v.plan!.changes[2].observable).toBe(false);
    p.decisions[2] = { ...p.decisions[2], decision: "update", existingTests: ["tests/api/orders/create-order.spec.ts"], proposedScenarios: [{ title: "t", requirementIds: [], setup: [], assertions: ["a"] }] };
    expect(validatePlan(p, ctx).errors.join()).toMatch(/internal change needs no new tests/);
  });
  it("rejects skip on an observable change and covered-but-create", () => {
    const p: any = basePlan();
    p.decisions[0] = { ...p.decisions[0], decision: "skip", evidence: ev() };
    p.decisions[1] = { ...p.decisions[1], coverage: "covered" };
    const errs = validatePlan(p, { ...ctx }).errors.join("\n");
    expect(errs).toMatch(/"skip" is only for non-observable/);
  });
});

describe("risk rules (computed in code)", () => {
  it("maps factors to levels", () => {
    expect(riskOf(["money"])).toBe("critical");
    expect(riskOf(["validation", "business-rule"])).toBe("high");
    expect(riskOf(["new-endpoint"])).toBe("medium");
    expect(riskOf(["read-only"])).toBe("low");
  });
  it("adds conflicting-oracle, breaking-contract and cross-service factors itself", () => {
    const plan: any = validatePlan(basePlan(), ctx).plan;
    plan.changes[0].riskFactors = ["validation"];
    plan.changes[0].type = "contract-change";
    const r = applyRisk(plan, { breakingEndpoints: new Set(["POST /orders"]), crossService: true });
    expect(r.changes[0].factors).toEqual(expect.arrayContaining(["breaking-contract", "cross-service"]));
    expect(r.changes[0].risk).toBe("high");
    expect(r.changes[1].factors).toContain("conflicting-oracle");
    expect(r.changes[2].risk).toBe("low");
    expect(r.overall).toBe("high");
  });
  it("non-observable changes are low risk unless they touch auth, money or personal data", () => {
    expect(riskOfChange({ observable: false }, ["validation", "business-rule"])).toBe("low");
    expect(riskOfChange({ observable: false }, ["auth"])).toBe("medium");
    expect(riskOfChange({ observable: true }, ["auth"])).toBe("critical");
  });
  it("normalises endpoints", () => {
    expect(normaliseEndpoint("get /orders/{orderId}/")).toBe("GET /orders/{}");
    expect(normaliseEndpoint("GET /orders/:id")).toBe("GET /orders/{}");
  });
});

describe("contract diff (deterministic)", () => {
  const before = `
openapi: 3.0.3
info: { title: t, version: "1" }
paths:
  /orders:
    post:
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/NewOrder' }
      responses:
        "201":
          description: ok
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Order' }
    get:
      parameters:
        - { in: query, name: limit, schema: { type: integer, maximum: 100 } }
      responses: { "200": { description: ok } }
  /legacy:
    get: { responses: { "200": { description: ok } } }
components:
  schemas:
    NewOrder:
      type: object
      required: [item]
      properties:
        item: { type: string }
        qty: { type: integer, minimum: 1 }
    Order:
      type: object
      required: [id, email]
      properties:
        id: { type: string }
        email: { type: string }
        status: { type: string, enum: [new, paid] }
`;
  const after = before
    .replace("required: [item]", "required: [item, deliverySlot]")
    .replace("qty: { type: integer, minimum: 1 }", "qty: { type: integer, minimum: 1 }\n        deliverySlot: { type: string, format: date-time }")
    .replace("email: { type: string }", "email: { type: string, nullable: true }")
    .replace("enum: [new, paid]", "enum: [new, paid, refunded]")
    .replace("maximum: 100", "maximum: 50")
    .replace("  /legacy:\n    get: { responses: { \"200\": { description: ok } } }\n", "  /orders/{id}:\n    get: { responses: { \"200\": { description: ok }, \"404\": { description: nf } } }\n");

  it("classifies breaking and compatible changes", () => {
    const d = diffSpecs(before, after);
    expect(d.status).toBe("compared");
    const k = d.changes.map((c) => `${c.endpoint} ${c.kind} ${c.location} ${c.breaking ? "B" : "-"}`);
    expect(k).toEqual(
      expect.arrayContaining([
        "POST /orders field-added request.body.deliverySlot B",
        "POST /orders nullable-added response.201.body.email B",
        "POST /orders enum-values-added response.201.body.status B",
        "GET /orders constraint-tightened query:limit B",
        "GET /orders/{} operation-added  -",
        "GET /legacy operation-removed  B",
      ]),
    );
    expect([...breakingEndpoints(d)].sort()).toEqual(["GET /legacy", "GET /orders", "POST /orders"]);
    expect(contractDiffMarkdown(d, "openapi.yaml")).toContain("⚠️ breaking");
  });
  it("reports unchanged, added and missing specs", () => {
    expect(diffSpecs(before, before).status).toBe("unchanged");
    expect(diffSpecs(undefined, after).status).toBe("spec-added");
    expect(diffSpecs(undefined, undefined).status).toBe("no-spec");
    expect(diffSpecs("a: [", "b").status).toBe("unparseable");
  });
});

describe("report rendering", () => {
  it("renders the gap report from the plan with computed risk and contract facts", () => {
    const v = validatePlan(basePlan(), ctx);
    const risked = applyRisk(v.plan!, { breakingEndpoints: new Set(), crossService: false });
    const md = renderGapReport({
      service: "orders",
      plan: v.plan!,
      risked,
      contract: { status: "unchanged", changes: [] },
      specPath: "openapi.yaml",
      requirementsLine: "**Requirements:** SHOP-42",
      corrections: v.corrections,
      warnings: [],
      oracle: "provided",
    });
    expect(md).toMatch(/^### QA impact – orders · 🟠 High risk/);
    expect(md).toContain("| POST /orders – cap 5 (AC-3) | 🟠 High | conflicting | missing | **review** |");
    expect(md).toContain("Requirement conflicts");
    expect(md).toContain("Corrections applied by qa-sentinel");
    expect(md).toContain("the spec is unchanged");
    expect(md).toContain("| log tweak | 🟢 Low | missing | unknown | **skip** |"); // skips are shown with their reason
  });
});

describe("Jira", () => {
  it("converts wiki markup and ADF to parseable text", () => {
    expect(wikiToMarkdown("h3. Acceptance Criteria\n# first\n# second\n* note")).toBe("### Acceptance Criteria\n1. first\n1. second\n- note");
    const adf = { type: "doc", content: [{ type: "orderedList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "slot required" }] }] }] }] };
    expect(toText(adf)).toBe("1. slot required");
  });

  it("resolves a story from Jira by key found in commits, with approval from status", async () => {
    const server = http
      .createServer((req, res) => {
        expect(req.headers.authorization).toBe(`Basic ${Buffer.from("qa@x.com:tok").toString("base64")}`);
        res.setHeader("content-type", "application/json");
        if (!req.url!.startsWith("/rest/api/2/issue/SHOP-42")) return res.writeHead(404).end("{}");
        res.end(
          JSON.stringify({
            key: "SHOP-42",
            fields: { summary: "Delivery slots", description: "As a customer…", status: { name: "Ready for Dev" }, updated: "2026-10-01T10:00:00.000+0000", customfield_1: "# slot required\n# past slot 400\n# max 3 per slot" },
          }),
        );
      })
      .listen(0);
    const port = (server.address() as any).port;
    try {
      const c = ConfigSchema.parse({
        version: 1,
        mode: "scratch",
        project: { name: "p" },
        tests: { api: { framework: "playwright", runCommand: "x" } },
        ci: { platform: "gitlab" },
        requirements: { source: "jira", jira: { baseUrl: `http://127.0.0.1:${port}`, projectKeys: ["SHOP"], acceptanceCriteriaField: "customfield_1" } },
      });
      const s = await resolveRequirements(c, { keyHints: ["fix(orders): delivery slot [SHOP-42]"], env: { JIRA_EMAIL: "qa@x.com", JIRA_API_TOKEN: "tok" } });
      expect(s).toMatchObject({ source: "jira", storyKey: "SHOP-42", approvalStatus: "approved", trackerStatus: "Ready for Dev" });
      expect(s.acceptanceCriteria.map((a) => a.text)).toEqual(["slot required", "past slot 400", "max 3 per slot"]);
      expect(s.sourceUrl).toBe(`http://127.0.0.1:${port}/browse/SHOP-42`);
      // A status outside approvedStatuses is only "unverified"; no key → falls back to "none".
      const c2 = ConfigSchema.parse({ ...c, requirements: { ...c.requirements, jira: { ...c.requirements.jira, approvedStatuses: ["Done"] } } });
      expect((await resolveRequirements(c2, { keyHints: ["SHOP-42"], env: { JIRA_EMAIL: "qa@x.com", JIRA_API_TOKEN: "tok" } })).approvalStatus).toBe("unverified");
      expect((await resolveRequirements(c, { keyHints: ["no key here"], env: {} })).source).toBe("none");
    } finally {
      server.close();
    }
  });
});

describe("operating levels and usage", () => {
  it("level intelligence refuses to generate", async () => {
    const root = tmp();
    await initCommand({ cwd: root, yes: true, mode: "scratch", ci: "gitlab", workspace: root });
    await expect(generateCommand({ cwd: root, service: "x" })).rejects.toThrow(/level "intelligence"/);
  });
  it("maintenance level writes the generation pipeline", async () => {
    const root = tmp();
    await initCommand({ cwd: root, yes: true, mode: "scratch", ci: "gitlab", workspace: root, level: "maintenance" });
    expect(fs.readFileSync(path.join(root, "ci/qa-sentinel/tests.gitlab-ci.yml"), "utf8")).toContain("qa-generate:");
    const intel = tmp();
    await initCommand({ cwd: intel, yes: true, mode: "scratch", ci: "gitlab", workspace: intel });
    const y = fs.readFileSync(path.join(intel, "ci/qa-sentinel/tests.gitlab-ci.yml"), "utf8");
    expect(y).not.toContain("qa-generate:");
    expect(y).toContain("qa-agent-mr-checks:");
    expect(fs.readFileSync(path.join(intel, "ci/qa-sentinel/service.gitlab-ci.yml"), "utf8")).not.toContain("qa-trigger-generation");
  });
  it("sums usage across plan, repair and author runs", () => {
    expect(addUsage({ ok: true, status: "ok", result: "", turns: 3, costUsd: 0.1, durationMs: 1000 }, { ok: true, status: "ok", result: "", turns: 2, costUsd: 0.05, durationMs: 500 })).toEqual({ turns: 5, costUsd: 0.15000000000000002, durationMs: 1500 });
  });
});

describe("decision engine", () => {
  it("records the rule behind every decision", () => {
    const v = validatePlan(basePlan(), ctx);
    expect(v.rules).toMatchObject({ c1: expect.stringContaining("update tests"), c2: expect.stringContaining("human review"), c3: expect.stringContaining("no observable") });
  });
  it("forces ambiguous oracles to review (safety rule)", () => {
    const p = basePlan();
    p.changes[0].oracleStatus = "ambiguous";
    const v = validatePlan(p, ctx);
    expect(v.ok).toBe(true);
    expect(v.plan!.decisions[0].decision).toBe("review");
    expect(v.corrections.join()).toMatch(/oracle is ambiguous/);
  });
  it("lets the API contract act as oracle when there is no story", () => {
    const p: any = basePlan();
    p.changes = [{ ...p.changes[0], requirementIds: [], oracleStatus: "missing", evidence: [{ source: "openapi", file: "openapi.yaml", reference: "required: [slot]" }] }];
    p.decisions = [{ ...p.decisions[0], decision: "create", proposedScenarios: [{ title: "t", requirementIds: [], setup: [], assertions: ["400"] }] }];
    p.acMismatches = [];
    const v = validatePlan(p, { ...ctx, acIds: [], requirementsMissing: true });
    expect(v.errors).toEqual([]);
    expect(v.plan!.decisions[0].decision).toBe("create");
    // Without contract evidence there is nothing to test against: review.
    p.changes[0].evidence = ev();
    expect(validatePlan(p, { ...ctx, acIds: [], requirementsMissing: true }).plan!.decisions[0].decision).toBe("review");
  });
  it("rejects a non-safety mismatch so the agent repairs it", () => {
    const p = basePlan();
    p.decisions[0].coverage = "covered";
    p.decisions[0].decision = "create";
    expect(validatePlan(p, ctx).errors.join()).toMatch(/does not fit the rule "approved and already covered → reuse"/);
  });
});
