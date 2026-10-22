import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigSchema, writeConfig } from "../src/config.js";

// A fake agent runtime for the gap-report test: it records what it was asked and fails, so the report says
// "analysis incomplete" and no real model is ever called.
const asked: { prompt: string; cwd: string }[] = [];
vi.mock("../src/engines/ClaudeCodeEngine.js", () => ({
  engineFor: () => ({
    name: "fake",
    available: () => ({ ok: true }),
    run: async (t: { prompt: string; cwd: string }) => {
      asked.push({ prompt: t.prompt, cwd: t.cwd });
      return { ok: false, status: "error", result: "fake engine: no model in tests" };
    },
  }),
}));

import { gapReportCommand } from "../src/commands/gapReport.js";
import { ensureGitignore, upgradeCommand } from "../src/commands/init.js";
import { indexSource } from "../src/analysis/testIndex.js";
import { featureMarkdown, featureStatus, partFromGit, partsFromGit, partsFromGitLab, type FeatureManifest, type ServicePart } from "../src/feature/manifest.js";
import { acReadiness } from "../src/feature/readiness.js";
import { extractStoryKey, extractStoryKeys, requirementsLine, resolveRequirements } from "../src/requirements.js";
import { getAll } from "../src/scm/gitlab.js";
import { resolveKeysCached } from "../src/stories/resolve.js";

const GIT_ENV = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const g = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8", env: { ...process.env, ...GIT_ENV } }).trim();

const dirs: string[] = [];
const tmp = (p: string) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), p));
  dirs.push(d);
  return d;
};
afterEach(() => {
  vi.unstubAllEnvs();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** A tiny HTTP server on 127.0.0.1 with a request log. */
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
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { url, log, close: () => new Promise<void>((ok) => server.close(() => ok())) };
}

const PATTERN = "[A-Z][A-Z0-9]+-\\d+";
const svc: any = { name: "orders-service", path: ".", dependsOn: [] };

describe("extractStoryKeys", () => {
  it("finds every key in order, once each, across the texts", () => {
    expect(extractStoryKeys(PATTERN, "SHOP-12 and SHOP-19: shared fix", "feature/SHOP-12-x", "also SHOP-7")).toEqual(["SHOP-12", "SHOP-19", "SHOP-7"]);
  });
  it("finds a key that is only in the branch name", () => {
    expect(extractStoryKeys(PATTERN, "Add the thing", undefined, "feature/SHOP-44-the-thing")).toEqual(["SHOP-44"]);
  });
  it("does not find SHOP-1 inside SHOP-106 or a key inside a longer word", () => {
    expect(extractStoryKeys("SHOP-1", "SHOP-106 only")).toEqual([]);
    expect(extractStoryKeys(PATTERN, "see XSHOP-9y")).toEqual([]);
    expect(extractStoryKeys(PATTERN, "UTF-8 and SHOP-106")).toEqual(["UTF-8", "SHOP-106"]);
  });
  it("extractStoryKey is the first of them", () => {
    expect(extractStoryKey(PATTERN, undefined, "SHOP-3 then SHOP-4")).toBe("SHOP-3");
    expect(extractStoryKey(PATTERN, "nothing")).toBeUndefined();
  });
});

describe("test index: @bug tags", () => {
  it("indexes the bug a test was written for next to its story", () => {
    const [t] = indexSource("tests/a.spec.ts", `test("rejects a past slot @story:SHOP-12 @bug:SHOP-210 @ac:AC-2", async () => { expect(1).toBe(1); });\n`);
    expect(t.stories).toEqual(["SHOP-12"]);
    expect(t.bugs).toEqual(["SHOP-210"]);
    expect(t.acs).toEqual(["AC-2"]);
    expect(t.tags.join(",")).not.toContain("bug");
  });
});

describe("partsFromGitLab", () => {
  const mr = (iid: number, state: string, extra: Record<string, unknown> = {}) => ({ iid, state, title: `SHOP-106 part ${iid}`, description: "", source_branch: `work-${iid}`, web_url: `http://gl/mr/${iid}`, sha: `s${iid}`, ...extra });
  it("returns every MR: open ones, a merged one, a closed one as dropped, and one found only by its branch name", async () => {
    const gl = await serve((_req, url) => {
      const page = url.searchParams.get("page") ?? "1";
      if (url.searchParams.get("search")) {
        // The text search: two pages. Page 1 is short on purpose: only x-next-page says there is more.
        return page === "1"
          ? { body: [mr(1, "opened"), mr(2, "opened")], headers: { "x-next-page": "2" } }
          : { body: [mr(3, "merged", { merge_commit_sha: "m3", merged_at: "2026-10-01T00:00:00Z", diff_refs: { base_sha: "b3", head_sha: "h3", start_sha: "t3" } }), mr(4, "closed")], headers: { "x-next-page": "" } };
      }
      // The branch scan: MR 5 names the story only in its source branch; MR 6 is unrelated; MR 1 was already found.
      return { body: [{ ...mr(5, "opened"), title: "Tidy up", source_branch: "feature/SHOP-106-extra" }, { ...mr(6, "opened"), title: "Other", source_branch: "feature/SHOP-9-other" }, mr(1, "opened")], headers: { "x-next-page": "" } };
    });
    try {
      const ctx = { apiUrl: `${gl.url}/api/v4`, token: "t" };
      const parts = await partsFromGitLab(ctx, { name: "orders-service", path: ".", dependsOn: [], gitlabProject: "shop/orders" } as any, "SHOP-106", { lookbackDays: 14 });
      expect(parts.map((p) => p.mr!.iid).sort()).toEqual([1, 2, 3, 4, 5]);
      expect(parts.filter((p) => p.dropped).map((p) => p.mr!.iid)).toEqual([4]);
      expect(parts.filter((p) => !p.dropped && !p.merged).map((p) => p.mr!.iid).sort()).toEqual([1, 2, 5]);
      const merged = parts.find((p) => p.mr!.iid === 3)!;
      expect(merged).toMatchObject({ merged: true, sha: "m3", mergeSha: "m3", mergedAt: "2026-10-01T00:00:00Z", diffRefs: { base: "b3", head: "h3", start: "t3" }, keys: ["SHOP-106"] });
      // Open MRs first, the dropped one last.
      expect(parts.at(-1)!.dropped).toBe(true);
      expect(gl.log.some((l) => l.includes("search=SHOP-106") && l.includes("page=2"))).toBe(true);
      expect(gl.log.some((l) => l.includes("updated_after="))).toBe(true);
    } finally {
      await gl.close();
    }
  });
  it("getAll follows x-next-page, and still stops on a short page when there is no header", async () => {
    const gl = await serve((_req, url) => ({ body: [{ n: url.searchParams.get("page") }], headers: url.searchParams.get("page") === "3" ? { "x-next-page": "" } : { "x-next-page": String(Number(url.searchParams.get("page")) + 1) } }));
    try {
      expect((await getAll({ apiUrl: gl.url, token: "t" }, "/list")).map((x) => x.n)).toEqual(["1", "2", "3"]);
    } finally {
      await gl.close();
    }
    const plain = await serve(() => ({ body: [1, 2, 3] }));
    try {
      expect(await getAll({ apiUrl: plain.url, token: "t" }, "/list")).toEqual([1, 2, 3]);
      expect(plain.log).toHaveLength(1);
    } finally {
      await plain.close();
    }
  });
});

describe("partsFromGit", () => {
  function repoWithTwoBranches() {
    const r = tmp("qas-link-");
    g(r, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(r, "a.js"), "1");
    g(r, "add", "-A");
    g(r, "commit", "-q", "-m", "init");
    g(r, "checkout", "-q", "-b", "feature/SHOP-106-one");
    fs.writeFileSync(path.join(r, "a.js"), "2");
    g(r, "commit", "-qam", "SHOP-106: first part");
    g(r, "checkout", "-q", "main");
    return r;
  }
  it("finds a second branch by its name even when its commits do not name the story", () => {
    const r = repoWithTwoBranches();
    g(r, "checkout", "-q", "-b", "feature/SHOP-106-two");
    fs.writeFileSync(path.join(r, "b.js"), "x");
    g(r, "add", "-A");
    g(r, "commit", "-qm", "second part, no key here");
    g(r, "checkout", "-q", "main");
    const parts = partsFromGit(r, svc, "SHOP-106", "main");
    expect(parts.map((p) => p.branch).sort()).toEqual(["feature/SHOP-106-one", "feature/SHOP-106-two"]);
    expect(parts.every((p) => !p.merged && p.service === "orders-service")).toBe(true);
    expect(partFromGit(r, svc, "SHOP-106", "main")).toMatchObject({ merged: false });
  });
  it("one merged part for the work on main, plus one for each branch still open; a copy on origin is the same branch", () => {
    const r = repoWithTwoBranches();
    g(r, "merge", "-q", "--no-ff", "feature/SHOP-106-one", "-m", "merge one");
    g(r, "checkout", "-q", "-b", "feature/SHOP-106-two", "main");
    fs.writeFileSync(path.join(r, "b.js"), "x");
    g(r, "add", "-A");
    g(r, "commit", "-qm", "SHOP-106: second part");
    g(r, "checkout", "-q", "main");
    // A remote-tracking copy of the open branch.
    g(r, "update-ref", "refs/remotes/origin/feature/SHOP-106-two", g(r, "rev-parse", "feature/SHOP-106-two"));
    const parts = partsFromGit(r, svc, "SHOP-106", "main");
    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatchObject({ merged: true, branch: "feature/SHOP-106-one" });
    expect(parts[1]).toMatchObject({ merged: false, branch: "feature/SHOP-106-two" });
    expect(featureStatus(parts, undefined)).toBe("in-development");
  });
});

describe("acReadiness with several parts per service", () => {
  const part = (service: string, o: Partial<ServicePart> = {}): ServicePart => ({ service, source: "gitlab-mr", merged: true, sha: "a".repeat(40), mr: { iid: 1, url: "http://gl/1", state: "merged", title: "t" }, ...o });
  const manifest = (parts: ServicePart[], dropped: ServicePart[] = []): FeatureManifest => ({ story: "SHOP-106", parts, ...(dropped.length ? { dropped } : {}), status: featureStatus(parts), notes: [] });

  it("a service with one merged MR and one open MR is not merged", () => {
    const m = manifest([part("orders"), part("orders", { merged: false, mr: { iid: 2, url: "http://gl/2", state: "opened", title: "follow-up" } })]);
    const r = acReadiness(m, undefined, ["AC-1"], true)[0];
    expect(r.state).toBe("not-merged");
    expect(r.reason).toContain("orders !2");
    expect(m.status).toBe("in-development");
  });
  it("two merged MRs of one service count as merged, and the service is listed once", () => {
    const m = manifest([part("orders"), part("orders", { mr: { iid: 3, url: "http://gl/3", state: "merged", title: "again" } })]);
    const r = acReadiness(m, undefined, ["AC-1"], true)[0];
    expect(r.state).toBe("undetermined"); // merged; no environment to check
    expect(r.services).toEqual(["orders"]);
  });
  it("a dropped (closed) MR never holds anything back, and is shown as dropped", () => {
    const dropped = part("orders", { merged: false, dropped: true, mr: { iid: 9, url: "http://gl/9", state: "closed", title: "abandoned" } });
    const m = manifest([part("orders")], [dropped]);
    expect(featureStatus([part("orders"), dropped])).toBe("merged");
    expect(acReadiness(m, undefined, ["AC-1"], true)[0].reason).not.toContain("not merged");
    const md = featureMarkdown(m);
    expect(md).toContain("!9");
    expect(md).toContain("dropped");
  });
  it("featureMarkdown shows one row per MR with the service in each", () => {
    const m = manifest([part("orders"), part("orders", { merged: false, mr: { iid: 2, url: "http://gl/2", state: "opened", title: "follow-up" } })]);
    expect(featureMarkdown(m).split("\n").filter((l) => l.startsWith("| orders"))).toHaveLength(2);
  });
});

/** A mock Jira: issues by key, comments kept per issue. */
function jira(issues: Record<string, any>) {
  const comments: Record<string, { id: string; body: string }[]> = {};
  let n = 0;
  return serve((req, url, body) => {
    const m = url.pathname.match(/^\/rest\/api\/2\/issue\/([^/]+)(\/comment(?:\/(\d+))?)?$/);
    if (!m) return { status: 404, body: {} };
    const key = decodeURIComponent(m[1]);
    if (m[2]) {
      const list = (comments[key] ??= []);
      if (req.method === "GET") return { body: { comments: list, total: list.length } };
      const text = JSON.parse(body).body as string;
      if (req.method === "PUT") {
        const c = list.find((x) => x.id === m[3]);
        if (c) c.body = text;
        return { body: { id: m[3] } };
      }
      const id = String(++n);
      list.push({ id, body: text });
      return { status: 201, body: { id } };
    }
    const i = issues[key];
    return i ? { body: { key, fields: i } } : { status: 404, body: { errorMessages: ["Issue Does Not Exist"] } };
  }).then((s) => Object.assign(s, { comments }));
}
const card = (summary: string, type: string, o: Record<string, unknown> = {}) => ({ summary, issuetype: { name: type }, status: { name: "In Progress" }, description: "", labels: [], ...o });
const STORY_TEXT = (ac: string) => `## Acceptance criteria\n- AC-1: ${ac}\n`;

function config(jiraUrl: string, extra: Record<string, unknown> = {}) {
  return ConfigSchema.parse({
    version: 1,
    mode: "existing",
    project: { name: "t" },
    workspace: { services: [{ name: "orders", path: "orders" }] },
    tests: { api: { framework: "playwright", runCommand: "npx playwright test" } },
    ci: { platform: "gitlab", gitlabUrl: "https://gl.example" },
    requirements: { source: "jira", jira: { baseUrl: jiraUrl, projectKeys: ["SHOP"], featureIssueTypes: ["Story"] } },
    reporting: { targets: ["jira"] },
    ...extra,
  });
}

describe("resolving a bug to its story", () => {
  const issues = {
    "SHOP-12": card("Delivery slots", "Story", { description: STORY_TEXT("A slot takes at most 3 orders.") }),
    "SHOP-210": card("Slot accepts a 4th order", "Bug", { description: "Steps: book four orders.", parent: { key: "SHOP-12", fields: { issuetype: { name: "Story" } } } }),
  };
  it("resolveRequirements returns the story's ACs, keeps the bug as evidence, and says how it got there", async () => {
    const j = await jira(issues);
    try {
      const c = config(j.url);
      const env = { JIRA_PAT: "x" };
      const req = await resolveRequirements(c, { env, mr: { title: "SHOP-210 stop the 4th order" } });
      expect(req).toMatchObject({ source: "jira", storyKey: "SHOP-12", issueType: "Story", workKey: "SHOP-210", resolvedVia: "parent" });
      expect(req.acceptanceCriteria.map((a) => a.text)).toEqual(["A slot takes at most 3 orders."]);
      expect(req.context.find((x) => x.name === "Work card SHOP-210")?.text).toContain("book four orders");
      expect(req.rawText).not.toContain("book four orders");
      expect(requirementsLine(req)).toContain("SHOP-210 (Bug) → SHOP-12 via parent");
    } finally {
      await j.close();
    }
  });
  it("a story stays itself, and with no feature types nothing is resolved", async () => {
    const j = await jira(issues);
    try {
      const env = { JIRA_PAT: "x" };
      const own = await resolveRequirements(config(j.url), { env, mr: { title: "SHOP-12 slots" } });
      expect(own).toMatchObject({ storyKey: "SHOP-12" });
      expect(own.workKey).toBeUndefined();
      const flat = await resolveRequirements(config(j.url, { requirements: { source: "jira", jira: { baseUrl: j.url, projectKeys: ["SHOP"] } } }), { env, mr: { title: "SHOP-210 fix" } });
      expect(flat.storyKey).toBe("SHOP-210");
      expect(flat.workKey).toBeUndefined();
    } finally {
      await j.close();
    }
  });
  it("a key that is not in Jira is said so and not guessed at", async () => {
    const j = await jira(issues);
    try {
      const req = await resolveRequirements(config(j.url), { env: { JIRA_PAT: "x" }, mr: { title: "SHOP-1012 typo", description: "Slots must be limited" } });
      expect(req.source).toBe("gitlab-mr");
      expect(req.resolveNote).toContain("SHOP-1012 is not in Jira");
      expect(requirementsLine(req)).toContain("SHOP-1012 is not in Jira");
    } finally {
      await j.close();
    }
  });
  it("resolveKeysCached reads each card once", async () => {
    const j = await jira(issues);
    try {
      const out = await resolveKeysCached(config(j.url), { baseUrl: j.url, authHeader: "Bearer x" }, ["SHOP-210", "SHOP-12", "SHOP-210", "SHOP-404"], { hasCode: true });
      expect(out.map((r) => [r.work, r.feature, r.via])).toEqual([
        ["SHOP-210", "SHOP-12", "parent"],
        ["SHOP-12", "SHOP-12", "self"],
        ["SHOP-404", undefined, "not-found"],
      ]);
      expect(j.log.filter((l) => l.startsWith("GET /rest/api/2/issue/SHOP-12?")).length).toBe(1);
    } finally {
      await j.close();
    }
  });
});

describe("a merge request that names several stories", () => {
  it("makes one gap report for each story and posts each to its own story in Jira", async () => {
    const j = await jira({
      "SHOP-12": card("Delivery slots", "Story", { description: STORY_TEXT("A slot takes at most 3 orders.") }),
      "SHOP-19": card("Past orders", "Story", { description: STORY_TEXT("Orders in the past are rejected.") }),
      "SHOP-210": card("Slot accepts a 4th order", "Bug", { parent: { key: "SHOP-12", fields: { issuetype: { name: "Story" } } } }),
    });
    try {
      const root = tmp("qas-multi-");
      const repo = path.join(root, "orders");
      g(root, "init", "-q", "-b", "main");
      fs.mkdirSync(path.join(repo, "src"), { recursive: true });
      g(repo, "init", "-q", "-b", "main");
      fs.writeFileSync(path.join(repo, "src/a.ts"), "export const a = 0;\n");
      g(repo, "add", "-A");
      g(repo, "commit", "-qm", "base");
      g(repo, "checkout", "-q", "-b", "feat");
      fs.writeFileSync(path.join(repo, "src/a.ts"), "export const a = 0;\nexport const b = 1;\n");
      g(repo, "commit", "-qam", "change");
      writeConfig(root, config(j.url));
      vi.stubEnv("JIRA_PAT", "x");
      vi.stubEnv("CI_MERGE_REQUEST_TITLE", "SHOP-210 SHOP-19 SHOP-1012 shared change");
      vi.stubEnv("CI_MERGE_REQUEST_DIFF_BASE_SHA", g(repo, "rev-parse", "main"));
      asked.length = 0;

      const r = await gapReportCommand({ cwd: root, service: "orders", servicePath: repo, post: true });

      // Two stories (the bug leads to SHOP-12), the typo is reported, nothing guessed.
      expect(asked).toHaveLength(2);
      const stories = asked.map((a) => fs.readFileSync(path.join(a.cwd, a.prompt.match(/story: (\S+\/story\.md)/)![1]), "utf8"));
      expect(stories[0]).toContain("A slot takes at most 3 orders.");
      expect(stories[0]).toContain("Work card SHOP-210");
      expect(stories[1]).toContain("Orders in the past are rejected.");
      expect(r.report).toContain("2 stories in this merge request");
      expect(r.report).toContain("SHOP-1012 is not in Jira");
      expect(r.report).toContain("SHOP-210 (Bug) → SHOP-12 via parent");
      // Each story got its own qa-sentinel section.
      for (const key of ["SHOP-12", "SHOP-19"]) {
        expect(j.comments[key]).toHaveLength(1);
        expect(j.comments[key][0].body).toContain(`QA status · ${key}`);
        expect(j.comments[key][0].body).toContain("qa-sentinel:section=gap-report:orders");
      }
      expect(j.comments["SHOP-210"]).toBeUndefined();
      expect(j.comments["SHOP-1012"]).toBeUndefined();
      // The cost and jobs of each report are counted on its own story.
      const records = fs.readdirSync(path.join(root, ".qa-sentinel", "stories"));
      expect(records.sort()).toEqual(expect.arrayContaining(["SHOP-12.json", "SHOP-19.json"]));
    } finally {
      await j.close();
    }
  });

  it("requirements.multiKey: first looks only at the first story", async () => {
    const j = await jira({ "SHOP-12": card("Slots", "Story", { description: STORY_TEXT("A slot takes at most 3 orders.") }), "SHOP-19": card("Past", "Story", { description: STORY_TEXT("x") }) });
    try {
      const root = tmp("qas-multi1-");
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
      writeConfig(root, config(j.url, { requirements: { source: "jira", multiKey: "first", jira: { baseUrl: j.url, projectKeys: ["SHOP"], featureIssueTypes: ["Story"] } } }));
      vi.stubEnv("JIRA_PAT", "x");
      vi.stubEnv("CI_MERGE_REQUEST_TITLE", "SHOP-12 and SHOP-19");
      vi.stubEnv("CI_MERGE_REQUEST_DIFF_BASE_SHA", g(repo, "rev-parse", "main"));
      asked.length = 0;
      await gapReportCommand({ cwd: root, service: "orders", servicePath: repo, post: true });
      expect(asked).toHaveLength(1);
      expect(j.comments["SHOP-19"]).toBeUndefined();
      expect(j.comments["SHOP-12"]).toHaveLength(1);
    } finally {
      await j.close();
    }
  });
});

describe(".gitignore keeps Jira data out of git", () => {
  const ignored = (cwd: string, ...files: string[]) => {
    return files.every((f) => {
      try {
        execFileSync("git", ["check-ignore", "-q", f], { cwd, env: { ...process.env, ...GIT_ENV } });
        return true;
      } catch {
        return false;
      }
    });
  };
  it("lists .qa-sentinel/, qa-stories.md and qa-post-deploy.md, and adds them to an existing file", () => {
    const r = tmp("qas-ign-");
    g(r, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(r, ".gitignore"), "node_modules/\n.qa-sentinel/runs/\n");
    expect(ignored(r, ".qa-sentinel/stories/SHOP-1.json")).toBe(false);
    ensureGitignore(r);
    expect(ignored(r, ".qa-sentinel/stories/SHOP-1.json", "qa-stories.md", "qa-post-deploy.md")).toBe(true);
    const once = fs.readFileSync(path.join(r, ".gitignore"), "utf8");
    ensureGitignore(r);
    expect(fs.readFileSync(path.join(r, ".gitignore"), "utf8")).toBe(once);
  });
  it("upgrade adds the missing entries to a project set up before", () => {
    const r = tmp("qas-upg-");
    g(r, "init", "-q", "-b", "main");
    writeConfig(r, ConfigSchema.parse({ version: 1, mode: "existing", project: { name: "t" }, workspace: { services: [{ name: "orders", path: "." }] }, tests: { api: { framework: "playwright", runCommand: "npx playwright test" } }, ci: { platform: "gitlab" } }));
    fs.writeFileSync(path.join(r, ".gitignore"), ".qa-sentinel/runs/\n");
    upgradeCommand({ cwd: r });
    expect(ignored(r, ".qa-sentinel/stories/SHOP-1.json", "qa-stories.md")).toBe(true);
  });
});
