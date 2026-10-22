import fs from "node:fs";
import os from "node:os";
import { describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { acWriteReadiness } from "../src/feature/readiness.js";
import type { ServicePart } from "../src/feature/manifest.js";
import { acHash, type ExpectedFile } from "../src/expected/format.js";
import { crossServiceJobKey, generateJobKey } from "../src/stories/jobs.js";
import { headsDigest, storyScope } from "../src/generation/storyScope.js";
import { emptyRecord } from "../src/stories/record.js";
import { assessStory, type StoryFacts } from "../src/stories/assess.js";
import { validatePlan } from "../src/plan/validate.js";

const part = (service: string, merged: boolean, extra: Partial<ServicePart> = {}): ServicePart => ({ service, source: "git", sha: `${service}1234567`, merged, keys: ["SHOP-1"], ...extra });
const exp = (acs: Record<string, string[]>): ExpectedFile => ({ version: 1, story: "SHOP-1", acs: Object.entries(acs).map(([id, services]) => ({ id, hash: acHash(id), text: id, services, behaviours: [] })) });
const base = { mode: "when-ready-status" as const };
const row = (rows: ReturnType<typeof acWriteReadiness>, ac: string) => rows.find((r) => r.ac === ac)!;

describe("acWriteReadiness", () => {
  const e = exp({ "AC-1": ["orders", "storefront"], "AC-2": ["orders"] });
  it("one needed service is single, several are cross", () => {
    const r = acWriteReadiness([part("orders", true), part("storefront", false, { branch: "f" })], e, ["AC-1", "AC-2"], { ...base, jiraReady: true });
    expect(row(r, "AC-1")).toMatchObject({ kind: "cross", services: ["orders", "storefront"], state: "waiting-merge" });
    expect(row(r, "AC-2")).toMatchObject({ kind: "single", state: "ready" });
  });
  it("waiting-service: a needed service has no change in the story yet", () => {
    const r = acWriteReadiness([part("orders", true)], e, ["AC-1"], { ...base, jiraReady: true });
    expect(row(r, "AC-1")).toMatchObject({ state: "waiting-service" });
    expect(row(r, "AC-1").reason).toMatch(/no change found yet in storefront/);
  });
  it("waiting-status applies to cross ACs by default and not with when-ac-complete; an unknown status counts as ready", () => {
    const parts = [part("orders", true), part("storefront", true)];
    expect(row(acWriteReadiness(parts, e, ["AC-1"], { ...base, jiraReady: false }), "AC-1").state).toBe("waiting-status");
    expect(row(acWriteReadiness(parts, e, ["AC-1"], { mode: "when-ac-complete", jiraReady: false }), "AC-1").state).toBe("ready");
    expect(row(acWriteReadiness(parts, e, ["AC-1"], { ...base, jiraReady: undefined }), "AC-1")).toMatchObject({ state: "ready" });
    // A single-service AC is not held back by the status.
    expect(row(acWriteReadiness(parts, e, ["AC-2"], { ...base, jiraReady: false }), "AC-2").state).toBe("ready");
  });
  it("an override makes a cross AC ready without the status or a missing service, but an open merge request beats it", () => {
    const o = { overrides: [{ ac: "AC-1" }] };
    expect(row(acWriteReadiness([part("orders", true), part("storefront", true)], e, ["AC-1"], { ...base, jiraReady: false, ...o }), "AC-1").state).toBe("ready");
    expect(row(acWriteReadiness([part("orders", true)], e, ["AC-1"], { ...base, jiraReady: true, ...o }), "AC-1")).toMatchObject({ state: "ready" });
    const open = row(acWriteReadiness([part("orders", true), part("storefront", false, { branch: "f" })], e, ["AC-1"], { ...base, jiraReady: true, ...o }), "AC-1");
    expect(open.state).toBe("waiting-merge");
    expect(open.reason).toMatch(/never skipped/);
    expect(row(acWriteReadiness([], e, ["AC-1"], { ...base, ...o }), "AC-1").state).toBe("held-override-none");
  });
  it("a reverted part makes the AC reverted; a closed (dropped) one counts for nothing", () => {
    expect(row(acWriteReadiness([part("orders", true, { reverted: "abcdef123" }), part("storefront", true)], e, ["AC-1"], { ...base, jiraReady: true }), "AC-1").state).toBe("reverted");
    expect(row(acWriteReadiness([part("orders", true), part("storefront", false, { dropped: true })], e, ["AC-2"], { ...base }), "AC-2").state).toBe("ready");
  });
  it("without a named service the AC needs the Jira component services plus every service with a change", () => {
    const rows = acWriteReadiness([part("orders", true)], undefined, ["AC-1"], { ...base, components: ["orders", "storefront"], jiraReady: true });
    expect(rows[0]).toMatchObject({ kind: "cross", services: ["orders", "storefront"], state: "waiting-service" });
    expect(acWriteReadiness([part("orders", true)], undefined, ["AC-1"], { ...base })[0]).toMatchObject({ kind: "single", state: "ready" });
  });
});

describe("storyScope", () => {
  const c = ConfigSchema.parse({ version: 1, mode: "existing", project: { name: "t" }, tests: { api: { framework: "mocha", runCommand: "x" } }, ci: { platform: "gitlab" }, generation: { maxAcsPerRun: 2 } });
  const acs = ["AC-1", "AC-2", "AC-3"].map((id) => ({ id, text: id }));
  const e = exp({ "AC-1": ["orders", "storefront"], "AC-2": ["orders"], "AC-3": ["orders"] });
  const parts = [part("orders", true), part("storefront", true)];
  it("a merge writes its own single ACs and the ready cross ACs, at most maxAcsPerRun, and holds the rest with a reason", () => {
    const s = storyScope({ c, acs, expected: e, parts, service: "orders", jiraReady: true }, acHash);
    expect(s.acScope).toEqual(["AC-1", "AC-2"]);
    expect(s.crossInScope).toEqual(["AC-1"]);
    expect(s.heldAcs.get("AC-3")).toMatch(/next run/);
    const sf = storyScope({ c, acs, expected: e, parts, service: "storefront", jiraReady: true }, acHash);
    expect(sf.acScope).toEqual(["AC-1"]);
    expect(sf.heldAcs.get("AC-2")).toMatch(/orders's own merge/);
  });
  it("a cross AC already written for the same commits and AC text is not written again; new commits or a changed AC bring it back", () => {
    const rec = emptyRecord("SHOP-1");
    const run = (ps: ServicePart[], list = acs) => storyScope({ c, acs: list, expected: e, parts: ps, jiraReady: true, rec }, acHash).acScope;
    expect(run(parts)).toContain("AC-1");
    rec.crossService["AC-1"] = { state: "written", heads: headsDigest(parts, ["orders", "storefront"]), acHash: acHash("AC-1"), at: "t" };
    expect(run(parts)).not.toContain("AC-1");
    expect(run([part("orders", true, { sha: "newer0000" }), part("storefront", true)])).toContain("AC-1");
    expect(run(parts, [{ id: "AC-1", text: "AC-1 changed words" }, ...acs.slice(1)])).toContain("AC-1");
  });
  it("--acs names ACs: a waiting one is refused unless forced", () => {
    const waiting = [part("orders", true), part("storefront", false, { branch: "f" })];
    const s = storyScope({ c, acs, expected: e, parts: waiting, only: ["AC-1"], jiraReady: true }, acHash);
    expect(s.refused).toEqual(["AC-1"]);
    expect(s.acScope).toEqual([]);
    const f = storyScope({ c, acs, expected: e, parts: waiting, only: ["AC-1"], jiraReady: true, force: true }, acHash);
    expect(f.refused).toEqual([]);
    expect(f.acScope).toEqual(["AC-1"]);
  });
});

describe("storyScope: already written, unknown ids, and heads", () => {
  const c = ConfigSchema.parse({ version: 1, mode: "existing", project: { name: "t" }, tests: { api: { framework: "mocha", runCommand: "x" } }, ci: { platform: "gitlab" } });
  const acs = ["AC-1", "AC-2"].map((id) => ({ id, text: id }));
  const e = exp({ "AC-1": ["orders", "storefront"], "AC-2": ["orders"] });
  const parts = [part("orders", true), part("storefront", true)];
  it("a single-service AC written for these commits is not planned again, also when --acs names it; --force plans it", () => {
    const rec = emptyRecord("SHOP-1");
    rec.singleService["AC-2"] = { state: "written", heads: headsDigest(parts, ["orders"]), acHash: acHash("AC-2"), at: "t" };
    const run = (o: object) => storyScope({ c, acs, expected: e, parts, rec, jiraReady: true, ...o }, acHash);
    expect(run({}).acScope).toEqual(["AC-1"]);
    const named = run({ only: ["AC-2"] });
    expect(named.acScope).toEqual([]);
    expect(named.alreadyWritten).toEqual(["AC-2"]);
    expect(run({ only: ["AC-2"], force: true }).acScope).toEqual(["AC-2"]);
    // A new merge of its service brings it back.
    expect(run({ parts: [part("orders", true, { sha: "newer00000" }), part("storefront", true)] }).acScope).toContain("AC-2");
  });
  it("names the ids --acs asks for that the story does not have", () => {
    expect(storyScope({ c, acs, expected: e, parts, only: ["AC-1", "AC-9"], jiraReady: true }, acHash).unknown).toEqual(["AC-9"]);
  });
  it("allHeads covers the single-service ACs too; heads only the cross ones", () => {
    const s = storyScope({ c, acs, expected: e, parts, jiraReady: true }, acHash);
    expect(s.crossInScope).toEqual(["AC-1"]);
    expect(s.heads).toEqual(["orders:orders1234567", "storefront:storefront1234567"]);
    const only2 = storyScope({ c, acs, expected: e, parts, only: ["AC-2"], jiraReady: true }, acHash);
    expect(only2.heads).toEqual([]);
    expect(only2.allHeads).toEqual(["orders:orders1234567"]);
  });
});

describe("an abandoned open merge request", () => {
  const e = exp({ "AC-1": [], "AC-2": [] });
  const now = new Date("2026-06-01T00:00:00Z");
  const stale = part("billing", false, { mr: { iid: 5, url: "u", state: "opened", title: "wip", updatedAt: "2026-01-01T00:00:00Z" } });
  const fresh = part("billing", false, { mr: { iid: 5, url: "u", state: "opened", title: "wip", updatedAt: "2026-05-30T00:00:00Z" } });
  it("holds nothing back once nobody touched it for staleDays; a recently updated one still does", () => {
    const orders = part("orders", true);
    const rows = (p: ServicePart, staleDays: number) => acWriteReadiness([orders, p], e, ["AC-1"], { ...base, jiraReady: true, staleDays, now });
    expect(rows(stale, 30)[0]).toMatchObject({ kind: "single", services: ["orders"], state: "ready" });
    expect(rows(stale, 30)[0].reason).toMatch(/not waited for.*billing !5/);
    expect(rows(fresh, 30)[0]).toMatchObject({ kind: "cross", state: "waiting-merge" });
    expect(rows(stale, 0)[0]).toMatchObject({ state: "waiting-merge" }); // 0: never ignored
  });
});

describe("config", () => {
  it("rejects a branch prefix that git would read as an option or that climbs out", () => {
    const parse = (branchPrefix: string) => ConfigSchema.safeParse({ version: 1, mode: "existing", project: { name: "t" }, tests: { api: { framework: "mocha", runCommand: "x" } }, ci: { platform: "gitlab" }, generation: { branchPrefix } }).success;
    expect(parse("-bad/")).toBe(false);
    expect(parse("a/../b")).toBe(false);
    expect(parse("/abs/")).toBe(false);
    expect(parse("qa-sentinel/story-")).toBe(true);
  });
});

describe("job keys", () => {
  it("the cross-service key depends on the ACs, the commits and the AC texts, not on who asked", () => {
    const k = crossServiceJobKey("SHOP-1", ["AC-2", "AC-1"], ["orders:b", "storefront:a"], ["h2", "h1"]);
    expect(crossServiceJobKey("SHOP-1", ["AC-1", "AC-2"], ["storefront:a", "orders:b"], ["h1", "h2"])).toBe(k);
    expect(crossServiceJobKey("SHOP-1", ["AC-1", "AC-2"], ["storefront:a", "orders:NEW"], ["h1", "h2"])).not.toBe(k);
    expect(crossServiceJobKey("SHOP-1", ["AC-1"], ["orders:b", "storefront:a"], ["h2", "h1"])).not.toBe(k);
    // It ends like the single-service key (the digest of all AC texts), so the background check finds failed attempts for either.
    expect(k.split(":").at(-1)).toBe(generateJobKey("SHOP-1", "orders", "abcdef1234", ["h1", "h2"]).split(":").at(-1));
  });
});

describe("held ACs in plan validation", () => {
  const repo = fs.mkdtempSync(`${os.tmpdir()}/qas-held-`);
  const ev = [{ source: "source-code", file: "src/server.js", line: 1, reference: "x" }];
  const plan = (reqIds: string[], extra: Record<string, unknown> = {}) => ({
    schemaVersion: 1,
    verdict: "v",
    recommendedAction: "a",
    changes: [{ id: "c1", type: "business-rule", summary: "cap", observable: true, requirementIds: reqIds, oracleStatus: "approved", riskFactors: ["business-rule"], evidence: ev }],
    decisions: [{ changeId: "c1", coverage: "missing", decision: "create", reason: "r", existingTests: [], proposedScenarios: [{ title: "t", requirementIds: reqIds, behaviourIds: [], assertions: ["a"] }], evidence: ev, ...extra }],
    requirementStatus: reqIds.map((id) => ({ id, status: "implemented", evidence: ev })),
  });
  const ctx = { acIds: ["AC-1", "AC-2"], requirementsMissing: false, testRepo: repo, serviceRepo: repo, requireAcCoverage: true, storyMode: true, acScope: ["AC-2"], heldAcs: new Map([["AC-1", "storefront"]]) };
  it("a held AC needs no scenario and no status, and only warns", () => {
    const v = validatePlan(plan(["AC-2"]), ctx);
    expect(v.errors).toEqual([]);
    expect(v.warnings.join()).toMatch(/AC-1 waits for storefront/);
  });
  it("a scenario that cites a held AC is an error", () => {
    const v = validatePlan(plan(["AC-1", "AC-2"]), ctx);
    expect(v.errors.join()).toMatch(/AC-1 waits for storefront; leave it out until it is ready/);
  });
  it("without a scope every AC is required, as before", () => {
    const v = validatePlan(plan(["AC-2"]), { ...ctx, acScope: undefined, heldAcs: undefined });
    expect(v.errors.join()).toMatch(/AC-1 has no scenario/);
  });
  it("a create of a file an open agent merge request adds is an error", () => {
    const v = validatePlan(plan(["AC-2"], { targetFile: "./tests/api/orders.spec.ts" }), { ...ctx, addedByOpenMrs: new Map([["tests/api/orders.spec.ts", "!12"]]) });
    expect(v.errors.join()).toMatch(/already added by !12/);
    expect(validatePlan(plan(["AC-2"], { targetFile: "tests/api/other.spec.ts" }), { ...ctx, addedByOpenMrs: new Map([["tests/api/orders.spec.ts", "!12"]]) }).errors).toEqual([]);
  });
});

describe("the background check", () => {
  const facts = (o: Partial<StoryFacts> = {}): StoryFacts => ({
    key: "SHOP-1",
    source: "jira",
    approved: true,
    isFeature: true,
    labels: [],
    skipLabels: [],
    onlyLabels: [],
    acs: [{ id: "AC-1", text: "a" }],
    expected: { file: { version: 1, story: "SHOP-1", acs: [{ id: "AC-1", hash: acHash("a"), text: "a", services: [], behaviours: [{ id: "B1", kind: "main", statement: "s", expect: {}, state: "ready", source: "ac" }] }] } },
    expectationsMode: "write",
    trace: [{ ac: "AC-1", active: [{ id: "t" }], pending: [] } as any],
    code: "merged",
    limits: {},
    ...o,
  });
  it("needs-cross-service-tests: a covered story whose cross-service AC is ready and not written", () => {
    const a = assessStory(facts({ crossReady: ["AC-1"] }));
    expect(a.state).toBe("needs-cross-service-tests");
    expect(a.next).toBe("generate");
    expect(a.todo[0]).toMatchObject({ who: "ai", command: "qa-sentinel generate --story SHOP-1 --acs AC-1" });
    expect(assessStory(facts()).state).toBe("covered");
  });
  it("an AC with no test that cannot be written yet starts nothing; one already written on the story branch is not missing", () => {
    const noTest = { trace: [{ ac: "AC-1", active: [], pending: [] } as any] };
    const waiting = assessStory(facts({ ...noTest, writeReadiness: [{ ac: "AC-1", kind: "cross", state: "waiting-merge", reason: "not merged yet: storefront" }] }));
    expect(waiting.next).toBe("wait");
    expect(waiting.todo.some((t) => t.who === "ai")).toBe(false);
    expect(waiting.reasons.join()).toMatch(/AC-1: not merged yet: storefront/);
    expect(assessStory(facts({ ...noTest, writeReadiness: [{ ac: "AC-1", kind: "single", state: "ready", reason: "" }] })).next).toBe("generate");
    expect(assessStory(facts({ ...noTest, writtenOnBranch: ["AC-1"] })).state).toBe("covered");
  });
  it("expectations still come first, and a blocked job is reported as blocked", () => {
    const noFile = assessStory(facts({ expected: {}, crossReady: ["AC-1"] }));
    expect(noFile.state).toBe("needs-expectations");
    expect(assessStory(facts({ crossReady: ["AC-1"], limits: { generate: "budget" } })).todo[0].blocked).toBe("budget");
  });
});
