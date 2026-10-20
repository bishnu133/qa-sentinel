import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigSchema, writeConfig } from "../src/config.js";
import { acChanges, storiesCommand } from "../src/commands/stories.js";
import { acHash, renderExpected, type ExpectedFile } from "../src/expected/format.js";
import { fileStore } from "../src/stories/record.js";
import { searchStories, storiesJql } from "../src/scm/jira.js";
import type { JiraContext } from "../src/scm/jira.js";

const AC1 = "A slot takes at most 3 orders.";
const AC2 = "Orders in the past are rejected.";
const storyMd = (key: string, a1 = AC1) => `# ${key} Delivery slots\n\n## Acceptance criteria\n- AC-1: ${a1}\n- AC-2: ${AC2}\n`;
const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });

let root: string, repo: string, stories: string;
const configure = (extra: Record<string, unknown> = {}) =>
  writeConfig(
    repo,
    ConfigSchema.parse({
      version: 1,
      mode: "existing",
      project: { name: "t" },
      tests: { api: { framework: "playwright", runCommand: "npx playwright test" } },
      ci: { platform: "gitlab" },
      ...extra,
    }),
  );
const expectedFor = (key: string): ExpectedFile => ({
  version: 1,
  story: key,
  acs: [
    { id: "AC-1", hash: acHash(AC1), text: AC1, services: [], behaviours: [{ id: "B1", kind: "main", statement: "third accepted", expect: { n: 3 }, state: "ready", source: "ac" }] },
    { id: "AC-2", hash: acHash(AC2), text: AC2, services: [], behaviours: [{ id: "B2", kind: "main", statement: "past rejected", expect: { status: 400 }, state: "ready", source: "ac" }] },
  ],
});

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "qas-stories-"));
  repo = path.join(root, "qa-tests");
  stories = path.join(repo, "stories");
  fs.mkdirSync(stories, { recursive: true });
  fs.mkdirSync(path.join(repo, "tests/api"), { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  configure();
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const run = async (o: Record<string, unknown> = {}) => {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation(((s: string) => (chunks.push(String(s)), true)) as never);
  const code = await storiesCommand({ cwd: repo, json: true, ...o });
  spy.mockRestore();
  return { code, list: JSON.parse(chunks.join("")) as any[] };
};

describe("stories (files)", () => {
  it("tells each story what it needs next", async () => {
    fs.writeFileSync(path.join(stories, "SHOP-101.md"), storyMd("SHOP-101"));
    fs.writeFileSync(path.join(stories, "SHOP-102.md"), storyMd("SHOP-102"));
    fs.mkdirSync(path.join(repo, "expected"), { recursive: true });
    fs.writeFileSync(path.join(repo, "expected/SHOP-101.md"), renderExpected(expectedFor("SHOP-101")));
    fs.writeFileSync(path.join(repo, "tests/api/a.spec.ts"), `test("a @story:SHOP-101 @ac:AC-1", async () => { expect(1).toBe(1); });\n`);
    const { code, list } = await run({ storiesDir: "stories" });
    expect(code).toBe(0);
    const by = Object.fromEntries(list.map((a) => [a.key, a]));
    // SHOP-101: expected behaviour is there, AC-1 has a test, AC-2 has none; no service repos are reachable, so the code state is unknown and tests are asked for.
    expect(by["SHOP-101"]).toMatchObject({ state: "needs-tests", next: "generate", code: "unknown" });
    expect(by["SHOP-101"].acs.map((a: any) => a.tests)).toEqual(["covered", "none"]);
    // SHOP-102 has no expected file yet.
    expect(by["SHOP-102"]).toMatchObject({ state: "needs-expectations", next: "spec" });
    expect(by["SHOP-102"].todo[0].command).toBe("qa-sentinel spec --story SHOP-102");
    expect(fs.readFileSync(path.join(repo, "qa-stories.md"), "utf8")).toMatch(/SHOP-102 \| 📝 needs-expectations/);
  });
  it("is covered once every AC has a test, and expectations: off skips the expected-file step", async () => {
    fs.writeFileSync(path.join(stories, "SHOP-103.md"), storyMd("SHOP-103"));
    fs.writeFileSync(path.join(repo, "tests/api/a.spec.ts"), `test("a @story:SHOP-103 @ac:AC-1", async () => {});\ntest("b @story:SHOP-103 @ac:AC-2", async () => {});\n`);
    configure({ tests: { api: { framework: "playwright", runCommand: "npx playwright test" }, expectations: "off" } });
    const { list } = await run({ storiesDir: "stories" });
    expect(list[0]).toMatchObject({ key: "SHOP-103", state: "covered" });
  });
  it("reports a broken expected file as needing attention, not a crash", async () => {
    fs.writeFileSync(path.join(stories, "SHOP-101.md"), storyMd("SHOP-101"));
    fs.mkdirSync(path.join(repo, "expected"), { recursive: true });
    fs.writeFileSync(path.join(repo, "expected/SHOP-101.md"), "not an expected file");
    const { list } = await run({ storiesDir: "stories" });
    expect(list[0]).toMatchObject({ state: "needs-attention", next: "fix" });
  });
  it("skips files with no story key, and fails clearly when there is nothing to read", async () => {
    fs.writeFileSync(path.join(stories, "notes.md"), "# just notes\nnothing here");
    const out = await storiesCommand({ cwd: repo, storiesDir: "stories" });
    expect(out).toBe(0);
    await expect(storiesCommand({ cwd: repo, storiesDir: "nope" })).rejects.toThrow(/not a folder/);
    await expect(storiesCommand({ cwd: repo })).rejects.toThrow(/Nothing to check/);
  });
  it("keeps a record, rewrites it only when something changed, and says which AC changed", async () => {
    fs.writeFileSync(path.join(stories, "SHOP-101.md"), storyMd("SHOP-101"));
    await run({ storiesDir: "stories" });
    const file = path.join(repo, ".qa-sentinel/stories/SHOP-101.json");
    const first = fs.readFileSync(file, "utf8");
    expect(JSON.parse(first)).toMatchObject({ key: "SHOP-101", acs: [{ id: "AC-1" }, { id: "AC-2" }], lastCheck: { state: "needs-expectations", next: "spec" } });
    const mtime = fs.statSync(file).mtimeMs;
    await new Promise((r) => setTimeout(r, 20));
    await run({ storiesDir: "stories" });
    expect(fs.statSync(file).mtimeMs).toBe(mtime);
    fs.writeFileSync(path.join(stories, "SHOP-101.md"), storyMd("SHOP-101", "A slot takes at most 5 orders."));
    const { list } = await run({ storiesDir: "stories" });
    expect(list[0].changes).toEqual(["AC-1 changed since the last check"]);
    expect(fs.readFileSync(file, "utf8")).not.toBe(first);
  });
  it("does not touch the records with --no-record", async () => {
    fs.writeFileSync(path.join(stories, "SHOP-101.md"), storyMd("SHOP-101"));
    await run({ storiesDir: "stories", noRecord: true });
    expect(await fileStore(repo).list()).toEqual([]);
  });
  it("keeps stdout clean for JSON: progress and warnings go to stderr", async () => {
    fs.writeFileSync(path.join(stories, "SHOP-101.md"), storyMd("SHOP-101"));
    fs.writeFileSync(path.join(stories, "notes.md"), "# no key");
    const err: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void err.push(a.join(" ")));
    const stdout: string[] = [];
    const w = vi.spyOn(process.stdout, "write").mockImplementation(((s: string) => (stdout.push(String(s)), true)) as never);
    await storiesCommand({ cwd: repo, storiesDir: "stories", json: true });
    w.mockRestore();
    const logged = logSpy.mock.calls.length;
    logSpy.mockRestore();
    errSpy.mockRestore();
    expect(() => JSON.parse(stdout.join(""))).not.toThrow();
    expect(err.join("\n")).toMatch(/notes\.md: no story key/);
    expect(logged).toBe(0);
    expect(console.log).not.toBe(console.error);
  });
  it("prints the table when not asked for JSON", async () => {
    fs.writeFileSync(path.join(stories, "SHOP-101.md"), storyMd("SHOP-101"));
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void lines.push(a.join(" ")));
    await storiesCommand({ cwd: repo, storiesDir: "stories" });
    spy.mockRestore();
    const text = lines.join("\n");
    expect(text).toMatch(/SHOP-101\s+📝 needs-expectations/);
    expect(text).toMatch(/→ AI: write expected behaviour for AC-1, AC-2/);
    expect(text).toMatch(/1 need expected behaviour/);
  });
});

describe("acChanges", () => {
  it("lists changed, new and gone ACs, and nothing the first time", () => {
    expect(acChanges([], [{ id: "AC-1", hash: "a" }])).toEqual([]);
    expect(acChanges([{ id: "AC-1", hash: "a" }, { id: "AC-2", hash: "b" }], [{ id: "AC-1", hash: "x" }, { id: "AC-3", hash: "c" }])).toEqual(["AC-1 changed since the last check", "AC-3 is new since the last check", "AC-2 is gone since the last check"]);
  });
});

// ---------------------------------------------------------------------------------------------
// Jira (mocked responses)

const ctx: JiraContext = { baseUrl: "https://j.test", authHeader: "Basic x" };
const issue = (key: string, o: Record<string, unknown> = {}) => ({ key, fields: { summary: `Story ${key}`, status: { name: "In Progress" }, issuetype: { name: "Story" }, labels: [], updated: "2026-10-20T10:00:00.000+0000", ...o } });
const res = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("storiesJql", () => {
  it("names the projects, issue types and the lookback, quoted, and orders by update", () => {
    expect(storiesJql({ projectKeys: ["SHOP", "PAY"], statuses: [], issueTypes: ["Story", 'Big "Epic"'], lookbackDays: 14 })).toBe('project in ("SHOP", "PAY") AND issuetype in ("Story", "Big \\"Epic\\"") AND updated >= -14d ORDER BY updated DESC');
    expect(() => storiesJql({ projectKeys: [], statuses: [], issueTypes: [], lookbackDays: 3 })).toThrow(/projectKeys/);
  });
});

describe("searchStories", () => {
  it("follows nextPageToken on Jira Cloud and stops at max", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      seen.push(url);
      return url.includes("nextPageToken=T1") ? res({ issues: [issue("S-3")], isLast: true }) : res({ issues: [issue("S-1"), issue("S-2")], nextPageToken: "T1" });
    });
    const all = await searchStories(ctx, "project = S", { max: 10 });
    expect(all.map((s) => s.key)).toEqual(["S-1", "S-2", "S-3"]);
    expect(seen[0]).toMatch(/^https:\/\/j\.test\/rest\/api\/3\/search\/jql\?jql=project%20%3D%20S&fields=summary,status,issuetype,labels,updated&maxResults=10$/);
    const two = await searchStories(ctx, "project = S", { max: 2 });
    expect(two.map((s) => s.key)).toEqual(["S-1", "S-2"]);
  });
  it("falls back to the Server/Data Center search when the Cloud one is not there, and pages by offset", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      seen.push(url);
      if (url.includes("/rest/api/3/")) return res({ errorMessages: ["not found"] }, 404);
      return url.includes("startAt=0") ? res({ issues: [issue("S-1"), issue("S-2")], total: 3 }) : res({ issues: [issue("S-3")], total: 3 });
    });
    const all = await searchStories(ctx, "project = S", { max: 50 });
    expect(all.map((s) => s.key)).toEqual(["S-1", "S-2", "S-3"]);
    expect(seen.some((u) => u.includes("/rest/api/2/search?jql="))).toBe(true);
  });
  it("does not fall back on a real error (bad JQL), and honours api: cloud / server", async () => {
    vi.stubGlobal("fetch", async () => res({ errorMessages: ["bad jql"] }, 400));
    await expect(searchStories(ctx, "oops", { max: 5 })).rejects.toThrow(/400/);
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => (seen.push(url), res({ issues: [], total: 0 })));
    await searchStories(ctx, "x", { max: 5, api: "server" });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("/rest/api/2/search");
  });
  it("maps the fields, with labels and the type", async () => {
    vi.stubGlobal("fetch", async () => res({ issues: [issue("S-1", { labels: ["qa-skip"], issuetype: { name: "Bug" } })], isLast: true }));
    expect(await searchStories(ctx, "x", { max: 5 })).toEqual([{ key: "S-1", summary: "Story S-1", status: "In Progress", issueType: "Bug", labels: ["qa-skip"], updated: "2026-10-20T10:00:00.000+0000" }]);
  });
});

describe("stories (Jira)", () => {
  const env = { JIRA_PAT: "pat" } as NodeJS.ProcessEnv;
  beforeEach(() => {
    configure({ requirements: { source: "jira", jira: { baseUrl: "https://j.test", projectKeys: ["SHOP"], featureIssueTypes: ["Story"] } } });
  });
  const fetchStub = (issues: Record<string, ReturnType<typeof issue>>, hits: string[] = []) =>
    vi.stubGlobal("fetch", async (url: string) => {
      hits.push(url);
      if (url.includes("/search/jql")) return res({ issues: Object.values(issues), isLast: true });
      const key = decodeURIComponent(url.match(/\/issue\/([^?/]+)/)![1]);
      const i = issues[key];
      return i ? res({ ...i, fields: { ...i.fields, description: `## Acceptance criteria\n- AC-1: ${AC1}\n- AC-2: ${AC2}` } }) : res({ errorMessages: ["no"] }, 404);
    });

  it("searches, reads only the stories worth reading, and assesses them", async () => {
    const hits: string[] = [];
    fetchStub(
      {
        "SHOP-1": issue("SHOP-1"),
        "SHOP-2": issue("SHOP-2", { labels: ["qa-skip"] }),
        "SHOP-3": issue("SHOP-3", { issuetype: { name: "Bug" } }),
        "SHOP-4": issue("SHOP-4", { status: { name: "Backlog" } }),
      },
      hits,
    );
    const { list } = await run({ env, all: true });
    const by = Object.fromEntries(list.map((a) => [a.key, a]));
    expect(by["SHOP-1"]).toMatchObject({ state: "needs-expectations", next: "spec", url: "https://j.test/browse/SHOP-1" });
    expect(by["SHOP-2"].headline).toMatch(/opted out/);
    expect(by["SHOP-3"].headline).toMatch(/Bug is not a feature type/);
    expect(by["SHOP-4"]).toMatchObject({ state: "skipped", next: "wait" });
    // Only SHOP-1 needed its text fetched.
    expect(hits.filter((u) => /\/issue\//.test(u))).toHaveLength(1);
  });
  it("hides the stories left alone unless --all", async () => {
    fetchStub({ "SHOP-1": issue("SHOP-1"), "SHOP-2": issue("SHOP-2", { labels: ["qa-skip"] }) });
    expect((await run({ env })).list.map((a) => a.key)).toEqual(["SHOP-1"]);
  });
  it("checks the keys it is given with fetch, not search", async () => {
    const hits: string[] = [];
    fetchStub({ "SHOP-9": issue("SHOP-9") }, hits);
    const { list } = await run({ env, story: ["shop-9"] });
    expect(list[0].key).toBe("SHOP-9");
    expect(hits.some((u) => u.includes("/search"))).toBe(false);
  });
  it("explains what is missing when Jira isn't set up", async () => {
    await expect(storiesCommand({ cwd: repo, env: {} as NodeJS.ProcessEnv })).rejects.toThrow(/JIRA_EMAIL/);
  });
  it("uses the JQL from the config when there is one", async () => {
    configure({ requirements: { source: "jira", jira: { baseUrl: "https://j.test", projectKeys: ["SHOP"], search: { jql: "filter = 123 ORDER BY rank" } } } });
    const hits: string[] = [];
    fetchStub({ "SHOP-1": issue("SHOP-1") }, hits);
    await run({ env });
    expect(decodeURIComponent(hits[0])).toContain("jql=filter = 123 ORDER BY rank");
  });
});
