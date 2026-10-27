import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addLabels, call, commentReactions, createOrUpdatePullRequest, getPrCommentBody, githubContext, githubPrFromEnv, githubPushUrl, githubToken, latestPrForBranch, openPrsWithLabel, prDiffRefs, prFiles, prIsDraft, upsertMarkedPrComment, upsertPrComment,
} from "../src/scm/github.js";
import { MARKER } from "../src/scm/gitlab.js";
import { githubMock } from "./helpers/mockGithub.js";
import { cleanTmp, tmp } from "./helpers/mocks.js";

const TOKEN = "ghs_secretTokenValue1234567890";
afterEach(() => {
  vi.unstubAllEnvs();
  cleanTmp();
});
const ctxOf = (url: string) => githubContext(url, { QA_SENTINEL_GITHUB_TOKEN: TOKEN })!;

describe("GitHub context", () => {
  it("token: QA_SENTINEL_GITHUB_TOKEN first, then GITHUB_TOKEN, then GH_TOKEN; none = no context", () => {
    expect(githubToken({ QA_SENTINEL_GITHUB_TOKEN: "a", GITHUB_TOKEN: "b" })).toBe("a");
    expect(githubToken({ GITHUB_TOKEN: "b", GH_TOKEN: "c" })).toBe("b");
    expect(githubToken({ GH_TOKEN: "c" })).toBe("c");
    expect(githubContext(undefined, {})).toBeUndefined();
  });
  it("API root: GITHUB_API_URL (set by Actions) wins over ci.githubApiUrl, then api.github.com; the push host follows", () => {
    expect(githubContext(undefined, { GITHUB_TOKEN: "t" })).toMatchObject({ apiUrl: "https://api.github.com", serverUrl: "https://github.com" });
    expect(githubContext("https://ghe.example/api/v3/", { GITHUB_TOKEN: "t" })).toMatchObject({ apiUrl: "https://ghe.example/api/v3", serverUrl: "https://ghe.example" });
    expect(githubContext("https://ghe.example/api/v3", { GITHUB_TOKEN: "t", GITHUB_API_URL: "https://other.example/api/v3", GITHUB_SERVER_URL: "https://other.example" })).toMatchObject({ apiUrl: "https://other.example/api/v3", serverUrl: "https://other.example" });
  });
});

describe("GitHub pull request context from the Actions environment", () => {
  const payload = (o: object) => {
    const f = path.join(tmp("qas-gh-event-"), "event.json");
    fs.writeFileSync(f, JSON.stringify(o));
    return f;
  };
  it("reads repository from GITHUB_REPOSITORY and everything else from the event payload and variables", () => {
    const mr = githubPrFromEnv({
      GITHUB_REPOSITORY: "octo/orders",
      GITHUB_BASE_REF: "main",
      GITHUB_HEAD_REF: "feature/SHOP-101",
      GITHUB_EVENT_PATH: payload({ pull_request: { number: 12, title: "SHOP-101 add cap", body: "AC1: cap is 3", html_url: "https://github.com/octo/orders/pull/12", base: { sha: "b".repeat(40), ref: "main" }, head: { ref: "feature/SHOP-101", sha: "h".repeat(40) } } }),
    });
    expect(mr).toEqual({ project: "octo/orders", mrIid: "12", base: "b".repeat(40), targetBranch: "main", title: "SHOP-101 add cap", description: "AC1: cap is 3", sourceBranch: "feature/SHOP-101", url: "https://github.com/octo/orders/pull/12" });
  });
  it("without a payload the number comes from refs/pull/<n>/merge and the base from GITHUB_BASE_REF; a broken payload is ignored", () => {
    expect(githubPrFromEnv({ GITHUB_REPOSITORY: "octo/orders", GITHUB_REF: "refs/pull/31/merge", GITHUB_BASE_REF: "main", GITHUB_SERVER_URL: "https://ghe.example" })).toMatchObject({ project: "octo/orders", mrIid: "31", base: "origin/main", targetBranch: "main", url: "https://ghe.example/octo/orders/pull/31" });
    const bad = path.join(tmp("qas-gh-event-"), "event.json");
    fs.writeFileSync(bad, "{ not json");
    expect(githubPrFromEnv({ GITHUB_REPOSITORY: "octo/orders", GITHUB_EVENT_PATH: bad, GITHUB_REF: "refs/pull/5/merge" }).mrIid).toBe("5");
  });
  it("a push event (no pull request) has no number; an issue_comment on a plain issue is not a pull request", () => {
    expect(githubPrFromEnv({ GITHUB_REPOSITORY: "octo/orders", GITHUB_REF: "refs/heads/main", GITHUB_EVENT_PATH: payload({ ref: "refs/heads/main" }) }).mrIid).toBeUndefined();
    expect(githubPrFromEnv({ GITHUB_REPOSITORY: "octo/orders", GITHUB_EVENT_PATH: payload({ issue: { number: 9 } }) }).mrIid).toBeUndefined();
    expect(githubPrFromEnv({ GITHUB_REPOSITORY: "octo/orders", GITHUB_EVENT_PATH: payload({ issue: { number: 9, pull_request: {} } }) }).mrIid).toBe("9");
  });
});

describe("GitHub push URL", () => {
  it("has the token only in the URL it returns, for github.com and for Enterprise; a bad path gives none", () => {
    expect(githubPushUrl("https://github.com", "octo/tests", { GITHUB_TOKEN: "tok en" })).toBe("https://x-access-token:tok%20en@github.com/octo/tests.git");
    expect(githubPushUrl("https://github.com", "octo/tests.git", { GITHUB_TOKEN: "t", GITHUB_SERVER_URL: "https://ghe.example/git" })).toBe("https://x-access-token:t@ghe.example/git/octo/tests.git");
    expect(githubPushUrl("https://github.com", "12345", { GITHUB_TOKEN: "t" })).toBeUndefined();
    expect(githubPushUrl("https://github.com", "octo/tests", {})).toBeUndefined();
  });
});

describe("GitHub client against a fake server", () => {
  it("sends the token as a Bearer header with the API version, never in the URL", async () => {
    const gh = await githubMock();
    try {
      await upsertPrComment(ctxOf(gh.url), "octo/orders", 12, "hello");
      expect(gh.headers[0]).toMatchObject({ authorization: `Bearer ${TOKEN}`, accept: "application/vnd.github+json", version: "2022-11-28" });
      expect(gh.log.join("\n")).not.toContain(TOKEN);
    } finally {
      await gh.close();
    }
  });

  it("one marker comment: created, then updated in place, never a second one; the stamp survives in the body", async () => {
    const gh = await githubMock();
    try {
      const ctx = ctxOf(gh.url);
      const a = await upsertPrComment(ctx, "octo/orders", 12, "report 1\n<!-- qa-sentinel:stamp fp=abc -->");
      const b = await upsertPrComment(ctx, "octo/orders", 12, "report 2");
      expect(a.action).toBe("created");
      expect(b).toEqual({ action: "updated", id: a.id });
      expect(gh.comments).toHaveLength(1);
      expect(gh.comments[0].body).toBe(`${MARKER}\nreport 2`);
      expect(await getPrCommentBody(ctx, "octo/orders", 12)).toBe(`${MARKER}\nreport 2`);
    } finally {
      await gh.close();
    }
  });

  it("only the token's own comments count: a comment by someone else that pastes the marker is ignored (via /user)", async () => {
    const gh = await githubMock();
    try {
      gh.comments.push({ id: 5, body: `${MARKER}\nfake`, user: { login: "mallory", id: 666, type: "User" }, html_url: "x" });
      const ctx = ctxOf(gh.url);
      expect(await getPrCommentBody(ctx, "octo/orders", 3)).toBeUndefined();
      const r = await upsertPrComment(ctx, "octo/orders", 3, "mine");
      expect(r.action).toBe("created");
      expect(gh.comments.find((c) => c.id === 5)!.body).toBe(`${MARKER}\nfake`);
    } finally {
      await gh.close();
    }
  });

  it("with the workflow token /user is refused: bot comments count, a person's pasted marker still does not", async () => {
    const gh = await githubMock({ userForbidden: true });
    try {
      gh.comments.push({ id: 5, body: `${MARKER}\nfake`, user: { login: "mallory", id: 666, type: "User" }, html_url: "x" });
      const ctx = ctxOf(gh.url);
      expect(await getPrCommentBody(ctx, "octo/orders", 3)).toBeUndefined();
      const a = await upsertPrComment(ctx, "octo/orders", 3, "one");
      const b = await upsertPrComment(ctx, "octo/orders", 3, "two");
      expect(b).toEqual({ action: "updated", id: a.id });
      expect(gh.comments.map((c) => c.body)).toEqual([`${MARKER}\nfake`, `${MARKER}\ntwo`]);
    } finally {
      await gh.close();
    }
  });

  it("finds the comment on a later page (Link header) instead of adding a second", async () => {
    const gh = await githubMock({ pageSize: 2 });
    try {
      const ctx = ctxOf(gh.url);
      for (const t of ["a", "b", "c"]) gh.comments.push({ id: gh.comments.length + 1, body: t, user: gh.me, html_url: "x" });
      gh.comments.push({ id: 50, body: `${MARKER}\nold`, user: gh.me, html_url: "x" });
      const r = await upsertPrComment(ctx, "octo/orders", 3, "new");
      expect(r).toEqual({ action: "updated", id: 50 });
      expect(gh.comments).toHaveLength(4);
    } finally {
      await gh.close();
    }
  });

  it("marked comments: created, same (nothing written), updated", async () => {
    const gh = await githubMock();
    try {
      const ctx = ctxOf(gh.url);
      const marker = "<!-- qa-sentinel:story-branch-blocked -->";
      expect(await upsertMarkedPrComment(ctx, "octo/tests", 7, marker, "blocked")).toBe("created");
      const writes = () => gh.log.filter((l) => /^(POST|PATCH)/.test(l)).length;
      const before = gh.log.length;
      expect(await upsertMarkedPrComment(ctx, "octo/tests", 7, marker, "blocked")).toBe("same");
      expect(gh.log.slice(before).every((l) => l.startsWith("GET"))).toBe(true);
      expect(await upsertMarkedPrComment(ctx, "octo/tests", 7, marker, "blocked again")).toBe("updated");
      expect(writes()).toBeGreaterThan(0);
      expect(gh.comments).toHaveLength(1);
    } finally {
      await gh.close();
    }
  });

  it("opens the test pull request with labels; a retry updates it and adds labels without removing a person's", async () => {
    const gh = await githubMock();
    try {
      const ctx = ctxOf(gh.url);
      const o = { source: "qa-sentinel/SHOP-101", target: "main", title: "QA agent: tests for SHOP-101", description: "body 1", labels: ["qa-agent", "story::SHOP-101"] };
      const a = await createOrUpdatePullRequest(ctx, "octo/tests", o);
      expect(a).toMatchObject({ action: "created", iid: 7, web_url: "https://github.com/octo/tests/pull/7" });
      gh.pulls[0].labels.push({ name: "reviewed-by-human" });
      const b = await createOrUpdatePullRequest(ctx, "octo/tests", { ...o, description: "body 2" });
      expect(b).toMatchObject({ action: "updated", iid: 7 });
      expect(gh.pulls).toHaveLength(1);
      expect(gh.pulls[0].body).toBe("body 2");
      expect(gh.pulls[0].labels.map((l) => l.name).sort()).toEqual(["qa-agent", "reviewed-by-human", "story::SHOP-101"]);
    } finally {
      await gh.close();
    }
  });

  it("a Draft: title becomes GitHub's draft flag and the prefix is dropped", async () => {
    const gh = await githubMock();
    try {
      await createOrUpdatePullRequest(ctxOf(gh.url), "octo/tests", { source: "qa-sentinel/x", target: "main", title: "Draft: QA agent: tests", description: "d" });
      expect(gh.pulls[0]).toMatchObject({ draft: true, title: "QA agent: tests" });
    } finally {
      await gh.close();
    }
  });

  it("latest pull request for a branch: open beats newer closed; merged and closed are told apart; none is undefined", async () => {
    const gh = await githubMock();
    try {
      const ctx = ctxOf(gh.url);
      const mk = (n: number, state: "open" | "closed", merged: boolean, day: number) => ({ number: n, state, title: `t${n}`, body: "", draft: false, html_url: `u${n}`, merged_at: merged ? "2026-01-01T00:00:00Z" : null, created_at: new Date(Date.UTC(2026, 0, day)).toISOString(), head: { ref: "qa-sentinel/s", sha: "h" }, base: { ref: "main", sha: "b" }, labels: [] });
      expect(await latestPrForBranch(ctx, "octo/tests", "qa-sentinel/s", "main")).toBeUndefined();
      gh.pulls.push(mk(1, "closed", true, 1), mk(2, "closed", false, 5));
      expect(await latestPrForBranch(ctx, "octo/tests", "qa-sentinel/s", "main")).toMatchObject({ iid: 2, state: "closed" });
      gh.pulls.splice(1, 1);
      expect(await latestPrForBranch(ctx, "octo/tests", "qa-sentinel/s")).toMatchObject({ iid: 1, state: "merged" });
      gh.pulls.push(mk(3, "open", false, 2));
      expect(await latestPrForBranch(ctx, "octo/tests", "qa-sentinel/s", "main")).toMatchObject({ iid: 3, state: "opened", web_url: "u3" });
    } finally {
      await gh.close();
    }
  });

  it("draft flag is asked from GitHub; unknown falls back to the title prefix; open agent PRs are found by label", async () => {
    const gh = await githubMock();
    try {
      const ctx = ctxOf(gh.url);
      await createOrUpdatePullRequest(ctx, "octo/tests", { source: "a", target: "main", title: "Draft: t", description: "", labels: ["qa-agent"] });
      await createOrUpdatePullRequest(ctx, "octo/tests", { source: "b", target: "main", title: "ready", description: "", labels: ["other"] });
      expect(await prIsDraft(ctx, "octo/tests", "7", "ready")).toBe(true);
      expect(await prIsDraft(ctx, "octo/tests", "8", "Draft: x")).toBe(false);
      expect(await prIsDraft(ctx, "octo/tests", "999", "Draft: x")).toBe(true); // 404: the title decides
      expect(await prIsDraft(undefined, undefined, undefined, "[Draft] x")).toBe(true);
      expect(await prIsDraft(undefined, undefined, undefined, "x")).toBe(false);
      expect(await openPrsWithLabel(ctx, "octo/tests", "qa-agent")).toEqual([{ iid: 7, web_url: "https://github.com/octo/tests/pull/7", source_branch: "a", title: "t" }]);
      await addLabels(ctx, "octo/tests", 8, []); // nothing to add: no call
    } finally {
      await gh.close();
    }
  });

  it("reads the changed files (all pages) and the diff refs of a pull request", async () => {
    const gh = await githubMock();
    try {
      const ctx = ctxOf(gh.url);
      await createOrUpdatePullRequest(ctx, "octo/orders", { source: "f", target: "main", title: "t", description: "" });
      gh.files[7] = [1, 2, 3].map((i) => ({ filename: `src/f${i}.ts`, status: i === 3 ? "removed" : "modified", additions: i, deletions: 0 }));
      expect((await prFiles(ctx, "octo/orders", 7)).map((f) => `${f.filename}:${f.status}`)).toEqual(["src/f1.ts:modified", "src/f2.ts:modified", "src/f3.ts:removed"]);
      expect(await prDiffRefs(ctx, "octo/orders", 7)).toEqual({ baseSha: "b".repeat(40), headSha: "h".repeat(40), targetBranch: "main", sourceBranch: "f" });
    } finally {
      await gh.close();
    }
  });

  it("reads reactions on a comment", async () => {
    const gh = await githubMock();
    try {
      gh.reactions[1001] = [{ content: "+1" }, { content: "-1" }, { content: "heart" }];
      expect((await commentReactions(ctxOf(gh.url), "octo/orders", 1001)).map((r) => r.content)).toEqual(["+1", "-1", "heart"]);
    } finally {
      await gh.close();
    }
  });

  it("retries a 502 and a rate limit (403 with Retry-After); a 404 is not retried", async () => {
    const gh = await githubMock({ failFirst: { n: 1, status: 502 } });
    try {
      expect((await call(ctxOf(gh.url), "GET", "/user")).data.login).toBe("qa-bot");
      expect(gh.log.filter((l) => l === "GET /user")).toHaveLength(2);
    } finally {
      await gh.close();
    }
    const limited = await githubMock({ failFirst: { n: 1, status: 403, headers: { "retry-after": "1" } } });
    try {
      expect((await call(ctxOf(limited.url), "GET", "/user")).data.login).toBe("qa-bot");
    } finally {
      await limited.close();
    }
    const missing = await githubMock();
    try {
      await expect(call(ctxOf(missing.url), "GET", "/repos/octo/orders/pulls/99")).rejects.toThrow(/404/);
      expect(missing.log.filter((l) => l.includes("pulls/99"))).toHaveLength(1);
    } finally {
      await missing.close();
    }
  });

  it("an error message never carries the token, even when the server echoes the Authorization header", async () => {
    const gh = await githubMock({ echoAuthInErrors: true });
    try {
      const err = await call(ctxOf(gh.url), "GET", "/nope").catch((e) => e as Error);
      expect(err.message).toContain("422");
      expect(err.message).not.toContain(TOKEN);
    } finally {
      await gh.close();
    }
  });

  it("agent-written text with a credential is masked before it is sent", async () => {
    const gh = await githubMock();
    vi.stubEnv("SOME_API_KEY", "super-secret-value-123");
    try {
      await upsertPrComment(ctxOf(gh.url), "octo/orders", 1, "leaked super-secret-value-123 here");
      expect(gh.comments[0].body).toContain("[redacted]");
      expect(gh.comments[0].body).not.toContain("super-secret-value-123");
    } finally {
      await gh.close();
    }
  });

  it("a repository that is not owner/repo is refused before any call", async () => {
    const gh = await githubMock();
    try {
      await expect(upsertPrComment(ctxOf(gh.url), "12345", 1, "x")).rejects.toThrow(/owner\/repo/);
      expect(gh.log).toHaveLength(0);
    } finally {
      await gh.close();
    }
  });
});
