import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { neutraliseQuickActions, upsertMarkedNote, type GitLabContext } from "../src/scm/gitlab.js";
import { parseOverrideLines } from "../src/stories/overrides.js";
import { ConfigSchema, writeConfig } from "../src/config.js";
import { publishCommand } from "../src/commands/publish.js";
import { deferSteps } from "../src/reporting/deferred.js";
import { assertNoLinks } from "../src/noLinks.js";
import { fetchIssue } from "../src/scm/jira.js";
import { commit, g, tmp } from "./helpers/mocks.js";

const ROOT = path.resolve(__dirname, "..");
const ZW = "​";
const servers: http.Server[] = [];
afterEach(() => {
  servers.splice(0).forEach((s) => s.close());
  vi.unstubAllEnvs();
});
const listen = async (h: http.RequestListener) => {
  const srv = http.createServer(h);
  await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok));
  servers.push(srv);
  return `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
};

describe("no symbolic link is committed", () => {
  it("git tracks no mode-120000 entry (a node_modules link to a path on one machine got in once)", () => {
    let out = "";
    try {
      out = execFileSync("git", ["ls-files", "-s"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    } catch {
      return; // not a git checkout (an unpacked tarball): nothing to check
    }
    expect(out.split("\n").filter((l) => l.startsWith("120000"))).toEqual([]);
    expect(fs.readFileSync(path.join(ROOT, ".gitignore"), "utf8").split("\n")).toContain("node_modules");
  });
});

describe("quick actions inside an HTML tag", () => {
  it("a / right after > is neutralised too, and doing it twice changes nothing more", () => {
    expect(neutraliseQuickActions("x <p>/approve</p>")).toBe(`x <p>${ZW}/approve</p>`);
    expect(neutraliseQuickActions("<details><summary>s</summary>/merge</details>")).toBe(`<details><summary>s</summary>${ZW}/merge</details>`);
    for (const t of ["x <p>/approve</p>", "/approve\n  /merge", "a\r\n/x", "<p>/a</p><p>/b</p>", "plain /api/orders"]) expect(neutraliseQuickActions(neutraliseQuickActions(t))).toBe(neutraliseQuickActions(t));
    // Markers, stamps and ordinary text are not touched.
    expect(neutraliseQuickActions("<!-- qa-sentinel:marker -->\n<sub>stamp</sub>\nsee /api/x")).toBe("<!-- qa-sentinel:marker -->\n<sub>stamp</sub>\nsee /api/x");
  });
  it("/qa ready is still read after it", () => {
    expect(parseOverrideLines(neutraliseQuickActions("/qa ready AC-1 checked by @dana"), "/qa ready").length).toBe(1);
  });
});

describe("upsertMarkedNote compares what GitLab holds", () => {
  it("a note with a line starting with / is 'same' the second time, not rewritten", async () => {
    const notes: { id: number; body: string; author: { id: number } }[] = [];
    const puts: number[] = [];
    const base = await listen((req, res) => {
      let b = "";
      req.on("data", (d) => (b += d));
      req.on("end", () => {
        const send = (s: number, o: unknown) => (res.writeHead(s, { "content-type": "application/json" }), res.end(JSON.stringify(o)));
        const u = req.url ?? "";
        if (u.includes("/user")) return send(200, { id: 1 });
        if (/\/notes(\?|$)/.test(u) && req.method === "GET") return send(200, notes);
        if (/\/notes$/.test(u) && req.method === "POST") return notes.push({ id: notes.length + 1, body: JSON.parse(b).body, author: { id: 1 } }), send(201, { id: 1 });
        if (req.method === "PUT") return puts.push(1), send(200, {});
        send(404, {});
      });
    });
    const ctx = { apiUrl: `${base}/api/v4`, token: "t" } as GitLabContext;
    const body = "**blocked**\n/api/orders returns 500";
    expect(await upsertMarkedNote(ctx, 1, 2, "<!-- m -->", body)).toBe("created");
    expect(await upsertMarkedNote(ctx, 1, 2, "<!-- m -->", body)).toBe("same");
    expect(puts).toHaveLength(0);
  });
});

describe("links on the way to the run folders", () => {
  const conf = (url: string) => ConfigSchema.parse({ version: 1, mode: "existing", project: { name: "t" }, tests: { api: { framework: "playwright", runCommand: "x" } }, ci: { platform: "gitlab", gitlabUrl: url } });
  it("publish refuses when .qa-sentinel/runs is a link to a folder elsewhere", async () => {
    const root = tmp("qas-plink-");
    g(root, "init", "-q", "-b", "main");
    commit(root, "README.md", "x\n", "init");
    const elsewhere = tmp("qas-elsewhere-");
    deferSteps(path.join(elsewhere, "r1"), "gap-report", "r1", [{ type: "report", report: "x", service: "orders", targets: ["gitlab-mr"] }]);
    fs.mkdirSync(path.join(root, ".qa-sentinel"), { recursive: true });
    fs.symlinkSync(elsewhere, path.join(root, ".qa-sentinel/runs"));
    writeConfig(root, conf("http://127.0.0.1:1"));
    const before = fs.readdirSync(path.join(elsewhere, "r1")).sort();
    await expect(publishCommand({ cwd: root, env: { QA_SENTINEL_GITLAB_TOKEN: "w", CI_PROJECT_ID: "7", CI_MERGE_REQUEST_IID: "7" } })).rejects.toThrow(/symbolic link/);
    await expect(publishCommand({ cwd: root, run: "r1", env: { QA_SENTINEL_GITLAB_TOKEN: "w", CI_PROJECT_ID: "7", CI_MERGE_REQUEST_IID: "7" } })).rejects.toThrow(/symbolic link/);
    expect(fs.readdirSync(path.join(elsewhere, "r1")).sort()).toEqual(before);
  });
  it("publish refuses when .qa-sentinel itself is a link", async () => {
    const root = tmp("qas-plink2-");
    g(root, "init", "-q", "-b", "main");
    commit(root, "README.md", "x\n", "init");
    const elsewhere = tmp("qas-elsewhere2-");
    fs.mkdirSync(path.join(elsewhere, "runs"));
    fs.symlinkSync(elsewhere, path.join(root, ".qa-sentinel"));
    writeConfig(root, conf("http://127.0.0.1:1"));
    await expect(publishCommand({ cwd: root, env: { QA_SENTINEL_GITLAB_TOKEN: "w" } })).rejects.toThrow(/symbolic link/);
  });
  it("a link deeper than 12 levels is found; a folder nested absurdly deep is refused", () => {
    const d = tmp("qas-deep-");
    let p = d;
    for (let i = 0; i < 14; i++) p = path.join(p, `d${i}`);
    fs.mkdirSync(p, { recursive: true });
    fs.symlinkSync("/etc/passwd", path.join(p, "x"));
    expect(() => assertNoLinks(d)).toThrow(/symbolic link/);
    const e = tmp("qas-deeper-");
    let q = e;
    for (let i = 0; i < 45; i++) q = path.join(q, "n");
    fs.mkdirSync(q, { recursive: true });
    expect(() => assertNoLinks(e)).toThrow(/nested more than/);
  });
});

describe("a Jira that never answers", () => {
  it("fetchIssue gives up after the timeout instead of waiting for the CI job's own", async () => {
    vi.stubEnv("QA_SENTINEL_JIRA_TIMEOUT_MS", "300");
    const base = await listen(() => {
      /* never answers */
    });
    const t0 = Date.now();
    await expect(fetchIssue({ baseUrl: base, authHeader: "Bearer x" }, "SHOP-1")).rejects.toThrow();
    expect(Date.now() - t0).toBeLessThan(5000);
  });
});
