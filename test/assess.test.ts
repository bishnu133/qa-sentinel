import { describe, expect, it } from "vitest";
import { assessStory, storiesMarkdown, type StoryFacts } from "../src/stories/assess.js";
import { acHash, type ExpectedFile } from "../src/expected/format.js";
import type { AcTrace, IndexedTest } from "../src/analysis/testIndex.js";

const AC1 = "A slot takes at most 3 orders.";
const AC2 = "Orders in the past are rejected.";
const acs = [
  { id: "AC-1", text: AC1 },
  { id: "AC-2", text: AC2 },
];

const test = (o: Partial<IndexedTest>): IndexedTest => ({ id: "t:1", file: "tests/a.spec.ts", line: 1, endLine: 5, title: "t", status: "active", services: [], endpoints: [], pages: [], stories: ["SHOP-101"], acs: [], tags: [], assertions: 1, statusOnly: false, ...o });
const row = (ac: string, active: IndexedTest[] = [], pending: IndexedTest[] = [], status?: AcTrace["status"]): AcTrace => ({ ac, active, pending, status: status ?? (active.length && pending.length ? "discrepancy" : active.length ? "covered" : pending.length ? "pending-only" : "not-traced") });

const expectedFile = (over: Partial<ExpectedFile["acs"][number]>[] = [{}, {}]): ExpectedFile => ({
  version: 1,
  story: "SHOP-101",
  acs: [
    { id: "AC-1", hash: acHash(AC1), text: AC1, services: [], behaviours: [{ id: "B1", kind: "main", statement: "third accepted", expect: { n: 3 }, state: "ready", source: "ac" }], ...over[0] },
    { id: "AC-2", hash: acHash(AC2), text: AC2, services: [], behaviours: [{ id: "B2", kind: "main", statement: "past rejected", expect: { status: 400 }, state: "ready", source: "ac" }], ...over[1] },
  ],
});

const facts = (o: Partial<StoryFacts> = {}): StoryFacts => ({
  key: "SHOP-101",
  title: "Delivery slots",
  source: "jira",
  status: "In Progress",
  approved: true,
  issueType: "Story",
  isFeature: true,
  labels: [],
  skipLabels: ["qa-skip"],
  onlyLabels: [],
  acs,
  expected: { file: expectedFile() },
  expectationsMode: "write",
  trace: [row("AC-1", [test({ acs: ["AC-1"] })]), row("AC-2", [test({ acs: ["AC-2"] })])],
  code: "merged",
  limits: {},
  ...o,
});

describe("assessStory", () => {
  it("leaves stories alone that are opted out, not a feature, or not approved", () => {
    expect(assessStory(facts({ labels: ["QA-Skip"] }))).toMatchObject({ state: "skipped", next: "none", headline: expect.stringContaining("opted out") });
    expect(assessStory(facts({ onlyLabels: ["qa-auto"], labels: [] }))).toMatchObject({ state: "skipped", headline: expect.stringContaining("not opted in") });
    expect(assessStory(facts({ onlyLabels: ["qa-auto"], labels: ["QA-AUTO"] })).state).toBe("covered");
    expect(assessStory(facts({ isFeature: false, issueType: "Bug" }))).toMatchObject({ state: "skipped", headline: expect.stringContaining("Bug is not a feature type") });
    expect(assessStory(facts({ approved: false, status: "Backlog" }))).toMatchObject({ state: "skipped", next: "wait", headline: expect.stringContaining('"Backlog"') });
  });
  it("needs a person when there are no readable ACs or the expected file is broken", () => {
    expect(assessStory(facts({ acs: [] }))).toMatchObject({ state: "needs-attention", next: "fix", todo: [{ who: "po" }] });
    const a = assessStory(facts({ expected: { error: "line 4: bad yaml" } }));
    expect(a).toMatchObject({ state: "needs-attention", next: "fix" });
    expect(a.todo[0].what).toMatch(/bad yaml/);
  });
  it("asks for expected behaviour when there is no file, or an AC is new, changed or empty", () => {
    const none = assessStory(facts({ expected: {} }));
    expect(none).toMatchObject({ state: "needs-expectations", next: "spec" });
    expect(none.todo[0]).toMatchObject({ who: "ai", command: "qa-sentinel spec --story SHOP-101" });
    const changed = assessStory(facts({ acs: [{ id: "AC-1", text: "A slot takes at most 5 orders." }, acs[1]] }));
    expect(changed).toMatchObject({ state: "needs-expectations", headline: "expected behaviour needed for 1 of 2 AC(s)" });
    expect(changed.reasons[0]).toMatch(/AC-1 \(changed\)/);
    const empty = assessStory(facts({ expected: { file: expectedFile([{ behaviours: [] }, {}]) } }));
    expect(empty.reasons[0]).toMatch(/AC-1 \(empty\)/);
    const added = assessStory(facts({ acs: [...acs, { id: "AC-3", text: "New rule." }] }));
    expect(added.reasons[0]).toMatch(/AC-3 \(new\)/);
  });
  it("does not ask for expected behaviour when tests.expectations is off", () => {
    expect(assessStory(facts({ expected: {}, expectationsMode: "off" })).state).toBe("covered");
  });
  it("shows an AI step that is stopped by a limit, with the reason", () => {
    const a = assessStory(facts({ expected: {}, limits: { spec: "AI budget: today (UTC) $100.00 of $100 is used" } }));
    expect(a.todo[0].blocked).toMatch(/AI budget/);
    expect(storiesMarkdown([a])).toMatch(/not started:\*\* AI budget/);
  });
  it("asks for tests when an AC has none and the code is merged or can't be checked", () => {
    const t = [row("AC-1", [test({ acs: ["AC-1"] })]), row("AC-2")];
    const a = assessStory(facts({ trace: t }));
    expect(a).toMatchObject({ state: "needs-tests", next: "generate" });
    expect(a.todo[0]).toMatchObject({ who: "ai", command: "qa-sentinel generate --story SHOP-101" });
    const unknown = assessStory(facts({ trace: t, code: "unknown" }));
    expect(unknown.next).toBe("generate");
    expect(unknown.reasons.join()).toMatch(/could not check/);
  });
  it("waits for the code instead of asking for tests when nothing is merged", () => {
    const t = [row("AC-1"), row("AC-2")];
    const unmerged = assessStory(facts({ trace: t, code: "unmerged" }));
    expect(unmerged).toMatchObject({ state: "needs-tests", next: "wait" });
    expect(unmerged.todo[0]).toMatchObject({ who: "dev" });
    expect(assessStory(facts({ trace: t, code: "none" })).headline).toMatch(/waiting for merged code/);
  });
  it("counts a known defect, an untestable AC and a ticked manual card as covered", () => {
    const defect = test({ status: "known-defect", acs: ["AC-1"], bug: "https://j/SHOP-140" });
    const a = assessStory(facts({ expected: { file: expectedFile([{}, { untestable: "needs a real courier" }]) }, trace: [row("AC-1", [], [defect]), row("AC-2")] }));
    expect(a).toMatchObject({ state: "covered", next: "none" });
    expect(a.acs.map((x) => x.tests)).toEqual(["known-defect", "untestable"]);
    expect(a.counts).toMatchObject({ covered: 2, knownDefects: 1 });
    expect(a.headline).toMatch(/1 known defect/);
    const manual = assessStory(facts({ trace: [row("AC-1", [test({})]), row("AC-2", [], [], "manual")] }));
    expect(manual.state).toBe("covered");
  });
  it("asks QA to add the bug link a known defect lacks", () => {
    const defect = test({ status: "known-defect", acs: ["AC-1"] });
    const a = assessStory(facts({ trace: [row("AC-1", [], [defect]), row("AC-2", [test({})])] }));
    expect(a.todo.map((t) => t.what).join()).toMatch(/add a \/\/ QA-BUG/);
  });
  it("sends fixme/skip tests to QA triage once every AC has something", () => {
    const fixme = test({ status: "fixme", acs: ["AC-1"], id: "t:9", line: 9 });
    const a = assessStory(facts({ trace: [row("AC-1", [test({})], [fixme]), row("AC-2", [test({})])] }));
    expect(a).toMatchObject({ state: "needs-triage", next: "triage" });
    expect(a.counts.awaitingTriage).toBe(1);
    expect(a.acs[0].tests).toBe("covered");
  });
  it("an AC whose only test is a fixme still needs QA, not new tests", () => {
    const fixme = test({ status: "fixme", acs: ["AC-2"] });
    const a = assessStory(facts({ trace: [row("AC-1", [test({})]), row("AC-2", [], [fixme])] }));
    expect(a.state).toBe("needs-triage");
    expect(a.acs[1].tests).toBe("triage");
  });
  it("lists questions for the PO and needs-review behaviours without blocking", () => {
    const f = expectedFile();
    f.acs[0].behaviours.push({ id: "B3", kind: "edge", statement: "cap per customer", expect: {}, state: "unspecified", question: "What is the cap per customer?", source: "ac" });
    f.acs[1].behaviours[0].state = "needs-review";
    const a = assessStory(facts({ expected: { file: f } }));
    expect(a.state).toBe("covered");
    expect(a.counts.questions).toBe(1);
    expect(a.todo.map((t) => t.who).sort()).toEqual(["po", "qa"]);
    expect(a.todo.find((t) => t.who === "po")!.what).toMatch(/AC-1\/B3 What is the cap/);
    expect(a.headline).toMatch(/2 task/);
  });
  it("reports an AC that left the story", () => {
    const f = expectedFile();
    const a = assessStory(facts({ acs: [acs[0]], expected: { file: f }, trace: [row("AC-1", [test({})])] }));
    expect(a.todo.map((t) => t.what).join()).toMatch(/AC-2 is no longer in the story/);
  });
  it("does not ask for tests again when the last generation settled these ACs", () => {
    const a = assessStory(facts({ trace: [row("AC-1", [test({})]), row("AC-2")], generateSettled: true }));
    expect(a.state).toBe("covered");
  });
  it("is deterministic: the same facts give the same answer", () => {
    expect(assessStory(facts({ expected: {} }))).toEqual(assessStory(facts({ expected: {} })));
  });
});

describe("storiesMarkdown", () => {
  it("has a row per story and lists tasks", () => {
    const md = storiesMarkdown([assessStory(facts({ url: "https://j/browse/SHOP-101" })), assessStory(facts({ key: "SHOP-102", expected: {} }))], new Date("2026-10-21T03:04:00Z"));
    expect(md).toMatch(/\| \[SHOP-101\]\(https:\/\/j\/browse\/SHOP-101\) \| ✅ covered/);
    expect(md).toMatch(/SHOP-102 \| 📝 needs-expectations/);
    expect(md).toMatch(/- AI: write expected behaviour for AC-1, AC-2/);
    expect(md).toMatch(/2026-10-21 03:04 UTC/);
  });
});
