import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { bundleFindings } from "../src/commands/bundlePolicy.js";
import { GIT_ENV, cleanTmp, commit, g, tmp } from "./helpers/mocks.js";
beforeEach(() => { for (const [k, v] of Object.entries(GIT_ENV)) vi.stubEnv(k, v); });
afterEach(() => { vi.unstubAllEnvs(); cleanTmp(); });
const cfg = ConfigSchema.parse({ version: 1, mode: "existing", project: { name: "p" }, tests: { api: { framework: "playwright", runCommand: "x" } }, ci: { platform: "gitlab" }, requirements: { source: "none" }, guardrails: { allowedHosts: [] } });
const rules = async (cwd: string, base: string, tip: string, targetRef = "main") => (await bundleFindings(cwd, cfg, { base, tip, targetRef, env: {} })).filter((f) => f.level === "violation").map((f) => `${f.rule}:${f.file}`).sort();
describe("a merge with an OLD commit of the target branch cannot hide changes from the publish check", () => {
  it("takes back an old version of a file outside the tests", async () => {
    const r = tmp("qas-atk-");
    g(r, "init", "-q", "-b", "main");
    commit(r, "src/auth.js", "check(token) // old, unsafe\n", "old");
    const old = g(r, "rev-parse", "HEAD");
    commit(r, "src/auth.js", "checkStrict(token) // fixed\n", "security fix");
    const base = g(r, "rev-parse", "HEAD");
    g(r, "checkout", "-q", "-b", "qa-sentinel/x");
    commit(r, "tests/api/a.spec.ts", "test('a', () => {});\n", "agent");
    g(r, "checkout", old, "--", "src/auth.js");
    g(r, "add", "-A");
    const tree = g(r, "write-tree");
    const tip = g(r, "commit-tree", tree, "-p", "HEAD", "-p", old, "-m", "Merge");
    const found = await rules(r, base, tip);
    expect(found).toContain("outside-allowed:src/auth.js");
  });

  const world = () => {
    const r = tmp("qas-atk-");
    g(r, "init", "-q", "-b", "main");
    commit(r, "src/a.js", "a1\n", "old");
    return r;
  };
  const evilMerge = (r: string, old: string, prepare: () => void) => {
    g(r, "checkout", "-q", "-b", "qa-sentinel/x");
    commit(r, "tests/api/a.spec.ts", "test('a', () => {});\n", "agent");
    prepare();
    g(r, "add", "-A", "-f");
    return g(r, "commit-tree", g(r, "write-tree"), "-p", "HEAD", "-p", old, "-m", "Merge");
  };
  it("deleting a file the target added after that old commit is the branch's own change", async () => {
    const r = world();
    const old = g(r, "rev-parse", "HEAD");
    commit(r, "src/new-guard.js", "guard\n", "main adds a guard");
    const base = g(r, "rev-parse", "HEAD");
    const tip = evilMerge(r, old, () => g(r, "rm", "-q", "src/new-guard.js"));
    expect(await rules(r, base, tip)).toContain("outside-allowed:src/new-guard.js");
  });
  it("a symbolic link that only the old commit has is refused", async () => {
    const r = world();
    fs.symlinkSync("/etc/passwd", path.join(r, "tests-link"));
    g(r, "add", "-A");
    g(r, "commit", "-q", "-m", "old commit with a link");
    const old = g(r, "rev-parse", "HEAD");
    g(r, "rm", "-q", "tests-link");
    g(r, "commit", "-q", "-m", "main removes it");
    const base = g(r, "rev-parse", "HEAD");
    const tip = evilMerge(r, old, () => g(r, "checkout", old, "--", "tests-link"));
    expect(await rules(r, base, tip)).toContain("symlink:tests-link");
  });
  it("a clean merge of the current target still is not the agent's", async () => {
    const r = world();
    g(r, "checkout", "-q", "-b", "qa-sentinel/y");
    commit(r, "tests/api/b.spec.ts", "test('b', () => {});\n", "agent");
    const base0 = g(r, "rev-parse", "HEAD");
    g(r, "checkout", "-q", "main");
    commit(r, "src/people.js", "p\n", "people");
    g(r, "checkout", "-q", "qa-sentinel/y");
    g(r, "merge", "-q", "--no-edit", "main");
    expect(await rules(r, base0, g(r, "rev-parse", "HEAD"))).toEqual([]);
  });
});
