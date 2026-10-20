import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { type ExpectedFile, acHash, renderExpected } from "../src/expected/format.js";
import { checkExpectationLock, lineDiff, storyOfExpectedPath } from "../src/expected/lock.js";
import { acTrailer, lockByAuthor } from "../src/expected/commits.js";
import type { FileChange } from "../src/git.js";

const AC1 = "A slot takes at most 3 orders.";
const AC2 = "The confirmation email names the slot.";
const current = new Map([["SHOP-101", [{ id: "AC-1", text: AC1 }, { id: "AC-2", text: AC2 }]]]);

const expected = (cap = 3): ExpectedFile => ({
  version: 1,
  story: "SHOP-101",
  acs: [
    { id: "AC-1", hash: acHash(AC1), text: AC1, services: [], behaviours: [{ id: "B1", kind: "boundary", statement: "A fourth order is rejected", expect: { maxOrdersPerSlot: cap, status: 409 }, state: "ready", source: "ac" }] },
    { id: "AC-2", hash: acHash(AC2), text: AC2, services: [], behaviours: [{ id: "B2", kind: "main", statement: "The email names the slot", expect: {}, state: "ready", source: "ac" }] },
  ],
});
const STORED = renderExpected(expected());

const spec = (cap: number, extra = "") => `import { test, expect } from "../fixtures";
const SLOT = "s1";
test.describe("POST /orders @story:SHOP-101", () => {
  test("rejects an order for a full slot @ac:AC-1", async ({ api }) => {
    for (let i = 0; i < ${cap}; i++) await api.post("/orders", { slot: SLOT });
    const res = await api.post("/orders", { slot: SLOT });
    expect(res.status()).toBe(409);
  });
  test("lists orders", async ({ api }) => {
    expect((await api.get("/orders")).status()).toBe(200);
  });${extra}
});
`;

/** files: path → [before, after]; `stored` is the story's expected file at the start (unchanged unless listed). */
const run = (files: Record<string, [string | undefined, string | undefined]>, acs: typeof current | undefined = current, storedText: string | null = STORED) => {
  const stored = storedText ?? undefined;
  const changes: FileChange[] = Object.entries(files).map(([p, [b, a]]) => ({ path: p, status: b === undefined ? "A" : a === undefined ? "D" : "M" }));
  const before = (f: string) => (f in files ? files[f][0] : f === "expected/SHOP-101.md" ? stored : undefined);
  const after = (f: string) => (f in files ? files[f][1] : f === "expected/SHOP-101.md" ? stored : undefined);
  return checkExpectationLock({ expectedDir: "expected", changes, before, after, currentAcs: acs });
};
const rules = (f: ReturnType<typeof run>) => f.map((x) => `${x.level}:${x.rule}`);
const edit = (from: string, to: string) => ({ "tests/orders.spec.ts": [spec(3), spec(3).replace(from, to)] as [string, string] });

describe("expectation lock: requirement tests", () => {
  it("rejects changing an assertion value when the AC didn't change, and says what to do", () => {
    const f = run(edit("toBe(409)", "toBe(201)"));
    expect(rules(f)).toEqual(["violation:expectation-changed"]);
    expect(f[0].message).toContain("`expect(res.status()).toBe(409);` → `expect(res.status()).toBe(201);`");
    expect(f[0].message).toContain("that is a defect to report, not a test to change");
  });

  it("rejects changing any literal in the test, and a top-level constant a requirement test uses", () => {
    expect(rules(run({ "tests/orders.spec.ts": [spec(3), spec(5)] }))).toEqual(["violation:expectation-changed"]);
    const f = run(edit('const SLOT = "s1";', 'const SLOT = "s2";'));
    expect(rules(f)).toEqual(["violation:expectation-changed"]);
    expect(f[0].message).toContain("SLOT is used by requirement test(s)");
  });

  it("rejects added control flow that can keep the checks from running", () => {
    expect(rules(run(edit("    expect(res.status()).toBe(409);", "    if (res.status() === 201) return;\n    expect(res.status()).toBe(409);")))).toEqual(["violation:expectation-changed"]);
    expect(rules(run(edit("    expect(res.status()).toBe(409);", "    test.skip(true, 'flaky');\n    expect(res.status()).toBe(409);")))).toEqual(["violation:expectation-changed"]);
  });

  it("rejects removing or switching off a requirement test", () => {
    const without = spec(3).replace(/  test\("rejects[\s\S]*?\n  \}\);\n/, "");
    expect(rules(run({ "tests/orders.spec.ts": [spec(3), without] }))).toContain("violation:expectation-removed");
    expect(rules(run(edit('test("rejects', 'test.fixme("rejects')))).toEqual(["violation:ac-test-disabled"]);
    expect(rules(run(edit("@ac:AC-1", "@ac:AC-2")))).toEqual(["violation:expectation-removed"]);
  });

  it("accepts moving an unchanged assertion, renaming a test, adding tests, and changes to tests without ACs", () => {
    const moved = spec(3).replace("    expect(res.status()).toBe(409);\n", "").replace('const res = await api.post("/orders", { slot: SLOT });', 'const res = await api.post("/orders", { slot: SLOT });\n        expect(res.status()).toBe(409);');
    expect(run({ "tests/orders.spec.ts": [spec(3), moved] })).toEqual([]);
    expect(run(edit("rejects an order for a full slot", "refuses an order when the slot is full"))).toEqual([]);
    expect(run({ "tests/orders.spec.ts": [spec(3), spec(3, `\n  test("new one @ac:AC-2", async () => { expect(1).toBe(1); });`)] })).toEqual([]);
    expect(run(edit("toBe(200)", "toBe(204)"))).toEqual([]);
  });

  it("covers describe-level @ac tags and test.each tables", () => {
    const desc = `test.describe("caps @story:SHOP-101 @ac:AC-1", () => {\n  test("fourth order", async () => {\n    expect(code).toBe(409);\n  });\n});\n`;
    expect(rules(run({ "a.spec.ts": [desc, desc.replace("409", "201")] }))).toEqual(["violation:expectation-changed"]);
    const each = `test.each([\n  [3, 409],\n])("order %i gets %i @story:SHOP-101 @ac:AC-1", async (n, code) => {\n  expect(code).toBeTruthy();\n});\n`;
    expect(rules(run({ "a.spec.ts": [each, each.replace("[3, 409]", "[5, 201]")] }))).toEqual(["violation:expectation-changed"]);
  });

  it("opens the lock for one AC only when its stored text is gone from the story", () => {
    const edited = new Map([["SHOP-101", [{ id: "AC-1", text: "A slot takes at most 5 orders." }, { id: "AC-2", text: AC2 }]]]);
    expect(run(edit("toBe(409)", "toBe(201)"), edited)).toEqual([]);
    expect(rules(run(edit("toBe(409)", "toBe(201)"), undefined))).toEqual(["violation:expectation-changed"]); // can't prove it changed
    // A new AC inserted above: the stored AC-1 text is still in the story (as AC-2), so AC-1 stays locked.
    const inserted = new Map([["SHOP-101", [{ id: "AC-1", text: "Users must sign in." }, { id: "AC-2", text: AC1 }, { id: "AC-3", text: AC2 }]]]);
    expect(rules(run(edit("toBe(409)", "toBe(201)"), inserted))).toEqual(["violation:expectation-changed"]);
  });

  it("only warns for stories with no stored expectation yet, and for tests with no story tag", () => {
    expect(rules(run(edit("toBe(409)", "toBe(201)"), current, null))).toEqual(["warning:expectation-changed"]);
    const noStory = spec(3).replace(" @story:SHOP-101", "");
    expect(rules(run({ "tests/orders.spec.ts": [noStory, noStory.replace("toBe(409)", "toBe(201)")] }))).toEqual(["warning:expectation-changed"]);
  });
});

describe("expectation lock: round-2 attacks", () => {
  const inline = `test.describe("caps @story:SHOP-101", () => {\n  test("cap @ac:AC-1", async () => expect(n).toBe(3));\n});\n`;
  const each = `test.each([[1, 3]])("cap @story:SHOP-101 @ac:AC-1", async (a, b) => {\n  expect(b).toBeTruthy();\n});\n`;
  it("checks code on the test's own line (inline assertions, test.each rows)", () => {
    expect(rules(run({ "a.spec.ts": [inline, inline.replace("toBe(3)", "toBe(5)")] }))).toEqual(["violation:expectation-changed"]);
    expect(rules(run({ "a.spec.ts": [each, each.replace("[[1, 3]]", "[[1, 5]]")] }))).toEqual(["violation:expectation-changed"]);
  });

  it("catches checks switched off by comments, loops, describe.skip, beforeEach skips, and mocked responses", () => {
    const wrap = (pre: string, post: string) => edit("    expect(res.status()).toBe(409);", `${pre}\n    expect(res.status()).toBe(409);\n${post}`);
    expect(rules(run(wrap("    /*", "    */")))).toContain("violation:expectation-changed");
    expect(rules(run(wrap("    for (const _ of []) {", "    }")))).toContain("violation:expectation-changed");
    expect(rules(run(edit('test.describe("POST', 'test.describe.skip("POST')))).toContain("violation:expectation-changed");
    expect(rules(run(edit('const SLOT = "s1";', 'const SLOT = "s1";\ntest.beforeEach(() => test.skip());')))).toContain("violation:expectation-changed");
    expect(rules(run(edit("    const res =", "    await page.route('**/orders', (r) => r.fulfill({ status: 409 }));\n    const res =")))).toContain("violation:expectation-changed");
  });

  it("covers top-level helper functions in the spec, and warns on values changed in shared test code", () => {
    const helper = spec(3).replace('const SLOT = "s1";', 'const SLOT = "s1";\nfunction full(n: number) {\n  return n >= 3;\n}').replace("    expect(res.status()).toBe(409);", "    expect(full(4)).toBe(true);");
    expect(rules(run({ "tests/orders.spec.ts": [helper, helper.replace("n >= 3", "n >= 5")] }))).toEqual(["violation:expectation-changed"]);
    expect(rules(run({ "tests/support/limits.ts": ["export const MAX = 3;\n", "export const MAX = 5;\n"] }))).toEqual(["warning:expectation-changed"]);
  });

  it("keeps an AC missing from the current list locked (it may be a parsing gap), and catches swapped ids and placeholder text", () => {
    const onlyAc1 = new Map([["SHOP-101", [{ id: "AC-1", text: AC1 }]]]);
    expect(rules(run({ "expected/SHOP-101.md": [STORED, STORED.replace("expect: {}", "expect: { slotShown: false }")] }, onlyAc1))).toContain("violation:expectation-changed");
    const swapped = expected();
    [swapped.acs[0].id, swapped.acs[1].id] = [swapped.acs[1].id, swapped.acs[0].id];
    expect(rules(run({ "expected/SHOP-101.md": [STORED, renderExpected(swapped)] }))).toContain("violation:expectation-changed");
    const placeholder = expected();
    placeholder.acs[1].behaviours = [];
    const lied = expected();
    lied.acs[1].text = "The email doesn't need the slot.";
    expect(rules(run({ "expected/SHOP-101.md": [renderExpected(placeholder), renderExpected(lied)] }))).toContain("violation:expectation-changed");
  });

  it("accepts story keys with underscores", () => {
    expect(storyOfExpectedPath("expected", "expected/MY_PROJ-1.md")).toBe("MY_PROJ-1");
  });
});

describe("expectation lock: expected files", () => {
  const exp = (after: ExpectedFile | string | undefined, before: string = STORED, acs: typeof current | undefined = current) =>
    run({ "expected/SHOP-101.md": [before, typeof after === "string" || after === undefined ? after : renderExpected(after)] }, acs);

  it("rejects an AI change to a stored value, a removed or moved behaviour, an added case, or a moved hash", () => {
    const changed = exp(expected(5));
    expect(rules(changed)).toEqual(["violation:expectation-changed"]);
    expect(changed[0].message).toContain("values maxOrdersPerSlot 3, status 409 → maxOrdersPerSlot 5, status 409");
    const gone = expected();
    gone.acs[1].behaviours = [];
    expect(rules(exp(gone))).toEqual(["violation:expectation-removed"]);
    const moved = expected();
    moved.acs[1].behaviours.push(moved.acs[0].behaviours.pop()!);
    expect(rules(exp(moved))).toContain("violation:expectation-changed");
    const more = expected();
    more.acs[1].behaviours.push({ id: "B3", kind: "edge", statement: "No slot: no slot line", expect: {}, state: "ready", source: "ac" });
    expect(rules(exp(more))).toEqual(["violation:expectation-changed"]);
    const rehashed = expected();
    rehashed.acs[0].hash = acHash("something else");
    expect(rules(exp(rehashed))).toContain("violation:expectation-changed");
    const retexted = expected();
    retexted.acs[0].untestable = "manual only";
    expect(rules(exp(retexted))).toEqual(["violation:expectation-changed"]);
  });

  it("accepts a new file, filling a placeholder, and revisions for an AC whose text changed (with the right hash)", () => {
    expect(run({ "expected/SHOP-101.md": [undefined, STORED] })).toEqual([]);
    const placeholder = expected();
    placeholder.acs[1].behaviours = [];
    const filled = expected();
    expect(exp(filled, renderExpected(placeholder))).toEqual([]);
    const newText = "A slot takes at most 5 orders.";
    const now = new Map([["SHOP-101", [{ id: "AC-1", text: newText }, { id: "AC-2", text: AC2 }]]]);
    const revised = expected(5);
    revised.acs[0] = { ...revised.acs[0], hash: acHash(newText), text: newText };
    expect(exp(revised, STORED, now)).toEqual([]);
    const madeUp = expected(99);
    madeUp.acs[0] = { ...madeUp.acs[0], hash: "abcdefabcdef", text: newText };
    expect(rules(exp(madeUp, STORED, now))).toEqual(["violation:expectation-changed"]);
  });

  it("rejects an invalid, deleted, or hand-edited-view expected file, and a change to a file that was invalid", () => {
    expect(rules(exp("---\nversion: 2\n---\n"))).toEqual(["violation:expected-file-invalid"]);
    expect(rules(exp(undefined))).toEqual(["violation:expectation-removed"]);
    expect(rules(exp(STORED.replace("maxOrdersPerSlot = 3", "maxOrdersPerSlot = 5")))).toEqual(["violation:expectation-changed"]);
    expect(rules(exp(expected(5), "---\nnot: [valid\n---\n"))).toEqual(["violation:expected-file-invalid"]);
  });

  it("finds expected files however the folder is written, with the story key upper-cased", () => {
    expect(storyOfExpectedPath("./expected/", "expected/shop-101.md")).toBe("SHOP-101");
    expect(storyOfExpectedPath("expected", "expected/README.md")).toBeUndefined();
    expect(storyOfExpectedPath("expected", "other/SHOP-101.md")).toBeUndefined();
  });
});

describe("line diff", () => {
  it("finds removed and added lines with their numbers", () => {
    expect(lineDiff("a\nb\nc\nd", "a\nB\nc\nd\ne")).toEqual({ removed: [{ n: 2, text: "b" }], added: [{ n: 2, text: "B" }, { n: 5, text: "e" }] });
  });
});

describe("expectation lock on a branch: by author", () => {
  const sh = (cwd: string, args: string[], who = "dev") =>
    execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: who, GIT_AUTHOR_EMAIL: `${who}@t`, GIT_COMMITTER_NAME: who, GIT_COMMITTER_EMAIL: `${who}@t` } }).trim();
  const AGENT = (trailer = "") => `test(orders): QA agent updates\n\nGenerated by qa-sentinel 0.8.0 from orders@abc.${trailer ? `\n\n${trailer}` : ""}`;
  const cfg = ConfigSchema.parse({ version: 1, mode: "existing", project: { name: "p" }, tests: { api: { framework: "playwright", runCommand: "x" } }, ci: { platform: "gitlab" }, requirements: { source: "none" } });
  const repoWithBase = () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "qas-lock-"));
    sh(repo, ["init", "-q", "-b", "main"]);
    fs.mkdirSync(path.join(repo, "expected"));
    fs.mkdirSync(path.join(repo, "tests"));
    fs.writeFileSync(path.join(repo, "expected/SHOP-101.md"), STORED);
    fs.writeFileSync(path.join(repo, "tests/orders.spec.ts"), spec(3));
    sh(repo, ["add", "-A"]);
    sh(repo, ["commit", "-qm", "base"]);
    return { repo, base: sh(repo, ["rev-parse", "HEAD"]) };
  };

  it("rejects qa-sentinel's commit that moves a value, and lists a person's edit as an override", async () => {
    const { repo, base } = repoWithBase();
    fs.writeFileSync(path.join(repo, "expected/SHOP-101.md"), renderExpected(expected(4)));
    sh(repo, ["commit", "-qam", "QA: cap is 4 (PO confirmed)"], "qa");
    fs.writeFileSync(path.join(repo, "tests/orders.spec.ts"), spec(3).replace("toBe(409)", "toBe(201)"));
    sh(repo, ["commit", "-qam", AGENT()], "ci");
    const f = await lockByAuthor(repo, cfg, base);
    expect(f.map((x) => `${x.level}:${x.rule}:${x.file}`).sort()).toEqual(["violation:expectation-changed:tests/orders.spec.ts", "warning:expectation-override:expected/SHOP-101.md"]);
    expect(f.find((x) => x.rule === "expectation-override")!.message).toContain("QA override by qa <qa@t>");
  });

  it("doesn't block on a change qa-sentinel made and a person reverted", async () => {
    const { repo, base } = repoWithBase();
    fs.writeFileSync(path.join(repo, "tests/orders.spec.ts"), spec(3).replace("toBe(409)", "toBe(201)"));
    sh(repo, ["commit", "-qam", AGENT()], "ci");
    fs.writeFileSync(path.join(repo, "tests/orders.spec.ts"), spec(3));
    sh(repo, ["commit", "-qam", "revert the agent's change"], "qa");
    expect(await lockByAuthor(repo, cfg, base)).toEqual([]);
  });

  it("opens an AC from the hashes qa-sentinel recorded in its commit when Jira isn't the source", async () => {
    const { repo, base } = repoWithBase();
    const newText = "A slot takes at most 5 orders.";
    fs.writeFileSync(path.join(repo, "tests/orders.spec.ts"), spec(3).replace("toBe(409)", "toBe(201)"));
    sh(repo, ["commit", "-qam", AGENT(acTrailer("SHOP-101", [{ id: "AC-1", text: newText }, { id: "AC-2", text: AC2 }]))], "ci");
    expect(await lockByAuthor(repo, cfg, base)).toEqual([]);
  });
});
