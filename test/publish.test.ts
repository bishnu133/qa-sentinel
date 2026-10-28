import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A fake agent runtime (no model is called): it writes the plan and the test file the prompt asks for.
const fake = vi.hoisted(() => ({ calls: [] as string[], planFails: false, fixme: false }));
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
          fs.writeFileSync(
            path.join(t.cwd, `tests/api/${scope.map((s) => s.toLowerCase()).join("-")}.spec.ts`),
            scope.map((ac) => (fake.fixme ? `// QA-AGENT: the product accepts a fourth order\ntest.fixme("${ac} works @story:SHOP-101 @ac:${ac}", () => { expect(1).toBe(1); });` : `test("${ac} works @story:SHOP-101 @ac:${ac}", () => { expect(1).toBe(1); });`)).join("\n") + "\n",
          );
          return { ok: true, status: "ok", result: "Added tests.", costUsd: 0.5 };
        }
        return { ok: false, status: "error", result: "fake engine: nothing for " + t.kind };
      },
    }),
  };
});

import { ConfigSchema, loadConfig, writeConfig } from "../src/config.js";
import { generateCommand } from "../src/commands/generate.js";
import { gapReportCommand } from "../src/commands/gapReport.js";
import { allowedBranch, publishCommand } from "../src/commands/publish.js";
import { deferSteps, deferInNewRun, bundleBranch, PUBLISH_FILE } from "../src/reporting/deferred.js";
import { emptyRecord, fileStore } from "../src/stories/record.js";
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
async function gitlabMock(o: { project: string; openMr?: boolean }) {
  const seen: Seen[] = [];
  let created = Boolean(o.openMr);
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
      if (/\/merge_requests/.test(p) && req.method === "GET") return send(200, created && /state=(opened|all)&source_branch/.test(url.search) ? [{ iid: 5, state: "opened", web_url: "http://gl.example/gitlab/qa/-/merge_requests/5" }] : []);
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
  fake.fixme = false;
});
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const c of closers.splice(0)) await c();
  cleanTmp();
});

const AC1 = "A slot takes at most 3 orders.";

async function world(extra: Record<string, unknown> = {}) {
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
      ...extra,
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


describe("split CI jobs: generate --defer-publish, then publish", () => {
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
    const step = doc.steps.find((x: { type: string }) => x.type === "merge-request");
    const types = doc.steps.map((x: { type: string }) => x.type);
    expect(types.slice(-2)).toEqual(["merge-request", "record"]); // the story record is a step after the push
    expect(types.indexOf("merge-request")).toBeLessThan(types.lastIndexOf("record"));
    expect(step).toMatchObject({ type: "merge-request", branch: "qa-sentinel/story-SHOP-101", storyKey: "SHOP-101" });
    // Where to write is not in the file: no project, target, base commit or push mode for the publish job to believe.
    for (const k of ["project", "target", "baseSha", "pushMode", "storyMode", "baseUrls"]) expect(step).not.toHaveProperty(k);
    expect(step.labels).toEqual(expect.arrayContaining(["qa-agent", "story::SHOP-101", "service::orders"]));
    expect(step.title).toBe("QA agent: tests for story SHOP-101");
    expect(fs.existsSync(path.join(runsDir, runId, "branch.bundle"))).toBe(true);
    expect(step.headSha).toBe(g(w.qa, "rev-parse", "HEAD"));

    // The publish job: the write token and a Jira login, no model credentials at all.
    const env = { QA_SENTINEL_GITLAB_TOKEN: WRITE, JIRA_PAT: "pat", QA_STORY_KEY: "SHOP-101", CI_API_V4_URL: `${w.gl.url}/api/v4` };
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
    // The split record: what the analysis found (written / held per AC) reached the story record through publish's `record` step.
    const rec = await fileStore(w.qa).load("SHOP-101");
    expect(Object.keys(rec?.singleService ?? {})).toContain("AC-1");
    expect(rec?.singleService["AC-1"]?.state).toBe("written");
    // Published once: "all" finds nothing waiting afterwards.
    expect(fs.existsSync(path.join(runsDir, runId, "published.json"))).toBe(true);
    expect(await publishCommand({ cwd: w.qa, env })).toBe(0);
    expect(w.gl.writes()).toHaveLength(1);
  }, 120_000);

  it("with bugs.mode on and automation.record: jira, the analysis job still writes nothing to Jira: the bug cards and the record wait for publish", async () => {
    fake.fixme = true;
    const w = await world({ bugs: { mode: "create" }, automation: { record: "jira" } });
    vi.stubEnv("QA_SENTINEL_GITLAB_TOKEN", READ);
    const code = await generateCommand({ cwd: w.qa, service: "orders", base: "HEAD~1", head: "HEAD", servicePath: w.orders, deferPublish: true, processEnv: analysisEnv(w.gl.url) });
    expect([0, 1]).toContain(code);
    expect(fake.calls).toContain("author");
    // Not one write to Jira (comments, issues, issue properties) and none to GitLab.
    expect(w.jira.calls.filter((c) => !c.startsWith("GET "))).toEqual([]);
    expect(w.gl.writes()).toEqual([]);
    const runsDir = path.join(w.qa, ".qa-sentinel/runs");
    const runId = fs.readdirSync(runsDir).find((n) => fs.existsSync(path.join(runsDir, n, PUBLISH_FILE)))!;
    const doc = JSON.parse(fs.readFileSync(path.join(runsDir, runId, PUBLISH_FILE), "utf8"));
    expect(doc.steps.map((s: { type: string }) => s.type)).toEqual(expect.arrayContaining(["bugs", "merge-request"]));
    expect(doc.steps.find((s: { type: string }) => s.type === "bugs")).toMatchObject({ story: "SHOP-101" });
  }, 120_000);

  it("refuses to push a bundle that breaks the write policy (the agent output is checked again in the job that holds the write token)", async () => {
    const w = await world();
    g(w.qa, "checkout", "-q", "-b", "qa-sentinel/story-SHOP-101");
    const head = commit(w.qa, "src/evil.js", "module.exports = 1;\n", "agent: sneaky");
    const run = path.join(w.qa, ".qa-sentinel/runs/2026-10-22T10-00-00-000Z-gen-orders");
    fs.mkdirSync(run, { recursive: true });
    bundleBranch(w.qa, run, "qa-sentinel/story-SHOP-101");
    deferSteps(run, "generate", path.basename(run), [{ type: "merge-request", branch: "qa-sentinel/story-SHOP-101", headSha: head, storyKey: "SHOP-101", title: "t", description: "d", labels: ["qa-agent"] }]);
    g(w.qa, "checkout", "-q", "main");
    expect(await publishCommand({ cwd: w.qa, run: path.basename(run), env: { QA_SENTINEL_GITLAB_TOKEN: WRITE, QA_STORY_KEY: "SHOP-101" } })).toBe(1);
    expect(g(w.origin, "branch", "--list", "qa-sentinel/*")).toBe("");
    expect(w.gl.writes()).toEqual([]);
    expect(fs.existsSync(path.join(run, "published.json"))).toBe(false);
  });

  it("does not overwrite a story branch that moved on the server since the analysis", async () => {
    const w = await world();
    // The branch exists on the server (a reviewer pushed); the bundle was made from an older tip.
    g(w.qa, "checkout", "-q", "-b", "qa-sentinel/story-SHOP-101");
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
    deferSteps(run, "generate", path.basename(run), [{ type: "merge-request", branch: "qa-sentinel/story-SHOP-101", headSha: head, storyKey: "SHOP-101", title: "t", description: "d", labels: [] }]); // expectSha: none = "the branch must not exist"
    expect(await publishCommand({ cwd: w.qa, run: path.basename(run), env: { QA_SENTINEL_GITLAB_TOKEN: WRITE, QA_STORY_KEY: "SHOP-101" } })).toBe(1);
    expect(g(w.origin, "rev-parse", "qa-sentinel/story-SHOP-101")).toBe(theirs);
    expect(w.gl.writes()).toEqual([]);
  });
});

describe("publish does not believe the run folder (the analysis job runs generated code)", () => {
  const writeEnv = (gl: string, more: Record<string, string> = {}) => ({ QA_SENTINEL_GITLAB_TOKEN: WRITE, JIRA_PAT: "pat", QA_STORY_KEY: "SHOP-101", CI_API_V4_URL: `${gl}/api/v4`, QA_SERVICE_NAME: "orders", QA_SERVICE_SHA: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678", ...more });
  /** A branch the "agent" made, bundled into a new run folder, with a publish.json written by hand (so it can lie). */
  function craft(w: Awaited<ReturnType<typeof world>>, o: { id: string; branch: string; files: Record<string, string | { link: string }>; message?: string; step?: (head: string) => Record<string, unknown>; raw?: string }) {
    const mainSha = g(w.qa, "rev-parse", "HEAD");
    if (o.branch !== "main") g(w.qa, "checkout", "-q", "-b", o.branch);
    for (const [f, content] of Object.entries(o.files)) {
      fs.mkdirSync(path.dirname(path.join(w.qa, f)), { recursive: true });
      if (typeof content === "string") fs.writeFileSync(path.join(w.qa, f), content);
      else fs.symlinkSync(content.link, path.join(w.qa, f));
    }
    g(w.qa, "add", "-f", "--", ...Object.keys(o.files));
    g(w.qa, "commit", "-q", "-m", o.message ?? "agent: tests");
    const head = g(w.qa, "rev-parse", "HEAD");
    const run = path.join(w.qa, ".qa-sentinel/runs", o.id);
    fs.mkdirSync(run, { recursive: true });
    bundleBranch(w.qa, run, o.branch);
    g(w.qa, "checkout", "-q", "main");
    g(w.qa, "reset", "-q", "--hard", mainSha);
    if (o.branch !== "main") g(w.qa, "branch", "-q", "-D", o.branch);
    const step = { type: "merge-request", branch: o.branch, headSha: head, title: "t", description: "d", labels: ["qa-agent"], ...(o.step?.(head) ?? {}) };
    fs.writeFileSync(path.join(run, PUBLISH_FILE), o.raw ?? JSON.stringify({ version: 1, kind: "generate", runId: o.id, createdAt: new Date().toISOString(), steps: [step] }));
    return { run, head };
  }
  const OK = { "tests/api/ok.spec.ts": 'test("ok @story:SHOP-101 @ac:AC-1", () => {});\n' };
  const originBranches = (w: { origin: string }) => g(w.origin, "branch", "--list", "qa-sentinel/*");

  it("computes the base itself: a baseSha in the file is refused, and a change outside the allowed paths is caught without it", async () => {
    const w = await world();
    const evil = { ".gitlab-ci.yml": "stages: [x]\n", "src/evil.js": "module.exports = 1;\n" };
    craft(w, { id: "r-a", branch: "qa-sentinel/orders-a1b2c3d4", files: evil, step: (head) => ({ baseSha: head }) });
    craft(w, { id: "r-b", branch: "qa-sentinel/orders-a1b2c3d4", files: evil });
    expect(await publishCommand({ cwd: w.qa, env: writeEnv(w.gl.url) })).toBe(1);
    expect(originBranches(w)).toBe("");
    expect(w.gl.writes()).toEqual([]);
  });

  it("takes branch, project, merge request and the rest from its own configuration: extra fields and foreign branches are refused", async () => {
    const w = await world();
    const mainBefore = g(w.origin, "rev-parse", "main");
    craft(w, { id: "r-main", branch: "main", files: OK });
    craft(w, { id: "r-other", branch: "qa-sentinel/story-OTHER-1", files: OK, step: () => ({ storyKey: "SHOP-101" }) });
    craft(w, { id: "r-project", branch: "qa-sentinel/orders-a1b2c3d4", files: OK, step: () => ({ project: "99", target: "release" }) });
    craft(w, { id: "r-force", branch: "qa-sentinel/orders-a1b2c3d4", files: OK, step: () => ({ pushMode: "per-merge", baseUrls: ["https://evil.example"] }) });
    expect(await publishCommand({ cwd: w.qa, env: writeEnv(w.gl.url) })).toBe(1);
    expect(g(w.origin, "rev-parse", "main")).toBe(mainBefore);
    expect(originBranches(w)).toBe("");
    expect(w.gl.writes()).toEqual([]);
  });

  it("a report step cannot name another merge request or project: the file may not carry them, and the job's own CI variables decide", async () => {
    const w = await world();
    const dir = path.join(w.qa, ".qa-sentinel/runs/r-note");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, PUBLISH_FILE), JSON.stringify({ version: 1, kind: "gap-report", runId: "r-note", createdAt: "x", steps: [{ type: "report", report: "hi", service: "orders", mr: { project: "99", mrIid: "1" }, targets: ["gitlab-mr"] }] }));
    expect(await publishCommand({ cwd: w.qa, env: writeEnv(w.gl.url, { CI_PROJECT_ID: "7", CI_MERGE_REQUEST_IID: "3" }) })).toBe(1);
    expect(w.gl.writes()).toEqual([]);
    // Without the field, the note goes to the merge request of THIS job.
    fs.writeFileSync(path.join(dir, PUBLISH_FILE), JSON.stringify({ version: 1, kind: "gap-report", runId: "r-note", createdAt: "x", steps: [{ type: "report", report: "hi", service: "orders", targets: ["gitlab-mr"] }] }));
    expect(await publishCommand({ cwd: w.qa, env: writeEnv(w.gl.url, { CI_PROJECT_ID: "7", CI_MERGE_REQUEST_IID: "3" }) })).toBe(0);
    expect(w.gl.writes().map((x) => x.path)).toEqual(["/gitlab/api/v4/projects/7/merge_requests/3/notes"]);
  });

  it("opens the merge request in the configured project and keeps only qa-sentinel's own label shapes", async () => {
    const w = await world();
    craft(w, { id: "r-ok", branch: "qa-sentinel/orders-a1b2c3d4", files: OK, step: () => ({ labels: ["qa-agent", "approved", "merge-ready", "story::OTHER-9", "service::orders", "risk::low"], title: "line one\nline two" }), raw: undefined });
    // A newline in the title is refused by the schema, so write it without one.
    const f = path.join(w.qa, ".qa-sentinel/runs/r-ok", PUBLISH_FILE);
    const doc = JSON.parse(fs.readFileSync(f, "utf8"));
    doc.steps[0].title = "QA agent: tests for orders";
    fs.writeFileSync(f, JSON.stringify(doc));
    expect(await publishCommand({ cwd: w.qa, env: writeEnv(w.gl.url, { CI_PROJECT_ID: "99" }) })).toBe(0);
    const post = w.gl.writes().find((x) => /\/merge_requests$/.test(x.path))!;
    expect(post.path).toBe("/gitlab/api/v4/projects/42/merge_requests"); // ci.testRepoProject, not CI_PROJECT_ID
    expect(JSON.parse(post.body).labels).toBe("qa-agent,service::orders,risk::low");
    expect(g(w.origin, "rev-parse", "qa-sentinel/orders-a1b2c3d4")).toBeTruthy();
  });

  it("takes only its own job's steps (--kind) and only this job's per-merge branch (rebuilt from QA_SERVICE_NAME and QA_SERVICE_SHA)", async () => {
    const w = await world();
    craft(w, { id: "k-1", branch: "qa-sentinel/orders-a1b2c3d4", files: OK });
    // A generate run offered to the gap-report job (and the other way round) is refused before anything is pushed.
    expect(await publishCommand({ cwd: w.qa, run: "k-1", kind: "gap-report", env: writeEnv(w.gl.url) })).toBe(1);
    expect(originBranches(w)).toBe("");
    // A gap-report run that smuggles in a merge-request step is refused, even when --kind matches what the file says.
    const run = path.join(w.qa, ".qa-sentinel/runs/k-2");
    fs.mkdirSync(run, { recursive: true });
    fs.writeFileSync(path.join(run, PUBLISH_FILE), JSON.stringify({ version: 1, kind: "gap-report", runId: "k-2", createdAt: "now", steps: [{ type: "merge-request", branch: "qa-sentinel/orders-a1b2c3d4", headSha: "a".repeat(40), title: "t", description: "d", labels: [] }] }));
    expect(await publishCommand({ cwd: w.qa, run: "k-2", kind: "gap-report", env: writeEnv(w.gl.url) })).toBe(1);
    expect(originBranches(w)).toBe("");
    expect(w.gl.writes()).toEqual([]);
    // The right kind works.
    expect(await publishCommand({ cwd: w.qa, run: "k-1", kind: "generate", env: writeEnv(w.gl.url) })).toBe(0);
    expect(originBranches(w)).toContain("qa-sentinel/orders-a1b2c3d4");
  });

  it("allowedBranch: an arbitrary qa-sentinel/* name, another service's branch, a wrong sha and a missing job identity are all refused", async () => {
    const w = await world();
    const c = loadConfig(w.qa);
    const env = { QA_SERVICE_NAME: "orders", QA_SERVICE_SHA: "a1b2c3d4e5f60718" };
    const ask = (branch: string, e: NodeJS.ProcessEnv = env) => () => allowedBranch(c, { branch }, e);
    expect(ask("qa-sentinel/orders-a1b2c3d4")()).toEqual({ story: false });
    for (const b of ["qa-sentinel/review-lessons", "qa-sentinel/billing-a1b2c3d4", "qa-sentinel/orders-ffffffff", "qa-sentinel/orders-a1b2c3d4/x", "qa-sentinel/backfill-orders-2026-10-27-abc"]) expect(ask(b), b).toThrow(/refused/);
    expect(ask("qa-sentinel/orders-a1b2c3d4", {})).toThrow(/QA_SERVICE_NAME/);
    expect(ask("qa-sentinel/orders-a1b2c3d4", { QA_SERVICE_NAME: "orders", QA_SERVICE_SHA: "A1B2C3D4E5F60718" })()).toEqual({ story: false }); // an uppercase sha variable
    // A service whose name starts with the story prefix cannot use the per-merge branch (it would look like a story branch): documented, refused.
    expect(ask("qa-sentinel/story-billing-a1b2c3d4", { QA_SERVICE_NAME: "story-billing", QA_SERVICE_SHA: "a1b2c3d4e5f60718" })).toThrow(/story branch/);
  });

  it("a record step does not run when the branch before it was not pushed", async () => {
    const w = await world();
    const { run } = craft(w, { id: "k-3", branch: "qa-sentinel/orders-a1b2c3d4", files: { ".gitlab-ci.yml": "stages: [x]\n" } });
    const f = path.join(run, PUBLISH_FILE);
    const doc = JSON.parse(fs.readFileSync(f, "utf8"));
    doc.steps.push({ type: "record", story: "SHOP-101", entries: [{ ac: "AC-1", kind: "single", state: "written", heads: "orders@abc", acHash: "h" }] });
    fs.writeFileSync(f, JSON.stringify(doc));
    expect(await publishCommand({ cwd: w.qa, run: "k-3", env: writeEnv(w.gl.url) })).toBe(1);
    expect(Object.keys((await fileStore(w.qa).load("SHOP-101"))?.singleService ?? {})).toEqual([]);
  });

  it("a notice that could not be sent is not marked done: the next publish sends it", async () => {
    const w = await world({ reporting: { targets: ["gitlab-mr", "jira"], jira: { notify: { "stopped-by-budget": { on: true, to: ["jsmith"] } } } } });
    const run = path.join(w.qa, ".qa-sentinel/runs/n-1");
    fs.mkdirSync(run, { recursive: true });
    fs.writeFileSync(path.join(run, PUBLISH_FILE), JSON.stringify({ version: 1, kind: "generate", runId: "n-1", createdAt: "now", steps: [{ type: "notify", story: "SHOP-101", event: "stopped-by-budget", text: "stopped", key: "k1" }] }));
    const real = globalThis.fetch;
    let down = true;
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => (down && init?.method === "POST" && String(url).includes("/comment") ? Promise.resolve(new Response("no", { status: 500 })) : real(url, init)));
    try {
      expect(await publishCommand({ cwd: w.qa, run: "n-1", env: writeEnv(w.gl.url) })).toBe(1);
      expect(fs.existsSync(path.join(run, "published.json")) ? JSON.parse(fs.readFileSync(path.join(run, "published.json"), "utf8")).done["0"] : undefined).toBeUndefined();
      down = false;
      expect(await publishCommand({ cwd: w.qa, run: "n-1", env: writeEnv(w.gl.url) })).toBe(0);
      expect(w.jira.comments["SHOP-101"] ?? []).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("a lock left by a crashed publish (older than two hours) is taken over once; a fresh lock is respected", async () => {
    const w = await world();
    const { run } = craft(w, { id: "l-1", branch: "qa-sentinel/orders-a1b2c3d4", files: OK });
    const lock = path.join(run, "publish.lock");
    fs.writeFileSync(lock, "999999 long ago\n");
    expect(await publishCommand({ cwd: w.qa, run: "l-1", env: writeEnv(w.gl.url) })).toBe(1); // fresh: another publish is working
    expect(originBranches(w)).toBe("");
    const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
    fs.utimesSync(lock, old, old);
    expect(await publishCommand({ cwd: w.qa, run: "l-1", env: writeEnv(w.gl.url) })).toBe(0);
    expect(originBranches(w)).toContain("qa-sentinel/orders-a1b2c3d4");
    expect(fs.readdirSync(run).filter((n) => n.startsWith("publish.lock"))).toEqual([]);
  });

  it("a story notice that keeps failing does not hold back the Jira summary, and is retried alone", async () => {
    const w = await world({ reporting: { targets: ["gitlab-mr", "jira"], jira: { notify: { "cross-service-tests-ready": { on: true, to: ["jsmith"] } } } } });
    craft(w, { id: "n-2", branch: "qa-sentinel/orders-a1b2c3d4", files: OK, step: () => ({ storyKey: "SHOP-101", labels: ["qa-agent"], notify: { story: "SHOP-101", event: "cross-service-tests-ready", text: "NOTICE ready: {mr}", key: "AC-1@{iid}" }, jira: { storyKey: "SHOP-101", service: "orders", risk: "low", verification: "VERIFIED", trace: [], acText: [], discrepancies: [], report: "the report" } }) });
    const real = globalThis.fetch;
    let down = true;
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => (down && init?.method === "POST" && String(url).includes("/comment") && String(init.body).includes("NOTICE") ? Promise.resolve(new Response("no", { status: 500 })) : real(url, init)));
    try {
      expect(await publishCommand({ cwd: w.qa, run: "n-2", env: writeEnv(w.gl.url) })).toBe(1);
      const st = JSON.parse(fs.readFileSync(path.join(w.qa, ".qa-sentinel/runs/n-2/published.json"), "utf8")).done;
      expect(Object.keys(st).sort()).toEqual(["0:mr", "0:post"]); // the summary is done, the notice is not
      expect((w.jira.comments["SHOP-101"] ?? []).some((x) => x.body.includes("the report") || x.body.includes("QA status"))).toBe(true);
      const pushes = w.gl.writes().length;
      down = false;
      expect(await publishCommand({ cwd: w.qa, run: "n-2", env: writeEnv(w.gl.url) })).toBe(0);
      expect(w.gl.writes()).toHaveLength(pushes); // nothing pushed or opened twice
      expect((w.jira.comments["SHOP-101"] ?? []).filter((x) => x.body.includes("NOTICE"))).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("resetRecord clears the story's written marks only after the push went through (a refused push leaves them)", async () => {
    const w = await world();
    const store = fileStore(w.qa);
    const seed = async () => store.save({ ...emptyRecord("SHOP-101"), singleService: { "AC-1": { state: "written", heads: "h", acHash: "a", at: "2026-10-20T00:00:00.000Z" } } });
    await seed();
    craft(w, { id: "x-1", branch: "qa-sentinel/story-SHOP-101", files: { ".gitlab-ci.yml": "stages: [x]\n" }, step: () => ({ storyKey: "SHOP-101", resetRecord: true }) });
    expect(await publishCommand({ cwd: w.qa, run: "x-1", env: writeEnv(w.gl.url) })).toBe(1); // the policy refuses the push
    expect(Object.keys((await store.load("SHOP-101"))?.singleService ?? {})).toEqual(["AC-1"]);
    fs.rmSync(path.join(w.qa, ".qa-sentinel/runs/x-1"), { recursive: true });
    craft(w, { id: "x-2", branch: "qa-sentinel/story-SHOP-101", files: OK, step: () => ({ storyKey: "SHOP-101", resetRecord: true }) });
    expect(await publishCommand({ cwd: w.qa, run: "x-2", env: writeEnv(w.gl.url) })).toBe(0);
    const rec = await store.load("SHOP-101");
    expect(Object.keys(rec?.singleService ?? {})).toEqual([]);
    expect(rec?.agentMr?.branch).toBe("qa-sentinel/story-SHOP-101");
  });

  it("a symbolic link in the run folder (published.json, jira-summary.md, manifest.json, a folder) is refused and nothing outside is written", async () => {
    const w = await world();
    const outside = path.join(w.root, "outside.txt");
    fs.writeFileSync(outside, "untouched\n");
    for (const [i, name] of ["published.json", "jira-summary.md", "manifest.json", "sub"].entries()) {
      const { run } = craft(w, { id: `ln-${i}`, branch: "qa-sentinel/orders-a1b2c3d4", files: OK });
      fs.symlinkSync(name === "sub" ? w.root : outside, path.join(run, name));
      expect(await publishCommand({ cwd: w.qa, run: `ln-${i}`, env: writeEnv(w.gl.url) }), name).toBe(1);
      expect(fs.readFileSync(outside, "utf8"), name).toBe("untouched\n");
      expect(originBranches(w), name).toBe("");
    }
    expect(w.gl.writes()).toEqual([]);
  });

  it("writeFileNoFollow and readFileNoFollow do not follow a link at the final path", async () => {
    const { writeFileNoFollow, readFileNoFollow, assertNoLinks } = await import("../src/noLinks.js");
    const dir = tmp("qas-nl-");
    const target = path.join(dir, "target.txt");
    fs.writeFileSync(target, "keep\n");
    fs.symlinkSync(target, path.join(dir, "link.txt"));
    expect(() => writeFileNoFollow(path.join(dir, "link.txt"), "evil")).toThrow();
    expect(() => readFileNoFollow(path.join(dir, "link.txt"))).toThrow();
    expect(fs.readFileSync(target, "utf8")).toBe("keep\n");
    writeFileNoFollow(path.join(dir, "plain.txt"), "ok");
    expect(readFileNoFollow(path.join(dir, "plain.txt"))).toBe("ok");
    expect(() => assertNoLinks(dir)).toThrow(/symbolic link/);
  });

  it("refuses generated artifacts, symbolic links and submodule links in the bundle", async () => {
    const w = await world();
    craft(w, { id: "r-art", branch: "qa-sentinel/orders-a1b2c3d4", files: { ...OK, "qa-gap-report.md": "x\n", ".qa-sentinel/runs/x/publish.json": "{}" } });
    craft(w, { id: "r-link", branch: "qa-sentinel/orders-a1b2c3d4", files: { ...OK, "tests/api/link.spec.ts": { link: "/etc/passwd" } } });
    // A submodule link: a gitlink entry in the index.
    g(w.qa, "checkout", "-q", "-b", "qa-sentinel/orders-a1b2c3d4");
    g(w.qa, "update-index", "--add", "--cacheinfo", `160000,${g(w.qa, "rev-parse", "HEAD")},tests/api/sub`);
    g(w.qa, "commit", "-q", "-m", "agent: submodule");
    const run = path.join(w.qa, ".qa-sentinel/runs/r-sub");
    fs.mkdirSync(run, { recursive: true });
    bundleBranch(w.qa, run, "qa-sentinel/orders-a1b2c3d4");
    const head = g(w.qa, "rev-parse", "HEAD");
    g(w.qa, "checkout", "-q", "main");
    deferSteps(run, "generate", "r-sub", [{ type: "merge-request", branch: "qa-sentinel/orders-a1b2c3d4", headSha: head, title: "t", description: "d", labels: [] }]);
    expect(await publishCommand({ cwd: w.qa, env: writeEnv(w.gl.url) })).toBe(1);
    expect(originBranches(w)).toBe("");
    expect(w.gl.writes()).toEqual([]);
  });

  it("one bad run does not stop the others; a malformed publish.json is refused", async () => {
    const w = await world();
    const bad = path.join(w.qa, ".qa-sentinel/runs/a-bad");
    fs.mkdirSync(bad, { recursive: true });
    fs.writeFileSync(path.join(bad, PUBLISH_FILE), "{ not json");
    craft(w, { id: "b-good", branch: "qa-sentinel/orders-a1b2c3d4", files: OK });
    expect(await publishCommand({ cwd: w.qa, env: writeEnv(w.gl.url) })).toBe(1);
    expect(g(w.origin, "rev-parse", "qa-sentinel/orders-a1b2c3d4")).toBeTruthy();
    expect(fs.existsSync(path.join(bad, "published.json"))).toBe(false);
  });

  it("two publishes of one run cannot both push; a repeat after success does nothing", async () => {
    const w = await world();
    craft(w, { id: "r-c", branch: "qa-sentinel/orders-a1b2c3d4", files: OK });
    const env = writeEnv(w.gl.url);
    const [a, b] = await Promise.all([publishCommand({ cwd: w.qa, run: "r-c", env }), publishCommand({ cwd: w.qa, run: "r-c", env })]);
    expect([a, b].sort()).toEqual([0, 1]);
    expect(w.gl.writes().filter((x) => /\/merge_requests$/.test(x.path))).toHaveLength(1);
    expect(fs.existsSync(path.join(w.qa, ".qa-sentinel/runs/r-c/publish.lock"))).toBe(false);
    expect(await publishCommand({ cwd: w.qa, run: "r-c", env })).toBe(0);
    expect(w.gl.writes().filter((x) => /\/merge_requests$/.test(x.path))).toHaveLength(1);
  });

  it("a run published in parts (--target) is not published twice by --run all", async () => {
    const w = await world();
    craft(w, {
      id: "r-p",
      branch: "qa-sentinel/story-SHOP-101",
      files: OK,
      step: () => ({ storyKey: "SHOP-101", jira: { storyKey: "SHOP-101", service: "orders", risk: "low", verification: "VERIFIED", trace: [], acText: [], discrepancies: [], report: "r" } }),
    });
    const env = writeEnv(w.gl.url);
    expect(await publishCommand({ cwd: w.qa, run: "r-p", target: "mr-create", env })).toBe(0);
    expect(w.gl.writes().filter((x) => /\/merge_requests$/.test(x.path))).toHaveLength(1);
    expect(w.jira.comments["SHOP-101"] ?? []).toEqual([]);
    expect(await publishCommand({ cwd: w.qa, env })).toBe(0); // all: only what is left
    expect(w.gl.writes().filter((x) => /\/merge_requests$/.test(x.path))).toHaveLength(1);
    expect((w.jira.comments["SHOP-101"] ?? []).some((c) => c.body.includes("merge_requests/5"))).toBe(true);
    expect(await publishCommand({ cwd: w.qa, env })).toBe(0);
    expect((w.jira.comments["SHOP-101"] ?? []).length).toBe(1);
  });

  it("exits non-zero when nothing could be published: no merge request, no token, no Jira login", async () => {
    const w = await world();
    const dir = path.join(w.qa, ".qa-sentinel/runs/r-n");
    deferSteps(dir, "gap-report", "r-n", [{ type: "report", report: "x", service: "orders", storyKey: "SHOP-12", targets: ["gitlab-mr"] }]);
    expect(await publishCommand({ cwd: w.qa, env: { QA_SENTINEL_GITLAB_TOKEN: WRITE } })).toBe(1); // no CI_MERGE_REQUEST_IID
    expect(await publishCommand({ cwd: w.qa, env: { CI_PROJECT_ID: "7", CI_MERGE_REQUEST_IID: "3", CI_API_V4_URL: `${w.gl.url}/api/v4` } })).toBe(1); // no token
    deferSteps(path.join(w.qa, ".qa-sentinel/runs/r-n2"), "gap-report", "r-n2", [{ type: "bugs", story: "SHOP-12", candidates: [] }]);
    expect(await publishCommand({ cwd: w.qa, run: "r-n2", env: {} })).toBe(1); // no Jira login
    expect(w.gl.writes()).toEqual([]);
  });

  it("a blocked story branch (merge conflict) leaves its note and Jira notice only in publish, on the story's own merge request", async () => {
    const w = await world();
    const open = await gitlabMock({ project: "42", openMr: true });
    closers.push(open.close);
    const dir = path.join(w.qa, ".qa-sentinel/runs/r-blocked");
    deferSteps(dir, "generate", "r-blocked", [
      { type: "notify", story: "SHOP-101", event: "merge-conflict", text: "the test branch cannot take main", key: "qa-sentinel/story-SHOP-101" },
      { type: "branch-note", story: "SHOP-101", marker: "<!-- qa-sentinel:story-branch-blocked -->", text: "**QA agent: blocked.** conflict in tests/api/a.spec.ts" },
    ]);
    expect(await publishCommand({ cwd: w.qa, run: "r-blocked", env: writeEnv(open.url) })).toBe(0);
    const notes = open.writes().filter((x) => /\/notes$/.test(x.path));
    expect(notes).toHaveLength(1);
    expect(notes[0].path).toBe("/gitlab/api/v4/projects/42/merge_requests/5/notes");
    expect(notes[0].body).toContain("blocked");
    // The file cannot name another branch or a marker of its own.
    fs.writeFileSync(path.join(dir, PUBLISH_FILE), JSON.stringify({ version: 1, kind: "generate", runId: "r-blocked", createdAt: "x", steps: [{ type: "branch-note", story: "SHOP-101", branch: "main", marker: "<!-- x -->", text: "t" }] }));
    fs.rmSync(path.join(dir, "published.json"), { force: true });
    expect(await publishCommand({ cwd: w.qa, run: "r-blocked", env: writeEnv(open.url) })).toBe(1);
  });

  it("a story branch that is not built on the server's copy is refused, not rewritten", async () => {
    const w = await world();
    const reviewer = path.join(w.root, "rev");
    g(w.root, "clone", "-q", w.origin, reviewer);
    g(reviewer, "checkout", "-q", "-b", "qa-sentinel/story-SHOP-101");
    const theirs = commit(reviewer, "REVIEW.md", "note\n", "reviewer");
    g(reviewer, "push", "-q", "origin", "qa-sentinel/story-SHOP-101");
    // The bundle's branch was made from main without the reviewer's commit, and says the server still has `theirs`.
    craft(w, { id: "r-ff", branch: "qa-sentinel/story-SHOP-101", files: OK, step: () => ({ storyKey: "SHOP-101", expectSha: theirs }) });
    expect(await publishCommand({ cwd: w.qa, run: "r-ff", env: writeEnv(w.gl.url) })).toBe(1);
    expect(g(w.origin, "rev-parse", "qa-sentinel/story-SHOP-101")).toBe(theirs);
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
    const env = { QA_SENTINEL_GITLAB_TOKEN: WRITE, JIRA_PAT: "pat", QA_STORY_KEY: "SHOP-101", CI_API_V4_URL: `${gl.url}/api/v4`, CI_PROJECT_ID: "7", CI_MERGE_REQUEST_IID: "7", CI_MERGE_REQUEST_TITLE: "SHOP-12 slots", CI_MERGE_REQUEST_SOURCE_BRANCH_NAME: "feature/SHOP-12-slots" };
    expect(await publishCommand({ cwd: root, env })).toBe(0);
    const writes = gl.writes();
    expect(writes.map((x) => `${x.method} ${x.path}`)).toEqual(["POST /gitlab/api/v4/projects/7/merge_requests/7/notes"]);
    expect(writes[0].token).toBe(WRITE);
    expect(writes[0].body).toContain("analysis incomplete");
    // The deferred path also adds the vote line, and the run's manifest gets the note's id (M4).
    expect(writes[0].body).toContain("Was this useful? 👍 / 👎");
    expect(JSON.parse(fs.readFileSync(path.join(runs, runId, "manifest.json"), "utf8")).mr).toEqual({ project: "7", iid: "7", noteId: 11 });
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
    deferSteps(dir, "gap-report", "r1", [{ type: "report", report: "### QA impact\nbody", service: "orders", storyKey: "SHOP-12" }]);
    const env = { QA_SENTINEL_GITLAB_TOKEN: WRITE, JIRA_PAT: "pat", CI_PROJECT_ID: "7", CI_MERGE_REQUEST_IID: "7" };
    expect(await publishCommand({ cwd: root, run: "r1", target: "gitlab-mr", env })).toBe(0);
    expect(gl.writes()).toHaveLength(1);
    expect(jira.comments["SHOP-12"] ?? []).toEqual([]);
    expect(JSON.parse(fs.readFileSync(path.join(dir, "published.json"), "utf8")).complete).toBeFalsy(); // only a part was published
    expect(await publishCommand({ cwd: root, run: "r1", target: "jira", env })).toBe(0);
    expect((jira.comments["SHOP-12"] ?? []).length).toBeGreaterThan(0);
    expect(gl.writes()).toHaveLength(1);
  }, 30_000);
});

describe("deferred notes of runs without an analysis (joined comment, waiting note)", () => {
  it("get a manifest of their own, and publish writes the note id into it", async () => {
    const gl = await gitlabMock({ project: "7" });
    closers.push(gl.close);
    const root = tmp("qas-pubjoined-");
    g(root, "init", "-q", "-b", "main");
    commit(root, "README.md", "x\n", "init");
    writeConfig(root, ConfigSchema.parse({ version: 1, mode: "existing", project: { name: "t" }, tests: { api: { framework: "playwright", runCommand: "x" } }, ci: { platform: "gitlab", gitlabUrl: gl.url } }));
    const dir = deferInNewRun(root, "gap-report", "gap-joined", [{ type: "report", report: "### QA impact · 2 stories in this merge request", service: "orders", targets: ["gitlab-mr"] }]);
    expect(JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"))).toMatchObject({ kind: "gap-report", outcome: "gap-joined" });
    expect(await publishCommand({ cwd: root, env: { QA_SENTINEL_GITLAB_TOKEN: WRITE, CI_PROJECT_ID: "7", CI_MERGE_REQUEST_IID: "7" } })).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")).mr).toEqual({ project: "7", iid: "7", noteId: 11 });
    expect(gl.writes()[0].body).toContain("Was this useful?");
  }, 30_000);
});

// The helper `serve` is unused here on purpose: GitLab needs a sub-path mock and a token log.
void serve;

describe("deferSteps cuts what is over the schema's limits (the paid work is not lost to a long description)", () => {
  it("a 100k description and a 10k AC text are cut, and the file reads back", async () => {
    const { deferSteps, parsePublishFile } = await import("../src/reporting/deferred.js");
    const dir = tmp("qas-clamp-");
    deferSteps(dir, "generate", "r1", [{ type: "merge-request", branch: "qa-sentinel/x", headSha: "a".repeat(40), title: "t", description: "d".repeat(100_000), labels: [], jira: { storyKey: "SHOP-1", service: "orders", risk: "low", verification: "VERIFIED", trace: [], acText: [["AC-1", "t".repeat(10_000)]], discrepancies: [], report: "r" } } as never]);
    deferSteps(dir, "generate", "r1", [{ type: "record", story: "SHOP-1", entries: [], evidence: [] }]);
    const doc = parsePublishFile(fs.readFileSync(path.join(dir, "publish.json"), "utf8"));
    const mr = doc.steps[0] as { description: string; jira?: { acText: [string, string][] } };
    expect(mr.description.length).toBe(60_000);
    expect(mr.jira!.acText[0][1].length).toBe(4000);
    expect(doc.steps).toHaveLength(2);
  });
});
