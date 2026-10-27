import fs from "node:fs";
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
  it("only a QA_CLEANUP_* variable may be the sweep login (a name pattern, not a list of known secrets), and the host must be allowed", () => {
    for (const name of ["QA_SENTINEL_GITLAB_TOKEN", "JIRA_PAT", "ANTHROPIC_API_KEY", "CI_JOB_TOKEN", "CI_REPOSITORY_URL", "CI_DEPENDENCY_PROXY_PASSWORD", "CI_JOB_JWT_V2", "SOME_OTHER_VARIABLE"]) {
      expect(() => cfg({ sweepAuthEnv: name }), name).toThrow(/QA_CLEANUP_/); // the config does not even load
      const c0 = cfg({});
      const bad = { ...c0, testData: { ...c0.testData, sweepAuthEnv: name } };
      expect(sweepRefusal(bad, {}), name).toMatch(/QA_CLEANUP_/);
    }
    const c = cfg({ sweepAuthEnv: "QA_CLEANUP_AUTH" }, { allowedHosts: ["qa.example.com", "*.qa.test"] });
    expect(sweepRefusal(c, { QA_BASE_URL: "https://qa.example.com/x", QA_CLEANUP_AUTH: "Bearer t" })).toBeUndefined();
    expect(sweepRefusal(c, { QA_BASE_URL: "https://api.qa.test", QA_CLEANUP_AUTH: "Bearer t" })).toBeUndefined();
    expect(sweepRefusal(c, { QA_BASE_URL: "https://evil.example.net", QA_CLEANUP_AUTH: "Bearer t" })).toMatch(/not in guardrails.allowedHosts/);
    expect(sweepRefusal(c, { QA_BASE_URL: "not a url", QA_CLEANUP_AUTH: "Bearer t" })).toMatch(/not a URL/);
    // Read from the work tree in CI, the config cannot add hosts: only the default hosts count (pass --config-from with the pipeline's commit).
    expect(sweepRefusal(c, { CI: "true", QA_BASE_URL: "https://qa.example.com/x", QA_CLEANUP_AUTH: "Bearer t" }, { trustedConfig: false })).toMatch(/--config-from/);
    expect(sweepRefusal(c, { CI: "true", QA_BASE_URL: "http://127.0.0.1:1", QA_CLEANUP_AUTH: "Bearer t" }, { trustedConfig: false })).toBeUndefined();
    expect(sweepRefusal(c, { CI: "true", QA_BASE_URL: "https://qa.example.com/x", QA_CLEANUP_AUTH: "Bearer t" }, { trustedConfig: true })).toBeUndefined();
    // No credential, nothing to leak: a base URL alone is not refused here.
    expect(sweepRefusal(c, { QA_BASE_URL: "https://evil.example.net" })).toBeUndefined();
  });

  it("data sweep refuses to load a work-tree config whose sweepAuthEnv names another credential", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qas-sweepref-"));
    made.push(dir);
    writeConfig(dir, cfg({}));
    fs.writeFileSync(path.join(dir, "qa-sentinel.config.yaml"), fs.readFileSync(path.join(dir, "qa-sentinel.config.yaml"), "utf8").replace(/testData:[\s\S]*?(?=\n\S|$)/, "testData:\n  cleanup: ledger\n  sweepAuthEnv: QA_SENTINEL_GITLAB_TOKEN"));
    await expect(dataSweepCommand({ cwd: dir, olderThan: 0, env: { QA_BASE_URL: "http://127.0.0.1:1", QA_SENTINEL_GITLAB_TOKEN: "glpat-SECRET" } })).rejects.toThrow(/QA_CLEANUP_/);
  });
});
