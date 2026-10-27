import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { flakyRuns, historyFor, historyKey, historySignals, readHistoryFile, runTime } from "../src/analysis/history.js";
import { indexSource } from "../src/analysis/testIndex.js";
import { applyRisk, raiseOne } from "../src/plan/risk.js";
import { validatePlan } from "../src/plan/validate.js";
import { renderGapReport } from "../src/plan/render.js";
import { planChange } from "../src/plan/planner.js";
import { createRunDir } from "../src/run.js";
import { changeSet } from "../src/git.js";
import type { AgentEngine, AgentTask } from "../src/engines/AgentEngine.js";

const g = (cwd: string, ...a: string[]) =>
  execFileSync("git", a, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "qas-hist-"));
const put = (root: string, rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};
const cfg = (extra: any = {}) =>
  ConfigSchema.parse({ version: 1, mode: "scratch", project: { name: "p" }, tests: { api: { framework: "playwright", runCommand: "x" } }, ci: { platform: "gitlab" }, workspace: { services: [{ name: "orders", path: "../orders" }] }, ...extra });
const NOW = new Date("2026-10-23T12:00:00Z");
const day = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString().replace(/[:.]/g, "-");
const verification = (root: string, daysAgo: number, flaky: string[], kind = "generate-orders") => put(root, `.qa-sentinel/runs/${day(daysAgo)}-${kind}/verification.json`, JSON.stringify({ status: "VERIFIED", flaky: flaky.map((k) => k.split("::").pop()), flakyKeys: flaky }));

const specs = indexSource(
  "tests/api/orders/orders.spec.ts",
  `test("creates an order @service:orders @endpoint:POST_/orders", async () => {});
// QA-BUG: https://jira.example/SHOP-210
test.fail("rejects qty 0 @service:orders @endpoint:POST_/orders", async () => {});
test("lists orders @service:orders @endpoint:GET_/orders", async () => {});`,
);

describe("A7 history signals", () => {
  it("reads the run time from the folder name, else the file time", () => {
    expect(runTime("2026-10-22T10-11-12-345Z-gap-orders", new Date(0)).toISOString()).toBe("2026-10-22T10:11:12.345Z");
    expect(runTime("odd-name", new Date(5)).getTime()).toBe(5);
  });

  it("collects flaky runs inside the window only, and ignores broken files", () => {
    const root = tmp();
    verification(root, 3, [`${'tests/api/orders/orders.spec.ts'}::creates an order`]);
    verification(root, 200, [`${'tests/api/orders/orders.spec.ts'}::creates an order`]);
    put(root, `.qa-sentinel/runs/${day(1)}-bad/verification.json`, "{not json");
    verification(root, 2, []);
    const r = flakyRuns(root, { days: 90, now: NOW });
    expect(r).toHaveLength(1);
    expect(r[0].tests).toEqual([{ file: "tests/api/orders/orders.spec.ts", name: "creates an order" }]);
    // older reports only have names
    put(root, `.qa-sentinel/runs/${day(4)}-old/verification.json`, JSON.stringify({ flaky: ["lists orders"] }));
    expect(flakyRuns(root, { days: 90, now: NOW }).find((x) => x.run.endsWith("-old"))!.tests).toEqual([{ name: "lists orders" }]);
    expect(flakyRuns(tmp(), { days: 90, now: NOW })).toEqual([]);
  });

  it("combines a known-defect test, flaky runs and kb/history.yaml per endpoint", () => {
    const root = tmp();
    verification(root, 3, [`${'tests/api/orders/orders.spec.ts'}::creates an order`]);
    put(root, `.qa-sentinel/runs/${day(10)}-old/verification.json`, JSON.stringify({ flaky: ["creates an order @endpoint:POST_/orders"] })); // an older report: names only, tags in the name
    put(root, "kb/history.yaml", 'endpoints:\n  "GET /orders":\n    incidents: 3\n    note: "slow listing, March"\n  "POST /refunds":\n    incidents: "two"\n');
    const { map, problems } = historySignals({ cwd: root, c: cfg(), index: specs, now: NOW });
    const post = historyFor(map, "orders", "POST /orders")!;
    expect(post.count).toBe(3); // 1 known-defect + 2 flaky days
    expect(post.signals.map((s) => s.kind).sort()).toEqual(["flaky", "flaky", "known-defect"]);
    expect(post.signals.find((s) => s.kind === "known-defect")!.detail).toContain("tests/api/orders/orders.spec.ts:3");
    expect(historyFor(map, "orders", "GET /orders")).toMatchObject({ count: 3 });
    expect(historyFor(map, "orders", "GET /orders")!.signals[0].detail).toContain("slow listing, March");
    expect(problems.join()).toContain('POST /refunds: "incidents" must be a number');
  });

  it("works with no history at all, and with a broken yaml file", () => {
    const root = tmp();
    expect(historySignals({ cwd: root, c: cfg(), index: [], now: NOW }).map.size).toBe(0);
    put(root, "kb/history.yaml", "endpoints: [unclosed");
    const r = readHistoryFile(root, cfg());
    expect(r.problems[0]).toContain("could not be read");
  });

  it("uses the file name from the config", () => {
    const root = tmp();
    put(root, "kb/incidents.yaml", 'endpoints:\n  "POST /orders": { incidents: 2 }\n');
    expect(historySignals({ cwd: root, c: cfg({ risk: { history: { file: "incidents.yaml" } } }), index: [], now: NOW }).map.get(historyKey(undefined, "POST /orders"))!.count).toBe(2);
  });
});

const ev = [{ source: "source-code" as const, file: "src/server.js", line: 1, reference: "x" }];
const planWith = (factors: string[], observable = true): any => ({
  schemaVersion: 1,
  verdict: "v",
  recommendedAction: "a",
  changes: [{ id: "c1", type: "validation-change", endpoint: "POST /orders", summary: "s", observable, requirementIds: [], oracleStatus: "missing", riskFactors: factors, evidence: ev }],
  decisions: [{ changeId: "c1", coverage: "missing", decision: observable ? "review" : "skip", existingTests: [], proposedScenarios: observable ? [{ title: "t", setup: [], assertions: ["a"] }] : [], evidence: ev, reason: "r" }],
  impactedTests: [],
  acMismatches: [],
  specDrift: [],
  requirementStatus: [],
  suspicious: [],
  openQuestions: [],
  skipReason: null,
});
const history = (n: number) => new Map([[historyKey(undefined, "POST /orders"), { endpoint: "POST /orders", count: n, signals: [{ kind: "incident" as const, count: n, detail: `${n} incident(s) in kb/history.yaml: double charge` }] }]]);
const base = { acIds: [], requirementsMissing: true, testRepo: os.tmpdir(), serviceRepo: os.tmpdir() };
const risked = (factors: string[], n: number, observable = true) => applyRisk(validatePlan(planWith(factors, observable), base).plan!, { breakingEndpoints: new Set(), crossService: false, history: history(n), historyThreshold: 2 });

describe("A7 risk from history", () => {
  it("raises one level, never to critical", () => {
    expect(raiseOne("low")).toBe("medium");
    expect(raiseOne("medium")).toBe("high");
    expect(raiseOne("high")).toBe("high");
    expect(raiseOne("critical")).toBe("critical");
  });

  it("low becomes medium at the threshold, with the evidence", () => {
    const r = risked(["read-only"], 2);
    expect(r.changes[0]).toMatchObject({ risk: "medium", factors: ["read-only", "history"] });
    expect(r.overall).toBe("medium");
    expect(r.historyRaised).toMatchObject([{ changeId: "c1", from: "low", to: "medium" }]);
    const md = renderGapReport({ service: "o", plan: validatePlan(planWith(["read-only"]), base).plan!, risked: r, contract: { status: "no-spec", changes: [] }, requirementsLine: "", corrections: [], warnings: [], oracle: "missing" });
    expect(md).toContain("**Risk raised by history (no AI)**");
    expect(md).toContain("c1: 🟢 Low to 🟡 Medium");
    expect(md).toContain("double charge");
  });

  it("does nothing below the threshold, and does not lift a high change to critical", () => {
    expect(risked(["read-only"], 1).changes[0].risk).toBe("low");
    expect(risked(["business-rule"], 5).changes[0].risk).toBe("high");
    expect(risked(["money"], 5).changes[0].risk).toBe("critical");
    expect(risked(["validation"], 2).changes[0].risk).toBe("high");
  });

  it("does not raise a change that changes no behaviour", () => {
    const r = risked(["internal"], 9, false);
    expect(r.changes[0].risk).toBe("low");
    expect(r.historyRaised).toBeUndefined();
  });
});

describe("planChange: the facts are computed in code and handed to the agent", () => {
  it("adds change types and history to the risk, and puts them in context.json", async () => {
    const svc = tmp();
    g(svc, "init", "-q", "-b", "main");
    put(svc, "src/server.js", "1");
    g(svc, "add", "-A");
    g(svc, "commit", "-q", "-m", "init");
    put(svc, "src/server.js", "app.post('/orders', handler);");
    put(svc, "db/migrations/002.sql", "alter table orders add column slot text;");
    g(svc, "add", "-A");
    g(svc, "commit", "-q", "-m", "slot");
    const cs = changeSet(svc, "HEAD~1", "HEAD");
    const test = tmp();
    put(test, "tests/api/orders.spec.ts", 'test("creates @service:orders @endpoint:POST_/orders", async () => {});');
    put(test, "kb/history.yaml", 'endpoints:\n  "POST /orders": { incidents: 2, note: "double charge" }\n');
    const c = cfg();
    const run = createRunDir(test, "gap-orders");
    const seen: AgentTask[] = [];
    const engine: AgentEngine = {
      name: "fake",
      available: () => ({ ok: true }),
      run: async (task) => {
        seen.push(task);
        const ctx = JSON.parse(fs.readFileSync(path.join(task.cwd, run.rel, "context.json"), "utf8"));
        const plan = planWith(["read-only"]);
        plan.changes[0].evidence = [{ source: "source-code", file: "src/server.js", line: 1, reference: "x" }];
        fs.writeFileSync(path.join(task.cwd, ctx.planPath), JSON.stringify(plan));
        return { ok: true, status: "ok", result: "done" };
      },
    };
    const out = await planChange({ cwd: test, c, service: c.workspace.services[0], repo: svc, cs, relevant: ["src/server.js"], req: { source: "none", acceptanceCriteria: [] } as any, run, engine });
    expect(out.status).toBe("valid");
    expect(out.risked!.overall).toBe("high"); // c0 (migration) is high
    expect(out.risked!.changes.map((x) => `${x.id}:${x.risk}`)).toEqual(["c1:medium", "c0:high"]); // c1 raised by history
    const ctx = JSON.parse(fs.readFileSync(path.join(run.dir, "context.json"), "utf8"));
    expect(ctx.changeKinds).toMatchObject([{ kind: "migration", file: "db/migrations/002.sql" }]);
    expect(ctx.endpointHistory).toMatchObject([{ endpoint: "POST /orders", signals: 2 }]);
    expect(ctx.endpointHistory[0].why.length).toBeLessThan(400);
    expect(ctx.accessControl).toEqual({ mode: "warn", roles: [] });
    expect(seen[0].prompt).toContain("change types");
    const validated = JSON.parse(fs.readFileSync(path.join(run.dir, "test-plan.validated.json"), "utf8"));
    expect(validated.risk.changeKinds).toHaveLength(1);
    expect(validated.risk.historyRaised[0]).toMatchObject({ changeId: "c1", from: "low", to: "medium" });
    expect(JSON.parse(fs.readFileSync(path.join(run.dir, "change-kinds.json"), "utf8"))).toHaveLength(1);
  });
});
