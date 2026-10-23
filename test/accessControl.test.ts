import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { validatePlan } from "../src/plan/validate.js";
import { renderGapReport } from "../src/plan/render.js";
import { applyRisk } from "../src/plan/risk.js";
import { indexSource } from "../src/analysis/testIndex.js";
import { ConfigSchema } from "../src/config.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "qas-access-"));
fs.mkdirSync(path.join(root, "src"), { recursive: true });
fs.writeFileSync(path.join(root, "src/server.js"), "x");
const base = { acIds: [], requirementsMissing: true, testRepo: root, serviceRepo: root };
const ev = [{ source: "source-code", file: "src/server.js", line: 1, reference: "x" }];
const scenario = (title: string, access?: any) => ({ title, setup: [], assertions: ["status"], ...(access ? { access } : {}) });
const plan = (o: { factors?: string[]; type?: string; scenarios?: any[]; noScenario?: string; decision?: string } = {}): any => ({
  schemaVersion: 1,
  verdict: "v",
  recommendedAction: "a",
  changes: [{ id: "c1", type: o.type ?? "business-rule", endpoint: "DELETE /orders/{id}", summary: "only admins cancel", observable: true, requirementIds: [], oracleStatus: "missing", riskFactors: o.factors ?? ["auth"], evidence: ev }],
  decisions: [{ changeId: "c1", coverage: "missing", decision: o.decision ?? "review", existingTests: [], proposedScenarios: o.scenarios ?? [scenario("admin cancels", { role: "admin", expect: "allowed" })], evidence: ev, reason: "r", ...(o.noScenario ? { noScenario: o.noScenario } : {}) }],
  impactedTests: [],
  acMismatches: [],
  specDrift: [],
  requirementStatus: [],
  suspicious: [],
  openQuestions: [],
  skipReason: null,
});
const two = ["admin", "clerk"];

describe("A6 access-control scenarios", () => {
  it("warns by default when an auth change has no no-token and no forbidden scenario", () => {
    const v = validatePlan(plan(), { ...base, roles: two });
    expect(v.ok).toBe(true);
    const w = v.warnings.join("\n");
    expect(w).toContain("DELETE /orders/{id}");
    expect(w).toContain('"no-token"');
    expect(w).toContain('"forbidden"');
  });

  it("is satisfied by a no-token and a forbidden scenario", () => {
    const s = [scenario("no token", { role: "none", expect: "no-token" }), scenario("clerk refused", { role: "clerk", expect: "forbidden" }), scenario("admin ok", { role: "admin", expect: "allowed" })];
    const v = validatePlan(plan({ scenarios: s }), { ...base, roles: two, accessControl: "require" });
    expect(v.errors).toEqual([]);
    expect(v.warnings.join("\n")).not.toContain("access control");
  });

  it("asks for forbidden only when two or more roles are configured", () => {
    const s = [scenario("no token", { role: "none", expect: "no-token" })];
    expect(validatePlan(plan({ scenarios: s }), { ...base, roles: ["admin"], accessControl: "require" }).errors).toEqual([]);
    const two1 = validatePlan(plan({ scenarios: s }), { ...base, roles: two, accessControl: "require" });
    expect(two1.errors.join("\n")).toContain('"forbidden"');
    expect(two1.errors.join("\n")).not.toContain('"no-token"');
  });

  it("require turns the gap into an error; a decision noScenario reason satisfies it", () => {
    const req = validatePlan(plan(), { ...base, roles: two, accessControl: "require" });
    expect(req.ok).toBe(false);
    expect(req.errors.join("\n")).toContain("access control needs scenario(s)");
    const reason = validatePlan(plan({ noScenario: "the gateway refuses anonymous calls; proved by tests/api/gateway.spec.ts" }), { ...base, roles: two, accessControl: "require" });
    expect(reason.errors).toEqual([]);
  });

  it("holds a new endpoint to it only when roles are configured", () => {
    const p = () => plan({ type: "new-endpoint", factors: ["new-endpoint"] });
    expect(validatePlan(p(), { ...base, roles: [], accessControl: "require" }).errors).toEqual([]);
    expect(validatePlan(p(), { ...base, roles: ["admin"], accessControl: "require" }).errors.join("\n")).toContain('"no-token"');
  });

  it("does not hold other changes, reuse decisions or plans without an endpoint", () => {
    expect(validatePlan(plan({ factors: ["validation"] }), { ...base, roles: two, accessControl: "require" }).errors).toEqual([]);
    const p = plan();
    p.changes[0].endpoint = undefined;
    expect(validatePlan(p, { ...base, roles: two, accessControl: "require" }).errors).toEqual([]);
  });

  it("rejects an unknown shape and warns about a role that is not configured", () => {
    const bad = plan({ scenarios: [scenario("x", { role: "admin", expect: "maybe" })] });
    expect(validatePlan(bad, { ...base, roles: two }).ok).toBe(false);
    const v = validatePlan(plan({ scenarios: [scenario("x", { role: "root", expect: "forbidden" })] }), { ...base, roles: two });
    expect(v.warnings.join("\n")).toContain('access role "root" is not in tests.auth.roles');
  });

  it("is a warning in the default config and the level is configurable", () => {
    const c = ConfigSchema.parse({ version: 1, mode: "scratch", project: { name: "p" }, tests: { api: { framework: "playwright", runCommand: "x" } }, ci: { platform: "gitlab" } });
    expect(c.risk.accessControl).toBe("warn");
    expect(() => ConfigSchema.parse({ ...c, risk: { accessControl: "block" } })).toThrow();
  });

  it("shows the access in the report", () => {
    const v = validatePlan(plan({ scenarios: [scenario("no token", { role: "none", expect: "no-token" }), scenario("clerk refused", { role: "clerk", expect: "forbidden" })] }), { ...base, roles: two });
    const md = renderGapReport({ service: "o", plan: v.plan!, risked: applyRisk(v.plan!, { breakingEndpoints: new Set(), crossService: false }), contract: { status: "no-spec", changes: [] }, requirementsLine: "", corrections: [], warnings: [], oracle: "missing" });
    expect(md).toContain("🔒 no token: no-token");
    expect(md).toContain("🔒 role clerk: forbidden");
  });

  it("indexes @role tags", () => {
    const [t] = indexSource("t.spec.ts", `test("clerk is refused @service:o @endpoint:DELETE_/orders/{id} @role:clerk", async () => {});`);
    expect(t.roles).toEqual(["clerk"]);
    expect(t.tags).toEqual([]);
    expect(t.title).toBe("clerk is refused");
  });
});
