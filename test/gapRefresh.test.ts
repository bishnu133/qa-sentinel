import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigSchema, writeConfig } from "../src/config.js";
import { gapReportCommand } from "../src/commands/gapReport.js";
import { changeSet } from "../src/git.js";
import { gapFingerprint, parseStamp, relevantDiffDigest, stampOf, updatedLine } from "../src/plan/fingerprint.js";
import { MARKER } from "../src/scm/gitlab.js";

const diffOf = (file: string, line: number, add: string) => `diff --git a/${file} b/${file}\nindex 111..222 100644\n--- a/${file}\n+++ b/${file}\n@@ -${line},1 +${line},2 @@\n ctx\n+${add}\n`;

describe("fingerprint", () => {
  it("ignores line numbers and files that are not relevant", () => {
    const a = diffOf("src/a.ts", 10, "x = 1") + diffOf("README.md", 1, "docs");
    const b = diffOf("src/a.ts", 55, "x = 1") + diffOf("README.md", 1, "other docs");
    expect(relevantDiffDigest(a, ["src/a.ts"])).toBe(relevantDiffDigest(b, ["src/a.ts"]));
  });
  it("changes when relevant code or an AC changes", () => {
    const a = diffOf("src/a.ts", 10, "x = 1");
    const b = diffOf("src/a.ts", 10, "x = 2");
    expect(gapFingerprint(a, ["src/a.ts"], ["h1"])).not.toBe(gapFingerprint(b, ["src/a.ts"], ["h1"]));
    expect(gapFingerprint(a, ["src/a.ts"], ["h1"])).not.toBe(gapFingerprint(a, ["src/a.ts"], ["h2"]));
    expect(gapFingerprint(a, ["src/a.ts"], ["h1", "h2"])).toBe(gapFingerprint(a, ["src/a.ts"], ["h2", "h1"]));
  });
  it("stamps and parses", () => {
    expect(parseStamp(`report\n${stampOf("abc123", "f".repeat(40))}\n`)).toEqual({ fp: "abc123", head: "f".repeat(12) });
    expect(parseStamp("no stamp")).toBeUndefined();
    expect(parseStamp(undefined)).toBeUndefined();
    expect(updatedLine("a".repeat(40), "b".repeat(40))).toContain("aaaaaaaa");
  });
});

describe("gap report refresh on a ready merge request", () => {
  let root: string, repo: string;
  const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "qas-refresh-"));
    repo = path.join(root, "orders");
    fs.mkdirSync(path.join(repo, "src"), { recursive: true });
    git("init", "-q", "-b", "main");
    fs.writeFileSync(path.join(repo, "src/a.ts"), "export const a = 0;\n");
    git("add", "-A");
    git("commit", "-qm", "base");
    git("checkout", "-q", "-b", "feat");
    fs.writeFileSync(path.join(repo, "src/a.ts"), "export const a = 0;\nexport const b = 1;\n");
    git("commit", "-qam", "change");
    writeConfig(root, ConfigSchema.parse({ version: 1, mode: "existing", project: { name: "t" }, workspace: { services: [{ name: "orders", path: "orders" }] }, tests: { api: { framework: "playwright", runCommand: "npx playwright test" } }, ci: { platform: "gitlab", gitlabUrl: "https://gl.example" } }));
    vi.stubEnv("CI_MERGE_REQUEST_IID", "7");
    vi.stubEnv("CI_PROJECT_ID", "1");
    vi.stubEnv("CI_MERGE_REQUEST_TITLE", "Add b");
    vi.stubEnv("CI_MERGE_REQUEST_DIFF_BASE_SHA", git("rev-parse", "main").trim());
    vi.stubEnv("QA_SENTINEL_GITLAB_TOKEN", "t");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("makes no new report when the stamp on the MR comment matches", async () => {
    const cs = changeSet(repo, "main", "HEAD");
    const fp = gapFingerprint(cs.diff, cs.files, []);
    const body = `${MARKER}\nold report\n${stampOf(fp, "0".repeat(40))}\n`;
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.includes("/notes")) return new Response(JSON.stringify([{ id: 5, body }]), { status: 200 });
      return new Response(JSON.stringify({ draft: false }), { status: 200 });
    });
    const r = await gapReportCommand({ cwd: root, service: "orders", servicePath: repo, post: true });
    expect(r).toMatchObject({ skipped: true, exitCode: 0 });
    expect(r.report).toContain("unchanged");
    expect(calls.some((c) => c.startsWith("PUT") || c.startsWith("POST"))).toBe(false);
  });
});
