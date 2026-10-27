import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyPatch, commandRunner, loadMutations, mutationMarkdown, parseMutationPatch, parseOutcome, runMutations, type Mutation } from "../bench/mutate.js";
import { cleanTmp, tmp } from "./helpers/mocks.js";

afterEach(cleanTmp);

// A tiny "service": a cap function. The "tests" are a script that prints TAP lines; no server, no network.
const SERVICE = `exports.cap = 3;\nexports.accept = (n) => n <= exports.cap;\n`;
const CHECK = `
const s = require(process.env.MUTANT_DIR + "/service.js");
const t = (name, ok) => console.log((ok ? "ok" : "not ok") + " " + (++n) + " - " + name);
let n = 0;
t("accepts 3 orders", s.accept(3));
t("rejects the 4th order (AC-3)", !s.accept(4));
`;
const patchOf = (from: string, to: string) => `diff --git a/service.js b/service.js\n--- a/service.js\n+++ b/service.js\n@@ -1,2 +1,2 @@\n${from.startsWith("exports.cap") ? `-${from}\n+${to}\n exports.accept = (n) => n <= exports.cap;` : ` exports.cap = 3;\n-${from}\n+${to}`}\n`;

const world = () => {
  const root = tmp("qas-mut-");
  const src = path.join(root, "svc");
  fs.mkdirSync(src);
  fs.writeFileSync(path.join(src, "service.js"), SERVICE);
  fs.writeFileSync(path.join(root, "check.js"), CHECK);
  return { src, run: commandRunner(`node ${path.join(root, "check.js")}`) };
};
const mut = (id: string, patch: string, expectKilledBy: string[]): Mutation => ({ id, description: id, patch, expectKilledBy });

describe("mutation patches", () => {
  it("reads the header and the diff; a mutation without an expect-killed-by header is refused", () => {
    const m = parseMutationPatch("cap.patch", `# mutation: cap\n# service: orders-service\n# describes: five instead of three\n# expect-killed-by: slot is full, AC-3\ndiff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n`);
    expect(m).toMatchObject({ id: "cap", service: "orders-service", description: "five instead of three", expectKilledBy: ["slot is full", "AC-3"], reference: false });
    expect(m.patch.startsWith("diff --git")).toBe(true);
    expect(() => parseMutationPatch("x.patch", "# mutation: x\ndiff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n")).toThrow(/expect-killed-by/);
    expect(parseMutationPatch("y.patch", "# mutation: y\n# expect-killed-by: none\ndiff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n").expectKilledBy).toEqual([]);
    expect(parseMutationPatch("reference.patch", "# reference: ok\ndiff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n").reference).toBe(true);
  });

  it("the patches that ship with SHOP-101 all apply to the sandbox's orders-service (reference first, then each defect alone)", () => {
    const { reference, mutations, testsDir } = loadMutations("SHOP-101");
    expect(reference).toBeDefined();
    expect(mutations.length).toBeGreaterThanOrEqual(5);
    expect(mutations.some((m) => m.id === "cap-3-to-5")).toBe(true);
    expect(testsDir && fs.existsSync(path.join(testsDir, "tests/api/orders/delivery-slot.spec.ts"))).toBe(true);
    const source = path.resolve("sandbox/shoplite/services/orders-service");
    for (const m of mutations) {
      const dir = tmp("qas-mut-apply-");
      fs.cpSync(source, dir, { recursive: true, filter: (s) => !s.includes("node_modules") });
      applyPatch(dir, reference!.patch);
      applyPatch(dir, m.patch);
      expect(fs.readFileSync(path.join(dir, "src/server.js"), "utf8")).not.toBe(fs.readFileSync(path.join(source, "src/server.js"), "utf8"));
    }
    expect(() => loadMutations("NOPE-1")).toThrow(/no mutations for NOPE-1/);
  });
});

describe("runMutations", () => {
  it("counts planted defects and catches: the cap defect is killed by the named test, an invisible one survives", async () => {
    const { src, run } = world();
    const report = await runMutations({
      scenario: "T-1",
      sourceDir: src,
      mutations: [
        mut("cap-3-to-5", patchOf("exports.cap = 3;", "exports.cap = 5;"), ["AC-3", "4th"]),
        mut("cap-3-to-2", patchOf("exports.cap = 3;", "exports.cap = 2;"), ["accepts 3"]),
        mut("comment-only", patchOf("exports.accept = (n) => n <= exports.cap;", "exports.accept = (n) => n <= exports.cap; // same"), []),
      ],
      run,
    });
    expect(report.baselineOk).toBe(true);
    expect(report.baseline).toMatchObject({ total: 2, failed: [] });
    expect(report.rows.map((r) => [r.id, r.status, r.expectationMet])).toEqual([
      ["cap-3-to-5", "killed", true],
      ["cap-3-to-2", "killed", true],
      ["comment-only", "survived", true],
    ]);
    expect(report.rows[0].killedBy).toEqual(["rejects the 4th order (AC-3)"]);
    expect([report.planted, report.caught, report.survived, report.errors]).toEqual([3, 2, 1, 0]);
    // The source itself is never changed.
    expect(fs.readFileSync(path.join(src, "service.js"), "utf8")).toBe(SERVICE);
    const md = mutationMarkdown(report);
    expect(md).toContain("**3 planted defects, 2 caught**, 1 survived");
    expect(md).toContain("not a general mutation score");
  });

  it("says so when a defect is caught by a different test than the patch names, and when a defect the patch expects to be caught survives", async () => {
    const { src, run } = world();
    const report = await runMutations({
      scenario: "T-2",
      sourceDir: src,
      mutations: [mut("wrong-test", patchOf("exports.cap = 3;", "exports.cap = 2;"), ["no such test"]), mut("missed", patchOf("exports.accept = (n) => n <= exports.cap;", "exports.accept = (n) => n <= exports.cap && true;"), ["AC-3"])],
      run,
    });
    expect(report.rows[0]).toMatchObject({ status: "killed", expectationMet: false });
    expect(report.rows[0].note).toMatch(/not by the test the patch names/);
    expect(report.rows[1]).toMatchObject({ status: "survived", expectationMet: false });
    expect(mutationMarkdown(report)).toContain("**no**");
  });

  it("scores nothing when the tests fail on the correct code, and applies the reference patch before every defect", async () => {
    const { src, run } = world();
    const bad = await runMutations({ scenario: "T-3", sourceDir: src, mutations: [mut("a", patchOf("exports.cap = 3;", "exports.cap = 5;"), [])], reference: mut("reference", patchOf("exports.cap = 3;", "exports.cap = 1;"), []), run });
    expect(bad.baselineOk).toBe(false);
    expect(bad.rows).toEqual([]);
    expect(mutationMarkdown(bad)).toMatch(/Nothing was scored[\s\S]*Failing on the correct code/);
    // A reference that keeps the tests green: the defect is planted on top of it.
    const ref = mut("reference", `diff --git a/service.js b/service.js\n--- a/service.js\n+++ b/service.js\n@@ -1,2 +1,3 @@\n exports.cap = 3;\n exports.accept = (n) => n <= exports.cap;\n+exports.extra = 1;\n`, []);
    const ok = await runMutations({ scenario: "T-3", sourceDir: src, reference: ref, mutations: [mut("cap", patchOf("exports.cap = 3;", "exports.cap = 5;"), ["AC-3"])], run });
    expect(ok).toMatchObject({ baselineOk: true, caught: 1 });
  });

  it("a test run that cannot work is an error, never a catch; a patch that does not apply is an error too", async () => {
    const { src } = world();
    const broken = commandRunner("exit 3");
    const report = await runMutations({ scenario: "T-4", sourceDir: src, mutations: [], run: broken });
    expect(report.baselineOk).toBe(false);
    expect(report.baseline.error).toMatch(/could not run/);
    const calls: string[] = [];
    const flaky = async (dir: string) => {
      calls.push(dir);
      return calls.length === 1 ? { total: 1, failed: [] } : { total: 0, failed: [], error: "the service did not start with this patch" };
    };
    const r2 = await runMutations({ scenario: "T-4", sourceDir: src, mutations: [mut("a", patchOf("exports.cap = 3;", "exports.cap = 5;"), ["x"]), mut("bad", "diff --git a/nope b/nope\n--- a/nope\n+++ b/nope\n@@ -1 +1 @@\n-a\n+b\n", ["x"])], run: flaky });
    expect(r2.rows.map((r) => r.status)).toEqual(["error", "error"]);
    expect(r2.errors).toBe(2);
    expect(r2.caught).toBe(0);
    expect(r2.rows[1].note).toMatch(/does not apply/);
  });
});

describe("reading test output", () => {
  it("reads Playwright's JSON reporter (nested suites) and TAP lines", () => {
    const json = JSON.stringify({ suites: [{ file: "a.spec.ts", specs: [{ title: "one", ok: true }], suites: [{ title: "describe", specs: [{ title: "two", ok: false, file: "a.spec.ts" }] }] }] });
    expect(parseOutcome(`noise\n${json}`, 1)).toEqual({ total: 2, failed: ["a.spec.ts › two"] });
    expect(parseOutcome("ok 1 - a\nnot ok 2 - b c\n", 1)).toEqual({ total: 2, failed: ["b c"] });
    expect(parseOutcome("", 0).error).toMatch(/no results/);
    expect(parseOutcome("", 2).error).toMatch(/exit 2/);
  });
});
