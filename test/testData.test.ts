import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { initCommand, addDataLedgerCommand } from "../src/commands/init.js";
import { loadConfig } from "../src/config.js";
import { pendingRecords, sweep, sweepAfterRun, sweepMarkdown } from "../src/testData.js";
import { dataSweepCommand } from "../src/commands/data.js";

const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const line = (o: object) => JSON.stringify(o) + "\n";

/** A killed run's ledger: program → company → event created, the event's own cleanup ran, then the run died. */
function crashedRun(dir: string, name = "run-1") {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.jsonl`);
  fs.writeFileSync(
    file,
    line({ op: "create", seq: 1, kind: "program", id: "p1", remove: { path: "/programs/p1" }, test: "books a session", at: "2026-10-17T01:00:00.000Z" }) +
      line({ op: "create", seq: 2, kind: "company", id: "c1", remove: { path: "/programs/p1/companies/c1" }, test: "books a session", at: "2026-10-17T01:00:01.000Z" }) +
      line({ op: "create", seq: 3, kind: "event", id: "e1", remove: { path: "/events/e1" }, test: "books a session", at: "2026-10-17T01:00:02.000Z" }) +
      line({ op: "delete", seq: 3 }) +
      line({ op: "create", seq: 4, kind: "session", id: "s1", test: "books a session", at: "2026-10-17T01:00:03.000Z" }) +
      '{"op":"create","seq":5,"kin', // half-written line from the kill
  );
  const old = Date.now() / 1000 - 3600;
  fs.utimesSync(file, old, old);
  return file;
}

function fakeFetch(status: (url: string) => number) {
  const calls: string[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method} ${url} ${(init?.headers as Record<string, string>)?.Authorization ?? ""}`.trim());
    return new Response(null, { status: status(url) });
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe("test data ledger and sweeper", () => {
  it("finds what a killed run left behind, newest first, skipping deleted records and a torn last line", () => {
    const dir = tmp("qas-ledger-");
    crashedRun(dir);
    expect(pendingRecords(dir).map((p) => p.id)).toEqual(["s1", "c1", "p1"]);
    // A run still writing (recent file) is left alone when asked.
    expect(pendingRecords(dir, { olderThanMinutes: 120 })).toEqual([]);
  });

  it("deletes leftovers in reverse order on the test environment, counts 404 as gone, keeps failures for next time", async () => {
    const dir = tmp("qas-ledger-");
    const file = crashedRun(dir);
    const { f, calls } = fakeFetch((u) => (u.endsWith("/companies/c1") ? 404 : u.endsWith("/programs/p1") ? 500 : 204));
    const r = await sweep({ dir, baseUrl: "http://qa.local/api", authHeader: "Bearer t", fetchImpl: f });
    expect(calls).toEqual(["DELETE http://qa.local/api/programs/p1/companies/c1 Bearer t", "DELETE http://qa.local/api/programs/p1 Bearer t"]);
    expect(r.deleted.map((p) => p.id)).toEqual(["c1"]);
    expect(r.failed.map((p) => [p.id, p.error])).toEqual([["p1", "500"]]);
    expect(r.manual.map((p) => p.id)).toEqual(["s1"]); // no delete request recorded
    expect(sweepMarkdown(r)).toContain("| session | s1 | books a session | ⚠️ no delete request recorded: remove by hand |");
    // The failure stays in the ledger; the next sweep only retries what's left.
    expect(fs.existsSync(file)).toBe(true);
    expect(pendingRecords(dir).map((p) => p.id)).toEqual(["s1", "p1"]);
  });

  it("removes a ledger once everything in it is deleted, and never calls another host", async () => {
    const dir = tmp("qas-ledger-");
    fs.writeFileSync(
      path.join(dir, "r.jsonl"),
      line({ op: "create", seq: 1, kind: "user", id: "u1", remove: { path: "/users/u1" }, at: "2026-10-17T01:00:00.000Z" }) +
        line({ op: "create", seq: 2, kind: "x", id: "x1", remove: { path: "//evil.example/steal" }, at: "2026-10-17T01:00:01.000Z" }) +
        line({ op: "delete", seq: 2 }),
    );
    const { f, calls } = fakeFetch(() => 204);
    const r = await sweep({ dir, baseUrl: "http://qa.local/", fetchImpl: f });
    expect(r.deleted.map((p) => p.id)).toEqual(["u1"]);
    expect(fs.existsSync(path.join(dir, "r.jsonl"))).toBe(false);

    fs.writeFileSync(path.join(dir, "s.jsonl"), line({ op: "create", seq: 1, kind: "x", id: "x1", remove: { path: "//evil.example/steal" }, at: "2026-10-17T01:00:01.000Z" }));
    const r2 = await sweep({ dir, baseUrl: "http://qa.local/", fetchImpl: f });
    expect(r2.failed[0].error).toMatch(/not a path on the test environment/);
    expect(calls).toEqual(["DELETE http://qa.local/users/u1"]);
  });

  it("the scaffolded ledger tracks records and deletes them newest first when the test ends, pass or fail", async () => {
    const root = tmp("qas-ledger-scaffold-");
    const c = await initCommand({ cwd: root, yes: true, mode: "scratch", ci: "gitlab", workspace: root, name: "demo" });
    expect(c.testData.cleanup).toBe("ledger");
    const ledgerSrc = fs.readFileSync(path.join(root, "src/data/ledger.ts"), "utf8");
    expect(ledgerSrc).toContain('process.env.QA_DATA_DIR ?? ".qa-data"');
    expect(fs.readFileSync(path.join(root, "src/fixtures/index.ts"), "utf8")).toContain("await ledger.cleanup()");
    expect(fs.readFileSync(path.join(root, ".gitignore"), "utf8")).toContain(".qa-data/");
    expect(fs.readFileSync(path.join(root, "ci/qa-sentinel/tests.gitlab-ci.yml"), "utf8")).toContain("qa-sentinel data sweep");

    // Run the generated TypeScript with a stand-in for Playwright's request context.
    const dataDir = path.join(root, "ledger-out");
    process.env.QA_DATA_DIR = dataDir;
    try {
      const { DataLedger } = await import(path.join(root, "src/data/ledger.ts"));
      const sent: string[] = [];
      const request = { fetch: async (p: string, o: { method: string }) => (sent.push(`${o.method} ${p}`), { ok: () => !p.includes("bad"), status: () => (p.includes("bad") ? 500 : 204) }) };
      const ledger = new DataLedger(request, "books a session", "t1-0");
      ledger.track("program", "p1", { path: "/programs/p1" });
      ledger.track("company", "c1", { path: "/companies/c1" });
      const removed: string[] = [];
      ledger.track("session", "s1", async () => void removed.push("s1"));
      // Mid-test, the ledger file already says how to clean up if the run is killed now.
      expect(pendingRecords(dataDir).map((p) => p.id)).toEqual(["s1", "c1", "p1"]);
      expect(await ledger.cleanup()).toEqual([]);
      expect(removed).toEqual(["s1"]);
      expect(sent).toEqual(["DELETE /companies/c1", "DELETE /programs/p1"]);
      expect(fs.readdirSync(dataDir)).toEqual([]); // clean: no file left

      const l2 = new DataLedger(request, "fails to clean", "t2-0");
      l2.track("thing", "b1", { path: "/bad/b1" });
      expect(await l2.cleanup()).toEqual(["thing b1: DELETE /bad/b1 → 500"]);
      expect(pendingRecords(dataDir).map((p) => p.id)).toEqual(["b1"]); // left for the sweeper
    } finally {
      delete process.env.QA_DATA_DIR;
    }
  });

  it("add-data-ledger switches an existing project over; generate's sweep reports what stays behind", async () => {
    const root = tmp("qas-ledger-existing-");
    await initCommand({ cwd: root, yes: true, mode: "scratch", ci: "gitlab", workspace: root, name: "demo" });
    const cfgFile = path.join(root, "qa-sentinel.config.yaml");
    const doc = YAML.parseDocument(fs.readFileSync(cfgFile, "utf8"));
    doc.setIn(["testData", "cleanup"], "project");
    fs.writeFileSync(cfgFile, doc.toString());
    fs.rmSync(path.join(root, "src/data/ledger.ts"));
    addDataLedgerCommand({ cwd: root });
    expect(loadConfig(root).testData.cleanup).toBe("ledger");
    expect(fs.existsSync(path.join(root, "src/data/ledger.ts"))).toBe(true);

    crashedRun(path.join(root, ".qa-data"));
    const findings = await sweepAfterRun(root, loadConfig(root), { QA_BASE_URL: "http://127.0.0.1:9/" });
    expect(findings.map((f) => f.rule)).toEqual(["test-data", "test-data", "test-data"]);
    expect(findings.find((f) => f.message.includes("session s1"))?.message).toContain("no delete request recorded");

    // Without the environment's URL the sweeper refuses rather than guessing where to send deletes.
    expect(await dataSweepCommand({ cwd: root, env: {} })).toBe(2);
    expect(await dataSweepCommand({ cwd: root, env: {}, dryRun: true })).toBe(1);
  });
});
