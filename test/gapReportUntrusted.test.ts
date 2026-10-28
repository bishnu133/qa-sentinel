import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigSchema, writeConfig } from "../src/config.js";
import { publishCommand } from "../src/commands/publish.js";
import { deferSteps } from "../src/reporting/deferred.js";
import { githubMock } from "./helpers/mockGithub.js";
import { commit, g, tmp } from "./helpers/mocks.js";

const closers: (() => void)[] = [];
afterEach(() => {
  closers.splice(0).forEach((c) => c());
  vi.unstubAllEnvs();
});

/** A GitLab mock that records every write. */
async function gitlab() {
  const writes: { method: string; path: string; body: string }[] = [];
  const srv = http.createServer((req, res) => {
    let b = "";
    req.on("data", (d) => (b += d));
    req.on("end", () => {
      const u = new URL(req.url ?? "/", "http://x");
      const send = (s: number, o: unknown) => (res.writeHead(s, { "content-type": "application/json" }), res.end(JSON.stringify(o)));
      if (req.method !== "GET") writes.push({ method: req.method ?? "", path: u.pathname, body: b });
      if (u.pathname.endsWith("/user")) return send(200, { id: 1 });
      if (/\/notes$/.test(u.pathname) && req.method === "GET") return send(200, []);
      if (/\/notes$/.test(u.pathname) && req.method === "POST") return send(201, { id: 1 });
      send(req.method === "GET" ? 200 : 404, req.method === "GET" ? [] : {});
    });
  });
  await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok));
  closers.push(() => srv.close());
  return { base: `http://127.0.0.1:${(srv.address() as { port: number }).port}`, writes, notes: () => writes.filter((w) => w.method === "POST" && w.path.endsWith("/notes")) };
}

function repo(ci: Record<string, unknown>, jira: Record<string, unknown>) {
  const root = tmp("qas-untrusted-");
  g(root, "init", "-q", "-b", "main");
  commit(root, "README.md", "x\n", "init");
  writeConfig(root, ConfigSchema.parse({ version: 1, mode: "existing", project: { name: "t" }, tests: { api: { framework: "playwright", runCommand: "x" } }, ci, requirements: { source: "jira", jira: { baseUrl: "http://127.0.0.1:1", ...jira } }, reporting: { targets: ["gitlab-mr"] } }));
  return root;
}
const report = (root: string, storyKey: string) => deferSteps(path.join(root, ".qa-sentinel/runs/r1"), "gap-report", "r1", [{ type: "report", report: "### QA impact\nbody", service: "orders", storyKey }]);

describe("split mode: a gap report is posted on the job's own merge request even when the pipeline names no trusted story", () => {
  it("GitLab, projectKeys empty (the default): the merge request names SHOP-12, the note is still posted", async () => {
    const gl = await gitlab();
    const root = repo({ platform: "gitlab", gitlabUrl: gl.base }, {});
    report(root, "SHOP-12");
    const env = { QA_SENTINEL_GITLAB_TOKEN: "w", CI_API_V4_URL: `${gl.base}/api/v4`, CI_PROJECT_ID: "7", CI_MERGE_REQUEST_IID: "7", CI_MERGE_REQUEST_TITLE: "SHOP-12 cap a slot" };
    expect(await publishCommand({ cwd: root, run: "r1", env })).toBe(0);
    expect(gl.notes()).toHaveLength(1);
    expect(gl.notes()[0].body).toContain("QA impact");
    expect(gl.writes.every((w) => w.path.includes("/merge_requests/7/notes"))).toBe(true); // nothing else was written
  });

  it("GitLab, a bug fix, and the publish job has no Jira login: the note is posted", async () => {
    const gl = await gitlab();
    const root = repo({ platform: "gitlab", gitlabUrl: gl.base }, { projectKeys: ["SHOP"] });
    report(root, "SHOP-1"); // the bug's story; the pipeline only knows SHOP-3
    for (const k of ["JIRA_PAT", "JIRA_EMAIL", "JIRA_API_TOKEN"]) vi.stubEnv(k, "");
    const env = { QA_SENTINEL_GITLAB_TOKEN: "w", CI_API_V4_URL: `${gl.base}/api/v4`, CI_PROJECT_ID: "7", CI_MERGE_REQUEST_IID: "7", CI_MERGE_REQUEST_TITLE: "SHOP-3 fix the cap" };
    expect(await publishCommand({ cwd: root, run: "r1", env })).toBe(0);
    expect(gl.notes()).toHaveLength(1);
  });

  it("GitHub: a pull request titled SHOP-12 makes the story trusted, so the comment is posted", async () => {
    const gh = await githubMock();
    closers.push(() => void gh.close());
    const root = repo({ platform: "github", provider: "github", githubApiUrl: gh.url, testRepoProject: "octo/tests" }, { projectKeys: ["SHOP"] });
    const event = path.join(tmp("qas-untrusted-ev-"), "event.json");
    fs.writeFileSync(event, JSON.stringify({ pull_request: { number: 12, title: "SHOP-12 add b", body: "Implements SHOP-12", html_url: "u", base: { sha: "a", ref: "main" }, head: { ref: "feature/SHOP-12-b", sha: "b" } } }));
    report(root, "SHOP-12");
    for (const k of ["CI_PROJECT_ID", "CI_MERGE_REQUEST_IID", "CI_API_V4_URL", "QA_SENTINEL_GITLAB_TOKEN", "CI_MERGE_REQUEST_TITLE"]) vi.stubEnv(k, "");
    const env = { PATH: process.env.PATH, GITHUB_REPOSITORY: "octo/orders", GITHUB_EVENT_PATH: event, GITHUB_BASE_REF: "main", GITHUB_HEAD_REF: "feature/SHOP-12-b", QA_SENTINEL_GITHUB_TOKEN: "ghs_x1234567890", GITHUB_API_URL: gh.url };
    expect(await publishCommand({ cwd: root, run: "r1", env })).toBe(0);
    expect(gh.comments).toHaveLength(1);
  });

  it("GitHub: a story the pull request does not name is posted without it, and Jira is not touched", async () => {
    const gh = await githubMock();
    closers.push(() => void gh.close());
    const root = repo({ platform: "github", provider: "github", githubApiUrl: gh.url, testRepoProject: "octo/tests" }, { projectKeys: ["SHOP"] });
    const event = path.join(tmp("qas-untrusted-ev-"), "event.json");
    fs.writeFileSync(event, JSON.stringify({ pull_request: { number: 12, title: "tidy up", body: "", html_url: "u", base: { sha: "a", ref: "main" }, head: { ref: "tidy", sha: "b" } } }));
    deferSteps(path.join(root, ".qa-sentinel/runs/r1"), "gap-report", "r1", [{ type: "report", report: "### QA impact\nbody", service: "orders", storyKey: "SHOP-99", targets: ["gitlab-mr", "jira"] }]);
    for (const k of ["CI_PROJECT_ID", "CI_MERGE_REQUEST_IID"]) vi.stubEnv(k, "");
    const env = { PATH: process.env.PATH, GITHUB_REPOSITORY: "octo/orders", GITHUB_EVENT_PATH: event, GITHUB_BASE_REF: "main", GITHUB_HEAD_REF: "tidy", QA_SENTINEL_GITHUB_TOKEN: "ghs_x1234567890", GITHUB_API_URL: gh.url, JIRA_PAT: "pat" };
    // The Jira base URL is a closed port: a Jira write would make the step fail (exit 1).
    expect(await publishCommand({ cwd: root, run: "r1", env })).toBe(0);
    expect(gh.comments).toHaveLength(1);
  });
});
