import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { changesBetween, changesSince } from "../src/git.js";
import { bundleFindings, ownChanges } from "../src/commands/bundlePolicy.js";
import { renderExpected, acHash, type ExpectedFile } from "../src/expected/format.js";
import { GIT_ENV, cleanTmp, commit, g, tmp } from "./helpers/mocks.js";

beforeEach(() => {
  for (const [k, v] of Object.entries(GIT_ENV)) vi.stubEnv(k, v);
});
afterEach(() => {
  vi.unstubAllEnvs();
  cleanTmp();
});

const cfg = ConfigSchema.parse({ version: 1, mode: "existing", project: { name: "p" }, tests: { api: { framework: "playwright", runCommand: "x" } }, ci: { platform: "gitlab" }, requirements: { source: "none" }, guardrails: { allowedHosts: [] } });
const rules = async (cwd: string, base: string, tip: string, targetRef = "main", c = cfg) => (await bundleFindings(cwd, c, { base, tip, targetRef, env: {} })).filter((f) => f.level === "violation").map((f) => `${f.rule}:${f.file}`).sort();

function repo() {
  const r = tmp("qas-bp-");
  g(r, "init", "-q", "-b", "main");
  commit(r, "README.md", "x\n", "init");
  return r;
}

describe("the write policy at publish time", () => {
  it("looks at the whole repository: a change outside the test folder of a monorepo is a violation", async () => {
    const root = repo();
    const qa = path.join(root, "packages/qa");
    commit(root, "packages/qa/tests/api/a.spec.ts", "test('a', () => {});\n", "tests");
    const base = g(root, "rev-parse", "HEAD");
    g(root, "checkout", "-q", "-b", "qa-sentinel/x");
    commit(root, "packages/qa/tests/api/b.spec.ts", "test('b', () => {});\n", "agent");
    commit(root, ".github/workflows/deploy.yml", "on: push\n", "agent: elsewhere");
    commit(root, "packages/other/src/app.js", "x\n", "agent: other package");
    const tip = g(root, "rev-parse", "HEAD");
    expect(await rules(qa, base, tip, base)).toEqual(["outside-allowed:../../.github/workflows/deploy.yml", "outside-allowed:../other/src/app.js"]);
  });

  it("verify --policy and the history helpers see the whole repository too, not only the test folder", () => {
    const root = repo();
    fs.mkdirSync(path.join(root, "packages/qa"), { recursive: true });
    commit(root, "packages/qa/a.txt", "a\n", "qa");
    const base = g(root, "rev-parse", "HEAD");
    commit(root, "ci/deploy.sh", "x\n", "outside the folder");
    const qa = path.join(root, "packages/qa");
    expect(changesSince(qa, base).map((c) => c.path)).toEqual(["../../ci/deploy.sh"]);
    expect(changesBetween(qa, base, "HEAD").map((c) => c.path)).toEqual(["../../ci/deploy.sh"]);
  });

  it("refuses generated artifacts, symbolic links and submodule links in an agent commit", async () => {
    const r = repo();
    const base = g(r, "rev-parse", "HEAD");
    g(r, "checkout", "-q", "-b", "qa-sentinel/x");
    fs.mkdirSync(path.join(r, "tests/api"), { recursive: true });
    fs.writeFileSync(path.join(r, "qa-gap-report.md"), "x\n");
    fs.symlinkSync("/etc/passwd", path.join(r, "tests/api/pw.spec.ts"));
    g(r, "add", "-f", "-A");
    g(r, "update-index", "--add", "--cacheinfo", `160000,${base},tests/api/sub`);
    g(r, "commit", "-q", "-m", "agent");
    const tip = g(r, "rev-parse", "HEAD");
    expect(await rules(r, base, tip)).toEqual(["artifact-committed:qa-gap-report.md", "outside-allowed:qa-gap-report.md", "submodule:tests/api/sub", "symlink:tests/api/pw.spec.ts"]);
  });

  it("does not follow a symbolic link when it reads content (a link to a file with a secret is not read)", async () => {
    const r = repo();
    const base = g(r, "rev-parse", "HEAD");
    g(r, "checkout", "-q", "-b", "qa-sentinel/x");
    const outside = path.join(tmp("qas-out-"), "secret.txt");
    fs.writeFileSync(outside, "-----BEGIN PRIVATE KEY-----\n");
    fs.mkdirSync(path.join(r, "tests/api"), { recursive: true });
    fs.symlinkSync(outside, path.join(r, "tests/api/s.spec.ts"));
    g(r, "add", "-A");
    g(r, "commit", "-q", "-m", "agent");
    const found = await rules(r, base, g(r, "rev-parse", "HEAD"));
    expect(found).toEqual(["symlink:tests/api/s.spec.ts"]); // refused as a link; its target was not read
  });

  it("takes in the target branch without calling its commits the agent's, but catches a change hidden in the merge commit", async () => {
    const r = repo();
    g(r, "checkout", "-q", "-b", "qa-sentinel/story-SHOP-1");
    commit(r, "tests/api/a.spec.ts", "test('a', () => {});\n", "agent");
    const base = g(r, "rev-parse", "HEAD");
    g(r, "checkout", "-q", "main");
    commit(r, "src/people.js", "people's work\n", "a person changes the service helper");
    g(r, "checkout", "-q", "qa-sentinel/story-SHOP-1");
    g(r, "merge", "-q", "--no-edit", "main");
    const clean = g(r, "rev-parse", "HEAD");
    expect(await rules(r, base, clean)).toEqual([]);
    expect(ownChanges(r, base, clean, "main")).toEqual([]);
    // Same merge, but the merge commit also carries a change of its own.
    g(r, "reset", "-q", "--hard", base);
    g(r, "merge", "-q", "--no-commit", "--no-ff", "main");
    fs.writeFileSync(path.join(r, "src/evil.js"), "x\n");
    g(r, "add", "-A");
    g(r, "commit", "-q", "-m", "Merge main");
    expect(await rules(r, base, g(r, "rev-parse", "HEAD"))).toEqual(["outside-allowed:src/evil.js"]);
  });

  describe("expected behaviour follows the story, whoever the commit says it is from", () => {
    const AC1 = "A slot takes at most 3 orders.";
    const exp = (cap: number): ExpectedFile => ({
      version: 1,
      story: "SHOP-101",
      acs: [{ id: "AC-1", hash: acHash(AC1), text: AC1, services: [], behaviours: [{ id: "B1", kind: "boundary", statement: "A fourth order is rejected", expect: { maxOrdersPerSlot: cap, status: 409 }, state: "ready", source: "ac" }] }],
    });
    it("a commit with no qa-sentinel marker and another author that moves a value is still the agent's violation; test.fail is too", async () => {
      const r = repo();
      fs.mkdirSync(path.join(r, "expected"));
      fs.writeFileSync(path.join(r, "expected/SHOP-101.md"), renderExpected(exp(3)));
      g(r, "add", "-A");
      g(r, "commit", "-q", "-m", "expected behaviour");
      const base = g(r, "rev-parse", "HEAD");
      g(r, "checkout", "-q", "-b", "qa-sentinel/x");
      fs.writeFileSync(path.join(r, "expected/SHOP-101.md"), renderExpected(exp(4)));
      g(r, "commit", "-q", "-am", "chore: tidy", "--author", "Some Person <p@example.com>");
      fs.mkdirSync(path.join(r, "tests/api"), { recursive: true });
      fs.writeFileSync(path.join(r, "tests/api/a.spec.ts"), "import { test } from '@playwright/test';\ntest('known defect', () => { test.fail(); });\n");
      g(r, "add", "-A");
      g(r, "commit", "-q", "-m", "chore: more tidy", "--author", "Other Person <o@example.com>");
      const found = await rules(r, base, g(r, "rev-parse", "HEAD"));
      expect(found).toContain("expectation-changed:expected/SHOP-101.md");
      expect(found.some((x) => x.startsWith("known-defect-by-agent:"))).toBe(true);
    });
  });
});
