import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigSchema, writeConfig } from "../src/config.js";
import { storiesCommand } from "../src/commands/stories.js";
import { fileStore, recordsDir, SWEEP_FILE } from "../src/stories/record.js";
import { readSweepState, sweepMrs, sweepSince, recordMrSeen } from "../src/stories/sweep.js";
import { card, g, jiraMock, parentOf, serve, tmp, cleanTmp, GIT_ENV } from "./helpers/mocks.js";

afterEach(() => {
  cleanTmp();
  vi.restoreAllMocks();
});

const STORY = (ac: string) => ({ description: `## Acceptance criteria\n- AC-1: ${ac}\n` });
const ISSUES = {
  "SHOP-12": card("Delivery slots", "Story", STORY("A slot takes at most 3 orders.")),
  "SHOP-19": card("Slot reminders", "Story", STORY("A reminder is sent.")),
  "SHOP-44": card("Slot admin", "Story", STORY("Admins can close a slot.")),
  "SHOP-210": card("Slot accepts a 4th order", "Bug", { parent: parentOf("SHOP-12") }),
};
const mr = (iid: number, state: string, title: string, branch: string, extra: Record<string, unknown> = {}) => ({ iid, state, title, description: "", source_branch: branch, web_url: `http://gl/orders/-/merge_requests/${iid}`, sha: `head${iid}`, ...extra });
const MRS = [
  mr(1, "merged", "SHOP-12 and SHOP-19: shared slot work", "feature/shared", { merge_commit_sha: "merge1", merged_at: "2026-10-18T08:00:00Z" }),
  mr(2, "opened", "Tidy the admin page", "feature/SHOP-44-admin"),
  mr(3, "merged", "SHOP-210 fourth order fix", "fix/slot", { squash_commit_sha: "squash3", merged_at: "2026-10-19T08:00:00Z" }),
  mr(4, "opened", "Bump a dependency", "chore/deps"),
];

function config(jiraUrl: string, extra: Record<string, unknown> = {}) {
  return ConfigSchema.parse({
    version: 1,
    mode: "existing",
    project: { name: "t" },
    workspace: { services: [{ name: "orders-service", path: "../orders", gitlabProject: "shop/orders" }] },
    tests: { api: { framework: "playwright", runCommand: "npx playwright test" } },
    ci: { platform: "gitlab", gitlabUrl: "https://gl.example" },
    requirements: { source: "jira", jira: { baseUrl: jiraUrl, projectKeys: ["SHOP"], featureIssueTypes: ["Story"] } },
    ...extra,
  });
}

describe("sweepMrs", () => {
  it("records each MR on every story it names, finds a branch-only key, links a bug to its story, and reports MRs without a key", async () => {
    const gl = await serve(() => ({ body: MRS, headers: { "x-next-page": "" } }));
    const jira = await jiraMock(ISSUES);
    try {
      const dir = tmp("qas-sweep-");
      const store = fileStore(dir);
      const now = new Date("2026-10-20T10:00:00Z");
      const r = await sweepMrs(config(jira.url), { apiUrl: `${gl.url}/api/v4`, token: "t" }, { baseUrl: jira.url, authHeader: "Bearer x" }, store, { since: "2026-09-20T10:00:00.000Z", now });
      expect(r).toMatchObject({ mrs: 4, complete: true });
      expect(r.touched.sort()).toEqual(["SHOP-12", "SHOP-19", "SHOP-44"]);
      expect(r.noKey.map((m) => m.iid)).toEqual([4]);

      const s12 = (await store.load("SHOP-12"))!;
      expect(s12.parts.map((p) => [p.iid, p.state]).sort()).toEqual([[1, "merged"], [3, "merged"]]);
      expect(s12.parts.find((p) => p.iid === 3)).toMatchObject({ workKey: "SHOP-210", squashSha: "squash3", keys: ["SHOP-210"] });
      expect(s12.linked).toEqual([{ key: "SHOP-210", issueType: "Bug", via: "parent", at: now.toISOString() }]);
      expect(s12.basis).toMatch(/^[0-9a-f]{10}$/);
      expect((await store.load("SHOP-19"))!.parts.map((p) => p.iid)).toEqual([1]);
      expect((await store.load("SHOP-44"))!.parts[0]).toMatchObject({ iid: 2, state: "opened", branch: "feature/SHOP-44-admin" });
      // The bug has no record of its own: it is its story's work.
      expect(await store.load("SHOP-210")).toBeUndefined();
      // One paged list call for the one repository.
      expect(gl.log.filter((l) => l.includes("/merge_requests?"))).toHaveLength(1);
      expect(gl.log[0]).toContain("updated_after=2026-09-20T10%3A00%3A00.000Z");
    } finally {
      await gl.close();
      await jira.close();
    }
  });

  it("a second sweep updates the same parts instead of adding copies", async () => {
    const gl = await serve(() => ({ body: MRS, headers: { "x-next-page": "" } }));
    const jira = await jiraMock(ISSUES);
    try {
      const store = fileStore(tmp("qas-sweep-"));
      const run = (now: string) => sweepMrs(config(jira.url), { apiUrl: `${gl.url}/api/v4`, token: "t" }, { baseUrl: jira.url, authHeader: "Bearer x" }, store, { since: "2026-09-20T00:00:00.000Z", now: new Date(now) });
      await run("2026-10-20T10:00:00Z");
      await run("2026-10-21T10:00:00Z");
      const s12 = (await store.load("SHOP-12"))!;
      expect(s12.parts).toHaveLength(2);
      expect(s12.parts[0]).toMatchObject({ firstSeenAt: "2026-10-20T10:00:00.000Z", lastSeenAt: "2026-10-21T10:00:00.000Z" });
      expect(s12.linked).toHaveLength(1);
    } finally {
      await gl.close();
      await jira.close();
    }
  });

  it("a key that is not in Jira is left out with a note, and a failed list leaves the sweep incomplete", async () => {
    const gl = await serve((_r, url) => (url.pathname.includes("shop%2Fbroken") ? { status: 403, body: {} } : { body: [mr(9, "opened", "SHOP-1012 typo", "x")], headers: { "x-next-page": "" } }));
    const jira = await jiraMock(ISSUES);
    try {
      const store = fileStore(tmp("qas-sweep-"));
      const c = config(jira.url, { workspace: { services: [{ name: "orders-service", path: "../orders", gitlabProject: "shop/orders" }, { name: "broken", path: "../b", gitlabProject: "shop/broken" }] } });
      const r = await sweepMrs(c, { apiUrl: `${gl.url}/api/v4`, token: "t" }, { baseUrl: jira.url, authHeader: "Bearer x" }, store, { since: "2026-09-20T00:00:00.000Z" });
      expect(r.touched).toEqual([]);
      expect(r.notes.join("\n")).toContain("SHOP-1012 is not in Jira");
      expect(r.notes.join("\n")).toContain("broken: could not list merge requests");
      expect(r.complete).toBe(false);
    } finally {
      await gl.close();
      await jira.close();
    }
  });

  it("without Jira the keys are used as they are", async () => {
    const gl = await serve(() => ({ body: [mr(5, "opened", "SHOP-77 thing", "x")], headers: { "x-next-page": "" } }));
    try {
      const store = fileStore(tmp("qas-sweep-"));
      const r = await sweepMrs(config("http://unused"), { apiUrl: `${gl.url}/api/v4`, token: "t" }, undefined, store, { since: "2026-09-20T00:00:00.000Z" });
      expect(r.touched).toEqual(["SHOP-77"]);
    } finally {
      await gl.close();
    }
  });
});

describe("sweepSince", () => {
  it("first run: the look-back window; then the last check minus the overlap; --rebuild: 365 days", () => {
    const dir = tmp("qas-since-");
    const c = config("http://unused");
    const now = new Date("2026-10-20T10:00:00Z");
    expect(sweepSince(dir, c, now)).toBe("2026-09-20T10:00:00.000Z");
    fs.mkdirSync(recordsDir(dir), { recursive: true });
    fs.writeFileSync(path.join(recordsDir(dir), SWEEP_FILE), JSON.stringify({ lastAt: "2026-10-20T08:00:00.000Z" }));
    expect(readSweepState(dir)).toEqual({ lastAt: "2026-10-20T08:00:00.000Z" });
    expect(sweepSince(dir, c, now)).toBe("2026-10-19T08:00:00.000Z");
    expect(sweepSince(dir, config("http://unused", { automation: { sweep: { overlapHours: 2 } } }), now)).toBe("2026-10-20T06:00:00.000Z");
    expect(sweepSince(dir, c, now, { rebuild: true })).toBe("2025-10-20T10:00:00.000Z");
  });
});

describe("recordMrSeen", () => {
  it("records the MR at first sight and does not downgrade a merged one", async () => {
    const store = fileStore(tmp("qas-seen-"));
    await recordMrSeen(store, { feature: "SHOP-12", service: "orders-service", mrIid: "7", url: "u", title: "t", branch: "b", headSha: "h1", workKey: "SHOP-210" });
    expect((await store.load("SHOP-12"))!.parts[0]).toMatchObject({ iid: 7, state: "opened", headSha: "h1", workKey: "SHOP-210" });
    const rec = (await store.load("SHOP-12"))!;
    await store.save({ ...rec, parts: rec.parts.map((p) => ({ ...p, state: "merged" as const })) });
    await recordMrSeen(store, { feature: "SHOP-12", service: "orders-service", mrIid: "7", headSha: "h2" });
    expect((await store.load("SHOP-12"))!.parts[0]).toMatchObject({ state: "merged", headSha: "h2" });
    await recordMrSeen(store, { feature: "SHOP-12", service: "orders-service", mrIid: undefined });
    expect((await store.load("SHOP-12"))!.parts).toHaveLength(1);
  });
});

describe("stories: the sweep before the check", () => {
  let repo: string;
  beforeEach(() => {
    repo = path.join(tmp("qas-stories-sweep-"), "qa-tests");
    fs.mkdirSync(path.join(repo, "tests/api"), { recursive: true });
    g(repo, "init", "-q", "-b", "main");
  });
  const quiet = async (o: Parameters<typeof storiesCommand>[0]) => {
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((() => true) as never);
    try {
      return await storiesCommand({ ...o, json: true });
    } finally {
      spy.mockRestore();
    }
  };

  it("sweeps first, remembers when, starts from last check minus the overlap next time, adds touched stories, and --no-sweep skips it", async () => {
    const gl = await serve(() => ({ body: MRS, headers: { "x-next-page": "" } }));
    const jira = await jiraMock(ISSUES);
    try {
      writeConfig(repo, config(jira.url));
      const env = { JIRA_PAT: "x", QA_SENTINEL_GITLAB_TOKEN: "t", CI_API_V4_URL: `${gl.url}/api/v4` };
      const lists = () => gl.log.filter((l) => l.includes("state=all&updated_after="));
      const sinceOf = (l: string) => decodeURIComponent(new URL(`http://x${l.split(" ")[1]}`).searchParams.get("updated_after")!);

      expect(await quiet({ cwd: repo, env, now: new Date("2026-10-20T10:00:00Z"), story: ["SHOP-12"] })).toBe(0);
      expect(sinceOf(lists()[0])).toBe("2026-09-20T10:00:00.000Z");
      expect(lists()).toHaveLength(2); // the sweep, then the story's branch scan
      expect(readSweepState(repo).lastAt).toBe("2026-10-20T10:00:00.000Z");
      const store = fileStore(repo);
      expect((await store.load("SHOP-12"))!.parts).toHaveLength(2);
      // `--story` checks only that story, and the records of the others were still filled.
      expect((await store.load("SHOP-44"))!.parts).toHaveLength(1);

      gl.log.length = 0;
      await quiet({ cwd: repo, env, now: new Date("2026-10-20T12:00:00Z"), story: ["SHOP-12"] });
      expect(sinceOf(lists()[0])).toBe("2026-10-19T10:00:00.000Z");
      expect(readSweepState(repo).lastAt).toBe("2026-10-20T12:00:00.000Z");

      gl.log.length = 0;
      await quiet({ cwd: repo, env, now: new Date("2026-10-20T13:00:00Z"), story: ["SHOP-12"], noSweep: true });
      // Only the story's own branch scan (the same kind of list call) is left: the sweep did not run.
      expect(lists()).toHaveLength(1);
      expect(readSweepState(repo).lastAt).toBe("2026-10-20T12:00:00.000Z");
    } finally {
      await gl.close();
      await jira.close();
    }
  });

  it("--rebuild looks back 365 days, and a failed sweep does not stop the check", async () => {
    const gl = await serve((_r, url) => (url.searchParams.get("search") ? { body: [], headers: { "x-next-page": "" } } : { status: 403, body: {} }));
    const jira = await jiraMock(ISSUES);
    try {
      writeConfig(repo, config(jira.url));
      const env = { JIRA_PAT: "x", QA_SENTINEL_GITLAB_TOKEN: "t", CI_API_V4_URL: `${gl.url}/api/v4` };
      expect(await quiet({ cwd: repo, env, now: new Date("2026-10-20T10:00:00Z"), story: ["SHOP-12"], rebuild: true })).toBe(0);
      expect(gl.log.some((l) => l.includes("updated_after=2025-10-20T10%3A00%3A00.000Z"))).toBe(true);
      // The list failed: the next sweep starts from the same time again.
      expect(readSweepState(repo).lastAt).toBeUndefined();
    } finally {
      await gl.close();
      await jira.close();
    }
  });
});

void GIT_ENV;
