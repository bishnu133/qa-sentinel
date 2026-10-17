import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { verifyChanges, parseJUnit } from "../src/verification.js";
import { junitReporter, runCommandRunsEverything, runnerOf } from "../src/layers.js";
import { readRunResults, matchResult } from "../src/showcase/results.js";

const ROOT = path.resolve(__dirname, "..");

/** A Mocha + Node assert test repo, filtered by environment name in the title (a common pattern), run through npm. */
function mochaRepo(script = "mocha --grep ccdev") {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "qas-mocha-"));
  fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(repo, "node_modules"), "dir");
  fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "t", private: true, scripts: { test: script } }));
  fs.mkdirSync(path.join(repo, "tests/api"), { recursive: true });
  fs.writeFileSync(
    path.join(repo, "tests/api/orders.spec.js"),
    `const assert = require("assert");
describe("POST /orders", () => {
  it("creates an order ccdev ccsit @service:orders @story:SHOP-1 @ac:AC-1", () => assert.strictEqual(1 + 1, 2));
  it("rejects qty 0 ccdev @service:orders @story:SHOP-1 @ac:AC-2", () => assert.strictEqual(400, 201));
  it("only runs in uat @service:orders", () => assert.ok(true));
});
`,
  );
  fs.writeFileSync(path.join(repo, "tests/api/other.spec.js"), `describe("other", () => it("other test ccdev", () => { throw new Error("must not run"); }));\n`);
  return repo;
}

const config = (runCommand: string) =>
  ConfigSchema.parse({ version: 1, mode: "existing", project: { name: "p" }, tests: { api: { framework: "mocha", dir: "tests/api", runCommand } }, ci: { platform: "gitlab" }, verification: { preflight: false, retryFailed: false } });

describe("Mocha test repos", () => {
  it("finds the runner behind npm scripts and switches on a JUnit reporter it can use", () => {
    expect(runnerOf("npm run test --", { test: "mocha --require ts-node/register" })).toBe("mocha");
    expect(runnerOf("npx mocha --grep ccdev")).toBe("mocha");
    expect(runnerOf("npx vitest run")).toBe("vitest");
    expect(runnerOf("npx playwright test --project=api")).toBe("playwright");
    expect(junitReporter("mocha", "npx mocha", "/r/j.xml", () => false)?.args).toBe(" --reporter xunit --reporter-option output=/r/j.xml");
    expect(junitReporter("mocha", "npm run test", "/r/j.xml", () => false)).toBeUndefined(); // npm keeps the flags without --
    expect(junitReporter("jest", "npx jest", "/r/j.xml", () => false)).toBeUndefined();
    expect(junitReporter("jest", "npx jest", "/r/j.xml", (p) => p === "jest-junit")?.env.JEST_JUNIT_OUTPUT_FILE).toBe("/r/j.xml");
    expect(runCommandRunsEverything("mocha --require ts-node/register tests/*.spec.ts --grep ccdev")).toBe(true);
    expect(runCommandRunsEverything("mocha --require ts-node/register --grep ccdev")).toBe(false);
    expect(runCommandRunsEverything("npx wdio run wdio.conf.ts")).toBe(false);
    expect(runCommandRunsEverything("npx playwright test --project=api")).toBe(false);
    expect(runCommandRunsEverything("npx jest --testPathIgnorePatterns '*.e2e.ts'")).toBe(false);
    expect(runCommandRunsEverything("npx mocha test/")).toBe(true);
  });

  it("verifies only the changed spec, keeps the team's --grep filter, and reads per-test results", async () => {
    const repo = mochaRepo();
    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "qas-run-"));
    const r = await verifyChanges({ cwd: repo, c: config("npm run test --"), changes: [{ path: "tests/api/orders.spec.js", status: "A" }], runDir, env: { PATH: process.env.PATH, HOME: process.env.HOME } });
    expect(r.status).toBe("FAILED");
    const tests = r.checks.find((x) => x.name === "tests")!;
    expect(tests.detail).toMatch(/^1 failed: rejects qty 0/);
    const log = fs.readFileSync(path.join(runDir, "test-output.log"), "utf8");
    expect(log).not.toContain("must not run");
    const cases = parseJUnit(fs.readFileSync(path.join(runDir, "junit.xml"), "utf8"));
    expect(cases.map((x) => [x.name.split(" @")[0], x.status])).toEqual([
      ["creates an order ccdev ccsit", "passed"],
      ["rejects qty 0 ccdev", "failed"],
    ]);
    expect(cases[0].file).toMatch(/tests\/api\/orders\.spec\.js$/); // mocha 10 reports the file
    // Showcase and traceability match results to tests by title when the report has no file.
    const results = readRunResults(path.join(runDir, "junit.xml"));
    expect(matchResult(results, { file: "tests/api/orders.spec.js", line: 3, title: "creates an order ccdev ccsit" })?.status).toBe("passed");
  });
});

describe("JUnit classname", () => {
  it("is used as the file only when it is a path (jest-junit and older mocha put the suite title there)", () => {
    const xml = `<testsuite><testcase classname="POST /orders" name="creates an order"/><testcase classname="tests/api/a.spec.ts" name="x"/></testsuite>`;
    expect(parseJUnit(xml).map((x) => x.file)).toEqual([undefined, "tests/api/a.spec.ts"]);
  });
});
