import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyPatch, commandRunner, extractRef, leftoverServiceFolders, loadMutations, mutationMarkdown, parseMutationPatch, parseOutcome, prepareTests, runMutations, shopliteRunner, type Mutation } from "../bench/mutate.js";
import { cleanTmp, commit, g, tmp } from "./helpers/mocks.js";

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

describe("a test run that did not really run is never a result (L1)", () => {
  it("Playwright's own errors, an exit code with no failed test, and a different number of tests are errors", async () => {
    const errs = JSON.stringify({ errors: [{ message: "global setup failed" }], suites: [{ file: "a.spec.ts", specs: [{ title: "one", ok: true }] }] });
    expect(parseOutcome(errs, 1)).toMatchObject({ total: 0, error: expect.stringMatching(/1 error\(s\) of its own/) });
    const green = JSON.stringify({ suites: [{ file: "a.spec.ts", specs: [{ title: "one", ok: true }] }] });
    expect(parseOutcome(green, 1).error).toMatch(/exited 1 although no test failed/);
    expect(parseOutcome(green, 0)).toEqual({ total: 1, failed: [] });
    expect(parseOutcome("", 0).error).toBeDefined();

    const { src } = world();
    let n = 0;
    const counts = async () => ({ total: n++ === 0 ? 2 : 1, failed: [] as string[] });
    const report = await runMutations({ scenario: "T-5", sourceDir: src, mutations: [mut("m", patchOf("exports.cap = 3;", "exports.cap = 5;"), [])], run: counts });
    expect(report.rows[0]).toMatchObject({ status: "error", note: "1 tests ran, 2 on the correct code" });
    expect(report.survived).toBe(0);
  });
});

describe("no shell touches a ref or a path (M1)", () => {
  const repoWithBranch = (branch: string) => {
    const root = tmp("qas-hostile-");
    const qa = path.join(root, "qa-tests");
    fs.mkdirSync(qa);
    g(qa, "init", "-q", "-b", "main");
    commit(qa, "tests/a.spec.ts", "// main\n", "init");
    g(qa, "checkout", "-q", "-b", branch);
    commit(qa, "tests/b.spec.ts", "// on the branch\n", "branch");
    return { root, qa };
  };

  it("a branch name made of shell syntax is read as a name: its files come out, and nothing is executed", () => {
    const marker = path.join(tmp("qas-marker-"), "pwned");
    const branch = `qa/x$(touch\${"{IFS}"}${marker})`;
    const { root, qa } = repoWithBranch(branch);
    const dest = tmp("qas-dest-");
    extractRef(qa, branch, dest);
    expect(fs.existsSync(path.join(dest, "tests/b.spec.ts"))).toBe(true);
    expect(fs.existsSync(marker)).toBe(false);
    // The same through prepareTests, which is what bench:mutate calls with --tests-ref.
    const t = prepareTests(root, { ref: branch });
    expect(fs.existsSync(path.join(t, "tests/b.spec.ts"))).toBe(true);
    expect(fs.existsSync(marker)).toBe(false);
    fs.rmSync(t, { recursive: true, force: true });
  });

  it("backticks, quotes and semicolons in a branch or a work folder are just characters; a ref that looks like an option is refused", () => {
    const marker = path.join(tmp("qas-marker2-"), "pwned");
    const branch = `a;touch ${marker};'b"c`;
    let made = true;
    let repo: { root: string; qa: string } | undefined;
    try {
      repo = repoWithBranch(branch);
    } catch {
      made = false; // git refuses the name: nothing to extract, and nothing can run either
    }
    if (made && repo) {
      const dest = tmp("qas-dest2-");
      extractRef(repo.qa, branch, dest);
      expect(fs.existsSync(path.join(dest, "tests/b.spec.ts"))).toBe(true);
    }
    expect(fs.existsSync(marker)).toBe(false);
    const { qa } = repoWithBranch("fine");
    expect(() => extractRef(qa, "--output=/tmp/x", tmp("qas-d3-"))).toThrow(/not a usable git ref/);
    expect(() => extractRef(qa, "no-such-branch", tmp("qas-d4-"))).toThrow(/cannot read no-such-branch/);
  });

  it("prepareTests removes its folder when the ref cannot be read (L5)", () => {
    const { root } = repoWithBranch("fine");
    const before = fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith("qas-mutate-tests-")).length;
    expect(() => prepareTests(root, { ref: "no-such-branch" })).toThrow();
    expect(fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith("qas-mutate-tests-")).length).toBe(before);
  });
});

describe("the ShopLite runner (M2)", () => {
  // Stub scripts stand in for qa-env/start.sh, stop.sh and Playwright, so the runner's own logic is tested without a sandbox.
  const stubs = (o: { start?: string; verify?: string; test?: string } = {}) => {
    const dir = tmp("qas-stubs-");
    const work = path.join(dir, "work");
    fs.mkdirSync(path.join(work, "payments-service"), { recursive: true });
    fs.mkdirSync(path.join(work, "orders-service"), { recursive: true });
    const tests = path.join(dir, "tests");
    fs.mkdirSync(tests);
    fs.writeFileSync(path.join(dir, "start.sh"), o.start ?? 'echo "started with $QA_ENV_LOCAL_SERVICES" >&2\nexport QA_BASE_URL=http://127.0.0.1:1\n');
    fs.writeFileSync(path.join(dir, "stop.sh"), "echo stopped >> \"$(dirname \"$0\")/stops\"\n");
    const src = path.join(dir, "mutant");
    fs.mkdirSync(src);
    fs.writeFileSync(path.join(src, "server.js"), "x\n");
    return {
      dir,
      src,
      runner: shopliteRunner({ servicesRoot: path.join(dir, "no-services"), work, testsDir: tests, startScript: path.join(dir, "start.sh"), stopScript: path.join(dir, "stop.sh"), verifyCommand: o.verify ?? "true", testCommand: o.test ?? 'printf "ok 1 - a\\nnot ok 2 - b\\n"' }),
    };
  };

  it("starts the environment on a copy of the mutant, runs the tests, always stops it, and reads the result", async () => {
    const w = stubs();
    const out = await w.runner(w.src);
    expect(out).toEqual({ total: 2, failed: ["b"] });
    expect(fs.readFileSync(path.join(w.dir, "stops"), "utf8").trim().split("\n").length).toBeGreaterThanOrEqual(2); // before and after
  });

  it("an environment that does not start is an error, not a catch", async () => {
    const w = stubs({ start: "echo boom >&2\nreturn 1\n" });
    expect((await w.runner(w.src)).error).toMatch(/did not start/);
  });

  it("an environment that is not serving the mutant is an error, not a survivor", async () => {
    const w = stubs({ verify: "false", test: 'printf "ok 1 - a\\n"' });
    expect((await w.runner(w.src)).error).toMatch(/not the mutant copy/);
  });

  it("the check compares the commit the mutant folder was given: EXPECT_SHA reaches the verify command", async () => {
    const w = stubs({ verify: '[ -n "$EXPECT_SHA" ] && [ ${#EXPECT_SHA} -eq 40 ]', test: 'printf "ok 1 - a\\n"' });
    expect(await w.runner(w.src)).toEqual({ total: 1, failed: [] });
  });

  it("paths reach bash as variables: a work folder with quotes and spaces still works", async () => {
    const dir = tmp("qas-weird-");
    const weird = path.join(dir, `we"ird $(x) dir`);
    fs.mkdirSync(path.join(weird, "orders-service"), { recursive: true });
    const tests = path.join(weird, "t e s t s");
    fs.mkdirSync(tests);
    fs.writeFileSync(path.join(weird, "start.sh"), "export QA_BASE_URL=http://127.0.0.1:1\n");
    fs.writeFileSync(path.join(weird, "stop.sh"), "true\n");
    const src = path.join(dir, "m");
    fs.mkdirSync(src);
    fs.writeFileSync(path.join(src, "a.js"), "1\n");
    const run = shopliteRunner({ servicesRoot: path.join(dir, "no-services"), work: weird, testsDir: tests, startScript: path.join(weird, "start.sh"), stopScript: path.join(weird, "stop.sh"), verifyCommand: "true", testCommand: 'printf "ok 1 - a\\n"' });
    expect(await run(src)).toEqual({ total: 1, failed: [] });
  });

  it("leftover /tmp/services folders are detected and make a run an error", async () => {
    const root = tmp("qas-svcroot-");
    expect(leftoverServiceFolders(root)).toEqual([]);
    fs.mkdirSync(path.join(root, "orders-service"));
    expect(leftoverServiceFolders(root)).toEqual([path.join(root, "orders-service")]);
    const w = stubs();
    const run = shopliteRunner({ servicesRoot: root, work: path.join(w.dir, "work"), testsDir: path.join(w.dir, "tests"), startScript: path.join(w.dir, "start.sh"), stopScript: path.join(w.dir, "stop.sh"), verifyCommand: "true", testCommand: "true" });
    expect((await run(w.src)).error).toMatch(/would run that code instead of the mutant/);
  });
});
