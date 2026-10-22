import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { storyParts } from "../src/story.js";
import { upsertPart } from "../src/stories/parts.js";
import { JIRA_PROPERTY, emptyRecord, jiraStore, StoryRecordSchema } from "../src/stories/record.js";
import { cleanTmp, commit, g, serve, tmp } from "./helpers/mocks.js";

afterEach(() => {
  cleanTmp();
  vi.unstubAllEnvs();
});

function workspace() {
  const ws = tmp("qas-review-");
  const orders = path.join(ws, "orders");
  fs.mkdirSync(orders);
  g(orders, "init", "-q", "-b", "main");
  commit(orders, "base.js", "0", "initial");
  const tests = path.join(ws, "qa-tests");
  fs.mkdirSync(tests);
  const c = ConfigSchema.parse({
    version: 1,
    mode: "scratch",
    project: { name: "p" },
    workspace: { services: [{ name: "orders", path: "../orders", gitlabProject: "shop/orders" }] },
    tests: { api: { framework: "playwright", runCommand: "x" } },
    ci: { platform: "gitlab", gitlabUrl: "https://gl.example" },
  });
  return { ws, orders, tests, c };
}
const T = new Date("2026-10-20T10:00:00Z");
const partOf = (iid: number, o: Record<string, unknown>) => ({ service: "orders", source: "gitlab-mr" as const, iid, state: "merged" as const, keys: ["SHOP-106"], ...o });

describe("storyParts with a record", () => {
  it("a merge request the record lists is checked for a revert too (its commits name no key)", async () => {
    const { orders, tests, c } = workspace();
    const squash = commit(orders, "s.js", "1", "tidy up (#1)");
    g(orders, "revert", "--no-edit", squash);
    const rec = upsertPart(emptyRecord("SHOP-106", T), partOf(1, { squashSha: squash }), T);
    const { parts, notes } = await storyParts({ c, cwd: tests, story: "SHOP-106", record: rec });
    expect(parts).toEqual([]);
    expect(notes.join("\n")).toContain("!1 was reverted");
  });

  it("a follow-up commit the record does not list is still part of the story", async () => {
    const { orders, tests, c } = workspace();
    const squash = commit(orders, "one.js", "1", "tidy up (#1)");
    commit(orders, "other.js", "x", "SHOP-999 somebody else");
    commit(orders, "two.js", "2", "SHOP-106: follow-up (hotfix, no MR)");
    const rec = upsertPart(emptyRecord("SHOP-106", T), partOf(1, { squashSha: squash }), T);
    const { parts } = await storyParts({ c, cwd: tests, story: "SHOP-106", record: rec });
    expect(parts).toHaveLength(1);
    expect(parts[0].relevant.sort()).toEqual(["one.js", "two.js"]);
  });

  it("a rebased MR from sweep-shaped data (merged, no merge or squash commit, no diff base) gets its base from GitLab's single-MR call; without it the commit messages are read and the note says so", async () => {
    const { orders, tests, c } = workspace();
    const base = g(orders, "rev-parse", "HEAD");
    commit(orders, "r-a.js", "1", "SHOP-106: rebased a");
    const head = commit(orders, "r-b.js", "1", "SHOP-106: rebased b");
    commit(orders, "u.js", "x", "other");
    const rec = upsertPart(emptyRecord("SHOP-106", T), partOf(5, {}), T);

    const gl = await serve((_r, url) =>
      url.pathname.endsWith("/merge_requests/5") ? { body: { iid: 5, diff_refs: { base_sha: base, head_sha: head, start_sha: base } } } : { body: [], headers: { "x-next-page": "" } },
    );
    const down = await serve(() => ({ status: 404, body: {} }));
    try {
      const withRefs = await storyParts({ c, cwd: tests, story: "SHOP-106", record: rec, gitlab: { apiUrl: `${gl.url}/api/v4`, token: "t" } });
      expect(withRefs.parts[0].relevant.sort()).toEqual(["r-a.js", "r-b.js"]);
      expect(withRefs.notes.join("\n")).not.toContain("without a merge or squash commit");

      const without = await storyParts({ c, cwd: tests, story: "SHOP-106", record: rec, gitlab: { apiUrl: `${down.url}/api/v4`, token: "t" } });
      expect(without.notes.join("\n")).toContain("merged without a merge or squash commit");
      expect(without.parts[0].relevant.sort()).toEqual(["r-a.js", "r-b.js"]);
    } finally {
      await gl.close();
      await down.close();
    }
  });

  it("an open MR is fetched through the one-off token URL (never written to .git/config) and cut at the merge base", async () => {
    const { ws, orders, tests, c } = workspace();
    const origin = path.join(ws, "origin.git");
    g(ws, "init", "-q", "--bare", "-b", "main", origin);
    g(orders, "remote", "add", "origin", origin);
    g(orders, "push", "-q", "origin", "main");
    const other = path.join(ws, "other");
    g(ws, "clone", "-q", origin, other);
    commit(other, "open.js", "1", "open MR work");
    const head = g(other, "rev-parse", "HEAD");
    g(other, "push", "-q", "origin", "HEAD:refs/merge-requests/9/head");
    g(orders, "fetch", "-q", "origin", "main");
    // The "server" behind the token URL is the bare repository; `origin` itself would also work, so make origin useless.
    g(orders, "remote", "set-url", "origin", path.join(ws, "nowhere.git"));
    vi.stubEnv("QA_SENTINEL_GITLAB_TOKEN", "tok");
    vi.stubEnv("CI_SERVER_URL", undefined as unknown as string);
    vi.stubEnv("GIT_CONFIG_COUNT", "1");
    vi.stubEnv("GIT_CONFIG_KEY_0", `url.${origin}.insteadOf`);
    vi.stubEnv("GIT_CONFIG_VALUE_0", "https://oauth2:tok@gl.example/shop/orders.git");
    const rec = upsertPart(emptyRecord("SHOP-106", T), partOf(9, { state: "opened", headSha: head }), T);
    const { parts, notes } = await storyParts({ c, cwd: tests, story: "SHOP-106", record: rec });
    expect(notes).toEqual([]);
    expect(parts[0].relevant).toEqual(["open.js"]);
    expect(parts[0].heads).toEqual([head]);
    expect(fs.readFileSync(path.join(orders, ".git/config"), "utf8")).not.toContain("tok");
  });
});

describe("the story record in a Jira property", () => {
  it("the new part fields survive a round trip, and a malformed commit id is dropped on read", async () => {
    let stored: any;
    const jira = await serve((req, url, body) => {
      if (!url.pathname.includes(`/properties/${JIRA_PROPERTY}`)) return { status: 404, body: {} };
      if (req.method === "PUT") {
        stored = JSON.parse(body);
        return { status: 204, body: {} };
      }
      return stored ? { body: { key: JIRA_PROPERTY, value: stored } } : { status: 404, body: { errorMessages: ["nope"] } };
    });
    try {
      const dir = tmp("qas-jira-rec-");
      const store = jiraStore(dir, { baseUrl: jira.url, authHeader: "Bearer x" });
      const rec = upsertPart(emptyRecord("SHOP-12", T), partOf(5, { diffBase: "aaaa1111", headSha: "bbbb2222", mergedAt: "2026-10-19T08:00:00Z", workKey: "SHOP-210", branch: "fix/x", title: "t", url: "u" }), T);
      await store.save(rec);
      expect(stored.parts[0]).toMatchObject({ iid: 5, diffBase: "aaaa1111", headSha: "bbbb2222", workKey: "SHOP-210", state: "merged" });
      // A different runner (no local copy) reads it from Jira.
      const again = await jiraStore(tmp("qas-jira-rec2-"), { baseUrl: jira.url, authHeader: "Bearer x" }).load("SHOP-12");
      expect(again!.parts[0]).toMatchObject({ iid: 5, diffBase: "aaaa1111", headSha: "bbbb2222", workKey: "SHOP-210", mergedAt: "2026-10-19T08:00:00Z" });
      // Anything that is not a hex commit id is dropped, not trusted.
      const bad = StoryRecordSchema.parse({ ...rec, parts: [{ ...rec.parts[0], headSha: "--upload-pack=x", mergeSha: "a;b" }] });
      expect(bad.parts[0].headSha).toBeUndefined();
      expect(bad.parts[0].mergeSha).toBeUndefined();
      expect(bad.parts[0].diffBase).toBe("aaaa1111");
    } finally {
      await jira.close();
    }
  });
});
