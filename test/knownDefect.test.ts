import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { indexSource, traceMarkdown, traceStory } from "../src/analysis/testIndex.js";
import { KNOWN_DEFECT, checkKnownDefectMarkers } from "../src/guardrails.js";

const SRC = `import { test, expect } from "@playwright/test";

// QA-BUG: https://jira.example.com/browse/SHOP-140
test.fail("rejects a fourth order @story:SHOP-101 @ac:AC-1", async ({ request }) => {
  expect((await request.post("/orders")).status()).toBe(409);
});

test.fail("names the slot @story:SHOP-101 @ac:AC-2", { annotation: { type: "issue", description: "https://jira.example.com/browse/SHOP-141" } }, async () => {
  expect(1).toBe(1);
});

test.fail("no link yet @story:SHOP-101 @ac:AC-3", async () => {
  expect(1).toBe(1);
});

test.fixme("waiting for triage @story:SHOP-101 @ac:AC-3", async () => {
  expect(1).toBe(1);
});
`;

describe("known defects (test.fail)", () => {
  const idx = indexSource("tests/api/slots.spec.ts", SRC);

  it("are their own status, with the bug link (comment or annotation), not folded into fixme", () => {
    expect(idx.map((t) => [t.status, t.bug])).toEqual([
      ["known-defect", "https://jira.example.com/browse/SHOP-140"],
      ["known-defect", "https://jira.example.com/browse/SHOP-141"],
      ["known-defect", undefined],
      ["fixme", undefined],
    ]);
  });

  it("show as pending with their bug link in the traceability matrix", () => {
    const md = traceMarkdown("SHOP-101", traceStory(idx, "SHOP-101", [{ id: "AC-1" }, { id: "AC-3" }]));
    expect(md).toMatch(/known defect: https:\/\/jira.example.com\/browse\/SHOP-140/);
    expect(md).toMatch(/known defect, no bug link/);
    expect(md).toMatch(/pending-only/);
  });

  it("are recognised in every form: test.fail() in the body, test.fail(cond), describe.fail", () => {
    const src = [
      'test("a @ac:AC-1", async () => {', "  test.fail();", "  expect(1).toBe(2);", "});",
      'test("b @ac:AC-1", async () => {', '  test.fail(true, "SHOP-9");', "});",
      'test.describe.fail("group", () => {', '  test("c @ac:AC-1", async () => {', "    expect(1).toBe(2);", "  });", "});",
      'test("d @ac:AC-1", async () => {', "  expect(1).toBe(1);", "});",
    ].join("\n");
    expect(indexSource("x.spec.ts", src).map((t) => t.status)).toEqual(["known-defect", "known-defect", "known-defect", "active"]);
    
    for (const l of ["  test.fail();", '  test.fail(true, "bug");', 'test.describe.fail("g", () => {', 'test.fail("t", async () => {']) expect(KNOWN_DEFECT.test(l)).toBe(true);
  });

  it("may not be added by an AI run", () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "qas-kd-"));
    const g = (...a: string[]) => execFileSync("git", a, { cwd: repo, encoding: "utf8" });
    g("init", "-q");
    g("-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "--allow-empty", "-m", "init");
    fs.mkdirSync(path.join(repo, "tests"));
    fs.writeFileSync(path.join(repo, "tests/a.spec.ts"), SRC);
    const f = checkKnownDefectMarkers([{ path: "tests/a.spec.ts", status: "A" }], repo, "HEAD");
    expect(f).toEqual([expect.objectContaining({ level: "violation", rule: "known-defect-by-agent", message: expect.stringMatching(/^3 test\(s\)/) })]);
  });
});
