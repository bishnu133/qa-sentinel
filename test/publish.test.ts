import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A fake agent runtime (no model is called): it writes the plan and the test file the prompt asks for.
const fake = vi.hoisted(() => ({ calls: [] as string[], planFails: false }));
vi.mock("../src/engines/ClaudeCodeEngine.js", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  return {
    engineFor: () => ({
      name: "fake",
      available: () => ({ ok: true }),
      run: async (t: { kind: string; prompt: string; cwd: string }) => {
        fake.calls.push(t.kind);
        if (fake.planFails) return { ok: false, status: "error", result: "fake engine: no model in tests" };
        const ctxRel = /Run context: (\S+?\/context\.json)/.exec(t.prompt)?.[1];
        const ctx = ctxRel ? JSON.parse(fs.readFileSync(path.join(t.cwd, ctxRel), "utf8")) : undefined;
        const scope: string[] = ctx?.acScope ?? ctx?.acceptanceCriteriaIds ?? [];
        if (t.kind === "plan" && ctx) {
          const ev = [{ source: "source-code", file: "src/app.js", line: 1, reference: "x" }];
          const plan = {
            schemaVersion: 1,
            verdict: "tests for " + scope.join(","),
            recommendedAction: "write them",
            changes: [{ id: "c1", type: "business-rule", summary: "slot cap", observable: true, requirementIds: scope, oracleStatus: "approved", riskFactors: ["business-rule"], evidence: ev }],
            decisions: [{ changeId: "c1", coverage: "missing", decision: "create", reason: "r", existingTests: [], targetFile: `tests/api/${scope.map((s) => s.toLowerCase()).join("-")}.spec.ts`, proposedScenarios: scope.map((ac) => ({ title: `${ac} works`, requirementIds: [ac], behaviourIds: [], assertions: ["a"] })), evidence: ev }],
            requirementStatus: scope.map((id) => ({ id, status: "implemented", evidence: ev })),
          };
          fs.writeFileSync(path.join(t.cwd, ctx.planPath), JSON.stringify(plan));
          return { ok: true, status: "ok", result: "done", costUsd: 0.5 };
        }
        if (t.kind === "author" && ctx) {
          fs.mkdirSync(path.join(t.cwd, "tests/api"), { recursive: true });
          fs.writeFileSync(path.join(t.cwd, `tests/api/${scope.map((s) => s.toLowerCase()).join("-")}.spec.ts`), scope.map((ac) => `test("${ac} works @story:SHOP-101 @ac:${ac}", () => { expect(1).toBe(1); });`).join("\n") + "\n");
          return { ok: true, status: "ok", result: "Added tests.", costUsd: 0.5 };
        }
        return { ok: false, status: "error", result: "fake engine: nothing for " + t.kind };
      },
    }),
  };
});

import { ConfigSchema, writeConfig } from "../src/config.js";
import { generateCommand } from "../src/commands/generate.js";
import { gapReportCommand } from "../src/commands/gapReport.js";
import { publishCommand } from "../src/commands/publish.js";
import { deferSteps, bundleBranch, PUBLISH_FILE } from "../src/reporting/deferred.js";
import { fileStore } from "../src/stories/record.js";
import { GIT_ENV, cleanTmp, commit, g, serve, tmp } from "./helpers/mocks.js";
import { mockJira } from "./helpers/mockJira.js";

const READ = "read-only-token";
const WRITE = "write-token";

interface Seen {
  method: string;
  path: string;
  token?: string;
  body: string;
}
/** A GitLab under the sub-path /gitlab that records every request with the token it came with. */
async function gitlabMock(o: { project: string }) {
  const seen: Seen[] = [];
  let created = false;
  const enc = encodeURIComponent(o.project);
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      seen.push({ method: req.method ?? "", path: url.pathname, token: req.headers["private-token"] as string | undefined, body });
      const send = (status: number, b: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(b));
      };
      const p = url.pathname.replace(/^\/gitlab\/api\/v4/, "");
      if (!url.pathname.startsWith("/gitlab/api/v4/")) return send(404, {});
      if (p === "/user") return send(200, { id: 1, username: "bot" });
      if (p === `/projects/${enc}/merge_requests` && req.method === "POST") {
        created = true;
        return send(201, { iid: 5, web_url: "http://gl.example/gitlab/qa/-/merge_requests/5" });
      }
      if (/\/merge_requests\/\d+\/notes$/.test(p) && req.method === "POST") return send(201, { id: 11 });
      if (/\/notes$/.test(p)) return send(200, []);
      if (/\/merge_requests/.test(p) && req.method === "GET") return send(200, created && /state=opened&source_branch/.test(url.search) ? [{ iid: 5, web_url: "http://gl.example/gitlab/qa/-/merge_requests/5" }] : []);
      send(404, {});
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/gitlab`;
  return { url, seen, writes: () => seen.filter((s) => s.method !== "GET"), close: () => new Promise<void>((ok) => (server.closeAllConnections?.(), server.close(() => ok()))) };
}

let closers: (() => Promise<void>)[] = [];
beforeEach(() => {
  vi.stubEnv("CI", "");
  for (const [k, v] of Object.entries({ ...GIT_ENV, GIT_TERMINAL_PROMPT: "0" })) vi.stubEnv(k, v);
  vi.stubEnv("JIRA_PAT", "pat");
  vi.stubEnv("JIRA_EMAIL", "");
  vi.stubEnv("ANTHROPIC_API_KEY", "");
  fake.calls.length = 0;
  fake.planFails = false;
});
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const c of closers.splice(0)) await c();
  cleanTmp();
});

const AC1 = "A slot takes at most 3 orders.";

describe("split CI jobs: generate --defer-publish, then publish", () => {
  async function world() {
    const root = tmp("qas-pub-");
    const origin = path.join(root, "origin.git");
    fs.mkdirSync(origin);
    g(origin, "init", "-q", "--bare", "-b", "main");
    const qa = path.join(root, "qa-tests");
    const orders = path.join(root, "orders");
    for (const d of [qa, orders]) {
      fs.mkdirSync(d);
      g(d, "init", "-q", "-b", "main");
    }
    commit(orders, "src/app.js", "v1", "init");
    commit(orders, "src/app.js", "v2", "SHOP-101 orders: cap a slot");
    const jira = await mockJira({ issues: { "SHOP-101": { summary: "Delivery slots", issuetype: { name: "Story" }, status: { name: "In Progress" }, description: `## Acceptance criteria\n- AC-1: ${AC1}\n`, labels: [], components: [] } } });
    const gl = await gitlabMock({ project: "42" });
    closers.push(jira.close, gl.close);
    writeConfig(
      qa,
      ConfigSchema.parse({
        version: 1,
        mode: "existing",
        project: { name: "t" },
        level: "maintenance",
        workspace: { services: [{ name: "orders", path: "../orders" }] },
        tests: { api: { framework: "mocha", runCommand: "node runner.js" }, expectations: "off" },
        ci: { platform: "gitlab", targetBranch: "main", gitlabUrl: gl.url, testRepoProject: "42" },
        requirements: { source: "jira", jira: { baseUrl: jira.baseUrl, projectKeys: ["SHOP"] } },
        reporting: { targets: ["gitlab-mr", "jira"] },
        generation: { scope: "story" },
        verification: { preflight: false, requireVerifiedToPush: false },
        review: { enabled: false },
        guardrails: { allowedHosts: [] },
      }),
    );
    fs.writeFileSync(path.join(qa, "runner.js"), "process.exit(0);\n");
    fs.writeFileSync(path.join(qa, ".gitignore"), ".qa-sentinel/\nqa-sentinel-summary.md\n");
    g(qa, "add", "-A");
    g(qa, "commit", "-q", "-m", "init tests");
    g(qa, "remote", "add", "origin", origin);
    g(qa, "push", "-q", "origin", "main");
    return { root, qa, origin, orders, jira, gl };
  }
  // The analysis job: a model key (the fake engine) and a read-only GitLab token. No write token anywhere in this environment.
  const analysisEnv = (gl: string) => ({ CI: "true", QA_SENTINEL_GITLAB_TOKEN: READ, CI_API_V4_URL: `${gl}/api/v4` });

  it("analysis writes no GitLab object and pushes nothing; publish then pushes from the bundle and opens the MR with the write token, and needs no model key", async () => {
    const w = await world();
    vi.stubEnv("QA_SENTINEL_GITLAB_TOKEN", READ);
    const code = await generateCommand({ cwd: w.qa, service: "orders", base: "HEAD~1", head: "HEAD", servicePath: w.orders, deferPublish: true, processEnv: analysisEnv(w.gl.url) });
    expect(code).toBe(0);
    expect(fake.calls).toContain("author");
    // Nothing was written anywhere: no non-GET request to GitLab, nothing on the server, no Jira comment.
    expect(w.gl.writes()).toEqual([]);
    expect(w.gl.seen.every((s) => s.token === READ || s.token === undefined)).toBe(true);
    expect(g(w.origin, "branch", "--list", "qa-sentinel/*")).toBe("");
    expect(w.jira.comments["SHOP-101"] ?? []).toEqual([]);
    const runsDir = path.join(w.qa, ".qa-sentinel/runs");
    const runId = fs.readdirSync(runsDir).find((n) => fs.existsSync(path.join(runsDir, n, PUBLISH_FILE)))!;
    const doc = JSON.parse(fs.readFileSync(path.join(runsDir, runId, PUBLISH_FILE), "utf8"));
    expect(doc).toMatchObject({ version: 1, kind: "generate", runId });
    const step = doc.steps[0];
    expect(step).toMatchObject({ type: "merge-request", branch: "qa-sentinel/story-SHOP-101", pushMode: "story", storyMode: true, target: "main", project: "42" });
    expect(step.labels).toEqual(expect.arrayContaining(["qa-agent", "story::SHOP-101", "service::orders"]));
    expect(step.title).toBe("QA agent: tests for story SHOP-101");
    expect(fs.existsSync(path.join(runsDir, runId, "branch.bundle"))).toBe(true);
    expect(step.headSha).toBe(g(w.qa, "rev-parse", "HEAD"));

    // The publish job: the write token and a Jira login, no model credentials at all.
    const env = { QA_SENTINEL_GITLAB_TOKEN: WRITE, JIRA_PAT: "pat", CI_API_V4_URL: `${w.gl.url}/api/v4` };
    expect(Object.keys(env).some((k) => /ANTHROPIC|CLAUDE/.test(k))).toBe(false);
    const callsBefore = fake.calls.length;
    expect(await publishCommand({ cwd: w.qa, run: runId, env })).toBe(0);
    expect(fake.calls.length).toBe(callsBefore); // publishing never starts an agent
    expect(g(w.origin, "rev-parse", "qa-sentinel/story-SHOP-101")).toBe(step.headSha);
    const posts = w.gl.writes();
    expect(posts.map((p) => `${p.method} ${p.path}`)).toEqual(["POST /gitlab/api/v4/projects/42/merge_requests"]);
    expect(posts[0].token).toBe(WRITE);
    expect(JSON.parse(posts[0].body)).toMatchObject({ source_branch: "qa-sentinel/story-SHOP-101", target_branch: "main", title: step.title });
    // Jira got the summary with the MR link, and the record knows the agent MR.
    expect((w.jira.comments["SHOP-101"] ?? []).some((c) => c.body.includes("merge_requests/5"))).toBe(true);
    expect((await fileStore(w.qa).load("SHOP-101"))?.agentMr).toMatchObject({ branch: "qa-sentinel/story-SHOP-101", iid: 5, state: "opened" });
    // Published once: "all" finds nothing waiting afterwards.
    expect(fs.existsSync(path.join(runsDir, runId, "published.json"))).toBe(true);
    expect(await publishCommand({ cwd: w.qa, env })).toBe(0);
    expect(w.gl.writes()).toHaveLength(1);
  }, 120_000);

  it("refuses to push a bundle that breaks the write policy (the agent output is checked again in the job that holds the write token)", async () => {
    const w = await world();
    g(w.qa, "checkout", "-q", "-b", "qa-sentinel/story-SHOP-101");
    const base = g(w.qa, "rev-parse", "HEAD");
    const head = commit(w.qa, "src/evil.js", "module.exports = 1;\n", "agent: sneaky");
    const run = path.join(w.qa, ".qa-sentinel/runs/2026-10-22T10-00-00-000Z-gen-orders");
    fs.mkdirSync(run, { recursive: true });
    bundleBranch(w.qa, run, "qa-sentinel/story-SHOP-101");
    deferSteps(run, "generate", path.basename(run), [{ type: "merge-request", branch: "qa-sentinel/story-SHOP-101", headSha: head, baseSha: base, target: "main", project: "42", pushMode: "story", storyMode: true, storyKey: "SHOP-101", title: "t", description: "d", labels: ["qa-agent"] }]);
    g(w.qa, "checkout", "-q", "main");
    expect(await publishCommand({ cwd: w.qa, run: path.basename(run), env: { QA_SENTINEL_GITLAB_TOKEN: WRITE } })).toBe(1);
    expect(g(w.origin, "branch", "--list", "qa-sentinel/*")).toBe("");
    expect(w.gl.writes()).toEqual([]);
    expect(fs.existsSync(path.join(run, "published.json"))).toBe(false);
  });

  it("does not overwrite a story branch that moved on the server since the analysis", async () => {
    const w = await world();
    // The branch exists on the server (a reviewer pushed); the bundle was made from an older tip.
    g(w.qa, "checkout", "-q", "-b", "qa-sentinel/story-SHOP-101");
    const base = g(w.qa, "rev-parse", "HEAD");
    const head = commit(w.qa, "tests/api/ac-1.spec.ts", 'test("AC-1 works @story:SHOP-101 @ac:AC-1", () => {});\n', "agent: tests");
    const run = path.join(w.qa, ".qa-sentinel/runs/2026-10-22T11-00-00-000Z-gen-orders");
    fs.mkdirSync(run, { recursive: true });
    bundleBranch(w.qa, run, "qa-sentinel/story-SHOP-101");
    g(w.qa, "checkout", "-q", "main");
    const reviewer = path.join(w.root, "reviewer");
    g(w.root, "clone", "-q", w.origin, reviewer);
    g(reviewer, "checkout", "-q", "-b", "qa-sentinel/story-SHOP-101");
    const theirs = commit(reviewer, "REVIEW.md", "note\n", "reviewer");
    g(reviewer, "push", "-q", "origin", "qa-sentinel/story-SHOP-101");
    deferSteps(run, "generate", path.basename(run), [{ type: "merge-request", branch: "qa-sentinel/story-SHOP-101", headSha: head, baseSha: base, target: "main", project: "42", pushMode: "story", storyMode: true, title: "t", description: "d", labels: [] }]); // expectSha: none = "the branch must not exist"
    expect(await publishCommand({ cwd: w.qa, run: path.basename(run), env: { QA_SENTINEL_GITLAB_TOKEN: WRITE } })).toBe(1);
    expect(g(w.origin, "rev-parse", "qa-sentinel/story-SHOP-101")).toBe(theirs);
    expect(w.gl.writes()).toEqual([]);
  });
});

describe("split CI jobs: gap-report --defer-publish, then publish", () => {
  it("writes the MR note, the Jira section and the record only in publish", async () => {
    const jira = await mockJira({ issues: { "SHOP-12": { summary: "Delivery slots", issuetype: { name: "Story" }, status: { name: "In Progress" }, description: "## Acceptance criteria\n- AC-1: A slot takes at most 3 orders.\n", labels: [], components: [] } } });
    const gl = await gitlabMock({ project: "7" });
    closers.push(jira.close, gl.close);
    const root = tmp("qas-pubgap-");
    const repo = path.join(root, "orders");
    g(root, "init", "-q", "-b", "main");
    fs.mkdirSync(repo, { recursive: true });
    g(repo, "init", "-q", "-b", "main");
    commit(repo, "src/a.ts", "export const a = 0;\n", "base");
    const baseSha = g(repo, "rev-parse", "HEAD");
    g(repo, "checkout", "-q", "-b", "feature/SHOP-12-slots");
    const head = commit(repo, "src/a.ts", "export const a = 0;\nexport const b = 1;\n", "SHOP-12 change");
    writeConfig(
      root,
      ConfigSchema.parse({
        version: 1,
        mode: "existing",
        project: { name: "t" },
        workspace: { services: [{ name: "orders", path: "orders", gitlabProject: "shop/orders" }] },
        tests: { api: { framework: "playwright", runCommand: "npx playwright test" } },
        ci: { platform: "gitlab", gitlabUrl: gl.url },
        requirements: { source: "jira", jira: { baseUrl: jira.baseUrl, projectKeys: ["SHOP"], featureIssueTypes: ["Story"] } },
        reporting: { targets: ["gitlab-mr", "jira"] },
      }),
    );
    fake.planFails = true; // "analysis incomplete" is enough here
    vi.stubEnv("QA_SENTINEL_GITLAB_TOKEN", READ);
    vi.stubEnv("CI_PROJECT_ID", "7");
    vi.stubEnv("CI_MERGE_REQUEST_IID", "7");
    vi.stubEnv("CI_MERGE_REQUEST_TITLE", "SHOP-12 slots");
    vi.stubEnv("CI_MERGE_REQUEST_SOURCE_BRANCH_NAME", "feature/SHOP-12-slots");
    vi.stubEnv("CI_MERGE_REQUEST_SOURCE_BRANCH_SHA", head);
    vi.stubEnv("CI_MERGE_REQUEST_DIFF_BASE_SHA", baseSha);
    vi.stubEnv("CI_MERGE_REQUEST_PROJECT_URL", "https://gl.example/shop/orders");

    // --defer-publish alone is enough (it implies --post).
    const r = await gapReportCommand({ cwd: root, service: "orders", servicePath: repo, deferPublish: true });
    expect(r.report).toContain("analysis incomplete");
    expect(gl.writes()).toEqual([]);
    expect(jira.comments["SHOP-12"] ?? []).toEqual([]);
    expect(await fileStore(root).load("SHOP-12")).toBeUndefined();
    const runs = path.join(root, ".qa-sentinel/runs");
    const runId = fs.readdirSync(runs).find((n) => fs.existsSync(path.join(runs, n, PUBLISH_FILE)))!;
    const doc = JSON.parse(fs.readFileSync(path.join(runs, runId, PUBLISH_FILE), "utf8"));
    expect(doc.steps.map((s: { type: string }) => s.type)).toEqual(["mr-seen", "report"]);

    // The publish job: the write token, a Jira login, no model key.
    const env = { QA_SENTINEL_GITLAB_TOKEN: WRITE, JIRA_PAT: "pat", CI_API_V4_URL: `${gl.url}/api/v4` };
    expect(await publishCommand({ cwd: root, env })).toBe(0);
    const writes = gl.writes();
    expect(writes.map((x) => `${x.method} ${x.path}`)).toEqual(["POST /gitlab/api/v4/projects/7/merge_requests/7/notes"]);
    expect(writes[0].token).toBe(WRITE);
    expect(writes[0].body).toContain("analysis incomplete");
    expect((jira.comments["SHOP-12"] ?? []).length).toBeGreaterThan(0);
    expect((await fileStore(root).load("SHOP-12"))?.parts[0]).toMatchObject({ service: "orders", iid: 7, branch: "feature/SHOP-12-slots" });
    // --target filters: nothing left for the merge request note once it was published.
    expect(await publishCommand({ cwd: root, env })).toBe(0);
    expect(gl.writes()).toHaveLength(1);
  }, 60_000);

  it("--target gitlab-mr posts only the merge request note, --target jira only the story", async () => {
    const jira = await mockJira({});
    const gl = await gitlabMock({ project: "7" });
    closers.push(jira.close, gl.close);
    const root = tmp("qas-pubtarget-");
    g(root, "init", "-q", "-b", "main");
    commit(root, "README.md", "x\n", "init");
    writeConfig(root, ConfigSchema.parse({ version: 1, mode: "existing", project: { name: "t" }, tests: { api: { framework: "playwright", runCommand: "x" } }, ci: { platform: "gitlab", gitlabUrl: gl.url }, requirements: { source: "jira", jira: { baseUrl: jira.baseUrl, projectKeys: ["SHOP"] } }, reporting: { targets: ["gitlab-mr", "jira"] } }));
    const dir = path.join(root, ".qa-sentinel/runs/r1");
    deferSteps(dir, "gap-report", "r1", [{ type: "report", report: "### QA impact\nbody", service: "orders", storyKey: "SHOP-12", mr: { project: "7", mrIid: "7" } }]);
    const env = { QA_SENTINEL_GITLAB_TOKEN: WRITE, JIRA_PAT: "pat" };
    expect(await publishCommand({ cwd: root, run: "r1", target: "gitlab-mr", env })).toBe(0);
    expect(gl.writes()).toHaveLength(1);
    expect(jira.comments["SHOP-12"] ?? []).toEqual([]);
    expect(fs.existsSync(path.join(dir, "published.json"))).toBe(false); // only a part was published
    expect(await publishCommand({ cwd: root, run: "r1", target: "jira", env })).toBe(0);
    expect((jira.comments["SHOP-12"] ?? []).length).toBeGreaterThan(0);
    expect(gl.writes()).toHaveLength(1);
  }, 30_000);
});

// The helper `serve` is unused here on purpose: GitLab needs a sub-path mock and a token log.
void serve;
