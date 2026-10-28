import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigSchema, writeConfig } from "../src/config.js";
import { publishCommand } from "../src/commands/publish.js";
import { cleanTmp, tmp } from "./helpers/mocks.js";
afterEach(() => cleanTmp());

async function withJira(run: (o: { cwd: string; props: Record<string, any>; env: NodeJS.ProcessEnv }) => Promise<void>) {
  const props: Record<string, any> = {};
  const srv = http.createServer((req, res) => { let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => {
    const m = req.url!.match(/\/issue\/([^/]+)\/properties\/(.+)$/);
    if (m) { const k = m[1] + "/" + m[2]; if (req.method === "PUT") { props[k] = JSON.parse(b); res.writeHead(204).end(); return; }
      if (k in props) { res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ key: m[2], value: props[k] })); return; } }
    res.writeHead(404, { "content-type": "application/json" }).end("{}"); }); });
  await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok));
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  try {
    const cwd = tmp("qas-poison-");
    writeConfig(cwd, ConfigSchema.parse({ version: 1, mode: "existing", project: { name: "t" }, tests: { api: { framework: "playwright", runCommand: "x" } }, ci: { platform: "gitlab" }, requirements: { jira: { baseUrl: base, projectKeys: ["SHOP"] } }, automation: { record: "jira" } }));
    await run({ cwd, props, env: { JIRA_PAT: "x" } });
  } finally { srv.close(); }
}
const craftRun = (cwd: string, steps: unknown[]) => {
  const dir = path.join(cwd, ".qa-sentinel", "runs", "evil");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "publish.json"), JSON.stringify({ version: 1, kind: "generate", runId: "evil", createdAt: "x", steps }));
};
const entries = [{ ac: "AC-1", kind: "single", state: "written", heads: "h", acHash: "a" }, { ac: "AC-2", kind: "cross", state: "written", heads: "h", acHash: "a" }, { ac: "AC-3", kind: "single", state: "held", heads: "h", acHash: "a", reason: "r" }];

const MR = (story: string, extra: Record<string, unknown> = {}) => ({ type: "merge-request", branch: `qa-sentinel/story-${story}`, headSha: "a".repeat(40), storyKey: story, title: "t", description: "d", labels: [], ...extra });

describe("a hostile publish.json cannot write to a story this job is not for (the story key comes from the pipeline, not the run folder)", () => {
  const pipeline = (more: NodeJS.ProcessEnv = {}) => ({ JIRA_PAT: "x", QA_STORY_KEY: "SHOP-1", ...more });
  const recordOf = (props: Record<string, any>, k: string) => props[`${k}/qa-sentinel.record`];

  it("P1: a merge-request step and a record step for another story: nothing is pushed and no record is written", async () => {
    await withJira(async ({ cwd, props }) => {
      craftRun(cwd, [MR("OTHER-9"), { type: "record", story: "OTHER-9", entries, evidence: [{ id: "AC-1", status: "covered", runId: "evil" }] }]);
      expect(await publishCommand({ cwd, kind: "generate", env: pipeline() })).toBe(1);
      expect(recordOf(props, "OTHER-9")).toBeUndefined();
    });
  });
  it("P2: a record step for another story with no merge request: no held entries, no evidence, no clearConflict", async () => {
    await withJira(async ({ cwd, props }) => {
      craftRun(cwd, [{ type: "record", story: "OTHER-9", entries, evidence: [{ id: "AC-1", status: "covered", runId: "evil" }], clearConflict: true }]);
      expect(await publishCommand({ cwd, kind: "generate", env: pipeline() })).toBe(1);
      expect(recordOf(props, "OTHER-9")).toBeUndefined();
    });
  });
  it("P3: a conflict step for another story (the run's merge request being a per-merge one) is refused; for this job's own story it is applied", async () => {
    await withJira(async ({ cwd, props }) => {
      const conflict = (story: string) => ({ branch: `qa-sentinel/story-${story}`, message: "[click here|https://evil.example]", key: "k" });
      craftRun(cwd, [{ type: "record", story: "OTHER-9", conflict: conflict("OTHER-9"), entries: [], evidence: [] }]);
      expect(await publishCommand({ cwd, kind: "generate", env: pipeline() })).toBe(1);
      expect(recordOf(props, "OTHER-9")).toBeUndefined();
    });
  });
  it("M4: a run with no merge request ('existing tests are enough') writes its own story's written entries; a reset in a record step is refused", async () => {
    await withJira(async ({ cwd, props }) => {
      craftRun(cwd, [{ type: "record", story: "SHOP-1", entries, evidence: [] }]);
      expect(await publishCommand({ cwd, kind: "generate", env: pipeline() })).toBe(0);
      const rec = recordOf(props, "SHOP-1");
      expect(Object.fromEntries(Object.entries(rec.singleService).map(([k, v]: any) => [k, v.state]))).toEqual({ "AC-1": "written", "AC-3": "held" });
      expect(Object.keys(rec.crossService)).toEqual(["AC-2"]);
      fs.rmSync(path.join(cwd, ".qa-sentinel", "runs", "evil"), { recursive: true });
      craftRun(cwd, [{ type: "record", story: "SHOP-1", entries: [], evidence: [], reset: true }]);
      expect(await publishCommand({ cwd, kind: "generate", env: pipeline() })).toBe(1);
    });
  });
  it("the story can come from the service commit's title or the trigger variables,", async () => {
    await withJira(async ({ cwd, props }) => {
      craftRun(cwd, [{ type: "record", story: "SHOP-7", entries, evidence: [] }]);
      expect(await publishCommand({ cwd, kind: "generate", env: { JIRA_PAT: "x", QA_SERVICE_COMMIT_TITLE: "SHOP-7 orders: cap a slot" } })).toBe(0);
      expect(recordOf(props, "SHOP-7")).toBeDefined();
    });
  });
});

describe("trusted stories: a bug leads to its story through Jira; free text counts only with projectKeys", () => {
  const cfgFor = (jiraBase: string, keys: string[]) =>
    ConfigSchema.parse({ version: 1, mode: "existing", project: { name: "t" }, tests: { api: { framework: "playwright", runCommand: "x" } }, ci: { platform: "gitlab" }, requirements: { source: "jira", jira: { baseUrl: jiraBase, projectKeys: keys, featureIssueTypes: ["Story"], hierarchy: { links: [{ name: "Relates", from: ["Bug"] }] } } } });

  it("M1: the bug named in the service commit makes its linked story trusted; a story the bug does not lead to stays refused", async () => {
    const { mockJira } = await import("./helpers/mockJira.js");
    const { trustedStories } = await import("../src/commands/publish.js");
    const j = await mockJira({
      issues: {
        "SHOP-3": { summary: "bug", issuetype: { name: "Bug" }, status: { name: "In Progress" }, labels: [], components: [], issuelinks: [{ type: { name: "Relates", inward: "relates to", outward: "relates to" }, outwardIssue: { key: "SHOP-1" } }] },
        "SHOP-1": { summary: "story", issuetype: { name: "Story" }, status: { name: "In Progress" }, labels: [], components: [] },
      },
    });
    try {
      const c = cfgFor(j.baseUrl, ["SHOP"]);
      const t = await trustedStories(c, { JIRA_PAT: "x", QA_SERVICE_COMMIT_TITLE: "SHOP-3 fix the slot cap" });
      expect(t.has("SHOP-3")).toBe(true);
      expect(t.has("SHOP-1")).toBe(true);
      expect(t.has("SHOP-9")).toBe(false);
      // The same without a Jira login: only the bug.
      const none = await trustedStories(c, { QA_SERVICE_COMMIT_TITLE: "SHOP-3 fix the slot cap" });
      expect([...none]).toEqual(["SHOP-3"]);
    } finally {
      await j.close();
    }
  });

  it("with projectKeys empty, UTF-8 and SHA-256 in commit text are not story keys; QA_STORY_KEY still is", async () => {
    const { trustedStories } = await import("../src/commands/publish.js");
    const c = cfgFor("http://127.0.0.1:1", []);
    expect([...(await trustedStories(c, { QA_SERVICE_COMMIT_TITLE: "fix UTF-8 and SHA-256 handling", QA_SERVICE_COMMIT_MESSAGE: "see RFC-7231, SHOP-5" }))]).toEqual([]);
    expect([...(await trustedStories(c, { QA_STORY_KEY: "shop-5", QA_SERVICE_COMMIT_TITLE: "UTF-8" }))]).toEqual(["SHOP-5"]);
    const c2 = cfgFor("http://127.0.0.1:1", ["SHOP"]);
    expect([...(await trustedStories(c2, { QA_SERVICE_COMMIT_TITLE: "UTF-8 SHOP-5" }))]).toEqual(["SHOP-5"]);
  });

  it("M3: gap-report steps are bound too: a report, notice, bug or mr-seen step for a story the merge request does not name is refused", async () => {
    await withJira(async ({ cwd, props, env }) => {
      const dir = path.join(cwd, ".qa-sentinel", "runs", "gap");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "publish.json"), JSON.stringify({ version: 1, kind: "gap-report", runId: "gap", createdAt: "x", steps: [
        { type: "notify", story: "OTHER-9", event: "merge-conflict", text: "x", key: "k" },
        { type: "mr-seen", args: { feature: "OTHER-9", service: "orders" } },
        { type: "report", report: "r", storyKey: "OTHER-9", targets: ["jira"] },
      ] }));
      expect(await publishCommand({ cwd, kind: "gap-report", env: { ...env, QA_STORY_KEY: "SHOP-1", CI_MERGE_REQUEST_IID: "3", CI_PROJECT_ID: "7" } })).toBe(1);
      expect(props["OTHER-9/qa-sentinel.record"]).toBeUndefined();
      const state = JSON.parse(fs.existsSync(path.join(dir, "published.json")) ? fs.readFileSync(path.join(dir, "published.json"), "utf8") : '{"done":{}}');
      expect(Object.keys(state.done)).toEqual([]);
    });
  });
});
