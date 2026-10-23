import http from "node:http";
import { describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { indexSource } from "../src/analysis/testIndex.js";
import { bugDescription, bugsFromDiscrepancies, bugsFromPlan, bugsFromResults, fileBugs, noteFixedBugs } from "../src/bugs/bugs.js";

const cfg = (mode: "suggest" | "create") =>
  ConfigSchema.parse({ version: 1, mode: "scratch", project: { name: "p" }, tests: { api: { framework: "playwright", runCommand: "npx playwright test --project=api" } }, ci: { platform: "gitlab" }, bugs: { mode } });
const items = [{ id: "AC-1", text: "Total is qty x price" }, { id: "TS-1", text: "Quantity 1-99" }];
const index = indexSource("tests/web/order.spec.ts", `test("shows the total @story:SHOP-7 @ac:AC-1", async () => {});\ntest.fixme("rejects 100 @story:SHOP-7 @ac:TS-1", async () => {});`);
const plan: any = {
  acMismatches: [{ requirementId: "AC-1", requirement: "total", observed: "shows the unit price", evidence: [{ source: "source-code", file: "src/pages.js", line: 91, reference: "money(o.unitPrice)" }] }],
  requirementStatus: [
    { id: "AC-1", status: "conflict", coveredByAcs: [], evidence: [{ source: "source-code", file: "src/pages.js", line: 91, reference: "x" }] },
    { id: "TS-1", status: "not-found", coveredByAcs: [], evidence: [], note: "no range check" },
  ],
};
const run = { runCommand: (t: any) => `npx playwright test ${t.file}:${t.line}` };

function fakeJira() {
  const state = { issues: [] as any[], links: [] as any[], comments: [] as any[], props: {} as Record<string, any>, n: 0 };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const u = req.url!;
      const json = (code: number, v?: unknown) => (res.writeHead(code, { "content-type": "application/json" }), res.end(v === undefined ? "" : JSON.stringify(v)));
      if (u === "/rest/api/2/myself") return json(200, { accountId: "bot" });
      if (u.startsWith("/rest/api/2/project/")) return json(200, { issueTypes: [{ name: "Task" }, { name: "Story" }] });
      if (u === "/rest/api/2/issue" && req.method === "POST") return state.issues.push(JSON.parse(body).fields), json(201, { key: `SHOP-${100 + ++state.n}` });
      if (u === "/rest/api/2/issueLink") return state.links.push(JSON.parse(body)), json(201);
      if (u.includes("/properties/")) return req.method === "GET" ? (state.props.bugs ? json(200, { value: state.props.bugs }) : json(404, {})) : ((state.props.bugs = JSON.parse(body)), json(200));
      if (u.includes("?fields=status")) return json(200, { fields: { status: { name: "To Do", statusCategory: { key: "new" } } } });
      if (u.includes("/comment") && req.method === "GET") return json(200, { comments: [], total: 0 });
      if (u.includes("/comment")) return state.comments.push({ url: u, ...JSON.parse(body) }), json(201, { id: "1" });
      json(404, { u });
    });
  });
  return { server, state };
}

describe("bug cards", () => {
  it("builds candidates from fixme discrepancies, failing results and the story-wide plan", () => {
    const fromFixme = bugsFromDiscrepancies("SHOP-7", items, [{ file: "tests/web/order.spec.ts", test: "rejects 100", note: "accepts 100" }], index, plan, run);
    expect(fromFixme[0]).toMatchObject({ item: "TS-1", kind: "not-working", actual: "accepts 100", command: "npx playwright test tests/web/order.spec.ts:2" });
    const fromRun = bugsFromResults(cfg("create"), "SHOP-7", items, index, [{ file: "web/order.spec.ts", line: 1, title: "shows the total", status: "failed", evidence: [], error: "Expected SGD 25.00, received SGD 12.50" }], run);
    expect(fromRun[0]).toMatchObject({ item: "AC-1", actual: "Expected SGD 25.00, received SGD 12.50" });
    const fromPlan = bugsFromPlan("SHOP-7", items, plan);
    expect(fromPlan.map((b) => [b.item, b.kind, b.suspected])).toEqual([["AC-1", "not-working", true], ["TS-1", "not-built", true]]);
    const desc = bugDescription(fromPlan[0]);
    expect(desc).toContain("{code:json}");
    expect(desc).toContain('"requirement": "AC-1"');
    expect(desc).toContain("src/pages.js:91");
  });

  it("creates each bug once, linked to the story, falls back to Task, and notes fixes once", async () => {
    const { server, state } = fakeJira();
    await new Promise<void>((ok) => server.listen(0, ok));
    const ctx = { baseUrl: `http://127.0.0.1:${(server.address() as any).port}`, authHeader: "Basic x" };
    try {
      const c = cfg("create");
      const cands = bugsFromPlan("SHOP-7", items, plan);
      const r1 = await fileBugs(ctx, c, "SHOP-7", cands);
      expect(r1.created).toEqual(["SHOP-101", "SHOP-102"]);
      expect(state.issues[0].issuetype.name).toBe("Task");
      expect(state.issues[0].labels).toEqual(["qa-sentinel", "bug", "qa-sentinel-suspected"]);
      expect(state.links[0]).toMatchObject({ inwardIssue: { key: "SHOP-101" }, outwardIssue: { key: "SHOP-7" } });
      const r2 = await fileBugs(ctx, c, "SHOP-7", cands);
      expect(r2.created).toEqual([]);
      expect(r2.skipped[0]).toContain("already raised as SHOP-101");
      expect(await noteFixedBugs(ctx, "SHOP-7", ["AC-1"], "sit")).toEqual(["SHOP-101"]);
      expect(await noteFixedBugs(ctx, "SHOP-7", ["AC-1"], "sit")).toEqual([]);
      expect(state.comments.at(-1).body).toContain("now pass on SIT");
      const s = await fileBugs(ctx, cfg("suggest"), "SHOP-8", cands);
      expect(s.suggested).toBe(2);
      expect(state.comments.at(-1).body).toContain("Proposed bugs");
    } finally {
      server.close();
    }
  });
});
