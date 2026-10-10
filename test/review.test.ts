import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { changedTests, indexSource } from "../src/analysis/testIndex.js";
import { reviewMarkdown, validateReview } from "../src/review/reviewer.js";
import { collectKnowledge } from "../src/kb.js";
import { ConfigSchema } from "../src/config.js";

const src = `test("returns 404 @endpoint:GET_/p/{id}", async ({ api }) => {
  const res = await api.get("/p/x");
  expect(res.status()).toBe(404);
});
test("refunds @endpoint:POST_/p/{id}/refund @ac:AC-1", async ({ api }) => {
  const res = await api.post("/p/1/refund", { amount: 10 });
  expect(res.status()).toBe(200);
  expect((await res.json()).refundedAmount).toBe(10);
});`;
const idx = indexSource("tests/api/p.spec.ts", src);

describe("test review", () => {
  it("flags status-only tests and finds changed tests", () => {
    expect(idx.map((t) => t.statusOnly)).toEqual([true, false]);
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "qas-rev-"));
    fs.mkdirSync(path.join(repo, "tests/api"), { recursive: true });
    fs.writeFileSync(path.join(repo, "tests/api/p.spec.ts"), src);
    expect(changedTests(idx, repo, ["tests/api/p.spec.ts"], () => ['  expect((await res.json()).refundedAmount).toBe(10);']).map((t) => t.line)).toEqual([5]);
  });
  it("validates a review: every test judged, weak needs an issue, ACs must exist", () => {
    const ok = validateReview(
      { schemaVersion: 1, summary: "fine", tests: [{ id: "tests/api/p.spec.ts:1", verdict: "adequate" }, { id: "tests/api/p.spec.ts:5", verdict: "strong", requirementIds: ["AC-1"], suggestion: null }] },
      idx,
      ["AC-1"],
    );
    expect(ok.errors).toEqual([]);
    const bad = validateReview({ schemaVersion: 1, summary: "x", tests: [{ id: "tests/api/p.spec.ts:5", verdict: "weak", requirementIds: ["AC-9"] }, { id: "nope:1", verdict: "strong" }] }, idx, ["AC-1"]);
    expect(bad.errors.join("\n")).toMatch(/names no issue[\s\S]*unknown AC-9[\s\S]*nope:1 is not one[\s\S]*no verdict for tests\/api\/p.spec.ts:1/);
  });
  it("renders flagged tests and missing scenarios", () => {
    const md = reviewMarkdown(
      { status: "reviewed", errors: [], runs: [], review: { schemaVersion: 1, summary: "one weak", tests: [{ id: "tests/api/p.spec.ts:1", verdict: "weak", requirementIds: [], issues: ["status only"], suggestion: "assert error body" }, { id: "tests/api/p.spec.ts:5", verdict: "strong", requirementIds: [], issues: [] }], missingScenarios: [{ requirementId: "AC-1", scenario: "refund twice" }] } },
      idx,
    );
    expect(md).toContain("🟢 1 strong · 🟠 1 weak — one weak");
    expect(md).toContain("| `tests/api/p.spec.ts:1` returns 404 | 🟠 weak | status only | assert error body |");
    expect(md).toContain("- AC-1: refund twice");
  });
});

describe("knowledge base", () => {
  it("collects kb markdown (not the README) within the size cap", () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "qas-kb-"));
    fs.mkdirSync(path.join(repo, "kb/domain"), { recursive: true });
    fs.writeFileSync(path.join(repo, "kb/README.md"), "not for agents");
    fs.writeFileSync(path.join(repo, "kb/domain/payments.md"), "Refunds never exceed the amount.");
    fs.writeFileSync(path.join(repo, "kb/glossary.md"), "x".repeat(3000));
    const c = ConfigSchema.parse({ version: 1, mode: "existing", project: { name: "t" }, tests: { api: { framework: "playwright", dir: "tests/api", helpersDir: "src/api", runCommand: "npx playwright test" } }, ci: { platform: "gitlab" }, knowledge: { maxChars: 1000 } } as any);
    const k = collectKnowledge(repo, c)!;
    expect(k.files).toEqual(["kb/domain/payments.md", "kb/glossary.md"]);
    expect(k.markdown).toContain("Refunds never exceed the amount.");
    expect(k.markdown).not.toContain("not for agents");
    expect(k.truncated).toBe(true);
  });
});
