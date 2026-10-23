import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { partToInput, partsOf, storyBasis, upsertPart } from "../src/stories/parts.js";
import { type RecordPart, StoryRecordSchema, emptyRecord, fileStore, fitForJira, trimRecord, SWEEP_FILE, recordsDir } from "../src/stories/record.js";
import { cleanTmp, tmp } from "./helpers/mocks.js";

afterEach(cleanTmp);
const T0 = new Date("2026-10-01T10:00:00Z");
const part = (service: string, iid: number, extra: Partial<RecordPart> = {}) => ({ service, source: "gitlab-mr" as const, iid, state: "opened" as const, keys: ["SHOP-12"], ...extra });

describe("the story record, new fields", () => {
  it("an old version-1 record still loads, and the new fields take their defaults", () => {
    // A record as the code before the parts field wrote it.
    const old = {
      version: 1,
      key: "SHOP-101",
      updatedAt: "2026-09-01T00:00:00.000Z",
      jira: { status: "In Progress", labels: [] },
      acs: [{ id: "AC-1", hash: "abc" }],
      lastCheck: { at: "2026-09-01T00:00:00.000Z", state: "needs-tests", next: "generate", reasons: [] },
      jobs: { "spec:SHOP-101:x": { key: "spec:SHOP-101:x", kind: "spec", state: "done", startedAt: "2026-09-01T00:00:00.000Z", attempts: 0, costUsd: 1.5 } },
      ledger: [{ at: "2026-09-01T00:00:00.000Z", job: "spec:SHOP-101:x", kind: "spec", costUsd: 1.5 }],
      totalCostUsd: 1.5,
    };
    const rec = StoryRecordSchema.parse(old);
    expect(rec).toMatchObject({ parts: [], linked: [], crossService: {}, acEvidence: {}, results: [], notified: [], overrides: [], totalCostUsd: 1.5 });
    expect(rec.agentMr).toBeUndefined();
    expect(rec.basis).toBeUndefined();
  });

  it("an old record file on disk is read by the file store", async () => {
    const dir = tmp("qas-rec-");
    fs.mkdirSync(recordsDir(dir), { recursive: true });
    fs.writeFileSync(path.join(recordsDir(dir), "SHOP-101.json"), JSON.stringify({ version: 1, key: "SHOP-101", updatedAt: "2026-09-01T00:00:00.000Z", acs: [], jobs: {}, ledger: [], totalCostUsd: 0 }));
    expect((await fileStore(dir).load("SHOP-101"))?.parts).toEqual([]);
  });

  it("the sweep's state file is never read as a story record", async () => {
    const dir = tmp("qas-rec-");
    const store = fileStore(dir);
    await store.save(emptyRecord("SHOP-1", T0));
    fs.writeFileSync(path.join(recordsDir(dir), SWEEP_FILE), JSON.stringify({ lastAt: T0.toISOString() }));
    expect((await store.list()).map((r) => r.key)).toEqual(["SHOP-1"]);
    // Still there: it was not moved aside as a damaged record.
    expect(fs.readdirSync(recordsDir(dir)).filter((n) => n.includes("damaged"))).toEqual([]);
    expect(fs.existsSync(path.join(recordsDir(dir), SWEEP_FILE))).toBe(true);
  });
});

describe("upsertPart", () => {
  it("adds a part, then updates the same MR in place and keeps when it was first seen", () => {
    let rec = emptyRecord("SHOP-12", T0);
    rec = upsertPart(rec, part("orders", 7, { title: "first" }), T0);
    rec = upsertPart(rec, part("orders", 8), T0);
    rec = upsertPart(rec, part("orders", 7, { state: "merged", mergeSha: "m7", title: "second" }), new Date("2026-10-02T10:00:00Z"));
    expect(rec.parts).toHaveLength(2);
    expect(partsOf(rec, "orders").find((p) => p.iid === 7)).toMatchObject({ state: "merged", mergeSha: "m7", title: "second", firstSeenAt: T0.toISOString(), lastSeenAt: "2026-10-02T10:00:00.000Z" });
    expect(partsOf(rec, "storefront")).toEqual([]);
  });
  it("a part from plain git (no MR number) is matched on its branch and head", () => {
    let rec = emptyRecord("SHOP-12", T0);
    const p = { service: "orders", source: "git" as const, state: "opened" as const, branch: "feature/x", headSha: "h1", keys: [] };
    rec = upsertPart(upsertPart(rec, p, T0), p, T0);
    expect(rec.parts).toHaveLength(1);
  });
  it("a merge request that was merged stays merged when a pipeline of it is seen again", () => {
    let rec = upsertPart(emptyRecord("SHOP-12", T0), part("orders", 7, { state: "merged" }), T0);
    rec = upsertPart(rec, part("orders", 7, { state: "merged" }), T0);
    expect(rec.parts[0].state).toBe("merged");
  });
  it("partToInput and the manifest agree on a merged MR", () => {
    const input = partToInput({ service: "orders", source: "gitlab-mr", mr: { iid: 3, url: "u", state: "merged", title: "t" }, merged: true, sha: "m3", mergeSha: "m3", keys: ["SHOP-12"], diffRefs: { base: "b", head: "h", start: "s" } });
    expect(input).toMatchObject({ iid: 3, state: "merged", mergeSha: "m3", headSha: "h", diffBase: "b" });
  });
});

describe("storyBasis", () => {
  const rec = (parts: RecordPart[]) => ({ ...emptyRecord("SHOP-12", T0), parts });
  const p = (service: string, sha: string, state: RecordPart["state"] = "merged"): RecordPart => ({ service, source: "gitlab-mr", state, mergeSha: sha, keys: [], firstSeenAt: "", lastSeenAt: "" });
  it("is ten hex characters, the same whatever the order, and changes with a merged head or an AC", () => {
    const a = storyBasis(rec([p("orders", "aaa"), p("web", "bbb")]), ["h1", "h2"]);
    expect(a).toMatch(/^[0-9a-f]{10}$/);
    expect(storyBasis(rec([p("web", "bbb"), p("orders", "aaa")]), ["h2", "h1"])).toBe(a);
    expect(storyBasis(rec([p("orders", "aaa"), p("web", "ccc")]), ["h1", "h2"])).not.toBe(a);
    expect(storyBasis(rec([p("orders", "aaa"), p("web", "bbb")]), ["h1", "h3"])).not.toBe(a);
  });
  it("ignores open, closed and reverted parts", () => {
    const base = storyBasis(rec([p("orders", "aaa")]), ["h1"]);
    expect(storyBasis(rec([p("orders", "aaa"), p("web", "x", "opened"), p("web", "y", "closed"), p("web", "z", "reverted")]), ["h1"])).toBe(base);
  });
});

describe("trimming", () => {
  it("fitForJira keeps a record with 100 parts under 28 KB and keeps the open ones", () => {
    const parts: RecordPart[] = Array.from({ length: 100 }, (_, i) => ({
      service: `service-${i % 5}`,
      source: "gitlab-mr",
      iid: i + 1,
      url: `https://gitlab.example.com/shop/service-${i % 5}/-/merge_requests/${i + 1}`,
      state: i < 3 ? "opened" : "merged",
      branch: `feature/SHOP-12-some-long-branch-name-${i}`,
      title: `SHOP-12 a fairly long merge request title number ${i} with some words`,
      headSha: "a".repeat(40),
      mergeSha: "b".repeat(40),
      squashSha: "c".repeat(40),
      diffBase: "d".repeat(40),
      mergedAt: `2026-09-${String((i % 28) + 1).padStart(2, "0")}T00:00:00Z`,
      keys: ["SHOP-12", "SHOP-19"],
      firstSeenAt: "2026-09-01T00:00:00.000Z",
      lastSeenAt: "2026-09-01T00:00:00.000Z",
    }));
    const rec = { ...emptyRecord("SHOP-12", T0), parts };
    const fit = fitForJira(trimRecord(rec, T0));
    expect(Buffer.byteLength(JSON.stringify(fit))).toBeLessThan(28_000);
    expect(fit.parts.filter((x) => x.state === "opened")).toHaveLength(3);
    expect(fit.parts.length).toBeLessThan(100);
  });
  it("keeps the newest 5 results per environment and the newest 200 recent notifications (older than 180 days may be sent again)", () => {
    const results = Array.from({ length: 8 }, (_, i) => ({ environment: i % 2 ? "sit" : "uat", at: `2026-10-0${i + 1}T00:00:00Z`, basis: "b", status: "passed", tests: 1 }));
    const recent = T0.toISOString();
    const notified = [...Array.from({ length: 5 }, (_, i) => ({ event: "e", key: `old${i}`, at: "2025-01-01T00:00:00Z" })), ...Array.from({ length: 210 }, (_, i) => ({ event: "e", key: `k${i}`, at: recent }))];
    const t = trimRecord({ ...emptyRecord("SHOP-12", T0), results, notified }, T0);
    expect(t.results.filter((r) => r.environment === "sit")).toHaveLength(4);
    expect(t.notified).toHaveLength(200);
    expect(t.notified[0].key).toBe("k10");
    expect(t.notified.some((n) => n.key.startsWith("old"))).toBe(false);
    const many = trimRecord({ ...emptyRecord("SHOP-12", T0), results: Array.from({ length: 9 }, (_, i) => ({ environment: "sit", at: `2026-10-0${i + 1}T00:00:00Z`, basis: "b", status: "passed", tests: 1 })) }, T0);
    expect(many.results).toHaveLength(5);
    expect(many.results[0].at).toBe("2026-10-09T00:00:00Z");
  });
});
