import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import { initCommand } from "../src/commands/init.js";

const made: string[] = [];
afterEach(() => made.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
const ROOT = path.resolve(__dirname, "..");

const run = (cmd: string, env: NodeJS.ProcessEnv, cwd: string) =>
  new Promise<number>((ok) => {
    const p = spawn("sh", ["-c", cmd], { cwd, env, stdio: "ignore" });
    p.on("close", (c) => ok(c ?? 1));
  });

/** The real after_script text of the template, run against a project whose work-tree config was changed by "generated code". */
async function attack(workTreeSweepAuth: string, extraWorkTreeConfig = "") {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "qas-exfil-"));
  made.push(repo);
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: repo, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  await initCommand({ cwd: repo, yes: true, mode: "scratch", ci: "gitlab", level: "maintenance", name: "t" });
  const doc = YAML.parse(fs.readFileSync(path.join(repo, "ci/qa-sentinel/tests.gitlab-ci.yml"), "utf8"), { logLevel: "error" });
  const strings = (doc["qa-generate"].after_script as unknown[]).filter((x) => typeof x === "string") as string[];
  const block = strings.find((x) => x.includes("sed -n"))!;
  const sweep = strings.find((x) => x.includes("qa-sentinel data sweep"))!;
  git("add", "-A");
  git("commit", "-qm", "pipeline commit");
  const sha = git("rev-parse", "HEAD");
  // What the agent did afterwards, in the work tree (the committed config keeps the default QA_CLEANUP_AUTH).
  const cfgFile = path.join(repo, "qa-sentinel.config.yaml");
  const cfg = YAML.parse(fs.readFileSync(cfgFile, "utf8"));
  cfg.testData = { ...(cfg.testData ?? {}), cleanup: "ledger", sweepAuthEnv: workTreeSweepAuth };
  fs.writeFileSync(cfgFile, YAML.stringify(cfg) + extraWorkTreeConfig);
  const hits: string[] = [];
  const srv = http.createServer((req, res) => { hits.push(`${req.method} ${req.url} auth=${req.headers.authorization ?? ""}`); res.writeHead(204).end(); });
  await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok));
  const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  try {
    const baseUrlEnv = /export (\w+)="\$qa_url"/.exec(block)![1];
    fs.writeFileSync(path.join(repo, ".qa-env.sh"), `export ${baseUrlEnv}='${url}'\n`);
    const ledger = path.join(repo, (cfg.testData?.ledgerDir ?? ".qa-data"));
    fs.mkdirSync(ledger, { recursive: true });
    fs.writeFileSync(path.join(ledger, "a.jsonl"), JSON.stringify({ op: "create", seq: 1, kind: "e", id: "1", remove: { path: "/steal" }, test: "t", at: "2026-01-01T00:00:00Z" }) + "\n");
    const shim = path.join(repo, "shim");
    fs.mkdirSync(shim);
    fs.writeFileSync(path.join(shim, "qa-sentinel"), `#!/bin/sh\nexec "${ROOT}/node_modules/.bin/tsx" "${ROOT}/src/cli.ts" "$@"\n`, { mode: 0o755 });
    const env = {
      PATH: `${shim}:${process.env.PATH}`, HOME: os.tmpdir(), CI: "true", CI_PROJECT_DIR: repo, CI_COMMIT_SHA: sha,
      QA_SENTINEL_GITLAB_TOKEN: "glpat-SECRET-WRITE", CI_JOB_TOKEN: "JOBTOK-1", CI_REPOSITORY_URL: "https://gitlab-ci-token:JOBTOK-1@gitlab.example/g/p.git",
      CI_DEPENDENCY_PROXY_PASSWORD: "JOBTOK-1", CI_JOB_JWT_V2: "eyJ-JWT", JIRA_PAT: "jira-secret", QA_CLEANUP_AUTH: "Bearer cleanup-ok",
    };
    const old = Date.now() / 1000 - 3600;
    for (const f of fs.readdirSync(ledger)) fs.utimesSync(path.join(ledger, f), old, old);
    await run(`QA_INSTALL_SKIP=0\n${block}\n${sweep}`, env, repo);
  } finally {
    srv.close();
  }
  return hits;
}

describe("after_script of the test repo template: the leak the re-review found", () => {
  it.each(["CI_REPOSITORY_URL", "CI_DEPENDENCY_PROXY_PASSWORD", "CI_JOB_JWT_V2", "CI_JOB_TOKEN", "QA_SENTINEL_GITLAB_TOKEN", "JIRA_PAT"])("a work-tree config naming %s as the sweep login sends nothing secret", async (name) => {
    const hits = await attack(name);
    expect(hits.join("\n")).not.toMatch(/JOBTOK|glpat|eyJ|jira-secret/);
  }, 90_000);

  it("the config comes from the pipeline's commit: the committed login is used, even when the work tree names another (and adds a host)", async () => {
    const hits = await attack("CI_REPOSITORY_URL", "guardrails:\n  allowedHosts: [127.0.0.2]\n");
    expect(hits.join("\n")).not.toMatch(/JOBTOK/);
    expect(hits.some((h) => h.includes("auth=Bearer cleanup-ok"))).toBe(true);
  }, 90_000);
});
