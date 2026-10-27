import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";
import { call, createOrUpdatePullRequest, getAll, getPrCommentBody, githubContext, timing, upsertPrComment } from "../src/scm/github.js";
import { MARKER } from "../src/scm/gitlab.js";
import { ConfigSchema, writeConfig } from "../src/config.js";
import { generateCommand } from "../src/commands/generate.js";
import { forcePush } from "../src/generation/forcePush.js";
import { initCommand } from "../src/commands/init.js";
import { githubMock } from "./helpers/mockGithub.js";
import { GIT_ENV, cleanTmp, g, serve, tmp, commit } from "./helpers/mocks.js";

const TOKEN = "ghp_reviewTokenValue1234567890";
const ctxOf = (url: string, bot?: string) => githubContext(url, { QA_SENTINEL_GITHUB_TOKEN: TOKEN }, bot)!;

let waits: number[] = [];
const realSleep = timing.sleep;
beforeEach(() => {
  waits = [];
  timing.sleep = async (ms) => void waits.push(ms);
});
afterEach(() => {
  timing.sleep = realSleep;
  vi.unstubAllEnvs();
  cleanTmp();
});

describe("who our comment is (M2, M3)", () => {
  it("a personal token whose /user answers 502 is retried and then STOPS: no duplicate comment is posted", async () => {
    const gh = await githubMock({ userStatus: 502 });
    try {
      gh.comments.push({ id: 1, body: `${MARKER}\nold`, user: { login: "qa-bot", id: 42, type: "User" }, html_url: "x" });
      await expect(upsertPrComment(ctxOf(gh.url), "octo/orders", 3, "new")).rejects.toThrow(/502/);
      expect(gh.log.filter((l) => l === "GET /user").length).toBeGreaterThan(1); // retried
      expect(gh.log.some((l) => l.startsWith("POST"))).toBe(false);
      expect(gh.comments).toHaveLength(1);
    } finally {
      await gh.close();
    }
  });

  it("with /user refused, only github-actions[bot] comments are ours: another app's marker comment is not read or edited", async () => {
    const gh = await githubMock({ userForbidden: true });
    try {
      gh.comments.push({ id: 7, body: `quote: ${MARKER}\nstamp from another tool`, user: { login: "some-other-app[bot]", id: 999, type: "Bot" }, html_url: "x" });
      const ctx = ctxOf(gh.url);
      expect(await getPrCommentBody(ctx, "octo/orders", 3)).toBeUndefined();
      const a = await upsertPrComment(ctx, "octo/orders", 3, "ours");
      expect(a.action).toBe("created");
      expect(gh.comments.find((c) => c.id === 7)!.body).toContain("stamp from another tool");
      expect(gh.log.filter((l) => l.startsWith("PATCH"))).toEqual([]);
      const b = await upsertPrComment(ctx, "octo/orders", 3, "ours again");
      expect(b).toEqual({ action: "updated", id: a.id });
    } finally {
      await gh.close();
    }
  });

  it("the bot login can be set (ci.githubBotLogin) for an App token", async () => {
    const gh = await githubMock({ userForbidden: true });
    try {
      gh.comments.push({ id: 7, body: `${MARKER}\nmine`, user: { login: "qa-sentinel-app[bot]", id: 5, type: "Bot" }, html_url: "x" });
      const r = await upsertPrComment(ctxOf(gh.url, "qa-sentinel-app[bot]"), "octo/orders", 3, "edited");
      expect(r).toEqual({ action: "updated", id: 7 });
    } finally {
      await gh.close();
    }
  });
});

describe("rate limits and retries (M5, L4)", () => {
  it("primary limit: 403 with x-ratelimit-remaining 0 waits until x-ratelimit-reset", async () => {
    const reset = String(Math.floor(Date.now() / 1000) + 30);
    const gh = await githubMock({ failFirst: { n: 1, status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset }, message: "API rate limit exceeded" } });
    try {
      expect((await call(ctxOf(gh.url), "GET", "/user")).data.login).toBe("qa-bot");
      expect(waits).toHaveLength(1);
      expect(waits[0]).toBeGreaterThan(25_000);
      expect(waits[0]).toBeLessThanOrEqual(32_000);
    } finally {
      await gh.close();
    }
  });

  it("a limit with no header waits a minute; a far reset and a huge Retry-After are capped at 120 s", async () => {
    const none = await githubMock({ failFirst: { n: 1, status: 403, message: "You have exceeded a secondary rate limit." } });
    try {
      await call(ctxOf(none.url), "GET", "/user");
      expect(waits).toEqual([60_000]);
    } finally {
      await none.close();
    }
    waits = [];
    const far = await githubMock({ failFirst: { n: 1, status: 429, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600) } } });
    try {
      await call(ctxOf(far.url), "GET", "/user");
      expect(waits).toEqual([120_000]);
    } finally {
      await far.close();
    }
    waits = [];
    const big = await githubMock({ failFirst: { n: 1, status: 403, headers: { "retry-after": "3600" } } });
    try {
      await call(ctxOf(big.url), "GET", "/user");
      expect(waits).toEqual([120_000]);
    } finally {
      await big.close();
    }
  });

  it("a plain 403 (no limit) is not retried", async () => {
    const gh = await githubMock({ failFirst: { n: 5, status: 403, message: "Resource not accessible by integration" } });
    try {
      await expect(call(ctxOf(gh.url), "GET", "/user")).rejects.toThrow(/403/);
      expect(gh.log).toHaveLength(1);
      expect(waits).toEqual([]);
    } finally {
      await gh.close();
    }
  });

  it("a POST is not repeated after a 5xx (it may have been done); a GET is; a POST is repeated after a rate limit", async () => {
    const gh = await githubMock({ failFirst: { n: 1, status: 502 } });
    try {
      await expect(call(ctxOf(gh.url), "POST", "/repos/octo/orders/issues/3/comments", { body: "x" })).rejects.toThrow(/502/);
      expect(gh.log).toHaveLength(1);
      expect(gh.comments).toHaveLength(0);
    } finally {
      await gh.close();
    }
    const limited = await githubMock({ failFirst: { n: 1, status: 429 } });
    try {
      await call(ctxOf(limited.url), "POST", "/repos/octo/orders/issues/3/comments", { body: "x" });
      expect(limited.comments).toHaveLength(1);
    } finally {
      await limited.close();
    }
  });
});

describe("paging only follows the API's own address (L1)", () => {
  it("a next link to another host, or to a host that merely starts with the API address, is not followed", async () => {
    for (const evil of ["http://127.0.0.1:1/x?page=2", "http://example.invalid/x?page=2"]) {
      const gh = await githubMock({ nextLink: evil });
      try {
        gh.comments.push({ id: 1, body: "a", user: gh.me, html_url: "x" });
        const all = await getAll(ctxOf(gh.url), "/repos/octo/orders/issues/3/comments");
        expect(all).toHaveLength(1);
        expect(gh.log).toHaveLength(1);
      } finally {
        await gh.close();
      }
    }
    const look = await serve((_req, url) => ({ body: [{ id: 1 }], headers: { link: `<${look.url}.evil.example${url.pathname}?page=2>; rel="next"` } }));
    try {
      expect(await getAll(ctxOf(look.url), "/repos/o/r/x")).toHaveLength(1);
      expect(look.log).toHaveLength(1);
    } finally {
      await look.close();
    }
  });

  it("Enterprise Server paging works under /api/v3", async () => {
    const seen: string[] = [];
    const ghe = await serve((req, url) => {
      seen.push(url.pathname + url.search);
      const page = Number(url.searchParams.get("page") ?? 1);
      return { body: [{ id: page }], headers: page < 3 ? { link: `<http://${req.headers.host}/api/v3/repos/o/r/x?per_page=100&page=${page + 1}>; rel="next"` } : {} };
    });
    try {
      const ctx = githubContext(`${ghe.url}/api/v3`, { QA_SENTINEL_GITHUB_TOKEN: TOKEN })!;
      expect((await getAll(ctx, "/repos/o/r/x")).map((x) => x.id)).toEqual([1, 2, 3]);
      expect(seen.every((p) => p.startsWith("/api/v3/repos/o/r/x"))).toBe(true);
    } finally {
      await ghe.close();
    }
  });
});

describe("API address (L2)", () => {
  it("plain http is refused except on this machine; https and Enterprise paths are fine", () => {
    expect(() => githubContext("http://ghe.example/api/v3", { GITHUB_TOKEN: "t" })).toThrow(/https/);
    expect(() => githubContext(undefined, { GITHUB_TOKEN: "t", GITHUB_API_URL: "http://ghe.example/api/v3" })).toThrow(/https/);
    expect(() => githubContext("not a url", { GITHUB_TOKEN: "t" })).toThrow(/not a URL/);
    expect(githubContext("https://ghe.example/api/v3", { GITHUB_TOKEN: "t" })).toBeDefined();
    expect(githubContext("http://127.0.0.1:9", { GITHUB_TOKEN: "t" })).toBeDefined();
    expect(githubContext("http://localhost:9", { GITHUB_TOKEN: "t" })).toBeDefined();
  });
});

describe("draft state (L3)", () => {
  const o = { source: "qa-sentinel/x", target: "main", description: "d", labels: ["qa-agent"] };
  it("a pull request opened as a draft is marked ready when a later run is not a draft, and back", async () => {
    const gh = await githubMock();
    try {
      const ctx = ctxOf(gh.url);
      await createOrUpdatePullRequest(ctx, "octo/tests", { ...o, title: "Draft: QA agent: tests" });
      expect(gh.pulls[0].draft).toBe(true);
      const r = await createOrUpdatePullRequest(ctx, "octo/tests", { ...o, title: "QA agent: tests" });
      expect(r.action).toBe("updated");
      expect(gh.pulls[0]).toMatchObject({ draft: false, title: "QA agent: tests" });
      await createOrUpdatePullRequest(ctx, "octo/tests", { ...o, title: "Draft: QA agent: tests" });
      expect(gh.pulls[0].draft).toBe(true);
    } finally {
      await gh.close();
    }
  });
  it("a repository without drafts (422) gets a normal pull request, with a note", async () => {
    const gh = await githubMock({ noDrafts: true });
    try {
      const r = await createOrUpdatePullRequest(ctxOf(gh.url), "octo/tests", { ...o, title: "Draft: t" });
      expect(r.action).toBe("created");
      expect(r.note).toMatch(/not available/);
      expect(gh.pulls[0].draft).toBe(false);
    } finally {
      await gh.close();
    }
  });
});

describe("the token is masked when a push fails (M1)", () => {
  it("forcePush: git's message carries the URL and the token; the error does not", () => {
    const repo = tmp("qas-push-");
    g(repo, "init", "-q", "-b", "main");
    commit(repo, "a.txt", "a", "a");
    let msg = "";
    try {
      forcePush(repo, `http://x-access-token:${TOKEN}@127.0.0.1:1/octo/tests.git`, "qa-sentinel/x", { ...process.env, ...GIT_ENV });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).not.toBe("");
    expect(msg).not.toContain(TOKEN);
  });

  it("the CLI prints errors masked", () => {
    const dir = tmp("qas-cli-");
    const cli = path.resolve("src/cli.ts");
    const r = spawnSync(path.resolve("node_modules/.bin/tsx"), [cli, "-C", path.join(dir, TOKEN), "gap-report", "--service", "x"], { encoding: "utf8", env: { ...process.env, ...GIT_ENV, QA_SENTINEL_GITHUB_TOKEN: TOKEN } });
    const out = `${r.stdout}${r.stderr}`;
    expect(out).toContain("No qa-sentinel.config.yaml"); // the message does carry the path...
    expect(out).toContain("[redacted]"); // ...with the token in it masked
    expect(out).not.toContain(TOKEN);
  });
});

describe("story-mode generate on GitHub (M6)", () => {
  it("is refused with a clear message instead of pushing and opening nothing", async () => {
    const root = tmp("qas-story-gh-");
    writeConfig(root, ConfigSchema.parse({ version: 1, mode: "existing", level: "maintenance", project: { name: "t" }, workspace: { services: [{ name: "orders", path: "orders" }] }, tests: { api: { framework: "playwright", runCommand: "npx playwright test" } }, ci: { platform: "github", provider: "github" } }));
    await expect(generateCommand({ cwd: root, service: "orders", story: "SHOP-101" })).rejects.toThrow(/GitLab only for now/);
  });
});

describe("the GitHub workflow template", () => {
  async function wf() {
    const repo = tmp("qas-gh-wf-");
    execFileSync("git", ["init", "-q"], { cwd: repo, env: { ...process.env, ...GIT_ENV } });
    await initCommand({ cwd: repo, yes: true, mode: "scratch", ci: "github", level: "intelligence", name: "t", workspace: tmp("qas-gh-empty-") });
    const raw = fs.readFileSync(path.join(repo, "ci/qa-sentinel/qa-gap-report.yml"), "utf8");
    return { raw, doc: YAML.parse(raw, { logLevel: "error" }) };
  }
  it("an incomplete analysis still reaches publish: the gap-report step is continue-on-error and publish runs after a successful job", async () => {
    const { doc } = await wf();
    const step = doc.jobs.analysis.steps.find((s: { name?: string }) => s.name?.startsWith("Gap report"));
    expect(step["continue-on-error"]).toBe(true);
    expect(doc.jobs.publish.if).toContain("needs.analysis.result == 'success'");
    // The steps after it must run whatever happened.
    const after = doc.jobs.analysis.steps.slice(doc.jobs.analysis.steps.indexOf(step) + 1);
    expect(after.length).toBeGreaterThan(0);
    for (const s of after) expect(s.if).toContain("always()");
  });
  it("never uses pull_request_target; removes symbolic links from the artifact both ways; asks publish for gap-report runs only", async () => {
    const { raw, doc } = await wf();
    expect(raw).not.toContain("pull_request_target");
    expect(Object.keys(doc.on)).toEqual(["pull_request"]);
    expect(raw).toContain("find qa-runs -type l -delete");
    expect(raw).toContain("find handover -type l -delete");
    expect(raw).toContain("--kind gap-report");
    expect(raw).toContain("QA_CLAUDE_CODE_VERSION");
  });
});
