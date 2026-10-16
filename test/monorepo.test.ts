import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { changeSet, changesSince, ensureAtCommit, fromRoot, showFile, workingChanges } from "../src/git.js";
import { initCommand } from "../src/commands/init.js";
import { findService } from "../src/run.js";
import { ConfigSchema } from "../src/config.js";

const sh = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
const write = (f: string, s: string) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, s);
};

/** One repository: packages/api-tests is the test repo, packages/ui-tests another team's, services/orders a service. */
function monorepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qas-mono-"));
  sh(root, "init", "-q", "-b", "master");
  write(path.join(root, "packages/api-tests/tests/api/orders.spec.ts"), "it('a', () => {});\n");
  write(path.join(root, "packages/ui-tests/tests/x.spec.ts"), "it('b', () => {});\n");
  write(path.join(root, "services/orders/src/server.ts"), "export const a = 1;\n");
  write(path.join(root, "services/payments/src/server.ts"), "export const p = 1;\n");
  sh(root, "add", "-A");
  sh(root, "commit", "-q", "-m", "init");
  return { root, tests: path.join(root, "packages/api-tests") };
}

describe("a test repo that is a folder of a monorepo", () => {
  it("reports changes relative to the test repo's folder; changes in other packages come back as ../ (outside)", () => {
    const { root, tests } = monorepo();
    write(path.join(tests, "tests/api/new.spec.ts"), "it('c', () => {});\n");
    write(path.join(root, "packages/ui-tests/tests/x.spec.ts"), "it('changed', () => {});\n");
    const w = workingChanges(tests).map((c) => c.path).sort();
    expect(w).toEqual(["../ui-tests/tests/x.spec.ts", "tests/api/new.spec.ts"]);
    const base = sh(root, "rev-parse", "HEAD");
    fs.writeFileSync(path.join(tests, "tests/api/orders.spec.ts"), "it('a2', () => {});\n");
    expect(changesSince(tests, base).map((c) => c.path)).toContain("tests/api/orders.spec.ts");
    expect(showFile(tests, base, "tests/api/orders.spec.ts")).toContain("it('a'");
    expect(fromRoot(tests, "packages/api-tests/x.ts")).toBe("x.ts");
  });

  it("a service that is a folder sees only its own changes, with paths from its folder", () => {
    const { root } = monorepo();
    const base = sh(root, "rev-parse", "HEAD");
    write(path.join(root, "services/orders/src/server.ts"), "export const a = 2;\n");
    write(path.join(root, "services/payments/src/server.ts"), "export const p = 2;\n");
    sh(root, "commit", "-qam", "both");
    const cs = changeSet(path.join(root, "services/orders"), base, "HEAD");
    expect(cs.files).toEqual(["src/server.ts"]);
    expect(cs.diff).not.toContain("payments");
  });

  it("init writes CI that runs from the folder and keeps artifacts under it", async () => {
    const { tests } = monorepo();
    await initCommand({ cwd: tests, yes: true, mode: "scratch", ci: "gitlab", level: "maintenance", name: "mono" });
    const ci = fs.readFileSync(path.join(tests, "ci/qa-sentinel/tests.gitlab-ci.yml"), "utf8");
    expect(ci).toContain('- cd "packages/api-tests"');
    expect(ci).toContain("paths: [packages/api-tests/qa-sentinel-summary.md, packages/api-tests/.qa-sentinel/runs/]");
    const svc = fs.readFileSync(path.join(tests, "ci/qa-sentinel/service.gitlab-ci.yml"), "utf8");
    expect(svc).toContain('QA_TESTS_DIR: "/tmp/qa-tests/packages/api-tests"');
    expect(svc).toContain('qa-sentinel -C "$QA_TESTS_DIR" gap-report');
  });

  it("in CI, a monorepo service's folder is joined onto the checkout (--service-path is the repository root)", () => {
    const c = ConfigSchema.parse({ version: 1, mode: "existing", project: { name: "p" }, tests: { api: { framework: "mocha", runCommand: "x" } }, ci: { platform: "gitlab" }, workspace: { services: [{ name: "orders", path: "../../services/orders", subdir: "services/orders" }] } });
    expect(findService(c, "orders", "/tmp/x", "/builds/group/platform").path).toBe("/builds/group/platform/services/orders");
    expect(findService(c, "orders", "/tmp/x").path).toBe("../../services/orders");
  });

  it("refuses to check out a service commit that would move the test repo in the same repository", () => {
    const { root, tests } = monorepo();
    const first = sh(root, "rev-parse", "HEAD");
    write(path.join(root, "services/orders/src/server.ts"), "export const a = 3;\n");
    sh(root, "commit", "-qam", "next");
    expect(() => ensureAtCommit(path.join(root, "services/orders"), first, true, tests)).toThrow(/same repository/);
    expect(sh(root, "rev-parse", "HEAD")).not.toBe(first);
  });
});
