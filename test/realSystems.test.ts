import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigSchema, writeConfig } from "../src/config.js";
import { fetchIssue, jiraContext, searchStories, serverInfo, jiraFlavour, storyAttachments, downloadAttachment, jiraAuthAmbiguous } from "../src/scm/jira.js";
import { call, createOrUpdateMergeRequest, gitlabContext, pushUrl, rawFile } from "../src/scm/gitlab.js";
import { jiraFlavourChecks, runChecks } from "../src/commands/doctor.js";
import { mentionOf } from "../src/reporting/notify.js";
import { wrapTestCommand } from "../src/wrapper.js";
import { buildClaudeArgs } from "../src/claude.js";
import { cleanTmp, tmp } from "./helpers/mocks.js";

// None of these tests reads process.env.CI or a global git identity: every environment is an explicit object.

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  cleanTmp();
});

interface Seen {
  method: string;
  path: string;
  auth?: string;
  token?: string;
}
async function listen(handler: (req: http.IncomingMessage, res: http.ServerResponse, url: URL, body: string) => void) {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      seen.push({ method: req.method ?? "", path: url.pathname, auth: req.headers.authorization, token: req.headers["private-token"] as string | undefined });
      handler(req, res, url, body);
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  closers.push(() => new Promise<void>((ok) => (server.closeAllConnections?.(), server.close(() => ok()))));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, seen };
}
const json = (res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
};

/** A Jira Data Center: /rest/api/2 only, personal access token as a Bearer header, no Cloud search. */
async function jiraDc(pat: string, o: { attachmentHost?: string } = {}) {
  let base = "";
  const s = await listen((req, res, url) => {
    const p = url.pathname;
    if (p === "/rest/api/2/serverInfo") return json(res, 200, { deploymentType: "Server", version: "9.12.4", baseUrl: base });
    if (req.headers.authorization !== `Bearer ${pat}`) return json(res, 401, { message: "You are not logged in" });
    if (p === "/rest/api/2/issue/WEB-1") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end("<!DOCTYPE html><html><body>Single sign-on</body></html>");
    }
    const m = p.match(/^\/rest\/api\/2\/issue\/([A-Z]+-\d+)$/);
    if (m) {
      const att = url.searchParams.get("fields") === "attachment";
      return json(res, 200, { key: m[1], fields: att ? { attachment: [{ id: "9", filename: "spec.yaml", content: `${o.attachmentHost ?? base}/secure/attachment/9/spec.yaml`, size: 5 }] } : { summary: "Delivery slots", status: { name: "In Progress" }, issuetype: { name: "Story" }, description: "## Acceptance criteria\n- AC-1: A slot takes 3 orders.\n", labels: [], updated: "2026-10-20T10:00:00.000+0000" } });
    }
    if (p === "/rest/api/3/search/jql") return json(res, 404, { errorMessages: ["not found"] });
    if (p === "/rest/api/2/search") return json(res, 200, { total: 1, issues: [{ key: "SHOP-5", fields: { summary: "Slots", status: { name: "Ready for QA" }, issuetype: { name: "Story" }, labels: [], updated: "2026-10-20T10:00:00.000+0000" } }] });
    if (p === "/secure/attachment/9/spec.yaml") {
      res.writeHead(200, { "content-type": "text/plain" });
      return res.end("a: 1\n");
    }
    json(res, 404, {});
  });
  base = s.url;
  return s;
}

describe("Jira login: PAT (Data Center) or Cloud", () => {
  it("auto uses Cloud when JIRA_EMAIL is set (even with a PAT also set), the PAT otherwise", () => {
    const base = "https://jira.example/";
    expect(jiraContext({ baseUrl: base, auth: "auto" }, { JIRA_PAT: "p" })?.authHeader).toBe("Bearer p");
    expect(jiraContext({ baseUrl: base, auth: "auto" }, { JIRA_PAT: "p", JIRA_EMAIL: "a@b.c", JIRA_API_TOKEN: "t" })?.authHeader).toBe(`Basic ${Buffer.from("a@b.c:t").toString("base64")}`);
    expect(jiraContext({ baseUrl: base }, { JIRA_EMAIL: "a@b.c", JIRA_API_TOKEN: "t" })?.authHeader).toMatch(/^Basic /);
    expect(jiraContext(base, { JIRA_PAT: "p" })?.baseUrl).toBe("https://jira.example"); // the old string form still works
  });
  it("pat and cloud force one form", () => {
    const both = { JIRA_PAT: "p", JIRA_EMAIL: "a@b.c", JIRA_API_TOKEN: "t" };
    expect(jiraContext({ baseUrl: "https://j", auth: "pat" }, both)?.authHeader).toBe("Bearer p");
    expect(jiraContext({ baseUrl: "https://j", auth: "cloud" }, both)?.authHeader).toMatch(/^Basic /);
    expect(jiraContext({ baseUrl: "https://j", auth: "cloud" }, { JIRA_PAT: "p" })).toBeUndefined();
    expect(jiraContext({ baseUrl: "https://j", auth: "pat" }, { JIRA_EMAIL: "a@b.c", JIRA_API_TOKEN: "t" })).toBeUndefined();
    expect(jiraAuthAmbiguous(both)).toBe(true);
    expect(jiraAuthAmbiguous({ JIRA_PAT: "p" })).toBe(false);
  });
  it("reads a story and searches on a Data Center that takes only a Bearer PAT and /rest/api/2", async () => {
    const dc = await jiraDc("pat-1");
    const ctx = jiraContext({ baseUrl: dc.url, auth: "auto" }, { JIRA_PAT: "pat-1" })!;
    const issue = await fetchIssue(ctx, "SHOP-5");
    expect(issue).toMatchObject({ key: "SHOP-5", status: "In Progress", issueType: "Story" });
    // The Cloud search answers 404 on Data Center: the client falls back to /rest/api/2/search.
    const found = await searchStories(ctx, 'project = "SHOP"', { max: 10 });
    expect(found.map((f) => f.key)).toEqual(["SHOP-5"]);
    expect(dc.seen.filter((s) => s.path.startsWith("/rest/api/")).every((s) => s.auth === "Bearer pat-1")).toBe(true);
    expect(dc.seen.some((s) => s.path === "/rest/api/3/search/jql")).toBe(true);
    // The wrong token is refused with Jira's answer.
    await expect(fetchIssue(jiraContext(dc.url, { JIRA_PAT: "nope" })!, "SHOP-5")).rejects.toThrow(/401/);
  });
  it("says a web page (SSO or proxy login) is not JSON, instead of a SyntaxError", async () => {
    const dc = await jiraDc("pat-1");
    const ctx = jiraContext(dc.url, { JIRA_PAT: "pat-1" })!;
    const err = await fetchIssue(ctx, "WEB-1").catch((e: Error) => e);
    expect((err as Error).message).toMatch(/Jira answered with a web page, not JSON \(a login or SSO proxy in front of Jira\?/);
    expect((err as Error).message).not.toMatch(/Unexpected token|SyntaxError/);
  });
  it("names the origin that was refused for an attachment behind a reverse proxy", async () => {
    const dc = await jiraDc("pat-1", { attachmentHost: "https://jira.corp.example" });
    const ctx = jiraContext(dc.url, { JIRA_PAT: "pat-1" })!;
    const [a] = await storyAttachments(ctx, "SHOP-5");
    const err = await downloadAttachment(ctx, a.content).catch((e: Error) => e);
    expect((err as Error).message).toContain("https://jira.corp.example");
    expect((err as Error).message).toContain(dc.url);
    expect((err as Error).message).toMatch(/baseUrl/);
    // An attachment on the same origin downloads, with the PAT.
    expect(await downloadAttachment(ctx, `${dc.url}/secure/attachment/9/spec.yaml`)).toBe("a: 1\n");
  });
  it("uses the Data Center mention form [~username] and the Cloud form [~accountid:…]", () => {
    expect(mentionOf("jsmith")).toBe("[~jsmith]");
    expect(mentionOf("5b10a2844c20165700ede21a")).toBe("[~accountid:5b10a2844c20165700ede21a]");
    expect(mentionOf("712020:abc-def")).toBe("[~accountid:712020:abc-def]");
  });
});

describe("doctor: Jira flavour and login", () => {
  const cfg = (jira: Record<string, unknown> = {}) => ConfigSchema.parse({ version: 1, mode: "existing", project: { name: "t" }, tests: { api: { framework: "playwright", runCommand: "x" } }, ci: { platform: "gitlab" }, requirements: { source: "jira", jira: { baseUrl: "https://jira.example", projectKeys: ["SHOP"], ...jira } } });
  it("reports Data Center from serverInfo deploymentType Server, and checks the search API of that flavour", async () => {
    const dc = await jiraDc("pat-1");
    const ctx = jiraContext({ baseUrl: dc.url }, { JIRA_PAT: "pat-1" })!;
    expect(jiraFlavour(await serverInfo(ctx))).toBe("datacenter");
    const checks = await jiraFlavourChecks(cfg({ baseUrl: dc.url }), { serverInfo: () => serverInfo(ctx), search: (jql, api) => searchStories(ctx, jql, { max: 1, api }) });
    expect(checks.map((c) => c.label)).toContain("Jira flavour: Data Center (version 9.12.4)");
    expect(checks.find((c) => /search works/.test(c.label))?.label).toContain("/rest/api/2/search");
    expect(checks.every((c) => c.level === "ok")).toBe(true);
  });
  it("reports Cloud, and warns when the setting does not match the flavour or baseUrl differs from what Jira reports", async () => {
    const info = async () => ({ deploymentType: "Cloud", baseUrl: "https://acme.atlassian.net" });
    const out = await jiraFlavourChecks(cfg({ baseUrl: "https://jira.acme.example", auth: "pat" }), { serverInfo: info, search: async () => [] });
    expect(out.map((c) => c.label)).toContain("Jira flavour: Cloud");
    expect(out.some((c) => c.level === "warn" && /Jira Cloud with auth: pat/.test(c.label))).toBe(true);
    expect(out.some((c) => c.level === "warn" && /differs from the URL Jira reports/.test(c.label))).toBe(true);
    expect(out.find((c) => /search works/.test(c.label))?.label).toContain("/rest/api/3/search/jql");
  });
  it("warns, without failing, when serverInfo or the search cannot be read", async () => {
    const bad = await jiraFlavourChecks(cfg(), { serverInfo: async () => Promise.reject(new Error("Jira answered with a web page, not JSON")), search: async () => [] });
    expect(bad).toHaveLength(1);
    expect(bad[0].level).toBe("warn");
    const searchBad = await jiraFlavourChecks(cfg(), { serverInfo: async () => ({ deploymentType: "Server" }), search: async () => Promise.reject(new Error("Jira GET /rest/api/2/search: 403")) });
    expect(searchBad.find((c) => /answers/.test(c.label))?.level).toBe("warn");
  });
  it("runChecks warns when both JIRA_PAT and JIRA_EMAIL are set", () => {
    const dir = tmp("qas-doc-");
    writeConfig(dir, cfg());
    const both = runChecks(dir, { JIRA_PAT: "p", JIRA_EMAIL: "a@b.c", JIRA_API_TOKEN: "t" });
    expect(both.some((c) => c.level === "warn" && /both JIRA_PAT and JIRA_EMAIL/.test(c.label))).toBe(true);
    const pat = runChecks(dir, { JIRA_PAT: "p" });
    expect(pat.some((c) => /both JIRA_PAT/.test(c.label))).toBe(false);
    expect(pat.some((c) => c.level === "ok" && /Jira configured/.test(c.label))).toBe(true);
    const forced = runChecks(dir, { JIRA_PAT: "p" }).length; // auth: auto
    expect(forced).toBeGreaterThan(0);
  });
});

describe("self-hosted GitLab under a sub-path", () => {
  it("pushUrl keeps the path of a GitLab under a sub-path", () => {
    expect(pushUrl("https://corp.example/gitlab", "g/p", { QA_SENTINEL_GITLAB_TOKEN: "tok" })).toBe("https://oauth2:tok@corp.example/gitlab/g/p.git");
    expect(pushUrl("https://corp.example/gitlab/", "/g/sub/p.git", { QA_SENTINEL_GITLAB_TOKEN: "t/k" })).toBe("https://oauth2:t%2Fk@corp.example/gitlab/g/sub/p.git");
    expect(pushUrl("https://gitlab.com", "g/p", { QA_SENTINEL_GITLAB_TOKEN: "tok" })).toBe("https://oauth2:tok@gitlab.com/g/p.git");
    // CI_SERVER_URL (set by GitLab, with the relative URL root) wins over the config.
    expect(pushUrl("https://elsewhere.example", "g/p", { QA_SENTINEL_GITLAB_TOKEN: "tok", CI_SERVER_URL: "http://gl.internal:8080/gitlab" })).toBe("http://oauth2:tok@gl.internal:8080/gitlab/g/p.git");
    expect(pushUrl("https://corp.example/gitlab", "123", { QA_SENTINEL_GITLAB_TOKEN: "tok" })).toBeUndefined();
  });
  it("talks to a GitLab mock at http://127.0.0.1:PORT/gitlab: API URL from ci.gitlabUrl, paging, MR create", async () => {
    const mrs: { source: string }[] = [];
    const gl = await listen((req, res, url, body) => {
      const p = url.pathname;
      if (!p.startsWith("/gitlab/api/v4/")) return json(res, 404, { message: "404 Not Found" });
      const r = p.slice("/gitlab/api/v4".length);
      if (r === "/user") return json(res, 200, { id: 1, username: "bot" });
      if (r === "/projects/g%2Fp/merge_requests" && req.method === "GET") return json(res, 200, mrs.length ? [{ iid: 3, web_url: "x" }] : []);
      if (r === "/projects/g%2Fp/merge_requests" && req.method === "POST") {
        mrs.push({ source: JSON.parse(body).source_branch });
        return json(res, 201, { iid: 3, web_url: `${gl.url}/gitlab/g/p/-/merge_requests/3` });
      }
      if (r === "/projects/g%2Fp/repository/files/a.txt/raw") return json(res, 404, {});
      json(res, 404, {});
    });
    const ctx = gitlabContext(`${gl.url}/gitlab/`, { QA_SENTINEL_GITLAB_TOKEN: "tok" })!;
    expect(ctx.apiUrl).toBe(`${gl.url}/gitlab/api/v4`);
    expect((await call(ctx, "GET", "/user")).data.username).toBe("bot");
    const mr = await createOrUpdateMergeRequest(ctx, "g/p", { source: "qa-sentinel/x", target: "main", title: "t", description: "d" });
    expect(mr).toMatchObject({ iid: 3, action: "created" });
    expect(await rawFile(ctx, "g/p", "a.txt", "main")).toBeUndefined();
    expect(gl.seen.every((s) => s.path.startsWith("/gitlab/api/v4/") && s.token === "tok")).toBe(true);
    // CI_API_V4_URL from GitLab wins over the config.
    expect(gitlabContext("https://x.example", { QA_SENTINEL_GITLAB_TOKEN: "t", CI_API_V4_URL: `${gl.url}/gitlab/api/v4` })!.apiUrl).toBe(`${gl.url}/gitlab/api/v4`);
  });
  it("says a web page (SSO or proxy) is not JSON, with or without a good status", async () => {
    const gl = await listen((_req, res, url) => {
      res.writeHead(url.pathname.endsWith("/bad") ? 502 : 200, { "content-type": "text/html" });
      res.end("<html><body>Sign in</body></html>");
    });
    const ctx = { apiUrl: `${gl.url}/gitlab/api/v4`, token: "tok" };
    await expect(call(ctx, "GET", "/user", undefined, 1)).rejects.toThrow(/GitLab GET \/user answered with a web page, not JSON \(a login or SSO proxy in front of GitLab\?/);
    const bad = await call(ctx, "GET", "/bad", undefined, 1).catch((e: Error) => e);
    expect((bad as Error).message).toMatch(/failed: 502 \(a web page, not JSON/);
    expect((bad as Error).message).not.toContain("<html>");
  });
  it("keeps the cause when the connection fails (a closed socket here; TLS and proxy errors the same way)", async () => {
    const gl = await listen((req) => req.socket.destroy());
    const err = (await call({ apiUrl: `${gl.url}/gitlab/api/v4`, token: "tok" }, "GET", "/user", undefined, 1).catch((e: Error) => e)) as Error;
    expect(err.message).toMatch(/^GET http:\/\/127\.0\.0\.1:\d+\/gitlab\/api\/v4\/user failed: .+/);
    expect(err.message).not.toBe("fetch failed");
    const raw = (await rawFile({ apiUrl: `${gl.url}/gitlab/api/v4`, token: "t" }, "g/p", "a", "main").catch((e: Error) => e)) as Error;
    expect(raw.message).toMatch(/failed: /);
  });
});

describe("verification.wrapCommand", () => {
  const wrapped = (wrapCommand?: string) => ConfigSchema.parse({ version: 1, mode: "existing", project: { name: "t" }, tests: { api: { framework: "playwright", runCommand: "x" } }, ci: { platform: "gitlab" }, verification: { wrapCommand } });
  it("is unchanged without a wrapper, and must contain {cmd}", () => {
    expect(wrapTestCommand(wrapped(), "npx playwright test a.spec.ts")).toBe("npx playwright test a.spec.ts");
    expect(() => wrapped("firejail sh -c")).toThrow(/\{cmd\}/);
  });
  it("hands the command to the wrapper as one shell-quoted word that survives spaces and quotes", () => {
    const dir = tmp("qas-wrap-");
    const log = path.join(dir, "wrapper.log");
    const c = wrapped(`echo wrapper-ran >> ${JSON.stringify(log)} && sh -c {cmd}`);
    const spec = path.join(dir, "my specs", "it's here.spec.ts");
    fs.mkdirSync(path.dirname(spec), { recursive: true });
    fs.writeFileSync(spec, "x");
    const cmd = `node -e "process.stdout.write(process.argv[1] + '|' + require('fs').existsSync(process.argv[1]))" '${spec.replace(/'/g, `'\\''`)}'`;
    const r = spawnSync(wrapTestCommand(c, cmd), { shell: true, encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(`${spec}|true`);
    expect(fs.readFileSync(log, "utf8")).toBe("wrapper-ran\n"); // the wrapper ran, once
    // The exit code passes through.
    expect(spawnSync(wrapTestCommand(c, "exit 3"), { shell: true }).status).toBe(3);
  });
  it("doctor runs the wrapper with `true` and reports whether it works", () => {
    const dir = tmp("qas-wrapdoc-");
    const base = { version: 1, mode: "existing", project: { name: "t" }, tests: { api: { framework: "playwright", runCommand: "x" } }, ci: { platform: "gitlab" } };
    writeConfig(dir, ConfigSchema.parse({ ...base, verification: { wrapCommand: "sh -c {cmd}" } }));
    expect(runChecks(dir, {}).find((c) => /wrapCommand/.test(c.label))?.level).toBe("ok");
    writeConfig(dir, ConfigSchema.parse({ ...base, verification: { wrapCommand: "definitely-not-a-wrapper-xyz {cmd}" } }));
    expect(runChecks(dir, {}).find((c) => /wrapCommand/.test(c.label))?.level).toBe("fail");
  });
});

describe("agent.sandbox (Claude Code's built-in Bash sandbox)", () => {
  const base = { cwd: "/w", prompt: "p", maxTurns: 3, tools: ["Read"], allow: [], deny: ["Read(.env)"], timeoutMs: 1, env: {} };
  it("adds nothing unless it is switched on", () => {
    expect(JSON.parse(buildClaudeArgs(base)[buildClaudeArgs(base).indexOf("--settings") + 1])).toEqual({ permissions: { deny: ["Read(.env)"] } });
    const off = buildClaudeArgs({ ...base, sandbox: { enabled: false, allowedDomains: ["a"], failIfUnavailable: true } });
    expect(JSON.parse(off[off.indexOf("--settings") + 1]).sandbox).toBeUndefined();
  });
  it("passes the documented sandbox keys in the one --settings value", () => {
    const a = buildClaudeArgs({ ...base, sandbox: { enabled: true, allowedDomains: ["qa.example.com"], failIfUnavailable: true } });
    expect(a.filter((x) => x === "--settings")).toHaveLength(1);
    expect(JSON.parse(a[a.indexOf("--settings") + 1])).toEqual({
      permissions: { deny: ["Read(.env)"] },
      sandbox: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, network: { allowedDomains: ["qa.example.com"] } },
    });
  });
});

describe("wrapCommand reaches the real test runs", () => {
  it("verifyChanges runs the changed specs inside the wrapper (and the retry too)", async () => {
    const { verifyChanges } = await import("../src/verification.js");
    const repo = tmp("qas-wrapv-");
    const log = path.join(repo, "wrapper.log");
    fs.mkdirSync(path.join(repo, "tests/api/my dir"), { recursive: true });
    fs.writeFileSync(path.join(repo, "runner.js"), "require('fs').appendFileSync('ran.log', process.argv.slice(2).join('|') + '\\n');\n");
    fs.writeFileSync(path.join(repo, "tests/api/my dir/orders.spec.js"), "// spec\n");
    const c = ConfigSchema.parse({
      version: 1,
      mode: "existing",
      project: { name: "p" },
      tests: { api: { framework: "mocha", dir: "tests/api", runCommand: "node runner.js" } },
      ci: { platform: "gitlab" },
      verification: { preflight: false, retryFailed: false, wrapCommand: `echo wrapped >> ${JSON.stringify(log)} && sh -c {cmd}` },
    });
    const runDir = tmp("qas-wrapv-run-");
    const r = await verifyChanges({ cwd: repo, c, changes: [{ path: "tests/api/my dir/orders.spec.js", status: "A" }], runDir, env: { PATH: process.env.PATH } });
    expect(r.checks.find((x) => x.name === "tests")?.status).toBe("passed");
    expect(fs.readFileSync(log, "utf8")).toBe("wrapped\n");
    expect(fs.readFileSync(path.join(repo, "ran.log"), "utf8")).toBe("tests/api/my dir/orders.spec.js\n"); // the quoting survived the space
  });
  it("doctor says an enabled sandbox with no allowed domains cannot reach the QA environment", () => {
    const dir = tmp("qas-sbxdoc-");
    writeConfig(dir, ConfigSchema.parse({ version: 1, mode: "existing", project: { name: "t" }, tests: { api: { framework: "playwright", runCommand: "x" } }, ci: { platform: "gitlab" }, agent: { sandbox: { enabled: true } } }));
    expect(runChecks(dir, {}).some((c) => c.level === "warn" && /allowedDomains is empty/.test(c.label))).toBe(true);
  });
});
