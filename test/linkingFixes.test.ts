import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigSchema, writeConfig } from "../src/config.js";

// A fake agent runtime. "ok" writes a small valid plan, "fail" fails the run, "throw" crashes it. `plan` decides per call.
const fake = vi.hoisted(() => ({
  asked: [] as { prompt: string; cwd: string }[],
  mode: (_n: number): "ok" | "fail" | "throw" => "fail",
  cost: 0,
}));
vi.mock("../src/engines/ClaudeCodeEngine.js", async () => {
  const fsm = await import("node:fs");
  const pathm = await import("node:path");
  const ev = [{ source: "source-code", file: "src/a.ts", line: 1, reference: "x" }];
  const plan = {
    schemaVersion: 1,
    verdict: "v",
    recommendedAction: "a",
    changes: [{ id: "c1", type: "internal", summary: "tweak", observable: false, requirementIds: [], oracleStatus: "missing", riskFactors: ["internal"], evidence: ev }],
    decisions: [{ changeId: "c1", coverage: "unknown", decision: "skip", existingTests: [], proposedScenarios: [], evidence: ev, reason: "no behaviour" }],
    impactedTests: [],
    acMismatches: [],
    specDrift: [],
    requirementStatus: [{ id: "AC-1", status: "not-found" }],
    suspicious: [],
    openQuestions: [],
    skipReason: null,
  };
  return {
    engineFor: () => ({
      name: "fake",
      available: () => ({ ok: true }),
      run: async (t: { prompt: string; cwd: string }) => {
        const n = fake.asked.push({ prompt: t.prompt, cwd: t.cwd });
        const mode = fake.mode(n);
        if (mode === "throw") throw new Error("engine exploded");
        if (mode === "fail") return { ok: false, status: "error", result: "fake engine: no model in tests", costUsd: fake.cost };
        const rel = /Write the plan as JSON to (\S+)\./.exec(t.prompt)?.[1];
        if (rel) fsm.writeFileSync(pathm.join(t.cwd, rel), JSON.stringify(plan));
        return { ok: true, status: "success", result: "done", costUsd: fake.cost };
      },
    }),
  };
});

import { gapReportCommand } from "../src/commands/gapReport.js";
import { ensureGitignore, trackedJiraFiles, upgradeCommand } from "../src/commands/init.js";
import { judgeStory } from "../src/commands/suite.js";
import { activeParts, assembleFeature, featureStatus, partsFromGit, partsFromGitLab, revertedParts, type FeatureManifest, type MrScanCache, type ServicePart } from "../src/feature/manifest.js";
import { acReadiness } from "../src/feature/readiness.js";
import { parseStamp } from "../src/plan/fingerprint.js";
import { resolveRequirements } from "../src/requirements.js";
import { resolveKeysCached } from "../src/stories/resolve.js";
import { combinedChange, storyParts } from "../src/story.js";
import { log } from "../src/log.js";

const GIT_ENV = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const g = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8", env: { ...process.env, ...GIT_ENV } }).trim();
const dirs: string[] = [];
const tmp = (p: string) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), p));
  dirs.push(d);
  return d;
};
const servers: { close: () => Promise<void> }[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fake.mode = () => "fail";
  fake.cost = 0;
  fake.asked.length = 0;
  for (const s of servers.splice(0)) await s.close();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

async function serve(handler: (req: http.IncomingMessage, url: URL, body: string) => { status?: number; body?: unknown; headers?: Record<string, string> }) {
  const log: string[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      log.push(`${req.method} ${url.pathname}${url.search}`);
      const r = handler(req, url, body);
      res.writeHead(r.status ?? 200, { "content-type": "application/json", ...(r.headers ?? {}) });
      res.end(JSON.stringify(r.body ?? {}));
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const s = { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, log, close: () => new Promise<void>((ok) => server.close(() => ok())) };
  servers.push(s);
  return s;
}
const card = (summary: string, type: string, o: Record<string, unknown> = {}) => ({ summary, issuetype: { name: type }, status: { name: "In Progress" }, description: "", labels: [], ...o });
const STORY = (ac: string) => `## Acceptance criteria\n- AC-1: ${ac}\n`;
const parent = (key: string) => ({ key, fields: { issuetype: { name: "Story" } } });
const issues: Record<string, any> = {
  "SHOP-12": card("Slots", "Story", { description: STORY("A slot takes at most 3 orders.") }),
  "SHOP-19": card("Past", "Story", { description: STORY("Past orders rejected.") }),
  "SHOP-20": card("Third", "Story", { description: STORY("Third story.") }),
  "SHOP-210": card("Bug", "Bug", { description: "first bug text", parent: parent("SHOP-12") }),
  "SHOP-211": card("Bug2", "Bug", { description: "second bug text", parent: parent("SHOP-12") }),
};
const jiraServer = () =>
  serve((req, url) => {
    const m = url.pathname.match(/^\/rest\/api\/2\/issue\/([^/]+)(\/comment.*)?$/);
    if (!m) return { status: 404 };
    if (m[2]) return req.method === "GET" ? { body: { comments: [], total: 0 } } : { status: 201, body: { id: "1" } };
    const i = issues[decodeURIComponent(m[1])];
    return i ? { body: { key: m[1], fields: i } } : { status: 404, body: {} };
  });
async function glServer(state: { draft: boolean } = { draft: false }) {
  const notes: { id: number; body: string; author: { id: number } }[] = [];
  const s = await serve((req, url, body) => {
    if (url.pathname === "/api/v4/user") return { body: { id: 7 } };
    if (url.pathname.endsWith("/notes") && req.method === "GET") return { body: notes, headers: { "x-next-page": "" } };
    if (url.pathname.endsWith("/notes") && req.method === "POST") {
      notes.push({ id: notes.length + 1, body: JSON.parse(body).body, author: { id: 7 } });
      return { status: 201, body: { id: notes.length } };
    }
    const put = url.pathname.match(/\/notes\/(\d+)$/);
    if (put) {
      notes[Number(put[1]) - 1].body = JSON.parse(body).body;
      return { body: {} };
    }
    if (/merge_requests\/5$/.test(url.pathname)) return { body: { draft: state.draft, title: "x" } };
    return { body: [] };
  });
  return Object.assign(s, { notes });
}

/** Manifests of the runs that only wrote a merge request note (joined comment, waiting note). */
function joinedManifests(root: string): any[] {
  const runs = path.join(root, ".qa-sentinel/runs");
  return fs
    .readdirSync(runs)
    .map((d) => path.join(runs, d, "manifest.json"))
    .filter((f) => fs.existsSync(f))
    .map((f) => JSON.parse(fs.readFileSync(f, "utf8")))
    .filter((m) => /^gap-(joined|waiting)$/.test(m.outcome ?? ""));
}

function setup(jiraUrl: string, glUrl: string, extra: Record<string, unknown> = {}, requirements: Record<string, unknown> = {}) {
  const root = tmp("qas-fix-");
  const repo = path.join(root, "orders");
  g(root, "init", "-q", "-b", "main");
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  g(repo, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repo, "src/a.ts"), "export const a = 0;\n");
  g(repo, "add", "-A");
  g(repo, "commit", "-qm", "base");
  g(repo, "checkout", "-q", "-b", "feat");
  fs.writeFileSync(path.join(repo, "src/a.ts"), "export const a = 1;\n");
  g(repo, "commit", "-qam", "change");
  writeConfig(
    root,
    ConfigSchema.parse({
      version: 1,
      mode: "existing",
      project: { name: "t" },
      workspace: { services: [{ name: "orders", path: "orders" }] },
      tests: { api: { framework: "playwright", runCommand: "npx playwright test" } },
      ci: { platform: "gitlab", gitlabUrl: glUrl },
      requirements: { source: "jira", jira: { baseUrl: jiraUrl, projectKeys: ["SHOP"], featureIssueTypes: ["Story"] }, ...requirements },
      reporting: { targets: ["jira", "gitlab-mr"] },
      ...extra,
    }),
  );
  vi.stubEnv("JIRA_PAT", "x");
  vi.stubEnv("QA_SENTINEL_GITLAB_TOKEN", "t");
  vi.stubEnv("CI_API_V4_URL", `${glUrl}/api/v4`);
  vi.stubEnv("CI_PROJECT_ID", "1");
  vi.stubEnv("CI_MERGE_REQUEST_IID", "5");
  vi.stubEnv("CI_MERGE_REQUEST_DIFF_BASE_SHA", g(repo, "rev-parse", "main"));
  return { root, repo };
}
const jiraGets = (j: { log: string[] }) => j.log.filter((l) => /^GET \/rest\/api\/2\/issue\/[^/]+\?/.test(l)).map((l) => l.split("?")[0].split("/").pop()!);
const svcOf = (name: string, extra: Record<string, unknown> = {}): any => ({ name, path: ".", dependsOn: [], ...extra });

describe("a merge request that names several stories: stamp and refresh (H1)", () => {
  it("stamps the joined comment, makes no AI run for an unchanged push, and --refresh or a changed AC runs again", async () => {
    const j = await jiraServer();
    const gl = await glServer();
    const { root, repo } = setup(j.url, gl.url);
    vi.stubEnv("CI_MERGE_REQUEST_TITLE", "SHOP-12 SHOP-19 change");
    fake.mode = () => "ok";
    const run = (o: Record<string, unknown> = {}) => gapReportCommand({ cwd: root, service: "orders", servicePath: repo, post: true, ...o });

    const first = await run();
    expect(first.exitCode).toBe(0);
    expect(fake.asked).toHaveLength(2);
    expect(gl.notes).toHaveLength(1);
    expect(parseStamp(gl.notes[0].body)).toMatchObject({ fp: expect.stringMatching(/^[0-9a-f]+$/) });
    const stamped = gl.notes[0].body;
    // The joined comment carries the vote line, with the stamp still last and readable; the run remembers the note for `metrics --online`.
    expect(stamped).toContain("Was this useful? 👍 / 👎");
    expect(stamped.trimEnd().split("\n").at(-1)).toMatch(/qa-sentinel/);
    const noted = joinedManifests(root);
    expect(noted).toHaveLength(1);
    expect(noted[0]).toMatchObject({ kind: "gap-report", outcome: "gap-joined", mr: { iid: "5", noteId: 1 } });

    // The same push again: nothing to do (the unchanged check reads the stamp through the vote line).
    const again = await run();
    expect(fake.asked).toHaveLength(2);
    expect(again).toMatchObject({ skipped: true, exitCode: 0 });
    expect(again.report).toContain("unchanged");
    expect(fs.readFileSync(path.join(root, "qa-gap-report.md"), "utf8")).toContain("unchanged");
    expect(gl.notes[0].body).toBe(stamped);

    // --refresh makes both again.
    await run({ refresh: true });
    expect(fake.asked).toHaveLength(4);

    // One story's acceptance criteria change: everything is made again, and the comment says it is an update.
    issues["SHOP-19"] = card("Past", "Story", { description: STORY("Past orders are rejected with 400.") });
    try {
      await run();
      expect(fake.asked).toHaveLength(6);
      expect(gl.notes[0].body).toContain("Updated for commit");
      expect(parseStamp(gl.notes[0].body)!.fp).not.toBe(parseStamp(stamped)!.fp);
    } finally {
      issues["SHOP-19"] = card("Past", "Story", { description: STORY("Past orders rejected.") });
    }
  });

  it("puts no stamp on the comment when a story failed, so the next push tries again", async () => {
    const j = await jiraServer();
    const gl = await glServer();
    const { root, repo } = setup(j.url, gl.url);
    vi.stubEnv("CI_MERGE_REQUEST_TITLE", "SHOP-12 SHOP-19 change");
    fake.mode = (n) => (n === 1 ? "ok" : "fail");
    const r = await gapReportCommand({ cwd: root, service: "orders", servicePath: repo, post: true });
    expect(r.exitCode).toBe(1);
    expect(gl.notes).toHaveLength(1);
    expect(parseStamp(gl.notes[0].body)).toBeUndefined();
    fake.mode = () => "ok";
    await gapReportCommand({ cwd: root, service: "orders", servicePath: repo, post: true });
    expect(fake.asked).toHaveLength(4);
  });

  it("a draft merge request names no story and reads no Jira; the waiting note is posted and the report file is written (M4)", async () => {
    const j = await jiraServer();
    const gl = await glServer({ draft: true });
    const { root, repo } = setup(j.url, gl.url);
    vi.stubEnv("CI_MERGE_REQUEST_TITLE", "Draft: SHOP-12 SHOP-19 change");
    const r = await gapReportCommand({ cwd: root, service: "orders", servicePath: repo, post: true });
    expect(r).toMatchObject({ skipped: true, exitCode: 0 });
    expect(r.report).toContain("waiting");
    expect(fs.readFileSync(path.join(root, "qa-gap-report.md"), "utf8")).toContain("waiting");
    expect(fake.asked).toHaveLength(0);
    expect(jiraGets(j)).toEqual([]);
    expect(gl.notes).toHaveLength(1);
    // The waiting note takes votes like a report, and its id is kept.
    expect(gl.notes[0].body).toContain("Was this useful? 👍 / 👎");
    expect(joinedManifests(root)[0]).toMatchObject({ outcome: "gap-waiting", mr: { noteId: 1 } });
  });
});

describe("a merge request that names several stories: regression list, failures, limits", () => {
  it("never reads a stale selection, and a story without a valid selection makes the whole suite run (H2)", async () => {
    const j = await jiraServer();
    const gl = await glServer();
    const { root, repo } = setup(j.url, gl.url);
    vi.stubEnv("CI_MERGE_REQUEST_TITLE", "SHOP-12 SHOP-19 change");
    fs.mkdirSync(path.join(root, ".qa-sentinel/gap/SHOP-12"), { recursive: true });
    fs.writeFileSync(path.join(root, ".qa-sentinel/gap/SHOP-12/qa-regression.txt"), "tests/stale.spec.ts\n");
    fs.writeFileSync(path.join(root, "qa-regression.txt"), "tests/old-top.spec.ts\n");
    // The first story fails, the second succeeds.
    fake.mode = (n) => (n === 1 ? "fail" : "ok");
    await gapReportCommand({ cwd: root, service: "orders", servicePath: repo, post: false });
    expect(fs.existsSync(path.join(root, ".qa-sentinel/gap/SHOP-12/qa-regression.txt"))).toBe(false);
    // An empty file is the full-suite marker.
    expect(fs.readFileSync(path.join(root, "qa-regression.txt"), "utf8")).toBe("");
  });

  it("shows a story that could not be analysed, and still writes and posts the comment (M6)", async () => {
    const j = await jiraServer();
    const gl = await glServer();
    const { root, repo } = setup(j.url, gl.url);
    vi.stubEnv("CI_MERGE_REQUEST_TITLE", "SHOP-12 SHOP-19 change");
    fake.mode = (n) => (n === 1 ? "ok" : "throw");
    const r = await gapReportCommand({ cwd: root, service: "orders", servicePath: repo, post: true });
    expect(r.exitCode).toBe(1);
    expect(r.report).toContain("Story SHOP-12");
    expect(r.report).toMatch(/Story SHOP-19[\s\S]*not analysed: engine exploded/);
    expect(gl.notes).toHaveLength(1);
    expect(gl.notes[0].body).toContain("not analysed: engine exploded");
    expect(parseStamp(gl.notes[0].body)).toBeUndefined();
  });

  it("a story the budget refuses says why in its section (M6)", async () => {
    const j = await jiraServer();
    const gl = await glServer();
    const { root, repo } = setup(j.url, gl.url, { automation: { budgets: { perStoryUsd: 25, perDayUsd: 6, perMonthUsd: 1000 } } });
    vi.stubEnv("CI_MERGE_REQUEST_TITLE", "SHOP-12 SHOP-19 change");
    fake.mode = () => "ok";
    fake.cost = 5.9;
    const r = await gapReportCommand({ cwd: root, service: "orders", servicePath: repo, post: true });
    expect(r.exitCode).not.toBe(0);
    expect(r.report).toMatch(/Story SHOP-19[\s\S]*not analysed: AI budget/);
    expect(r.report).toContain("perDayUsd");
    expect(gl.notes).toHaveLength(1);
  });

  it("says which stories were left out by requirements.maxKeysPerMr", async () => {
    const j = await jiraServer();
    const gl = await glServer();
    const { root, repo } = setup(j.url, gl.url, {}, { maxKeysPerMr: 2 });
    vi.stubEnv("CI_MERGE_REQUEST_TITLE", "SHOP-12 SHOP-19 SHOP-20 change");
    const r = await gapReportCommand({ cwd: root, service: "orders", servicePath: repo, post: false });
    expect(fake.asked).toHaveLength(2);
    expect(r.report).toContain("only the first 2 are analysed");
    expect(r.report).toContain("SHOP-20");
  });

  it("reads each Jira card once, and keeps every bug of a story as evidence (M3, M5)", async () => {
    const j = await jiraServer();
    const gl = await glServer();
    const { root, repo } = setup(j.url, gl.url);
    vi.stubEnv("CI_MERGE_REQUEST_TITLE", "SHOP-210 SHOP-211 SHOP-19 fix");
    await gapReportCommand({ cwd: root, service: "orders", servicePath: repo, post: false });
    expect(fake.asked).toHaveLength(2);
    const gets = jiraGets(j);
    for (const key of new Set(gets)) expect(gets.filter((x) => x === key), key).toHaveLength(1);
    const story = fs.readFileSync(path.join(fake.asked[0].cwd, fake.asked[0].prompt.match(/story: (\S+\/story\.md)/)![1]), "utf8");
    expect(story).toContain("Work card SHOP-210");
    expect(story).toContain("Work card SHOP-211");
    expect(story).toContain("first bug text");
    expect(story).toContain("second bug text");
    expect(story).toContain("A slot takes at most 3 orders.");
  });

  it("a single story named twice (a bug and its story) also keeps both cards without a second read", async () => {
    const j = await jiraServer();
    const gl = await glServer();
    const { root, repo } = setup(j.url, gl.url);
    vi.stubEnv("CI_MERGE_REQUEST_TITLE", "SHOP-210 SHOP-211 fix");
    await gapReportCommand({ cwd: root, service: "orders", servicePath: repo, post: false });
    expect(fake.asked).toHaveLength(1);
    const gets = jiraGets(j);
    for (const key of new Set(gets)) expect(gets.filter((x) => x === key), key).toHaveLength(1);
    const story = fs.readFileSync(path.join(fake.asked[0].cwd, fake.asked[0].prompt.match(/story: (\S+\/story\.md)/)![1]), "utf8");
    expect(story).toContain("Work card SHOP-210");
    expect(story).toContain("Work card SHOP-211");
  });
});

describe("only the code opts in to linking a bug to its story (M1)", () => {
  const cfg = (url: string) => ConfigSchema.parse({ version: 1, mode: "existing", project: { name: "t" }, workspace: { services: [{ name: "o", path: "o" }] }, tests: { api: { framework: "playwright", runCommand: "x" } }, ci: { platform: "gitlab" }, requirements: { source: "jira", jira: { baseUrl: url, projectKeys: ["SHOP"], featureIssueTypes: ["Story"] } } });
  it("review-story, spec and the expected-behaviour check read the card they were given", async () => {
    const j = await jiraServer();
    const c = cfg(j.url);
    // The way review-story, spec and currentAcsFor call it.
    const plain = await resolveRequirements(c, { keyHints: ["SHOP-210"], env: { JIRA_PAT: "x" } });
    expect(plain).toMatchObject({ storyKey: "SHOP-210", issueType: "Bug" });
    expect(plain.workKey).toBeUndefined();
    const linked = await resolveRequirements(c, { keyHints: ["SHOP-210"], hasCode: true, env: { JIRA_PAT: "x" } });
    expect(linked).toMatchObject({ storyKey: "SHOP-12", workKey: "SHOP-210", resolvedVia: "parent" });
  });
  it("a card that is not in Jira says it may also be hidden from this user", async () => {
    const j = await jiraServer();
    const out = await resolveKeysCached(cfg(j.url), { baseUrl: j.url, authHeader: "Bearer x" }, ["SHOP-404"], { hasCode: true });
    expect(out[0].explain).toContain("not in Jira or not visible to this user");
    const req = await resolveRequirements(cfg(j.url), { env: { JIRA_PAT: "x" }, mr: { title: "SHOP-404 typo", description: "text" } });
    expect(req.resolveNote).toContain("not in Jira or not visible to this user");
  });
});

describe("GitLab merge request lookups (M3)", () => {
  const mr = (iid: number) => ({ iid, state: "opened", title: `t${iid}`, description: "", source_branch: `feature/SHOP-9-${iid}`, web_url: `http://gl/${iid}`, sha: `s${iid}` });
  const fullPage = (n: number) => Array.from({ length: 100 }, (_, i) => mr(n * 1000 + i));
  it("asks for MRs updated since the lookback window", async () => {
    const gl = await serve(() => ({ body: [], headers: { "x-next-page": "" } }));
    const now = new Date("2026-10-22T00:00:00.000Z");
    await partsFromGitLab({ apiUrl: `${gl.url}/api/v4`, token: "t" }, svcOf("o", { gitlabProject: "shop/o" }), "SHOP-9", { lookbackDays: 14, now });
    const scan = gl.log.find((l) => l.includes("updated_after="))!;
    expect(decodeURIComponent(scan)).toContain("updated_after=2026-10-08T00:00:00.000Z");
  });
  it("scans at most 5 pages, says so, and shares one scan between stories", async () => {
    const gl = await serve((_req, url) => {
      const page = Number(url.searchParams.get("page") ?? "1");
      if (url.searchParams.get("search")) return { body: [], headers: { "x-next-page": "" } };
      return { body: fullPage(page), headers: { "x-next-page": String(page + 1) } };
    });
    const ctx = { apiUrl: `${gl.url}/api/v4`, token: "t" };
    const cache: MrScanCache = new Map();
    const notes: string[] = [];
    const s = svcOf("o", { gitlabProject: "shop/o" });
    const a = await partsFromGitLab(ctx, s, "SHOP-9", { scanCache: cache, notes });
    const scans = () => gl.log.filter((l) => l.includes("updated_after=")).length;
    expect(scans()).toBe(5);
    expect(notes[0]).toContain("only the newest 500 merge requests");
    // 500 MRs scanned; the first story's branch is in all of them, another story's in none.
    expect(a).toHaveLength(500);
    const other = await partsFromGitLab(ctx, s, "SHOP-77", { scanCache: cache, notes });
    expect(scans()).toBe(5);
    expect(other).toHaveLength(0);
  });
  it("assembleFeature puts the cut-off scan in the manifest notes, and part keys follow the Jira projects (Low)", async () => {
    const gl = await serve((_req, url) => {
      const page = Number(url.searchParams.get("page") ?? "1");
      if (url.searchParams.get("search")) return { body: [{ ...mr(1), title: "SHOP-9 and UTF-8 fix", source_branch: "x" }], headers: { "x-next-page": "" } };
      return { body: Array.from({ length: 100 }, (_, i) => ({ ...mr(page * 1000 + i), source_branch: "other" })), headers: { "x-next-page": String(page + 1) } };
    });
    const root = tmp("qas-asm-");
    const c = ConfigSchema.parse({
      version: 1, mode: "existing", project: { name: "t" },
      workspace: { services: [{ name: "o", path: "o", gitlabProject: "shop/o" }] },
      tests: { api: { framework: "playwright", runCommand: "x" } }, ci: { platform: "gitlab" },
      requirements: { source: "jira", jira: { baseUrl: "http://j", projectKeys: ["SHOP"] } },
    });
    const m = await assembleFeature({ c, cwd: root, story: "SHOP-9", gitlab: { apiUrl: `${gl.url}/api/v4`, token: "t" } });
    expect(m.parts[0].keys).toEqual(["SHOP-9"]);
    expect(m.notes.join("\n")).toContain("only the newest 500 merge requests");
  });
  it("a squash commit that was reverted is found (Low)", async () => {
    const repo = tmp("qas-sq-");
    g(repo, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(repo, "a.txt"), "1");
    g(repo, "add", "-A");
    g(repo, "commit", "-qm", "init");
    fs.writeFileSync(path.join(repo, "a.txt"), "2");
    g(repo, "commit", "-qam", "SHOP-5 the change (squashed)");
    const squash = g(repo, "rev-parse", "HEAD");
    g(repo, "commit", "-q", "--allow-empty", "-m", "Merge branch 'x' into 'main'");
    const merge = g(repo, "rev-parse", "HEAD");
    fs.writeFileSync(path.join(repo, "a.txt"), "1");
    g(repo, "commit", "-qam", `Revert "SHOP-5 the change (squashed)"\n\nThis reverts commit ${squash}.`);
    const revert = g(repo, "rev-parse", "HEAD");
    const gl = await serve((_req, url) => ({ body: url.searchParams.get("search") ? [{ iid: 1, state: "merged", title: "SHOP-5", description: "", source_branch: "b", web_url: "u", sha: "feedbeef", merge_commit_sha: merge, squash_commit_sha: squash, merged_at: "2026-10-01T00:00:00Z" }] : [], headers: { "x-next-page": "" } }));
    const c = ConfigSchema.parse({
      version: 1, mode: "existing", project: { name: "t" },
      workspace: { services: [{ name: "o", path: ".", gitlabProject: "shop/o" }] },
      tests: { api: { framework: "playwright", runCommand: "x" } }, ci: { platform: "gitlab" },
    });
    const m = await assembleFeature({ c, cwd: repo, story: "SHOP-5", gitlab: { apiUrl: `${gl.url}/api/v4`, token: "t" } });
    expect(m.parts[0].reverted).toBe(revert);
    expect(m.status).toBe("reverted");
  });
});

describe("a change that was reverted and then landed again (M2)", () => {
  const part = (o: Partial<ServicePart>): ServicePart => ({ service: "orders", source: "gitlab-mr", merged: true, sha: "a".repeat(40), mr: { iid: 1, url: "u", state: "merged", title: "t" }, mergedAt: "2026-10-01T00:00:00Z", ...o });
  const reverted = part({ reverted: "r".repeat(40) });
  const reland = part({ mr: { iid: 2, url: "u", state: "merged", title: "again" }, sha: "b".repeat(40), mergedAt: "2026-10-05T00:00:00Z" });
  const manifest = (parts: ServicePart[]): FeatureManifest => ({ story: "SHOP-1", parts, status: featureStatus(parts), notes: [] });

  it("is reverted only while no newer merged part of the service stands", () => {
    expect(featureStatus([reverted])).toBe("reverted");
    expect(featureStatus([reverted, reland])).toBe("merged");
    expect(revertedParts([reverted, reland])).toEqual([]);
    expect(activeParts([reverted, reland])).toEqual([reland]);
    // An older part cannot repair a newer revert.
    const older = part({ mr: { iid: 0, url: "u", state: "merged", title: "old" }, mergedAt: "2026-09-01T00:00:00Z" });
    expect(featureStatus([older, reverted])).toBe("reverted");
    // A second service is not affected by the first one's re-land.
    expect(featureStatus([reverted, reland, part({ service: "billing", reverted: "c".repeat(40) })])).toBe("reverted");
  });
  it("the acceptance criteria and the suite follow", () => {
    const m = manifest([reverted, reland]);
    expect(acReadiness(m, undefined, ["AC-1"], true)[0].state).toBe("undetermined"); // merged; no environment
    expect(acReadiness(manifest([reverted]), undefined, ["AC-1"], true)[0].state).toBe("reverted");
    expect(judgeStory(m, undefined).state).not.toBe("held-back");
    expect(judgeStory(manifest([reverted]), undefined).state).toBe("held-back");
  });
});

describe("local git parts (Low)", () => {
  it("local commits on the target branch that are not pushed are not an open part named after it", () => {
    const r = tmp("qas-main-");
    g(r, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(r, "a.js"), "1");
    g(r, "add", "-A");
    g(r, "commit", "-qm", "init");
    g(r, "update-ref", "refs/remotes/origin/main", "HEAD");
    fs.writeFileSync(path.join(r, "a.js"), "2");
    g(r, "commit", "-qam", "SHOP-7 not pushed yet");
    const parts = partsFromGit(r, svcOf("orders"), "SHOP-7", "main");
    expect(parts.filter((p) => p.branch === "main" || p.branch === "origin/main")).toEqual([]);
    expect(parts.filter((p) => !p.merged)).toEqual([]);
  });
});

describe("story mode with several parts in one service (H3)", () => {
  it("is one range for the service: the merged work and the open branch, without the unrelated work between", async () => {
    const root = tmp("qas-story-");
    const r = path.join(root, "orders");
    fs.mkdirSync(r);
    g(r, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(r, "a.js"), "1\n");
    g(r, "add", "-A");
    g(r, "commit", "-qm", "init");
    g(r, "checkout", "-q", "-b", "feature/SHOP-106-one");
    fs.writeFileSync(path.join(r, "one.js"), "one\n");
    g(r, "add", "-A");
    g(r, "commit", "-qm", "SHOP-106 part one");
    g(r, "checkout", "-q", "main");
    g(r, "merge", "-q", "--no-ff", "feature/SHOP-106-one", "-m", "Merge SHOP-106 one");
    fs.writeFileSync(path.join(r, "unrelated.js"), "u\n");
    g(r, "add", "-A");
    g(r, "commit", "-qm", "unrelated work");
    g(r, "checkout", "-q", "-b", "feature/SHOP-106-two");
    fs.writeFileSync(path.join(r, "two.js"), "two\n");
    g(r, "add", "-A");
    g(r, "commit", "-qm", "SHOP-106 part two");
    g(r, "checkout", "-q", "-b", "feature/SHOP-106-three", "main");
    fs.writeFileSync(path.join(r, "three.js"), "three\n");
    fs.writeFileSync(path.join(r, "two.js"), "two\n");
    g(r, "add", "-A");
    g(r, "commit", "-qm", "third part, no key in this message");
    g(r, "checkout", "-q", "main");
    const c = ConfigSchema.parse({ version: 1, mode: "existing", project: { name: "t" }, workspace: { services: [{ name: "orders", path: "orders" }] }, tests: { api: { framework: "playwright", runCommand: "x" } }, ci: { platform: "gitlab" } });

    const sp = await storyParts({ c, cwd: root, story: "SHOP-106" });
    expect(sp.parts).toHaveLength(1);
    const [p] = sp.parts;
    expect(p.merged).toBe(false);
    expect(p.heads).toHaveLength(3);
    expect([...p.cs.files].sort()).toEqual(["one.js", "three.js", "two.js"]);
    expect(p.cs.diff).not.toContain("unrelated.js");
    const cc = combinedChange("SHOP-106", sp.parts);
    expect(cc.relevant.filter((f) => f.endsWith("two.js"))).toEqual(["orders/two.js"]);
    expect(cc.relevant).not.toContain("orders/unrelated.js");
  });
});

describe(".gitignore and upgrade (Low)", () => {
  const ignored = (cwd: string, ...files: string[]) =>
    files.every((f) => {
      try {
        execFileSync("git", ["check-ignore", "-q", f], { cwd, env: { ...process.env, ...GIT_ENV } });
        return true;
      } catch {
        return false;
      }
    });
  it("does not add a line that only spells an existing one differently", () => {
    const r = tmp("qas-ign2-");
    g(r, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(r, ".gitignore"), "/.qa-sentinel\n/qa-stories.md\nqa-post-deploy.md/\n");
    ensureGitignore(r);
    const lines = fs.readFileSync(path.join(r, ".gitignore"), "utf8").split("\n").map((l) => l.trim().replace(/^\/+/, "").replace(/\/+$/, ""));
    for (const x of [".qa-sentinel", "qa-stories.md", "qa-post-deploy.md"]) expect(lines.filter((l) => l === x), x).toHaveLength(1);
    // The folder that is ignored as a whole already covers its subfolder.
    expect(lines).not.toContain(".qa-sentinel/runs");
    expect(ignored(r, ".qa-sentinel/stories/SHOP-1.json", "qa-stories.md")).toBe(true);
  });
  it("upgrade names Jira files that git already tracks, with the command to stop tracking them", () => {
    const r = tmp("qas-trk-");
    g(r, "init", "-q", "-b", "main");
    writeConfig(r, ConfigSchema.parse({ version: 1, mode: "existing", project: { name: "t" }, workspace: { services: [{ name: "orders", path: "." }] }, tests: { api: { framework: "playwright", runCommand: "npx playwright test" } }, ci: { platform: "gitlab" } }));
    fs.mkdirSync(path.join(r, ".qa-sentinel/stories"), { recursive: true });
    fs.writeFileSync(path.join(r, ".qa-sentinel/stories/SHOP-1.json"), "{}");
    fs.writeFileSync(path.join(r, "qa-stories.md"), "x");
    g(r, "add", "-A", "-f");
    g(r, "commit", "-qm", "oops");
    expect(trackedJiraFiles(r)).toEqual([".qa-sentinel", "qa-stories.md"]);
    const info = vi.spyOn(log, "info").mockImplementation(() => undefined);
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    upgradeCommand({ cwd: r });
    expect(warn.mock.calls.join("\n")).toContain("already tracked");
    expect(info.mock.calls.join("\n")).toContain("git rm -r --cached -- .qa-sentinel qa-stories.md");
  });
});

describe("tests written for a bug carry its key (M7)", () => {
  it("the skills and the author agent say how to tag a test for a work card", () => {
    const root = path.resolve(__dirname, "..");
    for (const f of ["templates/skills/write-api-test/SKILL.md", "templates/skills/write-web-test/SKILL.md", "templates/skills/write-mobile-test/SKILL.md", "templates/agents/api-test-author.md"])
      expect(fs.readFileSync(path.join(root, f), "utf8"), f).toContain("@bug:");
    expect(fs.readFileSync(path.join(root, "src/commands/generate.ts"), "utf8")).toContain("@bug:${req.workKey}");
  });
});
