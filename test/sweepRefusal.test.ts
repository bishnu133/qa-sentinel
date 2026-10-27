import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigSchema, writeConfig } from "../src/config.js";
import { dataSweepCommand } from "../src/commands/data.js";
import { sweepRefusal } from "../src/testData.js";

const made: string[] = [];
afterEach(() => made.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

const cfg = (testData: Record<string, unknown>, guardrails: Record<string, unknown> = {}) =>
  ConfigSchema.parse({ version: 1, mode: "existing", project: { name: "p" }, tests: { api: { framework: "playwright", runCommand: "x" } }, ci: { platform: "gitlab" }, requirements: { source: "none" }, testData: { cleanup: "ledger", ...testData }, guardrails });

describe("the sweeper does not send a credential it should not (config and .qa-env.sh are written by code the agent may have changed)", () => {
  it("refuses a sweepAuthEnv that names a known secret, and a credential for a host outside allowedHosts", () => {
    for (const name of ["QA_SENTINEL_GITLAB_TOKEN", "QA_SENTINEL_GITLAB_WRITE_TOKEN", "JIRA_PAT", "QA_JIRA_PUBLISH_PAT", "ANTHROPIC_API_KEY", "AWS_SECRET_ACCESS_KEY", "CI_JOB_TOKEN"]) expect(sweepRefusal(cfg({ sweepAuthEnv: name }), {}), name).toMatch(/credential/);
    const c = cfg({ sweepAuthEnv: "QA_CLEANUP_AUTH" }, { allowedHosts: ["qa.example.com", "*.qa.test"] });
    expect(sweepRefusal(c, { QA_BASE_URL: "https://qa.example.com/x", QA_CLEANUP_AUTH: "Bearer t" })).toBeUndefined();
    expect(sweepRefusal(c, { QA_BASE_URL: "https://api.qa.test", QA_CLEANUP_AUTH: "Bearer t" })).toBeUndefined();
    expect(sweepRefusal(c, { QA_BASE_URL: "https://evil.example.net", QA_CLEANUP_AUTH: "Bearer t" })).toMatch(/not in guardrails.allowedHosts/);
    expect(sweepRefusal(c, { QA_BASE_URL: "not a url", QA_CLEANUP_AUTH: "Bearer t" })).toMatch(/not a URL/);
    // No credential, nothing to leak: a base URL alone is not refused here.
    expect(sweepRefusal(c, { QA_BASE_URL: "https://evil.example.net" })).toBeUndefined();
  });

  it("data sweep with sweepAuthEnv: QA_SENTINEL_GITLAB_TOKEN sends nothing (the exfiltration from the review)", async () => {
    const hits: string[] = [];
    const srv = http.createServer((req, res) => { hits.push(`${req.method} ${req.url} ${req.headers.authorization ?? ""}`); res.writeHead(204).end(); });
    await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok));
    try {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qas-sweepref-"));
      made.push(dir);
      writeConfig(dir, cfg({ sweepAuthEnv: "QA_SENTINEL_GITLAB_TOKEN" }));
      fs.mkdirSync(path.join(dir, ".qa-data"), { recursive: true });
      const file = path.join(dir, ".qa-data", "r.jsonl");
      fs.writeFileSync(file, JSON.stringify({ op: "create", seq: 1, kind: "x", id: "1", remove: { path: "/steal" }, test: "t", at: "2026-10-17T01:00:00.000Z" }) + "\n");
      const old = Date.now() / 1000 - 3600;
      fs.utimesSync(file, old, old);
      const code = await dataSweepCommand({ cwd: dir, olderThan: 0, env: { QA_BASE_URL: `http://127.0.0.1:${(srv.address() as { port: number }).port}`, QA_SENTINEL_GITLAB_TOKEN: "glpat-SECRET" } });
      expect(code).toBe(2);
      expect(hits).toEqual([]);
    } finally {
      srv.close();
    }
  });
});
