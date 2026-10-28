import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A fake agent runtime: it writes the plan and the test files the prompt asks for, records what it saw, and never calls a model.
const fake = vi.hoisted(() => ({ calls: [] as { kind: string; prompt: string }[], seenAtPlan: [] as string[][], contexts: [] as any[], planOverride: undefined as undefined | ((scope: string[]) => any), suffix: "" }));
vi.mock("../src/engines/ClaudeCodeEngine.js", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const BEHAVIOUR: Record<string, string> = { "AC-1": "B1", "AC-2": "B2" };
  return {
    engineFor: () => ({
      name: "fake",
      available: () => ({ ok: true }),
      run: async (t: { kind: string; prompt: string; cwd: string }) => {
        fake.calls.push({ kind: t.kind, prompt: t.prompt });
        const ctxRel = /Run context: (\S+?\/context\.json)/.exec(t.prompt)?.[1];
        const ctx = ctxRel ? JSON.parse(fs.readFileSync(path.join(t.cwd, ctxRel), "utf8")) : undefined;
        if (t.kind === "plan" && ctx) {
          fake.contexts.push(ctx);
          fake.seenAtPlan.push(fs.existsSync(path.join(t.cwd, "tests/api")) ? fs.readdirSync(path.join(t.cwd, "tests/api")).sort() : []);
          const scope: string[] = ctx.acScope ?? ctx.acceptanceCriteriaIds;
          const ev = [{ source: "source-code", file: "src/app.js", line: 1, reference: "x" }];
          const plan = fake.planOverride
            ? fake.planOverride(scope)
            : {
                schemaVersion: 1,
                verdict: "tests for " + scope.join(","),
                recommendedAction: "write them",
                changes: [{ id: "c1", type: "business-rule", summary: "slot cap", observable: true, requirementIds: scope, oracleStatus: "approved", riskFactors: ["business-rule"], evidence: ev }],
                decisions: [
                  {
                    changeId: "c1",
                    coverage: "missing",
                    decision: "create",
                    reason: "r",
                    existingTests: [],
                    targetFile: `tests/api/${scope.map((s) => s.toLowerCase()).join("-")}.spec.ts`,
                    proposedScenarios: scope.map((ac) => ({ title: `${ac} works`, requirementIds: [ac], behaviourIds: [BEHAVIOUR[ac]], assertions: ["a"] })),
                    evidence: ev,
                  },
                ],
                requirementStatus: scope.map((id) => ({ id, status: "implemented", evidence: ev })),
              };
          fs.writeFileSync(path.join(t.cwd, ctx.planPath), JSON.stringify(plan));
          return { ok: true, status: "ok", result: "done", costUsd: 0.5 };
        }
        if (t.kind === "author" && ctx) {
          const scope: string[] = ctx.acScope ?? ctx.acceptanceCriteriaIds;
          fs.mkdirSync(path.join(t.cwd, "tests/api"), { recursive: true });
          const file = `tests/api/${scope.length ? scope.map((s) => s.toLowerCase()).join("-") : "change"}${fake.suffix}.spec.ts`;
          fs.writeFileSync(path.join(t.cwd, file), (scope.length ? scope.map((ac) => `test("${ac} works @story:SHOP-101 @ac:${ac} @b:${BEHAVIOUR[ac]}", () => { expect(1).toBe(1); });`) : [`test("the change works @story:SHOP-101", () => { expect(1).toBe(1); });`]).join("\n") + "\n");
          return { ok: true, status: "ok", result: "Added tests.", costUsd: 0.5 };
        }
        return { ok: false, status: "error", result: "fake engine: nothing for " + t.kind };
      },
    }),
  };
});

import { ConfigSchema, writeConfig } from "../src/config.js";
import { generateCommand } from "../src/commands/generate.js";
import { acHash, renderExpected, type ExpectedFile } from "../src/expected/format.js";
import { fileStore } from "../src/stories/record.js";
import { crossServiceJobKey } from "../src/stories/jobs.js";
import { GIT_ENV, cleanTmp, commit, g, serve, tmp } from "./helpers/mocks.js";

const AC1 = "A slot takes at most 3 orders in the browser.";
const AC2 = "Orders in the past are rejected.";
const expectedFile = (): ExpectedFile => ({
  version: 1,
  story: "SHOP-101",
  acs: [
    { id: "AC-1", hash: acHash(AC1), text: AC1, services: ["orders", "storefront"], behaviours: [{ id: "B1", kind: "main", statement: "shown", expect: {}, state: "ready", source: "ac" }] },
    { id: "AC-2", hash: acHash(AC2), text: AC2, services: ["orders"], behaviours: [{ id: "B2", kind: "main", statement: "rejected", expect: {}, state: "ready", source: "ac" }] },
  ],
});

interface World {
  root: string;
  qa: string;
  origin: string;
  orders: string;
  storefront: string;
  jira: { status: string };
  jiraUrl: string;
  /** Comments written to the mock Jira. */
  comments: { id: string; body: string; author?: { accountId: string } }[];
}
let w: World;
let closers: (() => Promise<void>)[] = [];
const envOf = (extra: Record<string, string> = {}) => ({ CI: "true", ...extra });

async function world(o: { notify?: Record<string, unknown>; scope?: "story" | "service"; crossService?: "when-ready-status" | "when-ac-complete"; gitlab?: string; runner?: string; expected?: ExpectedFile; jiraDescription?: string; jiraComponents?: string[]; componentMap?: Record<string, string> } = {}): Promise<World> {
  const root = tmp("qas-story-");
  const origin = path.join(root, "origin.git");
  fs.mkdirSync(origin);
  g(origin, "init", "-q", "--bare", "-b", "main");
  const qa = path.join(root, "qa-tests");
  const orders = path.join(root, "orders");
  const storefront = path.join(root, "storefront");
  for (const d of [qa, orders, storefront]) {
    fs.mkdirSync(d);
    g(d, "init", "-q", "-b", "main");
  }
  commit(orders, "src/app.js", "v1", "init");
  commit(storefront, "src/ui.js", "v1", "init");
  // Orders merges its part first (a commit on main naming the story); the storefront part is still a branch.
  commit(orders, "src/app.js", "v2", "SHOP-101 orders: cap a slot");
  g(storefront, "checkout", "-q", "-b", "feature/SHOP-101-ui");
  commit(storefront, "src/ui.js", "v2", "show the slot cap");
  g(storefront, "checkout", "-q", "main");

  const jira = { status: "In Progress" };
  const comments: World["comments"] = [];
  const j = await serve((req, url, reqBody) => {
    if (url.pathname === "/rest/api/2/myself") return { body: { accountId: "bot" } };
    if (/\/comment/.test(url.pathname)) {
      if (req.method === "GET") return { body: { comments, total: comments.length } };
      const f = JSON.parse(reqBody);
      if (req.method === "POST") {
        comments.push({ id: String(comments.length + 1), author: { accountId: "bot" }, ...f });
        return { status: 201, body: { id: String(comments.length) } };
      }
      Object.assign(comments.find((x) => x.id === url.pathname.split("/").pop())!, f);
      return { body: {} };
    }
    const m = url.pathname.match(/^\/rest\/api\/2\/issue\/([^/]+)$/);
    if (!m) return { status: 404, body: {} };
    return { body: { key: m[1], fields: { summary: "Delivery slots", issuetype: { name: "Story" }, status: { name: jira.status }, description: o.jiraDescription ?? `## Acceptance criteria\n- AC-1: ${AC1}\n- AC-2: ${AC2}\n`, labels: [], components: (o.jiraComponents ?? []).map((name) => ({ name })) } } };
  });
  closers.push(j.close);
  const c = ConfigSchema.parse({
    version: 1,
    mode: "existing",
    project: { name: "t" },
    level: "maintenance",
    workspace: { services: [{ name: "orders", path: "../orders" }, { name: "storefront", path: "../storefront" }] },
    tests: { api: { framework: "mocha", runCommand: o.runner ?? "node runner.js" }, expectations: "off" },
    ci: { platform: "gitlab", targetBranch: "main", ...(o.gitlab ? { gitlabUrl: o.gitlab, testRepoProject: "42" } : {}) },
    requirements: { source: "jira", jira: { baseUrl: j.url, projectKeys: ["SHOP"], ...(o.componentMap ? { components: o.componentMap } : {}) } },
    generation: { scope: o.scope ?? "story", crossService: o.crossService ?? "when-ready-status" },
    verification: { preflight: false, requireVerifiedToPush: false },
    review: { enabled: false },
    guardrails: { allowedHosts: [] },
    reporting: { jira: { notify: o.notify ?? {} } },
  });
  writeConfig(qa, c);
  fs.writeFileSync(path.join(qa, "runner.js"), "process.exit(0);\n");
  fs.writeFileSync(path.join(qa, ".gitignore"), ".qa-sentinel/\nqa-sentinel-summary.md\nqa-stories.md\n");
  fs.mkdirSync(path.join(qa, "expected"), { recursive: true });
  fs.writeFileSync(path.join(qa, "expected/SHOP-101.md"), renderExpected(o.expected ?? expectedFile()));
  g(qa, "add", "-A");
  g(qa, "commit", "-q", "-m", "init tests");
  g(qa, "remote", "add", "origin", origin);
  g(qa, "push", "-q", "origin", "main");
  return { root, qa, origin, orders, storefront, jira, jiraUrl: j.url, comments };
}

const branchFiles = (origin: string, branch = "qa-sentinel/story-SHOP-101") => g(origin, "ls-tree", "-r", "--name-only", branch).split("\n");
const gen = (o: Partial<Parameters<typeof generateCommand>[0]> = {}) =>
  generateCommand({ cwd: w.qa, service: "orders", base: "HEAD~1", head: "HEAD", servicePath: w.orders, push: true, processEnv: envOf(), ...o });

beforeEach(() => {
  vi.stubEnv("CI", "");
  vi.stubEnv("JIRA_EMAIL", "a@b.c");
  vi.stubEnv("JIRA_API_TOKEN", "x");
  for (const [k, v] of Object.entries({ ...GIT_ENV, GIT_TERMINAL_PROMPT: "0" })) vi.stubEnv(k, v);
  fake.calls.length = 0;
  fake.seenAtPlan.length = 0;
  fake.contexts.length = 0;
  fake.planOverride = undefined;
  fake.suffix = "";
});
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const c of closers.splice(0)) await c();
  cleanTmp();
});

describe("one test branch per story, built on incrementally", () => {
  it("walks SHOP-101: the orders merge writes AC-2 only, the storefront merge adds AC-1 on the same branch, keeping a reviewer's commit", async () => {
    w = await world();
    // 1. Orders merges. AC-2 needs only orders; AC-1 needs orders and storefront (still a branch).
    expect(await gen()).toBe(0);
    const branch = "qa-sentinel/story-SHOP-101";
    expect(branchFiles(w.origin)).toContain("tests/api/ac-2.spec.ts");
    expect(branchFiles(w.origin).some((f) => f.includes("ac-1"))).toBe(false);
    expect(fake.contexts[0].acScope).toEqual(["AC-2"]);
    expect(fake.contexts[0].heldAcs["AC-1"]).toMatch(/storefront/);
    const rec1 = (await fileStore(w.qa).load("SHOP-101"))!;
    expect(rec1.crossService["AC-1"]).toMatchObject({ state: "held" });
    expect(rec1.acEvidence["AC-2"].status).toBe("implemented");
    // The working tree is on the story branch; the base branch of the test repo was not touched.
    expect(g(w.qa, "rev-parse", "--abbrev-ref", "HEAD")).toBe(branch);
    expect(g(w.origin, "rev-parse", "main")).toBe(g(w.qa, "rev-parse", "main"));

    // 2. A reviewer pushes to the branch, main moves, the storefront part merges, and the Jira card is ready.
    const reviewer = path.join(w.root, "reviewer");
    g(w.root, "clone", "-q", w.origin, reviewer);
    g(reviewer, "checkout", "-q", branch);
    const reviewerSha = commit(reviewer, "REVIEW.md", "please also check the empty slot\n", "reviewer: note");
    g(reviewer, "push", "-q", "origin", branch);
    g(reviewer, "checkout", "-q", "main");
    commit(reviewer, "docs.md", "main moved\n", "other work");
    g(reviewer, "push", "-q", "origin", "main");
    g(w.storefront, "merge", "--no-ff", "-q", "-m", "Merge feature/SHOP-101-ui", "feature/SHOP-101-ui");
    w.jira.status = "Ready for QA";
    const tipBefore = g(w.origin, "rev-parse", branch);
    g(w.qa, "checkout", "-q", "main");
    expect(await gen({ service: "storefront", servicePath: w.storefront })).toBe(0);

    const files = branchFiles(w.origin);
    expect(files).toEqual(expect.arrayContaining(["REVIEW.md", "docs.md", "tests/api/ac-2.spec.ts", "tests/api/ac-1.spec.ts"]));
    // The branch was not rebuilt from main: main has no test files, the branch has both.
    expect(g(w.origin, "ls-tree", "-r", "--name-only", "main")).not.toContain("tests/api");
    // Fast-forward only: the earlier tip and the reviewer's commit are still in the history.
    g(w.origin, "merge-base", "--is-ancestor", tipBefore, branch);
    g(w.origin, "merge-base", "--is-ancestor", reviewerSha, branch);
    // The planner ran on the story branch: it saw AC-2's tests and the reviewer's file, so it could not plan them again.
    expect(fake.seenAtPlan[1]).toContain("ac-2.spec.ts");
    expect(fake.contexts[1].acScope).toEqual(["AC-1"]);
    expect(fake.contexts[1].heldAcs["AC-2"]).toMatch(/orders/);
    const rec2 = (await fileStore(w.qa).load("SHOP-101"))!;
    expect(rec2.crossService["AC-1"]).toMatchObject({ state: "written" });

    // 3. The same cross-service change asked for again (from the command line) is skipped by its job key: no AI run.
    const callsBefore = fake.calls.length;
    expect(await gen({ service: "", story: "SHOP-101", acs: ["AC-1"], base: undefined, head: undefined })).toBe(0);
    expect(fake.calls.length).toBe(callsBefore);
    // ... and so is a merge run that finds nothing new to write.
    expect(await gen({ service: "storefront", servicePath: w.storefront })).toBe(0);
    expect(fake.calls.length).toBe(callsBefore);
    const keys = Object.keys((await fileStore(w.qa).load("SHOP-101"))!.jobs);
    expect(keys.filter((k) => k.includes(":acs-AC-1:"))).toHaveLength(1);
  }, 90_000);

  it("keeps an AC that needs several services waiting while the Jira card is not in a ready status (default), and writes it with when-ac-complete", async () => {
    w = await world();
    g(w.storefront, "merge", "--no-ff", "-q", "-m", "Merge feature/SHOP-101-ui", "feature/SHOP-101-ui");
    // Both parts merged, card still "In Progress".
    expect(await gen({ service: "storefront", servicePath: w.storefront })).toBe(0);
    // Storefront has no single-service AC and AC-1 waits for the status: the only thing it has to say is AC-1 waits.
    expect(fake.calls.filter((c) => c.kind === "plan")).toHaveLength(0);
    expect(g(w.origin, "branch", "--list", "qa-sentinel/*")).toBe("");
  }, 60_000);

  it("generation.crossService: when-ac-complete ignores the Jira status", async () => {
    w = await world({ crossService: "when-ac-complete" });
    g(w.storefront, "merge", "--no-ff", "-q", "-m", "Merge feature/SHOP-101-ui", "feature/SHOP-101-ui");
    expect(await gen({ service: "storefront", servicePath: w.storefront })).toBe(0);
    expect(fake.contexts[0].acScope).toEqual(["AC-1"]);
    expect(branchFiles(w.origin)).toContain("tests/api/ac-1.spec.ts");
  }, 60_000);
});

/** A mock GitLab for the test repo's project (42): merge requests (list, create, update) and notes. */
async function mockGitlab() {
  const mrs: any[] = [];
  const notes: Record<number, { id: number; body: string; author: { id: number } }[]> = {};
  const gl = await serve((req, url, body) => {
    const p = url.pathname.replace("/api/v4", "");
    const q = url.searchParams;
    const page = { headers: { "x-next-page": "" } };
    if (p === "/user") return { body: { id: 1 } };
    const note = p.match(/^\/projects\/42\/merge_requests\/(\d+)\/notes(?:\/(\d+))?$/);
    if (note) {
      const iid = Number(note[1]);
      notes[iid] ??= [];
      if (req.method === "GET") return { body: notes[iid], ...page };
      const text = JSON.parse(body).body;
      if (req.method === "POST") {
        notes[iid].push({ id: notes[iid].length + 1, body: text, author: { id: 1 } });
        return { body: notes[iid].at(-1) };
      }
      notes[iid].find((n) => n.id === Number(note[2]))!.body = text;
      return { body: {} };
    }
    const one = p.match(/^\/projects\/42\/merge_requests\/(\d+)$/);
    if (one && req.method === "PUT") {
      const m = mrs.find((x) => x.iid === Number(one[1]))!;
      const f = JSON.parse(body);
      Object.assign(m, { title: f.title, description: f.description, labels: String(f.labels).split(",").filter(Boolean) });
      return { body: m };
    }
    if (p === "/projects/42/merge_requests" && req.method === "POST") {
      const f = JSON.parse(body);
      const m = { iid: mrs.length + 1, state: "opened", web_url: `${gl.url}/mr/${mrs.length + 1}`, source_branch: f.source_branch, target_branch: f.target_branch, title: f.title, description: f.description, labels: String(f.labels).split(",").filter(Boolean) };
      mrs.push(m);
      return { body: m };
    }
    if (p === "/projects/42/merge_requests" && req.method === "GET") {
      let list = [...mrs].reverse();
      if (q.get("state") === "opened") list = list.filter((m) => m.state === "opened");
      if (q.get("source_branch")) list = list.filter((m) => m.source_branch === q.get("source_branch"));
      if (q.get("labels")) list = list.filter((m) => m.labels.includes(q.get("labels")));
      return { body: list, ...page };
    }
    return { status: 404, body: {} };
  });
  closers.push(gl.close);
  return { url: gl.url, mrs, notes, log: gl.log };
}
const glEnv = () => envOf({ QA_SENTINEL_GITLAB_TOKEN: "t", JIRA_EMAIL: "a@b.c", JIRA_API_TOKEN: "x" });
const notes = (event: string) => w.comments.filter((c) => c.body.includes(`qa-sentinel:notify:${event}`));
const BRANCH = "qa-sentinel/story-SHOP-101";

describe("the story's merge request", () => {
  it("is created once and then updated in place; its title names the story and it lists the ACs still waiting", async () => {
    const gl = await mockGitlab();
    w = await world({ gitlab: gl.url, crossService: "when-ac-complete", notify: { "cross-service-tests-ready": { on: true, to: ["jsmith"] } } });
    expect(await gen({ processEnv: glEnv() })).toBe(0);
    expect(notes("cross-service-tests-ready")).toHaveLength(0); // AC-2 is single-service: nothing end-to-end to review yet
    expect(gl.mrs).toHaveLength(1);
    expect(gl.mrs[0].title).toBe("QA agent: tests for story SHOP-101");
    expect(gl.mrs[0].labels).toEqual(expect.arrayContaining(["qa-agent", "story::SHOP-101", "service::orders"]));
    expect(gl.mrs[0].description).toMatch(/Waiting ACs[\s\S]*AC-1: waits for/);
    expect((await fileStore(w.qa).load("SHOP-101"))!.agentMr).toMatchObject({ branch: BRANCH, iid: 1, state: "opened" });
    // The manifest records when the service change landed and when its test merge request was opened (metrics: hours between them).
    const runs = path.join(w.qa, ".qa-sentinel/runs");
    const manifest = JSON.parse(fs.readFileSync(path.join(runs, fs.readdirSync(runs).find((d) => fs.existsSync(path.join(runs, d, "manifest.json")) && JSON.parse(fs.readFileSync(path.join(runs, d, "manifest.json"), "utf8")).kind === "generate")!, "manifest.json"), "utf8"));
    expect(Date.parse(manifest.trigger.serviceCommitAt)).toBeLessThanOrEqual(Date.parse(manifest.trigger.mrOpenedAt));

    g(w.storefront, "merge", "--no-ff", "-q", "-m", "Merge feature/SHOP-101-ui", "feature/SHOP-101-ui");
    g(w.qa, "checkout", "-q", "main");
    expect(await gen({ service: "storefront", servicePath: w.storefront, processEnv: glEnv() })).toBe(0);
    expect(gl.mrs).toHaveLength(1); // the same merge request, not a second one
    expect(gl.mrs[0].labels).toEqual(expect.arrayContaining(["service::storefront", "service::orders"]));
    expect(gl.mrs[0].description).not.toMatch(/Waiting ACs[\s\S]*AC-1: waits/);
    // The end-to-end AC was written: the people who asked are told the test merge request is ready, once.
    expect(notes("cross-service-tests-ready")).toHaveLength(1);
    expect(notes("cross-service-tests-ready")[0].body).toContain(`[~jsmith] end-to-end tests for AC-1 are ready for review: ${gl.url}/mr/1`);
    expect(gl.log.filter((l) => l.startsWith("POST /api/v4/projects/42/merge_requests ")).length + gl.log.filter((l) => l === "POST /api/v4/projects/42/merge_requests").length).toBe(1);
  }, 60_000);

  it("starts a new branch from main when the earlier merge request was closed, and links the old one", async () => {
    const gl = await mockGitlab();
    w = await world({ gitlab: gl.url, crossService: "when-ac-complete" });
    expect(await gen({ processEnv: glEnv() })).toBe(0);
    const firstTip = g(w.origin, "rev-parse", BRANCH);
    gl.mrs[0].state = "closed";
    g(w.storefront, "merge", "--no-ff", "-q", "-m", "Merge feature/SHOP-101-ui", "feature/SHOP-101-ui");
    g(w.qa, "checkout", "-q", "main");
    expect(await gen({ service: "storefront", servicePath: w.storefront, processEnv: glEnv() })).toBe(0);
    expect(gl.mrs).toHaveLength(2);
    expect(gl.mrs[1].description).toMatch(/Previous test merge request \[!1\].*closed/);
    // Started again from main: the rejected tests are not in the new branch, and the old commit is not its ancestor.
    expect(branchFiles(w.origin)).toContain("tests/api/ac-1.spec.ts");
    expect(branchFiles(w.origin)).not.toContain("tests/api/ac-2.spec.ts");
    expect(() => g(w.origin, "merge-base", "--is-ancestor", firstTip, BRANCH)).toThrow();
  }, 60_000);

  it("a conflict with main stops the run: nothing is pushed, the repo is left clean, the job fails and the merge request gets a note", async () => {
    const gl = await mockGitlab();
    w = await world({ gitlab: gl.url, crossService: "when-ac-complete", notify: { "merge-conflict": { on: true, to: ["jsmith"] } } });
    expect(await gen({ processEnv: glEnv() })).toBe(0);
    const tip = g(w.origin, "rev-parse", BRANCH);
    const other = path.join(w.root, "other");
    g(w.root, "clone", "-q", w.origin, other);
    g(other, "checkout", "-q", BRANCH);
    commit(other, "tests/api/ac-2.spec.ts", "// the reviewer's version\n", "reviewer edits the test");
    g(other, "push", "-q", "origin", BRANCH);
    g(other, "checkout", "-q", "main");
    commit(other, "tests/api/ac-2.spec.ts", "// somebody else's file on main\n", "main adds the same path");
    g(other, "push", "-q", "origin", "main");
    const reviewerTip = g(w.origin, "rev-parse", BRANCH);
    g(w.storefront, "merge", "--no-ff", "-q", "-m", "Merge feature/SHOP-101-ui", "feature/SHOP-101-ui");
    g(w.qa, "checkout", "-q", "main");
    const planned = fake.calls.filter((c) => c.kind === "plan").length;

    expect(await gen({ service: "storefront", servicePath: w.storefront, processEnv: glEnv() })).toBe(1);
    expect(g(w.origin, "rev-parse", BRANCH)).toBe(reviewerTip);
    expect(reviewerTip).not.toBe(tip);
    expect(fake.calls.filter((c) => c.kind === "plan")).toHaveLength(planned); // no AI spend on a blocked branch
    expect(g(w.qa, "status", "--porcelain")).toBe("");
    expect(g(w.qa, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    const job = Object.values((await fileStore(w.qa).load("SHOP-101"))!.jobs).find((j) => j.outcome === "blocked-conflict");
    // Stopped before any AI work by something a person must fix: not an attempt of the job (it needs no --force once the conflict is resolved).
    expect(job).toMatchObject({ state: "aborted", attempts: 0 });
    expect(gl.notes[1]?.[0].body).toMatch(/qa-sentinel:story-branch-blocked[\s\S]*conflicts in tests\/api\/ac-2\.spec\.ts/);
    // A second check finds the same problem and edits the note instead of adding another.
    await gen({ service: "storefront", servicePath: w.storefront, processEnv: glEnv(), force: true });
    expect(gl.notes[1]).toHaveLength(1);
    // The people who asked are told once (the key holds both tips, so the same conflict is not announced again), and the record keeps it for the status comment.
    expect(notes("merge-conflict")).toHaveLength(1);
    expect(notes("merge-conflict")[0].body).toContain("[~jsmith] the test branch qa-sentinel/story-SHOP-101 cannot take main");
    const rec = (await fileStore(w.qa).load("SHOP-101"))!;
    expect(rec.conflict).toMatchObject({ branch: BRANCH });
    expect(rec.conflict!.key).toMatch(/^qa-sentinel\/story-SHOP-101@[0-9a-f]{10}\+[0-9a-f]{10}$/);
    expect(rec.notified.filter((n) => n.event === "merge-conflict")).toHaveLength(1);
  }, 90_000);

  it("is a draft with its status in the title when verification does not pass", async () => {
    const gl = await mockGitlab();
    w = await world({ gitlab: gl.url, runner: "sh -c 'exit 1' sh" });
    expect(await gen({ processEnv: glEnv() })).toBe(1);
    expect(gl.mrs[0].title).toMatch(/^Draft: QA agent: tests for story SHOP-101 \(FAILED\)$/);
    expect(gl.mrs[0].labels).toContain("qa-sentinel::failed");
    // The tests are committed and pushed for people to look at; the job counts as done (the same inputs would give the same result).
    expect(branchFiles(w.origin)).toContain("tests/api/ac-2.spec.ts");
  }, 60_000);
});

describe("jobs, locks and what stays out of git", () => {
  it("does not start while another generate job of the same story is running (it writes the same branch)", async () => {
    w = await world();
    const os = await import("node:os");
    const store = fileStore(w.qa);
    const now = new Date().toISOString();
    await store.save({ ...(await import("../src/stories/record.js")).emptyRecord("SHOP-101"), jobs: { "generate:SHOP-101:other": { key: "generate:SHOP-101:other", kind: "generate", state: "running", startedAt: now, attempts: 0, costUsd: 0, owner: `${os.hostname()}:${process.pid}` } } });
    expect(await gen()).toBe(0);
    expect(fake.calls).toHaveLength(0);
    expect(g(w.origin, "branch", "--list", "qa-sentinel/*")).toBe("");
    // --force starts it anyway (budgets still apply).
    expect(await gen({ force: true })).toBe(0);
    expect(fake.calls.length).toBeGreaterThan(0);
  }, 60_000);

  it("commits nothing Jira-derived: no story record, no stories overview, no run folders", async () => {
    w = await world();
    expect(await gen()).toBe(0);
    const tracked = branchFiles(w.origin);
    expect(tracked.filter((f) => f.startsWith(".qa-sentinel/") || f === "qa-stories.md" || f === "qa-sentinel-summary.md")).toEqual([]);
    expect(fs.existsSync(path.join(w.qa, ".qa-sentinel/stories/SHOP-101.json"))).toBe(true);
    // The Jira title appears in no tracked file of the branch (the expected file carries the AC text by design, not the card's title).
    expect(() => g(w.origin, "grep", "-q", "Delivery slots", BRANCH, "--")).toThrow(); // git grep exits 1 when nothing matches
  }, 60_000);

  it("a run that goes through clears the recorded merge conflict", async () => {
    w = await world();
    const { emptyRecord } = await import("../src/stories/record.js");
    await fileStore(w.qa).save({ ...emptyRecord("SHOP-101"), conflict: { branch: BRANCH, message: "old", at: "2026-10-01T00:00:00Z", key: "k" } });
    expect(await gen()).toBe(0);
    expect((await fileStore(w.qa).load("SHOP-101"))!.conflict).toBeUndefined();
  }, 60_000);

  it("rejects --acs for an AC that still waits, unless forced", async () => {
    w = await world();
    await expect(gen({ service: "", story: "SHOP-101", acs: ["AC-1"], base: undefined, head: undefined, push: false })).rejects.toThrow(/AC-1 cannot be planned yet.*waits for/);
  }, 60_000);

  it("generate --story on a story whose changes were all reverted does nothing and says so", async () => {
    w = await world();
    g(w.storefront, "branch", "-q", "-D", "feature/SHOP-101-ui"); // orders is the story's only change
    g(w.orders, "revert", "--no-edit", "HEAD");
    expect(await gen({ service: "", story: "SHOP-101", base: undefined, head: undefined, push: false })).toBe(0);
    expect(fake.calls).toHaveLength(0);
  }, 60_000);

  it("a revert commit does not start a run (no agent call, no merge request); the same change under another title does", async () => {
    const gl = await mockGitlab();
    w = await world({ gitlab: gl.url });
    expect(await gen({ processEnv: { ...glEnv(), QA_SERVICE_COMMIT_TITLE: 'Revert "SHOP-101 cap a slot"' } })).toBe(0);
    expect(fake.calls).toHaveLength(0);
    expect(gl.mrs).toHaveLength(0);
    expect(await gen({ processEnv: { ...glEnv(), QA_SERVICE_COMMIT_TITLE: "SHOP-101 cap a slot" } })).toBe(0);
    expect(fake.calls.length).toBeGreaterThan(0);
  }, 60_000);
});

describe("per-merge branches (generation.scope: service)", () => {
  it("keeps the old branch name and tells the planner about tests an open QA agent merge request already adds; a create of the same file is rejected", async () => {
    const gl = await mockGitlab();
    w = await world({ scope: "service", gitlab: gl.url });
    // Another agent merge request (from an earlier merge) adds tests/api/orders.spec.ts and is still open.
    const other = path.join(w.root, "other");
    g(w.root, "clone", "-q", w.origin, other);
    g(other, "checkout", "-q", "-b", "qa-sentinel/orders-aaaa1111");
    commit(other, "tests/api/orders.spec.ts", `test("rejects a past slot @story:SHOP-100", () => {});\n`, "agent tests");
    g(other, "push", "-q", "origin", "qa-sentinel/orders-aaaa1111");
    gl.mrs.push({ iid: 7, state: "opened", web_url: `${gl.url}/mr/7`, source_branch: "qa-sentinel/orders-aaaa1111", target_branch: "main", title: "QA agent", description: "", labels: ["qa-agent"] });
    const plan = (file: string) => (scope: string[]) => {
      const ev = [{ source: "source-code", file: "src/app.js", line: 1, reference: "x" }];
      return {
        schemaVersion: 1,
        verdict: "v",
        recommendedAction: "a",
        changes: [{ id: "c1", type: "business-rule", summary: "cap", observable: true, requirementIds: scope, oracleStatus: "approved", riskFactors: ["business-rule"], evidence: ev }],
        decisions: [{ changeId: "c1", coverage: "missing", decision: "create", reason: "r", existingTests: [], targetFile: file, proposedScenarios: scope.map((ac) => ({ title: ac, requirementIds: [ac], behaviourIds: [ac === "AC-1" ? "B1" : "B2"], assertions: ["a"] })), evidence: ev }],
        requirementStatus: scope.map((id) => ({ id, status: "implemented", evidence: ev })),
      };
    };
    fake.planOverride = plan("tests/api/orders.spec.ts");
    expect(await gen({ processEnv: glEnv() })).toBe(1);
    expect(fake.calls[0].prompt).toMatch(/open QA agent merge requests already add tests/);
    expect(fake.contexts[0].openAgentMrs).toMatch(/open-agent-mrs\.md$/);
    expect(fake.calls.filter((c) => c.kind === "repair-plan")).toHaveLength(1);
    expect(fake.calls.map((c) => c.kind)).not.toContain("author");
  }, 60_000);
});

const mergeStorefront = () => g(w.storefront, "merge", "--no-ff", "-q", "-m", "Merge feature/SHOP-101-ui", "feature/SHOP-101-ui");
const records = async () => (await fileStore(w.qa).load("SHOP-101"))!;
const storyGen = (o: Partial<Parameters<typeof generateCommand>[0]> = {}) => gen({ service: "", story: "SHOP-101", base: undefined, head: undefined, ...o });
const plans = () => fake.calls.filter((c) => c.kind === "plan").length;

describe("no second AI run for what the story branch already holds", () => {
  it("--acs and a story run skip an AC already written for these commits, until --force", async () => {
    w = await world();
    expect(await gen()).toBe(0); // the orders merge writes AC-2
    expect((await records()).singleService["AC-2"]).toMatchObject({ state: "written" });
    const before = fake.calls.length;
    // Asking for the AC again by name is not a way around the check.
    expect(await storyGen({ acs: ["AC-2"] })).toBe(0);
    expect(await storyGen()).toBe(0);
    expect(fake.calls.length).toBe(before);
    // --force plans it again (the fake writes a second file this time, as a real author would write other tests).
    fake.suffix = "-again";
    expect(await storyGen({ acs: ["AC-2"], force: true, push: false })).toBe(0);
    expect(fake.calls.length).toBeGreaterThan(before);
  }, 90_000);

  it("a merge run and --acs name the same job when they plan the same ACs against the same commits", async () => {
    w = await world({ crossService: "when-ac-complete" });
    mergeStorefront();
    // One run from the storefront merge: AC-1 (orders + storefront) is written.
    expect(await gen({ service: "storefront", servicePath: w.storefront })).toBe(0);
    const keys = Object.keys((await records()).jobs).filter((k) => k.startsWith("generate:SHOP-101:acs-"));
    expect(keys).toEqual([expect.stringMatching(/^generate:SHOP-101:acs-AC-1:/)]);
    // The key is made of the cross-service ACs alone (AC-2 is a single-service AC and is not part of it).
    expect(keys[0]).not.toContain("AC-2");
    // The record of what was written is lost; asking for the same AC by name is the same job, found done by its key.
    const rec = await records();
    rec.crossService = {};
    await fileStore(w.qa).save(rec);
    const before = plans();
    expect(await storyGen({ acs: ["AC-1"] })).toBe(0);
    expect(plans()).toBe(before);
    expect(Object.keys((await records()).jobs).filter((k) => k.startsWith("generate:SHOP-101:acs-"))).toEqual(keys);
  }, 90_000);

  it("the same holds for single-service ACs: a merge run and --acs share one job key", async () => {
    w = await world();
    expect(await gen()).toBe(0); // the orders merge: AC-2
    const keys = Object.keys((await records()).jobs).filter((k) => k.startsWith("generate:SHOP-101:acs-AC-2:"));
    expect(keys).toHaveLength(1);
    const rec = await records();
    rec.singleService = {};
    await fileStore(w.qa).save(rec);
    const before = plans();
    expect(await storyGen({ acs: ["AC-2"] })).toBe(0);
    expect(plans()).toBe(before);
  }, 90_000);

  it("stories reads the story branch: an AC whose tests are on it is not due again, and an AC that waits starts nothing", async () => {
    const { storiesCommand } = await import("../src/commands/stories.js");
    w = await world();
    expect(await gen()).toBe(0); // AC-2 written and pushed; AC-1 waits for the storefront merge
    g(w.qa, "checkout", "-q", "main");
    expect(fs.existsSync(path.join(w.qa, "tests/api/ac-2.spec.ts"))).toBe(false); // main does not hold them
    const out = path.join(w.qa, "qa-stories.json");
    const logs: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((x: any) => (logs.push(String(x)), true));
    try {
      await storiesCommand({ cwd: w.qa, story: ["SHOP-101"], json: true, noSweep: true, env: process.env, out });
    } finally {
      spy.mockRestore();
    }
    const [a] = JSON.parse(logs.join(""));
    expect(a.acs.find((x: any) => x.id === "AC-2").tests).toBe("covered");
    // AC-1 has no test and cannot get one yet (the storefront part is open): nothing for the AI to start.
    expect(a.next).toBe("wait");
    expect(a.todo.some((t: any) => t.who === "ai")).toBe(false);
    const calls = fake.calls.length;
    expect(await storiesCommand({ cwd: w.qa, story: ["SHOP-101"], noSweep: true, act: true, env: { ...process.env, CI: "true" }, out })).toBe(0);
    expect(fake.calls.length).toBe(calls);
  }, 90_000);

  it("stories --act runs the real generate; a limit that stops it gives exit 4, and a second check starts nothing new", async () => {
    const { storiesCommand } = await import("../src/commands/stories.js");
    w = await world({ crossService: "when-ac-complete" });
    mergeStorefront();
    const out = path.join(w.qa, "qa-stories.md");
    const env = { ...process.env, CI: "true" };
    // A budget that is used up between the check and the job (another story spent it): generate itself refuses.
    const runners = {
      spec: async () => 0,
      generate: async (o: Parameters<typeof generateCommand>[0]) => {
        const rec = (await fileStore(w.qa).load("SHOP-101")) ?? (await import("../src/stories/record.js")).emptyRecord("SHOP-101");
        rec.totalCostUsd = 100;
        await fileStore(w.qa).save(rec);
        return generateCommand(o);
      },
    };
    expect(await storiesCommand({ cwd: w.qa, story: ["SHOP-101"], noSweep: true, act: true, env, out, runners })).toBe(4);
    expect(fake.calls).toHaveLength(0);
    // Without the budget trouble the real command runs and finishes; the tests land on the story branch.
    const rec = await records();
    rec.totalCostUsd = 0;
    await fileStore(w.qa).save(rec);
    expect(await storiesCommand({ cwd: w.qa, story: ["SHOP-101"], noSweep: true, act: true, env, out })).toBe(0);
    expect(branchFiles(w.origin)).toEqual(expect.arrayContaining(["tests/api/ac-1-ac-2.spec.ts"]));
    const planned = plans();
    // The next check: everything is written, so nothing is due.
    g(w.qa, "checkout", "-q", "main");
    expect(await storiesCommand({ cwd: w.qa, story: ["SHOP-101"], noSweep: true, act: true, env, out })).toBe(0);
    expect(plans()).toBe(planned);
  }, 120_000);
});

describe("the record only says written after the push", () => {
  it("a refused push leaves no 'written' behind, and the next run writes the AC", async () => {
    w = await world();
    const hook = path.join(w.origin, "hooks/pre-receive");
    fs.writeFileSync(hook, '#!/bin/sh\nwhile read old new ref; do case "$ref" in refs/heads/qa-sentinel/*) echo "no pushes today" >&2; exit 1;; esac; done\n', { mode: 0o755 });
    await expect(gen()).rejects.toThrow(/could not be pushed|refused|no pushes today/i);
    const rec = await records();
    expect(rec.singleService["AC-2"]).toBeUndefined();
    expect(rec.agentMr).toBeUndefined();
    fs.rmSync(hook);
    // Not skipped as "already written": the AI runs again, and this time it is pushed and recorded.
    fake.suffix = "-again";
    const before = plans();
    expect(await gen({ force: true })).toBe(0);
    expect(plans()).toBe(before + 1);
    expect(branchFiles(w.origin)).toContain("tests/api/ac-2-again.spec.ts");
    expect((await records()).singleService["AC-2"]).toMatchObject({ state: "written" });
  }, 90_000);
});

describe("a story with no acceptance criteria", () => {
  it("is planned from the change itself on the story branch (it does not silently get no tests)", async () => {
    w = await world({ jiraDescription: "Just a description, no acceptance criteria.\n" });
    fake.planOverride = () => {
      const ev = [{ source: "source-code", file: "src/app.js", line: 1, reference: "x" }];
      return { schemaVersion: 1, verdict: "v", recommendedAction: "a", changes: [{ id: "c1", type: "business-rule", summary: "cap", observable: true, requirementIds: [], oracleStatus: "missing", riskFactors: ["business-rule"], evidence: ev }], decisions: [{ changeId: "c1", coverage: "missing", decision: "create", reason: "r", existingTests: [], proposedScenarios: [{ title: "cap", requirementIds: [], behaviourIds: [], assertions: ["a"] }], evidence: ev }], requirementStatus: [] };
    };
    const code = await gen();
    expect(fake.calls.some((c) => c.kind === "plan")).toBe(true);
    expect(fake.contexts[0].acScope).toBeUndefined();
    expect(code).toBe(0);
    expect(branchFiles(w.origin)).toContain("tests/api/change.spec.ts");
  }, 90_000);
});

describe("Jira components are mapped to services", () => {
  it("an AC that names no service uses the card's components through requirements.jira.components", async () => {
    // AC-1 names no service. The card's component "Storefront App" means the storefront service.
    const e = expectedFile();
    e.acs[0].services = [];
    w = await world({ expected: e, crossService: "when-ac-complete", jiraComponents: ["Storefront App"], componentMap: { "Storefront App": "storefront" } });
    mergeStorefront();
    expect(await gen({ service: "storefront", servicePath: w.storefront })).toBe(0);
    // With the raw component name ("Storefront App") the AC would wait for a service that does not exist.
    expect(fake.contexts[0].acScope).toContain("AC-1");
    expect(fake.contexts[0].heldAcs["AC-1"]).toBeUndefined();
  }, 90_000);
});

describe("a branch that goes away, or an open merge request next to a closed one", () => {
  it("continues the branch when ANY merge request of it is open, whichever was updated last", async () => {
    const gl = await mockGitlab();
    w = await world({ gitlab: gl.url, crossService: "when-ac-complete" });
    expect(await gen({ processEnv: glEnv() })).toBe(0);
    // An older closed merge request of the same branch (created earlier, but listed after the open one; a late comment makes it the "latest updated").
    gl.mrs.unshift({ iid: 99, state: "closed", web_url: `${gl.url}/mr/99`, source_branch: BRANCH, target_branch: "main", title: "old", description: "", labels: ["qa-agent"], created_at: "2020-01-01T00:00:00Z", updated_at: "2099-01-01T00:00:00Z" });
    gl.mrs[1].created_at = "2024-01-01T00:00:00Z";
    const reviewer = path.join(w.root, "reviewer");
    g(w.root, "clone", "-q", w.origin, reviewer);
    g(reviewer, "checkout", "-q", BRANCH);
    const reviewerSha = commit(reviewer, "REVIEW.md", "keep me\n", "reviewer: note");
    g(reviewer, "push", "-q", "origin", BRANCH);
    mergeStorefront();
    g(w.qa, "checkout", "-q", "main");
    expect(await gen({ service: "storefront", servicePath: w.storefront, processEnv: glEnv() })).toBe(0);
    g(w.origin, "merge-base", "--is-ancestor", reviewerSha, BRANCH); // the reviewer's commit is still in the branch
    expect(gl.mrs.filter((m) => m.state === "opened")).toHaveLength(1); // no second merge request
  }, 90_000);

  it("stops, with a note and no AI run, when the merge request is open but its branch was deleted", async () => {
    const gl = await mockGitlab();
    w = await world({ gitlab: gl.url, crossService: "when-ac-complete" });
    expect(await gen({ processEnv: glEnv() })).toBe(0);
    g(w.qa, "checkout", "-q", "main");
    g(w.qa, "branch", "-q", "-D", BRANCH);
    g(w.origin, "branch", "-q", "-D", BRANCH);
    mergeStorefront();
    const before = plans();
    expect(await gen({ service: "storefront", servicePath: w.storefront, processEnv: glEnv() })).toBe(1);
    expect(plans()).toBe(before);
    expect(g(w.origin, "branch", "--list", BRANCH)).toBe(""); // not silently started again from main
    expect(gl.notes[1]?.[0].body).toMatch(/no longer exists on the server/);
    const job = Object.values((await records()).jobs).find((j) => j.outcome === "blocked-missing-branch");
    expect(job).toMatchObject({ state: "aborted", attempts: 0 });
  }, 90_000);

  it("a closed merge request resets what the record says was written, so a story run writes it all again on the new branch", async () => {
    const gl = await mockGitlab();
    w = await world({ gitlab: gl.url, crossService: "when-ac-complete" });
    expect(await gen({ processEnv: glEnv() })).toBe(0);
    expect((await records()).singleService["AC-2"]).toBeDefined();
    gl.mrs[0].state = "closed";
    mergeStorefront();
    g(w.qa, "checkout", "-q", "main");
    expect(await storyGen({ processEnv: glEnv() })).toBe(0);
    expect(fake.contexts.at(-1)!.acScope).toEqual(["AC-1", "AC-2"]);
    expect(gl.mrs).toHaveLength(2);
    expect(branchFiles(w.origin)).toContain("tests/api/ac-1-ac-2.spec.ts");
  }, 90_000);
});

describe("cross-service ACs that need no change", () => {
  it("are recorded as written, so stories stops listing them as ready", async () => {
    w = await world({ crossService: "when-ac-complete" });
    expect(await gen()).toBe(0); // AC-2 on the branch
    mergeStorefront();
    g(w.qa, "checkout", "-q", "main");
    fake.planOverride = (scope) => {
      const ev = [{ source: "source-code", file: "src/ui.js", line: 1, reference: "x" }];
      return {
        schemaVersion: 1,
        verdict: "v",
        recommendedAction: "a",
        changes: [{ id: "c1", type: "business-rule", summary: "cap", observable: true, requirementIds: scope, oracleStatus: "approved", riskFactors: ["business-rule"], evidence: ev }],
        decisions: [{ changeId: "c1", coverage: "covered", decision: "reuse", reason: "r", existingTests: ["tests/api/ac-2.spec.ts"], proposedScenarios: [], evidence: ev }],
        requirementStatus: scope.map((id) => ({ id, status: "implemented", noScenario: "existing tests already prove it", evidence: ev })),
      };
    };
    expect(await gen({ service: "storefront", servicePath: w.storefront })).toBe(0);
    expect((await records()).crossService["AC-1"]).toMatchObject({ state: "written" });
  }, 90_000);
});

describe("a create of a file another open agent MR adds, with no targetFile in the plan", () => {
  it("is caught on the files the author really wrote", async () => {
    const gl = await mockGitlab();
    w = await world({ scope: "service", gitlab: gl.url });
    const other = path.join(w.root, "other");
    g(w.root, "clone", "-q", w.origin, other);
    g(other, "checkout", "-q", "-b", "qa-sentinel/orders-aaaa1111");
    commit(other, "tests/api/ac-1-ac-2.spec.ts", `test("x @story:SHOP-100", () => {});\n`, "agent tests");
    g(other, "push", "-q", "origin", "qa-sentinel/orders-aaaa1111");
    gl.mrs.push({ iid: 7, state: "opened", web_url: `${gl.url}/mr/7`, source_branch: "qa-sentinel/orders-aaaa1111", target_branch: "main", title: "QA agent", description: "", labels: ["qa-agent"] });
    const ev = [{ source: "source-code", file: "src/app.js", line: 1, reference: "x" }];
    fake.planOverride = (scope) => ({
      schemaVersion: 1,
      verdict: "v",
      recommendedAction: "a",
      changes: [{ id: "c1", type: "business-rule", summary: "cap", observable: true, requirementIds: scope, oracleStatus: "approved", riskFactors: ["business-rule"], evidence: ev }],
      decisions: [{ changeId: "c1", coverage: "missing", decision: "create", reason: "r", existingTests: [], proposedScenarios: scope.map((ac) => ({ title: ac, requirementIds: [ac], behaviourIds: [ac === "AC-1" ? "B1" : "B2"], assertions: ["a"] })), evidence: ev }],
      requirementStatus: scope.map((id) => ({ id, status: "implemented", evidence: ev })),
    });
    expect(await gen({ processEnv: glEnv() })).toBe(1);
    expect(fake.calls.map((c) => c.kind)).toContain("author");
    const runs = path.join(w.qa, ".qa-sentinel/runs");
    const guard = fs.readdirSync(runs).map((d) => path.join(runs, d, "guardrails.json")).find((f) => fs.existsSync(f))!;
    expect(fs.readFileSync(guard, "utf8")).toMatch(/duplicate-test-file[\s\S]*!7 already adds/);
  }, 90_000);
});

describe("--acs and story keys are checked", () => {
  it("rejects an AC the story does not have, --acs without --story, and a story key that is not a key", async () => {
    w = await world();
    await expect(storyGen({ acs: ["AC-9"], push: false })).rejects.toThrow(/AC-9 is not in SHOP-101 \(its ACs: AC-1, AC-2\)/);
    await expect(gen({ acs: ["AC-1"] })).rejects.toThrow(/--acs needs --story/);
    await expect(storyGen({ story: "../x", push: false })).rejects.toThrow(/not a story key/);
    expect(fake.calls).toHaveLength(0);
  }, 90_000);
});
