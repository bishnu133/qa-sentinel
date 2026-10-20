import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkExpectedValues } from "../src/expected/assertions.js";
import { acHash, type ExpectedFile } from "../src/expected/format.js";

const expected: ExpectedFile = {
  version: 1,
  story: "SHOP-101",
  acs: [
    {
      id: "AC-1",
      hash: acHash("A slot takes at most 3 orders."),
      text: "A slot takes at most 3 orders.",
      services: [],
      behaviours: [
        { id: "B1", kind: "boundary", statement: "A fourth order is rejected", expect: { maxOrdersPerSlot: 3, message: "Slot is full" }, state: "ready", source: "ac" },
        { id: "B2", kind: "main", statement: "third accepted", expect: { maxOrdersPerSlot: 3 }, state: "ready", source: "ac" },
      ],
    },
  ],
};

const repoWith = (src: string) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "qas-vals-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: repo });
  fs.mkdirSync(path.join(repo, "tests"));
  fs.writeFileSync(path.join(repo, "tests/slots.spec.ts"), src);
  return repo;
};
const run = (src: string, planned: string[] = ["B1"]) => checkExpectedValues({ repo: repoWith(src), ref: "HEAD", changes: [{ path: "tests/slots.spec.ts", status: "A" }], expected, plannedBehaviours: planned });

describe("tests assert the expected values", () => {
  it("passes when every expected number and text is in the test file (constants count)", () => {
    const f = run(`const MAX = 3;\ntest("rejects a 4th order @story:SHOP-101 @ac:AC-1 @b:B1", async () => {\n  expect(r.status()).toBe(409);\n  expect(body.message).toBe("Slot is full");\n  expect(MAX).toBe(MAX);\n});\n`);
    expect(f.filter((x) => x.level === "violation")).toEqual([]);
  });

  it("rejects a test that asserts the code's value instead", () => {
    const f = run(`test("allows up to 5 orders @story:SHOP-101 @ac:AC-1 @b:B1", async () => {\n  for (let i = 0; i < 5; i++) {}\n  expect(body.message).toBe("Slot is full");\n});\n`);
    expect(f).toEqual([expect.objectContaining({ level: "violation", rule: "expected-value-missing", message: expect.stringMatching(/"3" doesn't appear|3 doesn't appear/) })]);
  });

  it("rejects an unknown behaviour id, and warns about missing @b tags and planned behaviours without a test", () => {
    const f = run(`test("x @story:SHOP-101 @ac:AC-1 @b:B9", async () => {});\ntest("y @story:SHOP-101 @ac:AC-1", async () => { expect(3).toBe(3); });\n`, ["B1"]);
    expect(f.map((x) => `${x.level}:${x.rule}`)).toEqual(["violation:expected-value-missing", "warning:traceability", "warning:traceability"]);
    expect(f[2].message).toMatch(/SHOP-101\/B1 was planned/);
  });
});
