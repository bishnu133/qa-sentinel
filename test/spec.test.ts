import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import type { AgentEngine, AgentTask } from "../src/engines/AgentEngine.js";
import { acHash, type ExpectedFile } from "../src/expected/format.js";
import { proposalToFile, runSpecPass, type SpecAc, validateProposal } from "../src/expected/spec.js";
import type { RequirementSnapshot } from "../src/requirements.js";

const AC1 = "A slot takes at most 3 orders.";
const AC2 = "Orders are capped per customer.";
const STORY = `# SHOP-101 Delivery slots\n\n## Acceptance criteria\n- AC-1: ${AC1}\n- AC-2: ${AC2}`;
const acs: SpecAc[] = [
  { id: "AC-1", text: AC1, needsProposal: true },
  { id: "AC-2", text: AC2, needsProposal: true },
];

const good = () => ({
  acs: [
    {
      id: "AC-1",
      services: ["orders-service"],
      behaviours: [
        { kind: "main", statement: "A third order is accepted", expect: { maxOrdersPerSlot: 3, accepted: true }, basis: "A slot takes at most 3 orders", state: "ready" },
        { kind: "boundary", statement: "A fourth order is rejected", expect: { maxOrdersPerSlot: 3, accepted: false }, basis: "a slot takes at most 3 orders", state: "ready" },
      ],
    },
    { id: "AC-2", behaviours: [{ kind: "main", statement: "Orders past the cap are rejected", expect: {}, state: "unspecified", question: "What is the cap per customer?" }] },
  ],
});

describe("validateProposal (code-blind requirements pass)", () => {
  it("accepts values that appear in the quoted basis", () => {
    const v = validateProposal(good(), { acs, sources: STORY });
    expect(v.errors).toEqual([]);
    expect(v.proposal?.acs).toHaveLength(2);
  });

  it("rejects an invented number, a made-up basis and a missing AC", () => {
    const p = good();
    p.acs[0].behaviours[0].expect = { maxOrdersPerSlot: 3, status: 409 } as never;
    p.acs[0].behaviours[1].basis = "The API returns 409 when full";
    p.acs.pop();
    const v = validateProposal(p, { acs, sources: STORY });
    expect(v.proposal).toBeUndefined();
    const all = v.errors.join("\n");
    expect(all).toMatch(/value "409" isn't in its basis/);
    expect(all).toMatch(/basis "The API returns 409 when full" isn't in story.md/);
    expect(all).toMatch(/AC-2 is missing/);
  });

  it("matches numbers as whole numbers (3 is not found inside 30)", () => {
    const v = validateProposal(good(), { acs, sources: STORY.replace("at most 3", "at most 30") });
    expect(v.errors.join("\n")).toMatch(/isn't in story.md/);
  });

  it("needs a question for unspecified, and rejects unknown ACs and foreign ids", () => {
    const p = good() as ReturnType<typeof good> & { acs: unknown[] };
    (p.acs[1] as { behaviours: { question?: string }[] }).behaviours[0].question = undefined;
    p.acs.push({ id: "AC-9", behaviours: [] });
    (p.acs[0] as { behaviours: { id?: string }[] }).behaviours[0].id = "B7";
    const all = validateProposal(p, { acs, sources: STORY }).errors.join("\n");
    expect(all).toMatch(/unspecified needs a "question"/);
    expect(all).toMatch(/AC-9 isn't an AC of this story/);
    expect(all).toMatch(/B7 isn't one of AC-1's stored ids/);
  });

  it("accepts an untestable AC with a reason, and rejects an empty one", () => {
    const p = good();
    p.acs[1] = { id: "AC-2", untestable: "no observable outcome", behaviours: [] } as never;
    expect(validateProposal(p, { acs, sources: STORY }).errors).toEqual([]);
    p.acs[1] = { id: "AC-2", behaviours: [] } as never;
    expect(validateProposal(p, { acs, sources: STORY }).errors.join()).toMatch(/no behaviours and no "untestable"/);
  });
});

describe("validateProposal: what agents really write", () => {
  it("drops entries for ACs that weren't asked for (e.g. copied from current.json) instead of failing on them", () => {
    const only1: SpecAc[] = [{ ...acs[0] }, { ...acs[1], needsProposal: false }];
    const p = good() as { acs: unknown[] };
    p.acs[1] = { id: "AC-2", hash: "abc", text: AC2, services: [], behaviours: [{ id: "B3", kind: "main", statement: "x", expect: { cap: 9 }, state: "ready", source: "ac" }] };
    const v = validateProposal(p, { acs: only1, sources: STORY });
    expect(v.errors).toEqual([]);
    expect(v.proposal?.acs.map((a) => a.id)).toEqual(["AC-1"]);
  });

  it("rejects values in an unspecified behaviour (strings too)", () => {
    const p = good();
    p.acs[1].behaviours[0].expect = { message: "Slot is full" } as never;
    expect(validateProposal(p, { acs, sources: STORY }).errors.join()).toMatch(/an unspecified behaviour has no values yet/);
  });
});

describe("validateProposal: value matching", () => {
  const one = (b: Record<string, unknown>, story: string) =>
    validateProposal({ acs: [{ id: "AC-1", behaviours: [{ kind: "main", statement: "x", state: "ready", ...b }] }] }, { acs: [{ id: "AC-1", text: "t", needsProposal: true }], sources: story }).errors;
  it("matches numbers as numbers and texts as whole words", () => {
    expect(one({ expect: { max: 1000 }, basis: "up to 1,000 items per order" }, "Up to 1,000 items per order.")).toEqual([]);
    expect(one({ expect: { fee: 10.5 }, basis: "a fee of 10.50 is charged" }, "A fee of 10.50 is charged.")).toEqual([]);
    expect(one({ expect: { message: "Slot is full." }, basis: 'shows "Slot is full"' }, 'The page shows "Slot is full"')).toEqual([]);
    expect(one({ expect: { message: "a" }, basis: "Show a message to the user" }, "Show a message to the user").join()).toEqual("");
    expect(one({ expect: { code: "ORD" }, basis: "returns ORDER_LIMIT to the caller" }, "returns ORDER_LIMIT to the caller").join()).toMatch(/value "ORD" isn't in its basis/);
  });
  it("rejects a blank or one-word basis, and numbers in the statement that the basis doesn't give", () => {
    expect(one({ expect: { accepted: false }, basis: "   " }, "x").join()).toMatch(/basis" is missing or too short/);
    expect(one({ statement: "returns 409 when full", expect: { accepted: false }, basis: "a full slot takes no more orders" }, "A full slot takes no more orders.").join()).toMatch(/the statement says 409/);
  });
});

describe("proposalToFile", () => {
  it("keeps stored ids, numbers new behaviours after them, and drops numbers from unspecified", () => {
    const stored: ExpectedFile = {
      version: 1,
      story: "SHOP-101",
      acs: [{ id: "AC-1", hash: acHash("old text"), text: "old text", services: [], behaviours: [{ id: "B4", kind: "main", statement: "x", expect: {}, state: "ready", source: "ac" }] }],
    };
    const p = validateProposal(good(), { acs, sources: STORY }).proposal!;
    p.acs[1].behaviours[0].expect = { cap: 5, note: "ask", accepted: false };
    const f = proposalToFile("SHOP-101", "Delivery slots", acs, p, stored);
    expect(f.acs.flatMap((a) => a.behaviours.map((b) => b.id))).toEqual(["B5", "B6", "B7"]);
    expect(f.acs[0].hash).toBe(acHash(AC1));
    expect(f.acs[1].behaviours[0].expect).toEqual({ accepted: false });
    expect(f.acs[0].behaviours[0].basis).toBe("A slot takes at most 3 orders");
  });
});

describe("runSpecPass", () => {
  const c = ConfigSchema.parse({ version: 1, mode: "scratch", project: { name: "p" }, tests: { api: { framework: "playwright", runCommand: "x" } }, ci: { platform: "gitlab" } });
  const req: RequirementSnapshot = {
    storyKey: "SHOP-101",
    title: "Delivery slots",
    source: "file",
    acceptanceCriteria: [
      { id: "AC-1", text: AC1 },
      { id: "AC-2", text: AC2 },
    ],
    scopeItems: [],
    outOfScope: [],
    context: [],
    servicesNamed: [],
    approvalStatus: "unverified",
    rawText: STORY,
    capturedAt: "2026-10-20T00:00:00Z",
  } as RequirementSnapshot;

  /** An engine that writes the given proposals in turn and records what it was asked. */
  const fake = (...outputs: unknown[]) => {
    const tasks: AgentTask[] = [];
    const seen: string[][] = [];
    const engine: AgentEngine = {
      name: "fake",
      available: () => ({ ok: true }),
      run: async (t) => {
        tasks.push(t);
        seen.push(fs.readdirSync(t.cwd).sort());
        const o = outputs[tasks.length - 1];
        if (o !== undefined) fs.writeFileSync(path.join(t.cwd, "proposal.json"), JSON.stringify(o));
        return { ok: true, status: "ok", result: "done" };
      },
    };
    return { engine, tasks, seen };
  };
  const dirs = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "qas-spec-test-"));
    const runDir = path.join(root, "run");
    fs.mkdirSync(runDir);
    return { cwd: root, runDir };
  };

  it("runs code-blind in a fresh folder, denies the repos, and returns a merged file", async () => {
    const { cwd, runDir } = dirs();
    const f = fake(good());
    const r = await runSpecPass({ cwd, c, engine: f.engine, req, story: "SHOP-101", runDir, denyRead: [cwd] });
    expect(r.errors).toEqual([]);
    expect(r.file?.acs.map((a) => a.id)).toEqual(["AC-1", "AC-2"]);
    const t = f.tasks[0];
    expect(t.kind).toBe("spec");
    expect(path.resolve(t.cwd).startsWith(path.resolve(cwd))).toBe(false);
    expect(t.readDeny).toEqual([cwd]);
    expect(t.write?.allowed).toEqual(["proposal.json"]);
    expect(f.seen[0]).toEqual([".claude", "acs.json", "story.md"]);
    expect(fs.existsSync(t.cwd)).toBe(false);
    expect(fs.existsSync(path.join(runDir, "requirements-pass-proposal.json"))).toBe(true);
  });

  it("asks once more with the errors, then gives up", async () => {
    const { cwd, runDir } = dirs();
    const bad = { acs: [{ id: "AC-1", behaviours: [] }] };
    const f = fake(bad, bad);
    const r = await runSpecPass({ cwd, c, engine: f.engine, req, story: "SHOP-101", runDir, denyRead: [cwd] });
    expect(f.tasks).toHaveLength(2);
    expect(f.tasks[1].prompt).toMatch(/previous proposal was rejected/);
    expect(r.file).toBeUndefined();
    expect(r.errors.join()).toMatch(/AC-2 is missing/);
  });

  it("makes no AI run when every AC already has a current, filled expectation", async () => {
    const { cwd, runDir } = dirs();
    const first = await runSpecPass({ cwd, c, engine: fake(good()).engine, req, story: "SHOP-101", runDir, denyRead: [] });
    const f = fake();
    const again = await runSpecPass({ cwd, c, engine: f.engine, req, story: "SHOP-101", stored: first.file, runDir, denyRead: [] });
    expect(again.skipped).toBe(true);
    expect(f.tasks).toHaveLength(0);
    expect(again.file).toEqual(first.file);
  });

  it("asks only for the AC whose text changed and keeps the other one as reviewed", async () => {
    const { cwd, runDir } = dirs();
    const first = (await runSpecPass({ cwd, c, engine: fake(good()).engine, req, story: "SHOP-101", runDir, denyRead: [] })).file!;
    const AC2b = "A customer may have at most 2 open orders.";
    const req2 = { ...req, acceptanceCriteria: [req.acceptanceCriteria[0], { id: "AC-2", text: AC2b }], rawText: STORY.replace(AC2, AC2b) };
    const f = fake({ acs: [{ id: "AC-2", behaviours: [{ kind: "main", statement: "A third open order is rejected", expect: { maxOpenOrders: 2 }, basis: "at most 2 open orders", state: "ready" }] }] });
    const r = await runSpecPass({ cwd, c, engine: f.engine, req: req2, story: "SHOP-101", stored: first, runDir, denyRead: [] });
    expect(r.errors).toEqual([]);
    const asked = JSON.parse(fs.readFileSync(path.join(runDir, "requirements-pass-acs.json"), "utf8"));
    expect(asked.filter((a: { needsProposal: boolean }) => a.needsProposal).map((a: { id: string }) => a.id)).toEqual(["AC-2"]);
    expect(f.seen[0]).toContain("current.json");
    expect(r.file?.acs[0]).toEqual(first.acs[0]);
    expect(r.file?.acs[1].behaviours.at(-1)?.expect).toEqual({ maxOpenOrders: 2 });
    // qa-sentinel commits this before the author runs: the lock must accept it (AC-2 changed in the story).
    const { checkExpectationLock } = await import("../src/expected/lock.js");
    const { renderExpected } = await import("../src/expected/format.js");
    const findings = checkExpectationLock({ expectedDir: "expected", changes: [{ path: "expected/SHOP-101.md", status: "M" }] as never, before: () => renderExpected(first), after: () => renderExpected(r.file!), currentAcs: new Map([["SHOP-101", req2.acceptanceCriteria]]) });
    expect(findings.filter((x) => x.level === "violation")).toEqual([]);
  });

  it("never retires an AC that is missing from the story, and the lock accepts the result", async () => {
    const { cwd, runDir } = dirs();
    const first = (await runSpecPass({ cwd, c, engine: fake(good()).engine, req, story: "SHOP-101", runDir, denyRead: [] })).file!;
    const req1 = { ...req, acceptanceCriteria: [req.acceptanceCriteria[0]], rawText: STORY.replace(`- AC-2: ${AC2}`, "") };
    const f = fake();
    const r = await runSpecPass({ cwd, c, engine: f.engine, req: req1, story: "SHOP-101", stored: first, runDir, denyRead: [] });
    expect(f.tasks).toHaveLength(0);
    expect(r.file).toEqual(first);
    expect(r.changes.join()).toMatch(/AC-2 isn't in the story's current list/);
    const { checkExpectationLock } = await import("../src/expected/lock.js");
    const { renderExpected } = await import("../src/expected/format.js");
    const rel = "expected/SHOP-101.md";
    const findings = checkExpectationLock({ expectedDir: "expected", changes: [{ path: rel, status: "M" }] as never, before: () => renderExpected(first), after: () => renderExpected(r.file!), currentAcs: new Map([["SHOP-101", req1.acceptanceCriteria]]) } as never);
    expect(findings.filter((x) => x.level === "violation")).toEqual([]);
  });
});

describe("featureIssueTypes", () => {
  it("only listed issue types get expected behaviour; empty list or no type = feature", async () => {
    const { isFeature } = await import("../src/requirements.js");
    const mk = (types: string[]) => ConfigSchema.parse({ version: 1, mode: "scratch", project: { name: "p" }, tests: { api: { framework: "playwright", runCommand: "x" } }, ci: { platform: "gitlab" }, requirements: { jira: { featureIssueTypes: types } } });
    expect(isFeature(mk([]), { issueType: "Bug" })).toBe(true);
    expect(isFeature(mk(["Story", "Enhancement"]), { issueType: "story" })).toBe(true);
    expect(isFeature(mk(["Story"]), { issueType: "Bug" })).toBe(false);
    expect(isFeature(mk(["Story"]), {})).toBe(true);
  });
});

describe("code-blind permissions", () => {
  it("denies reading the test and service repos (Read rules also cover Grep and Glob)", async () => {
    const { claudePermissions } = await import("../src/guardrails.js");
    const p = claudePermissions({ write: { allowed: ["proposal.json"], blocked: [] }, bash: [], readOnlyDirs: [], readDeny: ["/work/qa-tests", "/work/orders-service"] });
    const deny = JSON.stringify(p);
    expect(deny).toContain("Read(//work/qa-tests/**)");
    expect(deny).toContain("Read(//work/orders-service/**)");
  });
});

describe("runSpecPass: renumbered ACs", () => {
  it("deleting AC-2 and renumbering AC-3 gives a valid file (no AC listed twice)", async () => {
    const c = ConfigSchema.parse({ version: 1, mode: "scratch", project: { name: "p" }, tests: { api: { framework: "playwright", runCommand: "x" } }, ci: { platform: "gitlab" } });
    const T = ["A slot takes at most 3 orders.", "Orders are capped per customer.", "Each order has at most 10 items."];
    const story = (ts: string[]) => `# SHOP-101\n\n## Acceptance criteria\n${ts.map((t, k) => `- AC-${k + 1}: ${t}`).join("\n")}`;
    const mk = (ts: string[]) => ({ storyKey: "SHOP-101", source: "file", acceptanceCriteria: ts.map((t, k) => ({ id: `AC-${k + 1}`, text: t })), scopeItems: [], outOfScope: [], context: [], servicesNamed: [], approvalStatus: "unverified", rawText: story(ts), capturedAt: "x" }) as unknown as RequirementSnapshot;
    const b = (n: number, basis: string) => ({ kind: "main", statement: "s", expect: { max: n }, basis, state: "ready" });
    const engine = (out: unknown): AgentEngine => ({ name: "f", available: () => ({ ok: true }), run: async (t) => (fs.writeFileSync(path.join(t.cwd, "proposal.json"), JSON.stringify(out)), { ok: true, status: "ok", result: "done" }) });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "qas-renum-"));
    const first = await runSpecPass({ cwd: root, c, engine: engine({ acs: [{ id: "AC-1", behaviours: [b(3, "at most 3 orders")] }, { id: "AC-2", untestable: "no number", behaviours: [] }, { id: "AC-3", behaviours: [b(10, "at most 10 items")] }] }), req: mk(T), story: "SHOP-101", runDir: root, denyRead: [] });
    expect(first.errors).toEqual([]);
    const r = await runSpecPass({ cwd: root, c, engine: engine({ acs: [{ id: "AC-2", behaviours: [b(10, "at most 10 items")] }] }), req: mk([T[0], T[2]]), story: "SHOP-101", stored: first.file, runDir: root, denyRead: [] });
    expect(r.errors).toEqual([]);
    expect(r.file!.acs.filter((a) => !a.removed).map((a) => [a.id, a.text])).toEqual([["AC-1", T[0]], ["AC-2", T[2]]]);
  });
});
