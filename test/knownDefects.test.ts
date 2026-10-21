import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigSchema, writeConfig } from "../src/config.js";
import { indexSource } from "../src/analysis/testIndex.js";
import { defectStatuses, removeAllMarkers, removeMarkers } from "../src/analysis/markers.js";
import { knownDefectsCommand } from "../src/commands/knownDefects.js";
import { readRunResults } from "../src/showcase/results.js";

const SRC = `import { test, expect } from "@playwright/test";

// QA-BUG: https://jira.example.com/browse/SHOP-140
// QA-AGENT: expected 409 but the API returns 201
test.fail("rejects a fourth order @story:SHOP-101 @ac:AC-1", async () => {
  expect(1).toBe(1);
});

// QA-BUG: https://jira.example.com/browse/SHOP-142
test.fail("still broken @story:SHOP-101 @ac:AC-2", async () => {
  expect(1).toBe(1);
});

test.fail("annotated @story:SHOP-101 @ac:AC-3", { annotation: { type: "issue", description: "https://jira.example.com/browse/SHOP-141" } }, async () => {
  expect(1).toBe(1);
});

// a normal comment
test("fine @story:SHOP-101 @ac:AC-4", async () => {});
`;
const FILE = "tests/api/slots.spec.ts";
const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });

const pw = (tests: { title: string; line: number; status: string; error?: string }[]) => ({
  suites: [
    {
      specs: tests.map((t) => ({
        file: "api/slots.spec.ts",
        line: t.line,
        title: t.title,
        tests: [{ status: t.status, results: [{ status: t.status === "expected" ? "passed" : "failed", ...(t.error ? { error: { message: t.error } } : {}) }] }],
      })),
    },
  ],
});
const lineOf = (title: string) => SRC.split("\n").findIndex((l) => l.includes(title)) + 1;

describe("marker removal (pure)", () => {
  const idx = indexSource(FILE, SRC);
  const t = (name: string) => idx.find((x) => x.title.startsWith(name))!;

  it("turns test.fail into test and drops the QA-BUG and QA-AGENT lines right above it", () => {
    const e = removeMarkers(SRC, t("rejects"));
    expect(e.text).toContain('test("rejects a fourth order');
    expect(e.text).not.toContain("SHOP-140");
    expect(e.text).not.toContain("QA-AGENT");
    expect(e.text).toContain("SHOP-142"); // the neighbour keeps its note
    expect(e.removed).toHaveLength(2);
  });
  it("leaves unrelated comments and other tests alone", () => {
    const e = removeMarkers(SRC, t("rejects"));
    expect(e.text).toContain("// a normal comment");
    expect(e.text).toContain('test.fail("still broken');
  });
  it("hands the annotation form to a person, with the reason", () => {
    const e = removeMarkers(SRC, t("annotated"));
    expect(e.text).toBeUndefined();
    expect(e.reason).toMatch(/by hand|annotation/);
  });
  it("edits several tests of one file bottom to top", () => {
    const r = removeAllMarkers(SRC, [t("rejects"), t("still broken")]);
    expect(r.done.size).toBe(2);
    expect(r.text).not.toContain("test.fail(\"rejects");
    expect(r.text).not.toContain("QA-BUG: https://jira.example.com/browse/SHOP-14");
    expect(r.text).toContain("annotated");
  });
  it("refuses when the line no longer holds the declaration (file changed since the run)", () => {
    const e = removeMarkers("const a = 1;\n", { line: 1, title: "x" });
    expect(e.text).toBeUndefined();
  });
});

describe("known defect states", () => {
  const idx = indexSource(FILE, SRC);
  const write = (tests: Parameters<typeof pw>[0]) => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "qas-kd-res-"));
    const f = path.join(d, "results.json");
    fs.writeFileSync(f, JSON.stringify(pw(tests)));
    return readRunResults(f);
  };
  it("tells fixed from still-failing, inconclusive and not run", () => {
    const res = write([
      { title: "rejects a fourth order @story:SHOP-101 @ac:AC-1", line: lineOf("rejects"), status: "unexpected", error: "Error: Expected to fail, but passed." },
      { title: "still broken @story:SHOP-101 @ac:AC-2", line: lineOf("still broken"), status: "expected" },
      { title: "annotated @story:SHOP-101 @ac:AC-3", line: lineOf("annotated"), status: "unexpected", error: "Error: connect ECONNREFUSED" },
    ]);
    const s = defectStatuses(idx, res);
    expect(s.map((x) => x.state)).toEqual(["fixed", "still-failing", "inconclusive"]);
    expect(defectStatuses(idx, [])[0].state).toBe("not-run");
  });
  it("reads the message from JUnit too", () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "qas-kd-junit-"));
    const f = path.join(d, "junit.xml");
    fs.writeFileSync(f, `<testsuites><testcase classname="slots.spec.ts" file="api/slots.spec.ts" name="rejects a fourth order @story:SHOP-101 @ac:AC-1"><failure message="Expected to fail, but passed." type="FAILURE"/></testcase></testsuites>`);
    expect(readRunResults(f)[0].error).toMatch(/Expected to fail, but passed/);
  });
});

describe("known-defects command", () => {
  let repo: string;
  beforeEach(() => {
    // The command commits with the process environment; a CI runner has no git identity of its own.
    for (const [k, v] of Object.entries({ GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" })) vi.stubEnv(k, v);
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "qas-kd-"));
    fs.mkdirSync(path.join(repo, "tests/api"), { recursive: true });
    fs.mkdirSync(path.join(repo, "test-results"));
    fs.writeFileSync(path.join(repo, FILE), SRC);
    writeConfig(repo, ConfigSchema.parse({ version: 1, mode: "existing", project: { name: "t" }, tests: { api: { framework: "playwright", runCommand: "npx playwright test" } }, ci: { platform: "gitlab" } }));
    fs.writeFileSync(
      path.join(repo, "test-results/results.json"),
      JSON.stringify(
        pw([
          { title: "rejects a fourth order @story:SHOP-101 @ac:AC-1", line: lineOf("rejects"), status: "unexpected", error: "Expected to fail, but passed." },
          { title: "still broken @story:SHOP-101 @ac:AC-2", line: lineOf("still broken"), status: "expected" },
          { title: "annotated @story:SHOP-101 @ac:AC-3", line: lineOf("annotated"), status: "unexpected", error: "Expected to fail, but passed." },
        ]),
      ),
    );
    git(repo, "init", "-q", "-b", "main");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "init");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(repo, { recursive: true, force: true });
  });
  const text = () => fs.readFileSync(path.join(repo, FILE), "utf8");

  it("only reports without --apply", async () => {
    expect(await knownDefectsCommand({ cwd: repo })).toBe(0);
    expect(text()).toBe(SRC);
  });
  it("--apply edits the fixed test, keeps the still-failing one, flags the annotation form (exit 1)", async () => {
    expect(await knownDefectsCommand({ cwd: repo, apply: true })).toBe(1);
    expect(text()).toContain('test("rejects a fourth order');
    expect(text()).toContain('test.fail("still broken');
    expect(text()).toContain('test.fail("annotated');
  });
  it("--commit puts it on a branch with the Generated-by line and needs a clean tree", async () => {
    fs.writeFileSync(path.join(repo, "dirty.txt"), "x");
    await expect(knownDefectsCommand({ cwd: repo, apply: true, commit: true })).rejects.toThrow(/clean working tree/);
    fs.rmSync(path.join(repo, "dirty.txt"));
    await knownDefectsCommand({ cwd: repo, apply: true, commit: true, branch: "qa-sentinel/test-branch" });
    expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("qa-sentinel/test-branch");
    expect(git(repo, "log", "-1", "--format=%B")).toMatch(/Generated by qa-sentinel/);
  });
  it("explains the flag mistakes and a missing results file", async () => {
    await expect(knownDefectsCommand({ cwd: repo, commit: true })).rejects.toThrow(/--apply/);
    await expect(knownDefectsCommand({ cwd: repo, apply: true, push: true })).rejects.toThrow(/--commit/);
    await expect(knownDefectsCommand({ cwd: repo, results: "nope.json" })).rejects.toThrow(/No test results/);
  });
});

describe("real Playwright 1.64 reports (test.fail that passes)", () => {
  // Recorded from a real run: a fixed bug's test.fail has no error in the JSON report, and its
  // "Expected to fail, but passed." is in the JUnit failure body, not in message="…".
  for (const f of ["results.json", "results.xml"])
    it(`reads ${f}`, async () => {
      const { readRunResults } = await import("../src/showcase/results.js");
      const r = readRunResults(path.join(__dirname, "fixtures/playwright-fail", f));
      const by = (t: string) => r.find((x) => x.title === t)!;
      expect(by("fixed bug")).toMatchObject({ status: "failed", unexpectedPass: true });
      expect(by("still broken")).toMatchObject({ status: "passed" });
      expect(by("still broken").unexpectedPass).toBeUndefined();
    });
});

describe("notes in the comment block", () => {
  it("removes QA-BUG / QA-AGENT lines but keeps other comments above the test", async () => {
    const { removeMarkers } = await import("../src/analysis/markers.js");
    const src = ['// QA-BUG: SHOP-9', "// @ac AC-1", "// QA-AGENT: confirmed by QA", 'test.fail("t", async () => {});'].join("\n");
    const e = removeMarkers(src, { line: 4, title: "t" });
    expect(e.text).toBe(['// @ac AC-1', 'test("t", async () => {});'].join("\n"));
    expect(e.removed).toEqual(["// QA-BUG: SHOP-9", "// QA-AGENT: confirmed by QA"]);
  });
});
