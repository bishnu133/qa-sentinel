import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

/** Every git call in a test carries its own identity and ignores global and system config. */
export const GIT_ENV = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
export const g = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8", env: { ...process.env, ...GIT_ENV } }).trim();

const made: string[] = [];
export const tmp = (prefix: string) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(d);
  return d;
};
export const cleanTmp = () => {
  for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true });
};

/** Commit a file change (creating the file's folder) and return the new commit. */
export function commit(repo: string, file: string, content: string, message: string): string {
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  fs.writeFileSync(path.join(repo, file), content);
  g(repo, "add", "-A");
  g(repo, "commit", "-q", "-m", message);
  return g(repo, "rev-parse", "HEAD");
}

/** A tiny HTTP server on 127.0.0.1:0 with a request log. */
export async function serve(handler: (req: http.IncomingMessage, url: URL, body: string) => { status?: number; body?: unknown; headers?: Record<string, string> }) {
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

export const card = (summary: string, type: string, o: Record<string, unknown> = {}) => ({ summary, issuetype: { name: type }, status: { name: "In Progress" }, description: "", labels: [], ...o });

/** A mock Jira (v2 API): issues by key. */
export const jiraMock = (issues: Record<string, any>) =>
  serve((_req, url) => {
    const m = url.pathname.match(/^\/rest\/api\/2\/issue\/([^/]+)$/);
    if (!m) return { status: 404, body: {} };
    const key = decodeURIComponent(m[1]);
    return issues[key] ? { body: { key, fields: issues[key] } } : { status: 404, body: { errorMessages: ["Issue Does Not Exist"] } };
  });

export const parentOf = (key: string) => ({ key, fields: { issuetype: { name: "Story" } } });
