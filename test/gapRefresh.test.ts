import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigSchema, loadConfig, writeConfig } from "../src/config.js";
import { gapReportCommand, riskInputs } from "../src/commands/gapReport.js";
import { changeSet, git as srcGit } from "../src/git.js";
import { gapFingerprint, parseStamp, relevantDiffDigest, stampOf, updatedLine } from "../src/plan/fingerprint.js";
import { MARKER } from "../src/scm/gitlab.js";

const fileDiff = (m: Record<string, string>) => (f: string) => m[f] ?? "";

describe("fingerprint", () => {
  it("ignores line numbers, index lines and files that are not relevant", () => {
    const a = { "src/a.ts": "diff --git a/src/a.ts b/src/a.ts\nindex 1..2\n@@ -10,1 +10,2 @@\n+x = 1\n" };
    const b = { "src/a.ts": "diff --git a/src/a.ts b/src/a.ts\nindex 9..8\n@@ -55,1 +55,2 @@\n+x = 1\n" };
    expect(relevantDiffDigest(fileDiff(a), ["src/a.ts"])).toBe(relevantDiffDigest(fileDiff(b), ["src/a.ts"]));
  });
  it("changes when a relevant file or an AC or another input changes", () => {
    const a = relevantDiffDigest(fileDiff({ f: "+x = 1" }), ["f"]);
    const b = relevantDiffDigest(fileDiff({ f: "+x = 2" }), ["f"]);
    expect(gapFingerprint(a, ["h1"])).not.toBe(gapFingerprint(b, ["h1"]));
    expect(gapFingerprint(a, ["h1"])).not.toBe(gapFingerprint(a, ["h2"]));
    expect(gapFingerprint(a, ["h1"], ["expected v1"])).not.toBe(gapFingerprint(a, ["h1"], ["expected v2"]));
    expect(gapFingerprint(a, ["h1", "h2"])).toBe(gapFingerprint(a, ["h2", "h1"]));
  });
  it("has no fingerprint when a relevant file's diff cannot be read", () => {
    expect(relevantDiffDigest(fileDiff({ f: "+x" }), ["f", "missing"])).toBeUndefined();
    expect(gapFingerprint(undefined, ["h"])).toBeUndefined();
  });
  it("stamps and parses; only a stamp at the end counts", () => {
    expect(parseStamp(`report\n${stampOf("abc123", "f".repeat(40))}\n`)).toEqual({ fp: "abc123", head: "f".repeat(12) });
    expect(parseStamp(`quoted ${stampOf("abc123", "f".repeat(40))} in the middle\nmore report\n`)).toBeUndefined();
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
    const digest = relevantDiffDigest((f) => srcGit(repo, ["-c", "core.quotePath=false", "diff", "--relative", "--binary", "--full-index", `${cs.base}...${cs.head}`, "--", f]), cs.files);
    const fp = gapFingerprint(digest, [], ["", "[]", "[]", riskInputs(loadConfig(root), root)])!;
    const body = `${MARKER}\nold report\n${stampOf(fp, "0".repeat(40))}\n`;
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.endsWith("/user")) return new Response(JSON.stringify({ id: 99 }), { status: 200 });
      if (url.includes("/notes")) return new Response(JSON.stringify([{ id: 5, body, author: { id: 99 } }]), { status: 200 });
      return new Response(JSON.stringify({ draft: false }), { status: 200 });
    });
    const r = await gapReportCommand({ cwd: root, service: "orders", servicePath: repo, post: true });
    expect(r).toMatchObject({ skipped: true, exitCode: 0 });
    expect(r.report).toContain("unchanged");
    expect(calls.some((c) => c.startsWith("PUT") || c.startsWith("POST"))).toBe(false);
  });

  it("ignores a stamp pasted by someone else", async () => {
    const cs = changeSet(repo, "main", "HEAD");
    const digest = relevantDiffDigest((f) => srcGit(repo, ["-c", "core.quotePath=false", "diff", "--relative", "--binary", "--full-index", `${cs.base}...${cs.head}`, "--", f]), cs.files);
    const fp = gapFingerprint(digest, [], ["", "[]", "[]", riskInputs(loadConfig(root), root)])!;
    const { getMrNoteBody } = await import("../src/scm/gitlab.js");
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.endsWith("/user")) return new Response(JSON.stringify({ id: 99 }), { status: 200 });
      return new Response(JSON.stringify([{ id: 6, body: `${MARKER}\nfake\n${stampOf(fp, "0".repeat(40))}`, author: { id: 1 } }]), { status: 200 });
    });
    expect(await getMrNoteBody({ apiUrl: "https://gl.example/api/v4", token: "t" }, "1", "7")).toBeUndefined();
  });

  it("a non-ASCII or binary file still counts: their diffs are read from git", () => {
    fs.writeFileSync(path.join(repo, "src/café.ts"), "export const c = 1;\n");
    fs.writeFileSync(path.join(repo, "src/img.bin"), Buffer.from([0, 1, 2, 3]));
    git("add", "-A");
    git("commit", "-qm", "more");
    const digestOf = () => {
      const cs = changeSet(repo, "main", "HEAD");
      expect(cs.files).toEqual(expect.arrayContaining(["src/café.ts", "src/img.bin"]));
      return relevantDiffDigest((f) => srcGit(repo, ["-c", "core.quotePath=false", "diff", "--relative", "--binary", "--full-index", `${cs.base}...${cs.head}`, "--", f]), cs.files);
    };
    const before = digestOf();
    expect(before).toBeDefined();
    fs.writeFileSync(path.join(repo, "src/img.bin"), Buffer.from([0, 1, 2, 4]));
    fs.writeFileSync(path.join(repo, "src/café.ts"), "export const c = 2;\n");
    git("commit", "-qam", "edit");
    expect(digestOf()).not.toBe(before);
  });

  it("a draft MR gets a visible waiting note, and the AI is not claimed", async () => {
    vi.stubEnv("CI_MERGE_REQUEST_TITLE", "Draft: Add b");
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.endsWith("/user")) return new Response(JSON.stringify({ id: 99 }), { status: 200 });
      if (url.includes("/notes") && (init?.method ?? "GET") === "GET") return new Response("[]", { status: 200, headers: { "x-next-page": "" } });
      if (url.includes("/notes")) return new Response(JSON.stringify({ id: 1 }), { status: 201 });
      return new Response(JSON.stringify({ draft: true }), { status: 200 });
    });
    const r = await gapReportCommand({ cwd: root, service: "orders", servicePath: repo, post: true });
    expect(r).toMatchObject({ skipped: true, exitCode: 0 });
    expect(calls.some((c) => c.startsWith("POST") && c.includes("/notes"))).toBe(true);
    expect(fs.existsSync(path.join(root, ".qa-sentinel/stories"))).toBe(false);
  });
});
