import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { bundleFindings } from "../src/commands/bundlePolicy.js";
import { GIT_ENV, cleanTmp, commit, g, tmp } from "./helpers/mocks.js";
beforeEach(() => { for (const [k, v] of Object.entries(GIT_ENV)) vi.stubEnv(k, v); });
afterEach(() => { vi.unstubAllEnvs(); cleanTmp(); });
const cfg = ConfigSchema.parse({ version: 1, mode: "existing", project: { name: "p" }, tests: { api: { framework: "playwright", runCommand: "x" } }, ci: { platform: "gitlab" }, requirements: { source: "none" }, guardrails: { allowedHosts: [] } });
const all = async (cwd: string, base: string, tip: string, targetRef = "main") => (await bundleFindings(cwd, cfg, { base, tip, targetRef, env: {} })).map((f) => `${f.level}:${f.rule}:${f.file}`).sort();
const world = () => { const r = tmp("qas-h1-"); g(r, "init", "-q", "-b", "main"); commit(r, "src/a.js", "a1\n", "old"); return r; };
const evil = (r: string, old: string, prep: () => void) => { g(r, "checkout", "-q", "-b", "qa-sentinel/x"); commit(r, "tests/api/z.spec.ts", "test('z', () => { expect(1).toBe(1); });\n", "agent"); prep(); g(r, "add", "-A", "-f"); return g(r, "commit-tree", g(r, "write-tree"), "-p", "HEAD", "-p", old, "-m", "Merge"); };
describe("bundle policy: old-main merges, modes, assertions, story base (re-review)", () => {
  it("mode change on a src file via old-main merge", async () => {
    const r = world(); fs.writeFileSync(path.join(r, "src/run.sh"), "echo\n"); fs.chmodSync(path.join(r, "src/run.sh"), 0o755); g(r, "add", "-A"); g(r, "commit", "-qm", "x");
    const old = g(r, "rev-parse", "HEAD"); fs.chmodSync(path.join(r, "src/run.sh"), 0o644); g(r, "add", "-A"); g(r, "commit", "-qm", "noexec");
    const base = g(r, "rev-parse", "HEAD");
    const tip = evil(r, old, () => g(r, "checkout", old, "--", "src/run.sh"));
    const f = await all(r, base, tip); expect(f.join()).toContain("src/run.sh");
  });
  it("old-main merge reverts a test to fewer assertions", async () => {
    const r = world(); commit(r, "tests/api/t.spec.ts", "test('t', () => { expect(1).toBe(1); });\n", "t1");
    const old = g(r, "rev-parse", "HEAD"); commit(r, "tests/api/t.spec.ts", "test('t', () => { expect(1).toBe(1); expect(2).toBe(2); expect(3).toBe(3); });\n", "more asserts");
    const base = g(r, "rev-parse", "HEAD");
    const tip = evil(r, old, () => g(r, "checkout", old, "--", "tests/api/t.spec.ts"));
    const f = await all(r, base, tip); expect(f.join()).toContain("assertion-removed");
  });
  it("old-main merge deletes a test main added later", async () => {
    const r = world(); const old = g(r, "rev-parse", "HEAD"); commit(r, "tests/api/new.spec.ts", "test('n', () => { expect(1).toBe(1); });\n", "new test");
    const base = g(r, "rev-parse", "HEAD");
    const tip = evil(r, old, () => g(r, "rm", "-q", "tests/api/new.spec.ts"));
    const f = await all(r, base, tip); expect(f.join()).toContain("test-deleted");
  });
  it("old-main merge reverts expected/ file", async () => {
    const r = world(); commit(r, "expected/SHOP-1.md", "# SHOP-1\n- AC-1: status 200\n", "e1");
    const old = g(r, "rev-parse", "HEAD"); commit(r, "expected/SHOP-1.md", "# SHOP-1\n- AC-1: status 403\n", "e2");
    const base = g(r, "rev-parse", "HEAD");
    const tip = evil(r, old, () => g(r, "checkout", old, "--", "expected/SHOP-1.md"));
    const f = await all(r, base, tip); expect(f.some((x) => x.startsWith("violation") && x.includes("expected/SHOP-1.md"))).toBe(true);
  });
  it("story-branch base (observed) older than target; merge of old main brings old auth", async () => {
    const r = world(); commit(r, "src/auth.js", "old\n", "o"); const old = g(r, "rev-parse", "HEAD");
    g(r, "checkout", "-q", "-b", "qa-sentinel/story/S-1"); commit(r, "tests/api/s.spec.ts", "test('s',()=>{expect(1).toBe(1)});\n", "s"); const observed = g(r, "rev-parse", "HEAD");
    g(r, "checkout", "-q", "main"); commit(r, "src/auth.js", "fixed\n", "fix");
    g(r, "checkout", "-q", "qa-sentinel/story/S-1"); g(r, "merge", "-q", "--no-edit", "main"); // legit merge of main
    commit(r, "tests/api/s2.spec.ts", "test('s2',()=>{expect(1).toBe(1)});\n", "s2");
    g(r, "checkout", old, "--", "src/auth.js"); g(r, "add", "-A");
    const tip = g(r, "commit-tree", g(r, "write-tree"), "-p", "HEAD", "-p", old, "-m", "Merge old");
    const f = await all(r, observed, tip); expect(f).toContain("violation:outside-allowed:src/auth.js");
  });
  it("tip is reset to an old main commit (story base newer)", async () => {
    const r = world(); commit(r, "src/auth.js", "old\n", "o"); const old = g(r, "rev-parse", "HEAD"); commit(r, "src/auth.js", "fixed\n", "fix"); const base = g(r, "rev-parse", "HEAD");
    // a merge with base as first parent but tree = old tree, second parent = old
    const tip = g(r, "commit-tree", g(r, "rev-parse", `${old}^{tree}`), "-p", base, "-p", old, "-m", "m");
    const f = await all(r, base, tip); expect(f).toContain("violation:outside-allowed:src/auth.js");
  });
  it("story branch: a normal merge of main, then a hand-made merge taking back an old main file, is flagged (the MR would newly show it)", async () => {
    const r = tmp("qas-h1b-"); g(r, "init", "-q", "-b", "main"); commit(r, "src/auth.js", "old\n", "o"); const old = g(r, "rev-parse", "HEAD");
    g(r, "checkout", "-q", "-b", "qa-sentinel/story-S-1"); commit(r, "tests/api/s.spec.ts", "test('s',()=>{expect(1).toBe(1)});\n", "s"); const observed = g(r, "rev-parse", "HEAD");
    g(r, "checkout", "-q", "main"); commit(r, "src/auth.js", "fixed\n", "fix");
    
    g(r, "checkout", "-q", "qa-sentinel/story-S-1"); g(r, "merge", "-q", "--no-edit", "main");
    g(r, "checkout", old, "--", "src/auth.js"); g(r, "add", "-A");
    const tip = g(r, "commit-tree", g(r, "write-tree"), "-p", "HEAD", "-p", old, "-m", "Merge old");
    
    const f = (await bundleFindings(r, cfg, { base: observed, tip, targetRef: "main", env: {} })).map((x) => `${x.level}:${x.rule}:${x.file}`);
    
    // Even simpler: no evil merge at all - just merge main legitimately and then a plain revert commit? (counted, per-commit walk)
    expect(f).toContain("violation:outside-allowed:src/auth.js");
  });
});
