import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";

// A fake agent runtime: no model is ever called. The gap report ends "analysis incomplete" and is still posted.
vi.mock("../src/engines/ClaudeCodeEngine.js", () => ({
  engineFor: () => ({ name: "fake", available: () => ({ ok: true }), run: async () => ({ ok: false, status: "error", result: "fake engine: no model in tests" }) }),
}));

import { ConfigSchema, loadConfig, writeConfig, type Config } from "../src/config.js";
import { ciProvider, requireGitlab, scmFor } from "../src/scm/provider.js";
import { gapReportCommand } from "../src/commands/gapReport.js";
import { publishCommand } from "../src/commands/publish.js";
import { initCommand } from "../src/commands/init.js";
import { onlineChecks, runChecks } from "../src/commands/doctor.js";
import { metricsCommand, fetchUsefulness } from "../src/commands/metrics.js";
import { tagCommand } from "../src/commands/tag.js";
import { scrubbedEnv } from "../src/env.js";
import { VOTE_LINE } from "../src/reporting/publish.js";
import { PUBLISH_FILE } from "../src/reporting/deferred.js";
import { githubMock } from "./helpers/mockGithub.js";
import { GIT_ENV, cleanTmp, commit, g, serve, tmp } from "./helpers/mocks.js";

const TOKEN = "ghs_providerTestToken1234567890";
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  cleanTmp();
});

const cfg = (ci: object): Config => ConfigSchema.parse({ version: 1, mode: "existing", project: { name: "t" }, workspace: { services: [{ name: "orders", path: "orders" }] }, tests: { api: { framework: "playwright", runCommand: "npx playwright test" } }, ci });

describe("config: ci.provider", () => {
  it("defaults to gitlab, so nothing changes for existing configs", () => {
    expect(ciProvider(cfg({ platform: "gitlab" }))).toBe("gitlab");
    expect(ciProvider(cfg({ platform: "jenkins" }))).toBe("gitlab");
  });
  it("github when ci.provider says so, or when the older ci.scm says github; provider wins over scm", () => {
    expect(ciProvider(cfg({ platform: "github", provider: "github" }))).toBe("github");
    expect(ciProvider(cfg({ platform: "gitlab", scm: "github" }))).toBe("github");
    expect(ciProvider(cfg({ platform: "gitlab", scm: "github", provider: "gitlab" }))).toBe("gitlab");
  });
  it("an unknown provider is a config error", () => {
    expect(() => cfg({ platform: "gitlab", provider: "bitbucket" })).toThrow();
  });
  it("requireGitlab stops GitHub configs with a clear message and lets GitLab through", () => {
    expect(() => requireGitlab(cfg({ platform: "github", provider: "github" }), "tag")).toThrow(/tag works with GitLab only for now/);
    expect(() => requireGitlab(cfg({ platform: "gitlab" }), "tag")).not.toThrow();
  });
  it("GitLab-only commands stop on GitHub before doing anything", async () => {
    const root = tmp("qas-gh-only-");
    writeConfig(root, cfg({ platform: "github", provider: "github" }));
    await expect(tagCommand({ cwd: root, dryRun: true })).rejects.toThrow(/GitLab only/);
  });
});

/** A small GitLab mock that speaks only what the provider contract uses. */
async function gitlabMock() {
  const notes: { id: number; body: string; author: { id: number } }[] = [];
  const mrs: any[] = [];
  const awards: Record<number, { name: string }[]> = { 11: [{ name: "thumbsup" }, { name: "thumbsdown" }, { name: "tada" }] };
  const srv = await serve((req, url, raw) => {
    const body = raw ? JSON.parse(raw) : {};
    const p = url.pathname.replace(/^\/api\/v4/, "");
    const m = req.method;
    if (p === "/user") return { body: { id: 1, username: "bot" } };
    if (p === "/projects/5/merge_requests/7/notes") {
      if (m === "GET") return { body: notes };
      const n = { id: 10 + notes.length + 1, body: body.body, author: { id: 1 } };
      notes.push(n);
      return { status: 201, body: n };
    }
    let r: RegExpMatchArray | null;
    if ((r = p.match(/^\/projects\/5\/merge_requests\/7\/notes\/(\d+)$/)) && m === "PUT") {
      const n = notes.find((x) => x.id === Number(r![1]))!;
      n.body = body.body;
      return { body: n };
    }
    if ((r = p.match(/^\/projects\/5\/merge_requests\/7\/notes\/(\d+)\/award_emoji$/))) return { body: awards[Number(r[1])] ?? [] };
    if (p === "/projects/5/merge_requests/7") return { body: { draft: true, title: "Draft: x" } };
    if (p === "/projects/5/merge_requests") {
      if (m === "GET") return { body: mrs.filter((x) => (!url.searchParams.get("source_branch") || x.source_branch === url.searchParams.get("source_branch")) && (x.state === "opened" || url.searchParams.get("state") === "all")) };
      const mr = { iid: mrs.length + 3, web_url: `https://gl.example/-/merge_requests/${mrs.length + 3}`, state: "opened", title: body.title, description: body.description, source_branch: body.source_branch, created_at: "2026-01-01T00:00:00Z" };
      mrs.push(mr);
      return { status: 201, body: mr };
    }
    if ((r = p.match(/^\/projects\/5\/merge_requests\/(\d+)$/)) && m === "PUT") {
      const mr = mrs.find((x) => x.iid === Number(r![1]))!;
      Object.assign(mr, { title: body.title, description: body.description });
      return { body: mr };
    }
    return { status: 404, body: {} };
  });
  return { ...srv, notes, mrs };
}

describe("Scm provider contract: the same calls on GitLab and GitHub", () => {
  const cases = [
    {
      name: "gitlab",
      make: async () => {
        const s = await gitlabMock();
        const env = { QA_SENTINEL_GITLAB_TOKEN: "t", CI_API_V4_URL: `${s.url}/api/v4` };
        return { s, scm: scmFor(cfg({ platform: "gitlab" }), env), project: "5", pr: "7", noteIdOf: () => 11, upBody: () => s.notes[0]?.body, nChange: () => s.mrs.length };
      },
    },
    {
      name: "github",
      make: async () => {
        const s = await githubMock();
        s.reactions[1001] = [{ content: "+1" }, { content: "-1" }, { content: "heart" }];
        const env = { QA_SENTINEL_GITHUB_TOKEN: TOKEN, GITHUB_API_URL: s.url };
        return { s, scm: scmFor(cfg({ platform: "github", provider: "github" }), env), project: "octo/orders", pr: "7", noteIdOf: () => 1001, upBody: () => s.comments[0]?.body, nChange: () => s.pulls.length };
      },
    },
  ];
  for (const k of cases) {
    it(`${k.name}: one marker note, marked notes, change request create/update, latest for branch, reactions`, async () => {
      const w = await k.make();
      try {
        const { scm, project, pr } = w;
        expect(scm.kind).toBe(k.name);
        expect(scm.hasToken).toBe(true);
        expect(await scm.getNoteBody(project, pr)).toBeUndefined();
        const a = await scm.upsertNote(project, pr, "report 1");
        const b = await scm.upsertNote(project, pr, "report 2");
        expect(a.action).toBe("created");
        expect(b).toEqual({ action: "updated", id: a.id });
        expect(w.upBody()).toBe("<!-- qa-sentinel:gap-report -->\nreport 2");
        expect(await scm.getNoteBody(project, pr)).toBe("<!-- qa-sentinel:gap-report -->\nreport 2");
        expect(await scm.upsertMarkedNote(project, pr, "<!-- m -->", "x")).toBe("created");
        expect(await scm.upsertMarkedNote(project, pr, "<!-- m -->", "x")).toBe("same");
        expect(await scm.upsertMarkedNote(project, pr, "<!-- m -->", "y")).toBe("updated");
        expect(await scm.noteReactions(project, pr, w.noteIdOf())).toEqual(k.name === "gitlab" ? [{ name: "thumbsup" }, { name: "thumbsdown" }, { name: "tada" }] : [{ name: "thumbsup" }, { name: "thumbsdown" }, { name: "heart" }]);

        const o = { source: "qa-sentinel/SHOP-1", target: "main", title: "QA agent: tests", description: "d1", labels: ["qa-agent"] };
        const c1 = await scm.createOrUpdateChangeRequest(project, o);
        const c2 = await scm.createOrUpdateChangeRequest(project, { ...o, description: "d2" });
        expect(c1.action).toBe("created");
        expect(c2).toMatchObject({ action: "updated", iid: c1.iid });
        expect(w.nChange()).toBe(1);
        expect(await scm.latestForBranch(project, "qa-sentinel/SHOP-1", "main")).toMatchObject({ iid: c1.iid, state: "opened" });
        expect(await scm.latestForBranch(project, "no-such-branch", "main")).toBeUndefined();
        expect(typeof (await scm.isDraft(project, pr, "x"))).toBe("boolean");
      } finally {
        await w.s.close();
      }
    });
  }

  it("test project and push path come from the config first, then the job's own variables", () => {
    const gh = scmFor(cfg({ platform: "github", provider: "github" }), {});
    expect(gh.testProject({ GITHUB_REPOSITORY: "octo/tests" })).toBe("octo/tests");
    expect(scmFor(cfg({ platform: "github", provider: "github", testRepoProject: "octo/other" }), {}).testProject({ GITHUB_REPOSITORY: "octo/tests" })).toBe("octo/other");
    expect(gh.envProjectPath({ GITHUB_REPOSITORY: "octo/tests" })).toBe("octo/tests");
    const gl = scmFor(cfg({ platform: "gitlab" }), {});
    expect(gl.testProject({ CI_PROJECT_ID: "9" })).toBe("9");
    expect(gl.envProjectPath({ CI_PROJECT_PATH: "g/t" })).toBe("g/t");
    expect(gl.hasToken).toBe(false);
    expect(gh.hasToken).toBe(false);
  });

  it("API calls without a token fail with a clear message instead of calling anything", async () => {
    const scm = scmFor(cfg({ platform: "github", provider: "github" }), {});
    await expect((async () => scm.upsertNote("octo/o", 1, "x"))()).rejects.toThrow(/no GitHub token/);
  });
});

describe("gap report on a GitHub pull request, end to end against a fake GitHub", () => {
  async function world(gh: { url: string }, extra: Record<string, unknown> = {}) {
    const root = tmp("qas-gh-e2e-");
    const repo = path.join(root, "orders");
    fs.mkdirSync(repo);
    g(repo, "init", "-q", "-b", "main");
    const base = commit(repo, "src/a.ts", "export const a = 0;\n", "base");
    const head = commit(repo, "src/a.ts", "export const a = 0;\nexport const b = 1;\n", "change");
    g(root, "init", "-q", "-b", "main");
    writeConfig(root, cfg({ platform: "github", provider: "github", githubApiUrl: gh.url, testRepoProject: "octo/tests", ...extra }));
    const event = path.join(tmp("qas-gh-ev-"), "event.json");
    fs.writeFileSync(event, JSON.stringify({ pull_request: { number: 12, title: "add b", body: "", html_url: "https://github.com/octo/orders/pull/12", base: { sha: base, ref: "main" }, head: { ref: "feature/x", sha: head } } }));
    // The job's environment as Actions sets it; nothing of this machine's CI or GitLab leaks in.
    for (const k of ["CI_PROJECT_ID", "CI_MERGE_REQUEST_IID", "CI_API_V4_URL", "QA_SENTINEL_GITLAB_TOKEN", "GITLAB_TOKEN", "GITHUB_API_URL", "GITHUB_TOKEN", "GH_TOKEN"]) vi.stubEnv(k, "");
    for (const [k, v] of Object.entries({ CI: "", GITHUB_REPOSITORY: "octo/orders", GITHUB_EVENT_PATH: event, GITHUB_BASE_REF: "main", GITHUB_HEAD_REF: "feature/x", QA_SENTINEL_GITHUB_TOKEN: TOKEN })) vi.stubEnv(k, v);
    return { root, repo, head, base };
  }

  it("posts one comment with the vote line, a rerun edits it, and the run remembers the comment for `metrics --online`", async () => {
    const gh = await githubMock();
    const out: string[] = [];
    for (const s of [process.stdout, process.stderr]) vi.spyOn(s, "write").mockImplementation(((chunk: unknown) => (out.push(String(chunk)), true)) as never);
    try {
      const w = await world(gh);
      await gapReportCommand({ cwd: w.root, service: "orders", servicePath: w.repo, post: true });
      await gapReportCommand({ cwd: w.root, service: "orders", servicePath: w.repo, post: true, refresh: true });
      expect(gh.comments).toHaveLength(1);
      expect(gh.comments[0].body).toContain("<!-- qa-sentinel:gap-report -->");
      expect(gh.comments[0].body).toContain(VOTE_LINE);
      expect(gh.pulls).toHaveLength(0);
      const runs = path.join(w.root, ".qa-sentinel/runs");
      const manifests = fs.readdirSync(runs).map((d) => JSON.parse(fs.readFileSync(path.join(runs, d, "manifest.json"), "utf8")));
      expect(manifests.every((m) => m.mr?.project === "octo/orders" && m.mr.iid === "12" && m.mr.noteId === 1001)).toBe(true);

      // metrics --online: reactions read through the same provider.
      gh.reactions[1001] = [{ content: "+1" }, { content: "+1" }, { content: "-1" }, { content: "rocket" }];
      expect(await fetchUsefulness(scmFor(loadConfig(w.root), { QA_SENTINEL_GITHUB_TOKEN: TOKEN, GITHUB_API_URL: gh.url }), manifests)).toEqual({ notes: 1, up: 2, down: 1, unreadable: 0 });
      const outFile = path.join(w.root, "m.md");
      await metricsCommand({ cwd: w.root, out: outFile, fetch: false, online: true, env: { QA_SENTINEL_GITHUB_TOKEN: TOKEN } });
      expect(fs.readFileSync(outFile, "utf8")).toContain("| Gap report comments: 👍 / 👎 | 2 / 1 on 1 comment(s) |");
      // The token appears in no output of the whole run and in no request URL.
      expect(out.join("")).not.toContain(TOKEN);
      expect(gh.log.join("\n")).not.toContain(TOKEN);
    } finally {
      await gh.close();
    }
  });

  it("a draft pull request gets the waiting note instead of a report", async () => {
    const gh = await githubMock();
    try {
      const w = await world(gh, { /* default when: ready */ });
      gh.pulls.push({ number: 12, state: "open", title: "wip", body: "", draft: true, html_url: "u", merged_at: null, created_at: "2026-01-01T00:00:00Z", head: { ref: "feature/x", sha: w.head }, base: { ref: "main", sha: w.base }, labels: [] });
      const c = loadConfig(w.root);
      writeConfig(w.root, ConfigSchema.parse({ ...c, automation: { ...c.automation, gapReport: { ...c.automation.gapReport, when: "ready" } } }));
      const r = await gapReportCommand({ cwd: w.root, service: "orders", servicePath: w.repo, post: true });
      expect(r.skipped).toBe(true);
      expect(gh.comments[0].body).toContain("waiting");
    } finally {
      await gh.close();
    }
  });

  it("split jobs: the analysis job (read token) writes nothing; the publish job comments from its own event, not from the run folder", async () => {
    const gh = await githubMock();
    try {
      const w = await world(gh);
      // Analysis job: it holds a token, but defers every write.
      await gapReportCommand({ cwd: w.root, service: "orders", servicePath: w.repo, deferPublish: true });
      expect(gh.comments).toHaveLength(0);
      expect(gh.log.filter((l) => /^(POST|PATCH|PUT)/.test(l))).toEqual([]);
      const runs = path.join(w.root, ".qa-sentinel/runs");
      const runId = fs.readdirSync(runs).find((n) => fs.existsSync(path.join(runs, n, PUBLISH_FILE)))!;

      // Tampered run folder: a pull request number written into the file must not be used.
      const file = path.join(runs, runId, PUBLISH_FILE);
      const doc = JSON.parse(fs.readFileSync(file, "utf8"));
      const honest = fs.readFileSync(file, "utf8");
      doc.steps[0].mr = { project: "evil/other", mrIid: "999" };
      fs.writeFileSync(file, JSON.stringify(doc));
      const tamperEnv = { ...process.env, QA_SENTINEL_GITHUB_TOKEN: TOKEN, GITHUB_API_URL: gh.url };
      expect(await publishCommand({ cwd: w.root, env: tamperEnv })).toBe(1); // publish.json is validated strictly: unknown keys are refused
      expect(gh.comments).toHaveLength(0);
      fs.writeFileSync(file, honest);

      // Publish job: its own event says PR 12 of octo/orders.
      expect(await publishCommand({ cwd: w.root, env: { ...process.env, QA_SENTINEL_GITHUB_TOKEN: TOKEN, GITHUB_API_URL: gh.url } })).toBe(0);
      expect(gh.comments).toHaveLength(1);
      expect(gh.log.some((l) => l.includes("/repos/octo/orders/issues/12/comments"))).toBe(true);
      expect(gh.log.some((l) => l.includes("evil") || l.includes("999"))).toBe(false);
      // A second publish of a finished run does nothing.
      expect(await publishCommand({ cwd: w.root, env: { ...process.env, QA_SENTINEL_GITHUB_TOKEN: TOKEN, GITHUB_API_URL: gh.url } })).toBe(0);
      expect(gh.comments).toHaveLength(1);
    } finally {
      await gh.close();
    }
  });

  it("publish: pushes the bundle branch to a local remote and opens the test pull request with labels", async () => {
    const gh = await githubMock();
    try {
      const w = await world(gh);
      // Not run here: the push needs a GitHub remote. What can be proven offline is the pull request step; see docs/TRY-PR10.md for the real push.
      const scm = scmFor(loadConfig(w.root), { QA_SENTINEL_GITHUB_TOKEN: TOKEN, GITHUB_API_URL: gh.url, GITHUB_REPOSITORY: "octo/tests" });
      const mr = await scm.createOrUpdateChangeRequest(scm.testProject({ GITHUB_REPOSITORY: "octo/tests" })!, { source: "qa-sentinel/SHOP-101", target: "main", title: "QA agent: tests for SHOP-101", description: "d", labels: ["qa-agent", "story::SHOP-101"] });
      expect(mr.action).toBe("created");
      expect(gh.pulls[0].labels.map((l) => l.name)).toEqual(["qa-agent", "story::SHOP-101"]);
    } finally {
      await gh.close();
    }
  });
});

describe("environment scrubbing", () => {
  it("QA_SENTINEL_GITHUB_TOKEN never reaches agents or test runs, even when listed as base", () => {
    const out = scrubbedEnv({ baseUrlEnv: "QA_BASE_URL", passEnv: [], forAgent: true }, { PATH: "/bin", QA_SENTINEL_GITHUB_TOKEN: "x", GITHUB_TOKEN: "y", GH_TOKEN: "z" });
    expect(out).toEqual({ PATH: "/bin" });
  });
});

describe("init --ci github and doctor", () => {
  async function inited(level: "intelligence" | "maintenance" = "intelligence") {
    const repo = tmp("qas-gh-init-");
    execFileSync("git", ["init", "-q"], { cwd: repo, env: { ...process.env, ...GIT_ENV } });
    await initCommand({ cwd: repo, yes: true, mode: "scratch", ci: "github", level, name: "t", testRepoProject: "octo/tests" });
    // init takes the sibling folders of a temp dir for services; none are wanted here (and checking hundreds is slow).
    const c = loadConfig(repo);
    writeConfig(repo, ConfigSchema.parse({ ...c, workspace: { ...c.workspace, services: [] } }));
    return repo;
  }
  const rel = (repo: string, f: string) => fs.readFileSync(path.join(repo, "ci/qa-sentinel", f), "utf8");

  it("writes ci.provider: github, the workflow and a README, and no GitLab files", async () => {
    const repo = await inited();
    const c = loadConfig(repo);
    expect(c.ci).toMatchObject({ platform: "github", provider: "github", testRepoProject: "octo/tests" });
    expect(fs.readdirSync(path.join(repo, "ci/qa-sentinel")).sort()).toEqual(["README.md", "qa-gap-report.yml"]);
    expect(rel(repo, "qa-gap-report.yml")).not.toMatch(/\{\{(?!\s)/); // no unresolved template tags (GitHub's own ${{ }} has a space)
  });

  it("the workflow is valid YAML with the split-job security model", async () => {
    const wf = YAML.parse(rel(await inited(), "qa-gap-report.yml"), { logLevel: "error" });
    expect(wf.on.pull_request.types).toContain("synchronize");
    expect(wf.permissions).toEqual({}); // nothing by default
    const { analysis, publish } = wf.jobs;
    expect(analysis.permissions).toEqual({ contents: "read", "pull-requests": "read" });
    expect(publish.permissions).toEqual({ contents: "read", "pull-requests": "write" });
    expect(publish.needs).toBe("analysis");
    const text = (job: object) => JSON.stringify(job);
    // The model key and the Jira read login: analysis only. The write token and the Jira publishing login: publish only.
    expect(text(analysis)).toContain("secrets.ANTHROPIC_API_KEY");
    expect(text(publish)).not.toMatch(/ANTHROPIC|JIRA_API_TOKEN|JIRA_EMAIL|JIRA_PAT"|secrets\.JIRA_PAT/);
    expect(text(analysis)).not.toContain("QA_JIRA_PUBLISH");
    expect(text(publish)).toContain("QA_JIRA_PUBLISH_PAT");
    expect(text(analysis)).toContain("--defer-publish");
    expect(text(publish)).toContain("publish --run all");
    // Neither job writes anything with a write-capable token other than publish; checkouts keep no credentials in .git/config.
    const checkouts = [...analysis.steps, ...publish.steps].filter((s: { uses?: string }) => s.uses?.startsWith("actions/checkout"));
    expect(checkouts.length).toBe(3);
    expect(checkouts.every((s: { with: Record<string, unknown> }) => s.with["persist-credentials"] === false)).toBe(true);
    // Fork pull requests get no secrets and a read-only token: skipped.
    expect(analysis.if).toContain("head.repo.full_name == github.repository");
  });

  it("every action is pinned to a version (a tag or a full SHA), never a branch; no pull request text reaches a shell line", async () => {
    const raw = rel(await inited(), "qa-gap-report.yml");
    const uses = [...raw.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]);
    expect(uses.length).toBeGreaterThan(4);
    for (const u of uses) expect(u).toMatch(/@(v\d+(\.\d+)*|[0-9a-f]{40})$/);
    // Untrusted event fields (title, body, branch name) go through env: only SHAs and numbers are used in ${{ }} inside run scripts.
    const wf = YAML.parse(raw, { logLevel: "error" });
    for (const job of Object.values<any>(wf.jobs)) for (const step of job.steps) if (step.run) expect(step.run).not.toContain("${{");
  });

  it("the skip-branches regexes (dependency bots) are in the workflow", async () => {
    expect(rel(await inited(), "qa-gap-report.yml")).toContain("^renovate\\/|^dependabot\\/");
  });

  it("doctor on GitHub asks for a GitHub token and owner/repo, not a GitLab one", async () => {
    const repo = await inited();
    const none = runChecks(repo, {}).map((c) => c.label);
    expect(none).toContain("GitHub token set");
    expect(none).not.toContain("GitLab token set");
    const ok = runChecks(repo, { GITHUB_TOKEN: "x" });
    expect(ok.find((c) => c.label === "GitHub token set")?.level).toBe("ok");
    const c = loadConfig(repo);
    writeConfig(repo, ConfigSchema.parse({ ...c, ci: { ...c.ci, testRepoProject: "12345" } }));
    expect(runChecks(repo, { GITHUB_TOKEN: "x" }).find((x) => x.label === "ci.testRepoProject is owner/repo")?.level).toBe("fail");
  });

  it("doctor --online: reaches the test repo through the API, and the Actions token that cannot read /user is a warning, not a failure", async () => {
    const gh = await githubMock({ userForbidden: true });
    try {
      const repo = await inited();
      const c = loadConfig(repo);
      writeConfig(repo, ConfigSchema.parse({ ...c, ci: { ...c.ci, githubApiUrl: gh.url } }));
      const checks = await onlineChecks(repo, { QA_SENTINEL_GITHUB_TOKEN: TOKEN });
      expect(checks.find((x) => x.label.startsWith("GitHub /user"))?.level).toBe("warn");
      expect(checks.find((x) => x.label === "test repo (octo/tests) reachable")?.level).toBe("ok");
      expect(JSON.stringify(checks)).not.toContain(TOKEN);
      expect((await onlineChecks(repo, {})).map((x) => x.level)).toEqual(["fail"]);
    } finally {
      await gh.close();
    }
  });

  it("init with GitLab still writes the GitLab files and no provider", async () => {
    const repo = tmp("qas-gl-init-");
    execFileSync("git", ["init", "-q"], { cwd: repo, env: { ...process.env, ...GIT_ENV } });
    await initCommand({ cwd: repo, yes: true, mode: "scratch", ci: "gitlab", level: "intelligence", name: "t" });
    expect(loadConfig(repo).ci.provider).toBeUndefined();
    expect(fs.existsSync(path.join(repo, "ci/qa-sentinel/service.gitlab-ci.yml"))).toBe(true);
  });
});
