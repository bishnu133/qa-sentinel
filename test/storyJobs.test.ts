import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type JobPolicy, type Budgets, beginJob, budgetStatus, budgetedEngine, digest, endJob, generateJobKey, jobPolicy, ownerAlive, specJobKey } from "../src/stories/jobs.js";
import { NO_STORY, assertSafeKey, emptyRecord, fileStore, fitForJira, recordsDir, trimRecord } from "../src/stories/record.js";
import type { AgentEngine, AgentTask } from "../src/engines/AgentEngine.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "qas-rec-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const policy = (o: Partial<JobPolicy> = {}): JobPolicy => ({ skipDone: true, lockMinutes: 90, maxAttempts: 3, force: false, ...o });
const budgets = (o: Partial<Budgets> = {}): Budgets => ({ perStoryUsd: 25, perDayUsd: 100, perMonthUsd: 1000, ...o });
const T0 = new Date("2026-10-21T02:00:00Z");
const mins = (n: number, from = T0) => new Date(from.getTime() + n * 60_000);

describe("story record files", () => {
  it("only lets plain keys become file names", () => {
    expect(assertSafeKey("SHOP-101")).toBe("SHOP-101");
    for (const bad of ["../x", "a/b", "", "a b", "x..y", ".hidden", "A".repeat(80)]) expect(() => assertSafeKey(bad)).toThrow();
  });
  it("saves and loads, and lists", async () => {
    const s = fileStore(dir);
    const r = emptyRecord("SHOP-101", T0);
    r.acs = [{ id: "AC-1", hash: "abc" }];
    await s.save(r);
    expect(await s.load("SHOP-101")).toMatchObject({ key: "SHOP-101", acs: [{ id: "AC-1", hash: "abc" }] });
    expect(await s.load("SHOP-999")).toBeUndefined();
    await s.save(emptyRecord("SHOP-102", T0));
    expect((await s.list()).map((x) => x.key).sort()).toEqual(["SHOP-101", "SHOP-102"]);
    expect(fs.readdirSync(recordsDir(dir)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
  it("moves a damaged record aside instead of overwriting it", async () => {
    const s = fileStore(dir);
    fs.mkdirSync(recordsDir(dir), { recursive: true });
    fs.writeFileSync(path.join(recordsDir(dir), "SHOP-101.json"), "{ not json");
    expect(await s.load("SHOP-101")).toBeUndefined();
    expect(fs.readdirSync(recordsDir(dir)).some((f) => f.startsWith("SHOP-101.json.damaged-"))).toBe(true);
  });
  it("does not trust a record that belongs to another story", async () => {
    const s = fileStore(dir);
    await s.save(emptyRecord("SHOP-101", T0));
    fs.copyFileSync(path.join(recordsDir(dir), "SHOP-101.json"), path.join(recordsDir(dir), "SHOP-102.json"));
    expect(await s.load("SHOP-102")).toBeUndefined();
  });
  it("runs locked sections one after another, and removes a stale lock", async () => {
    const s = fileStore(dir);
    const order: string[] = [];
    await Promise.all(
      ["a", "b", "c"].map((n) =>
        s.locked("SHOP-101", async () => {
          order.push(`${n}-in`);
          await new Promise((r) => setTimeout(r, 30));
          order.push(`${n}-out`);
        }),
      ),
    );
    for (let i = 0; i < order.length; i += 2) expect(order[i].replace("-in", "")).toBe(order[i + 1].replace("-out", ""));
    const lock = path.join(recordsDir(dir), "SHOP-101.json.lock");
    fs.writeFileSync(lock, "dead");
    const old = new Date(Date.now() - 120_000);
    fs.utimesSync(lock, old, old);
    await expect(s.locked("SHOP-101", async () => "ok")).resolves.toBe("ok");
  });
  it("trims old spend and old jobs", () => {
    const r = emptyRecord("SHOP-101", T0);
    r.ledger = [
      { at: "2026-06-01T00:00:00Z", job: "j", kind: "spec", costUsd: 1 },
      { at: "2026-10-20T00:00:00Z", job: "j", kind: "spec", costUsd: 2 },
    ];
    r.totalCostUsd = 3;
    expect(trimRecord(r, T0).ledger).toHaveLength(1);
    expect(trimRecord(r, T0).totalCostUsd).toBe(3);
    for (let i = 0; i < 80; i++) r.jobs[`j${i}`] = { key: `j${i}`, kind: "other", state: "done", startedAt: new Date(T0.getTime() + i * 1000).toISOString(), attempts: 1, costUsd: 0 };
    const t = trimRecord(r, T0);
    expect(Object.keys(t.jobs)).toHaveLength(60);
    expect(t.jobs["j79"]).toBeDefined();
    expect(t.jobs["j0"]).toBeUndefined();
  });
  it("shrinks a record until it fits a Jira property", () => {
    const r = emptyRecord("SHOP-101", T0);
    for (let i = 0; i < 400; i++) r.ledger.push({ at: T0.toISOString(), job: `generate:SHOP-101:orders-service:${"a".repeat(40)}:${i}`, kind: "generate", costUsd: 0.5 });
    const f = fitForJira(r);
    expect(Buffer.byteLength(JSON.stringify(f))).toBeLessThan(28_000);
    expect(f.totalCostUsd).toBe(r.totalCostUsd);
  });
});

describe("job keys", () => {
  it("are stable, and change with the inputs", () => {
    expect(specJobKey("SHOP-101", ["b", "a"])).toBe(specJobKey("SHOP-101", ["a", "b"]));
    expect(specJobKey("SHOP-101", ["a", "b"])).not.toBe(specJobKey("SHOP-101", ["a", "c"]));
    expect(specJobKey("SHOP-101", ["a"])).not.toBe(specJobKey("SHOP-102", ["a"]));
    const g = generateJobKey("SHOP-101", "orders-service", "0123456789abcdef0123", ["a"]);
    expect(g).toMatch(/^generate:SHOP-101:orders-service:0123456789ab:[0-9a-f]{10}$/);
    expect(generateJobKey(undefined, "orders-service", "0123456789abcdef", ["a"])).toContain("generate:-:");
    expect(generateJobKey("SHOP-101", "orders-service", "ffff", ["a"])).not.toBe(g);
    expect(digest(["a", "b"])).not.toBe(digest(["ab"]));
  });
});

describe("beginJob / endJob", () => {
  const go = (s: ReturnType<typeof fileStore>, o: { key?: string; p?: Partial<JobPolicy>; b?: Partial<Budgets>; now?: Date; kind?: "spec" | "generate" | "other" } = {}) =>
    beginJob(s, { story: "SHOP-101", kind: o.kind ?? "spec", key: o.key ?? "spec:SHOP-101:x", policy: policy(o.p), budgets: budgets(o.b), now: o.now ?? T0 });

  it("starts a job, records it as running, and refuses a second run of it", async () => {
    const s = fileStore(dir);
    const a = await go(s);
    expect(a.run).toBe(true);
    expect((await s.load("SHOP-101"))!.jobs["spec:SHOP-101:x"]).toMatchObject({ state: "running", attempts: 0 });
    const b = await go(s, { now: mins(5) });
    expect(b).toMatchObject({ run: false, reason: "running" });
    expect((b as any).message).toMatch(/already running/);
  });
  it("lets a second run take over when the first is past the lock time, or its process is gone", async () => {
    const s = fileStore(dir);
    await go(s);
    const late = await go(s, { now: mins(95) });
    expect(late.run).toBe(true);
    expect((late as any).notes[0]).toMatch(/never finished/);
    // a process on this machine that no longer exists
    const rec = (await s.load("SHOP-101"))!;
    rec.jobs["spec:SHOP-101:x"].owner = `${os.hostname()}:2147483646`;
    await s.save(rec);
    expect((await go(s, { now: mins(96) })).run).toBe(true);
  });
  it("sees a live process on this machine as alive, and other machines as alive until the lock expires", () => {
    expect(ownerAlive(`${os.hostname()}:${process.pid}`)).toBe(true);
    expect(ownerAlive(`${os.hostname()}:2147483646`)).toBe(false);
    expect(ownerAlive("some-other-host:1")).toBe(true);
    expect(ownerAlive(undefined)).toBe(true);
  });
  it("skips a job that is done when skipDone is on, runs it when it is off, and --force runs it", async () => {
    const s = fileStore(dir);
    const a = (await go(s)) as any;
    a.handle.addCost(0.05);
    await endJob(s, a.handle, { state: "done", outcome: "up to date", now: mins(1) });
    const again = await go(s, { now: mins(10) });
    expect(again).toMatchObject({ run: false, reason: "done" });
    expect((again as any).message).toMatch(/already done/);
    expect((await go(s, { now: mins(10), p: { skipDone: false } })).run).toBe(true);
  });
  it("runs a done job again with force", async () => {
    const s = fileStore(dir);
    const a = (await go(s)) as any;
    await endJob(s, a.handle, { state: "done", now: mins(1) });
    expect((await go(s, { now: mins(10), p: { force: true } })).run).toBe(true);
  });
  it("counts failures per key and stops after maxAttempts; aborted runs are not counted", async () => {
    const s = fileStore(dir);
    for (let i = 0; i < 3; i++) {
      const r = (await go(s, { now: mins(i * 10), p: { maxAttempts: 3 } })) as any;
      expect(r.run).toBe(true);
      await endJob(s, r.handle, { state: "failed", outcome: "expectations-failed", now: mins(i * 10 + 1) });
    }
    const blocked = await go(s, { now: mins(40), p: { maxAttempts: 3 } });
    expect(blocked).toMatchObject({ run: false, reason: "attempts" });
    expect((blocked as any).message).toMatch(/failed 3 times/);
    expect((await go(s, { now: mins(40), p: { force: true } })).run).toBe(true);
    // aborted: not counted
    const s2 = fileStore(fs.mkdtempSync(path.join(os.tmpdir(), "qas-rec2-")));
    for (let i = 0; i < 5; i++) {
      const r = (await go(s2, { now: mins(i * 10) })) as any;
      expect(r.run).toBe(true);
      await endJob(s2, r.handle, { state: "aborted", error: "no credentials", now: mins(i * 10 + 1) });
    }
    expect((await s2.load("SHOP-101"))!.jobs["spec:SHOP-101:x"].attempts).toBe(0);
  });
  it("records cost on the job, the ledger and the story total", async () => {
    const s = fileStore(dir);
    const a = (await go(s)) as any;
    a.handle.addCost(0.4);
    a.handle.addCost(0.1);
    a.handle.addCost(NaN);
    a.handle.addCost(-3);
    await endJob(s, a.handle, { state: "done", runId: "r1", now: mins(2) });
    const rec = (await s.load("SHOP-101"))!;
    expect(rec.totalCostUsd).toBeCloseTo(0.5);
    expect(rec.ledger).toEqual([{ at: mins(2).toISOString(), job: "spec:SHOP-101:x", kind: "spec", costUsd: 0.5 }]);
    expect(rec.jobs["spec:SHOP-101:x"]).toMatchObject({ state: "done", attempts: 0, runId: "r1", costUsd: 0.5 });
  });
  it("does not throw when the record can't be written", async () => {
    const s = fileStore(dir);
    const a = (await go(s)) as any;
    fs.rmSync(recordsDir(dir), { recursive: true, force: true });
    fs.writeFileSync(recordsDir(dir), "a file where the folder should be");
    await expect(endJob(s, a.handle, { state: "done" })).resolves.toBeUndefined();
  });
  it("works for work with no story", async () => {
    const s = fileStore(dir);
    const r = await beginJob(s, { story: NO_STORY, kind: "other", key: "other:x", policy: policy(), budgets: budgets(), now: T0 });
    expect(r.run).toBe(true);
  });
});

describe("budgets", () => {
  const rec = (key: string, entries: [string, number][], total = entries.reduce((a, e) => a + e[1], 0)) => {
    const r = emptyRecord(key, T0);
    r.ledger = entries.map(([at, costUsd]) => ({ at, job: "j", kind: "generate" as const, costUsd }));
    r.totalCostUsd = total;
    return r;
  };
  it("reports what is left under the tightest limit", () => {
    const a = rec("SHOP-1", [["2026-10-21T01:00:00Z", 20]]);
    const b = rec("SHOP-2", [["2026-10-21T01:30:00Z", 70], ["2026-10-20T10:00:00Z", 5]]);
    const st = budgetStatus(budgets(), [a, b], a, 1, T0);
    expect(st.spent).toMatchObject({ story: 20, day: 90 });
    expect(st.remainingUsd).toBe(5); // story: 25-20 = 5, day: 100-90 = 10
    expect(st.limit).toBe("story");
    expect(st.message).toBeUndefined();
  });
  it("refuses when less than the job needs is left, naming the setting", () => {
    const a = rec("SHOP-1", [["2026-10-21T01:00:00Z", 99.5]]);
    const st = budgetStatus(budgets({ perStoryUsd: 0 }), [a], a, 1, T0);
    expect(st.limit).toBe("day");
    expect(st.message).toMatch(/perDayUsd/);
    expect(st.message).toMatch(/\$0\.50 is left/);
  });
  it("counts the month, with days of other months excluded", () => {
    const a = rec("SHOP-1", [["2026-09-30T23:00:00Z", 900], ["2026-10-02T00:00:00Z", 50]]);
    const st = budgetStatus(budgets({ perStoryUsd: 0, perDayUsd: 0 }), [a], a, 0, T0);
    expect(st.spent.month).toBe(50);
    expect(st.remainingUsd).toBe(950);
  });
  it("uses the story's own copy rather than a stale one in the list", () => {
    const stale = rec("SHOP-1", [["2026-10-21T01:00:00Z", 1]]);
    const fresh = rec("SHOP-1", [["2026-10-21T01:00:00Z", 30]]);
    expect(budgetStatus(budgets({ perStoryUsd: 0 }), [stale], fresh, 0, T0).spent.day).toBe(30);
  });
  it("0 means no limit", () => {
    const a = rec("SHOP-1", [["2026-10-21T01:00:00Z", 5000]]);
    const st = budgetStatus({ perStoryUsd: 0, perDayUsd: 0, perMonthUsd: 0 }, [a], a, 99, T0);
    expect(st.remainingUsd).toBe(Infinity);
    expect(st.message).toBeUndefined();
  });
  it("stops a job from starting when the budget is gone, even with force", async () => {
    const s = fileStore(dir);
    const r = emptyRecord("SHOP-101", T0);
    r.totalCostUsd = 24.95;
    await s.save(r);
    const res = await beginJob(s, { story: "SHOP-101", kind: "generate", key: "generate:x", policy: policy({ force: true }), budgets: budgets(), now: T0 });
    expect(res).toMatchObject({ run: false, reason: "budget" });
  });
  it("lowers each agent call's cap to what is left and counts its cost", async () => {
    const s = fileStore(dir);
    const r = emptyRecord("SHOP-101", T0);
    r.totalCostUsd = 23; // 2 left of 25
    await s.save(r);
    const a = (await beginJob(s, { story: "SHOP-101", kind: "generate", key: "generate:x", policy: policy(), budgets: budgets(), now: T0 })) as any;
    const seen: number[] = [];
    const inner: AgentEngine = {
      name: "fake",
      available: () => ({ ok: true }),
      run: async (t: AgentTask) => (seen.push(t.maxBudgetUsd), { ok: true, status: "ok" as const, result: "", costUsd: 1.5 }),
    };
    const e = budgetedEngine(inner, a.handle);
    await e.run({ maxBudgetUsd: 5 } as AgentTask);
    expect(seen).toEqual([2]);
    expect(a.handle.remainingUsd()).toBeCloseTo(0.5);
    await e.run({ maxBudgetUsd: 1 } as AgentTask);
    expect(seen).toEqual([2, 0.5]);
    await e.run({ maxBudgetUsd: 1 } as AgentTask);
    const refused = await e.run({ maxBudgetUsd: 1 } as AgentTask);
    expect(refused).toMatchObject({ ok: false, status: "max-budget" });
    expect(seen).toHaveLength(2);
  });
  it("leaves the cap alone when there is no limit", async () => {
    const s = fileStore(dir);
    const a = (await beginJob(s, { story: "SHOP-101", kind: "spec", key: "spec:x", policy: policy(), budgets: { perStoryUsd: 0, perDayUsd: 0, perMonthUsd: 0 }, now: T0 })) as any;
    const seen: number[] = [];
    const e = budgetedEngine({ name: "f", available: () => ({ ok: true }), run: async (t) => (seen.push(t.maxBudgetUsd), { ok: true, status: "ok" as const, result: "" }) }, a.handle);
    await e.run({ maxBudgetUsd: 5 } as AgentTask);
    expect(seen).toEqual([5]);
  });
});

describe("jobPolicy", () => {
  const cfg = (skipDone: "ci" | "always" | "never") => ({ automation: { jobs: { skipDone, lockMinutes: 90, maxAttempts: 3 } } });
  it("skips done jobs in CI by default, always or never when told", () => {
    expect(jobPolicy(cfg("ci"), {}, { CI: "true" }).skipDone).toBe(true);
    expect(jobPolicy(cfg("ci"), {}, {}).skipDone).toBe(false);
    expect(jobPolicy(cfg("ci"), {}, { CI: "false" }).skipDone).toBe(false);
    expect(jobPolicy(cfg("always"), {}, {}).skipDone).toBe(true);
    expect(jobPolicy(cfg("never"), {}, { CI: "true" }).skipDone).toBe(false);
    expect(jobPolicy(cfg("never"), { once: true }, {}).skipDone).toBe(true);
    expect(jobPolicy(cfg("ci"), { force: true }, {}).force).toBe(true);
  });
});

describe("review fixes", () => {
  it("committed tests are done even when not verified; other non-zero ends are failed", async () => {
    const { endStateOf } = await import("../src/stories/jobs.js");
    expect(endStateOf(1, "committed-waiting_for_deployment")).toBe("done");
    expect(endStateOf(1, "committed-failed")).toBe("done");
    expect(endStateOf(1, "not-pushed-failed")).toBe("failed");
    expect(endStateOf(1, "guardrail-violation")).toBe("failed");
  });
  it("a missing local PID proves nothing in CI", () => {
    const dead = `${os.hostname()}:999999`;
    expect(ownerAlive(dead, {})).toBe(false);
    expect(ownerAlive(dead, { CI: "true" })).toBe(true);
  });
  it("trimming drops finished 'other' jobs before spec/generate jobs", () => {
    const rec = emptyRecord("SHOP-1");
    rec.jobs["spec:SHOP-1:x"] = { key: "spec:SHOP-1:x", kind: "spec", state: "done", startedAt: "2026-01-01T00:00:00Z", finishedAt: "2026-01-01T00:01:00Z", attempts: 0, costUsd: 1 };
    for (let i = 0; i < 70; i++) rec.jobs[`other:g:${i}`] = { key: `other:g:${i}`, kind: "other", state: "done", startedAt: `2026-02-01T00:00:${String(i % 60).padStart(2, "0")}Z`, finishedAt: `2026-02-0${1 + Math.floor(i / 60)}T00:01:${String(i % 60).padStart(2, "0")}Z`, attempts: 0, costUsd: 0.1 };
    const t = trimRecord(rec, new Date("2026-02-05T00:00:00Z"));
    expect(Object.keys(t.jobs)).toHaveLength(60);
    expect(t.jobs["spec:SHOP-1:x"]).toBeDefined();
  });
  it("attempts count failures in a row: a done run resets them", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qas-att-"));
    const store = fileStore(dir);
    const policy: JobPolicy = { skipDone: false, lockMinutes: 90, maxAttempts: 2, force: false };
    const budgets: Budgets = { perStoryUsd: 0, perDayUsd: 0, perMonthUsd: 0 };
    const run = async (state: "done" | "failed") => {
      const r = await beginJob(store, { story: "SHOP-1", kind: "spec", key: "spec:SHOP-1:k", policy, budgets });
      if (!r.run) return r.reason;
      await endJob(store, r.handle, { state });
      return "ran";
    };
    expect(await run("failed")).toBe("ran");
    expect(await run("done")).toBe("ran");
    expect(await run("failed")).toBe("ran");
    expect(await run("failed")).toBe("ran");
    expect(await run("failed")).toBe("attempts");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
