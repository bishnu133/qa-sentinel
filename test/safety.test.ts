import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { scrubbedEnv } from "../src/env.js";
import { checkContent, checkPaths, checkServiceUntouched, snapshotTree, claudePermissions, countAssertions, generatePolicy, hostAllowed, learnPolicy } from "../src/guardrails.js";
import { ConfigSchema } from "../src/config.js";
import { workingChanges, changesSince } from "../src/git.js";
import { extractStoryKey, parseAcceptanceCriteria, resolveRequirements, storyMarkdown } from "../src/requirements.js";
import { findDiscrepancies, overallStatus, parseJUnit, verifyChanges } from "../src/verification.js";
import { statusFromJson } from "../src/claude.js";
import { pushUrl } from "../src/scm/gitlab.js";
import { mrDescription } from "../src/reporting.js";
import { runProcess } from "../src/proc.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "qas-"));
const write = (root: string, rel: string, content: string) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), content);
};
const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
const gitInit = (dir: string) => {
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "user.email", "t@t");
  sh(dir, "config", "user.name", "t");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-qm", "init", "--allow-empty");
};
const config = (over: any = {}) =>
  ConfigSchema.parse({
    version: 1,
    mode: "scratch",
    project: { name: "p" },
    tests: { api: { framework: "playwright", dir: "tests/api", helpersDir: "src/api", runCommand: "npx playwright test --project=api", extraWritePaths: ["src/data/**"] } },
    ci: { platform: "gitlab" },
    ...over,
  });

describe("env scrubbing", () => {
  const env = {
    PATH: "/bin",
    HOME: "/h",
    QA_BASE_URL: "http://qa",
    QA_SENTINEL_GITLAB_TOKEN: "glpat-x",
    CI_JOB_TOKEN: "job",
    AWS_SECRET_ACCESS_KEY: "s",
    ANTHROPIC_API_KEY: "sk-ant",
    HTTPS_PROXY: "http://proxy",
    QA_USER_PASSWORD: "pw",
    RANDOM_VAR: "x",
  };
  it("agents get auth + base URL, never publisher tokens or unrelated secrets", () => {
    const e = scrubbedEnv({ baseUrlEnv: "QA_BASE_URL", passEnv: [], forAgent: true }, env);
    expect(e).toMatchObject({ PATH: "/bin", HOME: "/h", QA_BASE_URL: "http://qa", ANTHROPIC_API_KEY: "sk-ant", HTTPS_PROXY: "http://proxy" });
    for (const k of ["QA_SENTINEL_GITLAB_TOKEN", "CI_JOB_TOKEN", "AWS_SECRET_ACCESS_KEY", "QA_USER_PASSWORD", "RANDOM_VAR"]) expect(e[k]).toBeUndefined();
  });
  it("test runs never get the Anthropic key; passEnv opts in explicitly", () => {
    const e = scrubbedEnv({ baseUrlEnv: "QA_BASE_URL", passEnv: ["QA_USER_PASSWORD"], forAgent: false }, env);
    expect(e.ANTHROPIC_API_KEY).toBeUndefined();
    expect(e.QA_USER_PASSWORD).toBe("pw");
    expect(e.QA_SENTINEL_GITLAB_TOKEN).toBeUndefined();
  });
});

describe("write policy", () => {
  const policy = generatePolicy(config());
  it("derives allowed paths from config and blocks sensitive files even inside them", () => {
    expect(policy.allowed).toEqual(["tests/api/**", "src/api/**", "src/data/**", "test-map.yaml"]);
    const f = checkPaths(
      [
        { path: "tests/api/a.spec.ts", status: "M" },
        { path: "src/api/client.ts", status: "A" },
        { path: "tests/api/.env.local", status: "A" },
        { path: ".gitlab-ci.yml", status: "M" },
        { path: "src/server.ts", status: "M" },
        { path: "tests/api/new.spec.ts", status: "R", from: "README.md" },
        { path: "src/api/old.ts", status: "D" },
      ],
      policy,
    );
    const by = Object.fromEntries(f.map((x) => [x.file, x.rule]));
    expect(by).toEqual({ "tests/api/.env.local": "blocked-path", ".gitlab-ci.yml": "blocked-path", "src/server.ts": "outside-allowed", "README.md": "outside-allowed" });
  });
  it("learn may only touch its three files", () => {
    const f = checkPaths([{ path: "test-map.yaml", status: "M" }, { path: ".claude/agents/x.md", status: "M" }], learnPolicy());
    expect(f.map((x) => x.file)).toEqual([".claude/agents/x.md"]);
  });
  it("produces Claude Code allow/deny rules", () => {
    const p = claudePermissions({ write: policy, bash: ["npx playwright test --project=api *"], readOnlyDirs: ["/ws/orders"] });
    expect(p.allow).toContain("Edit(tests/api/**)");
    expect(p.allow).toContain("Bash(npx playwright test --project=api *)");
    expect(p.deny).toContain("Edit(.gitlab-ci.yml)");
    expect(p.deny).toContain("Edit(//ws/orders/**)");
    expect(p.deny).toContain("Read(//**/.git/config)");
  });
});

describe("content checks", () => {
  it("flags unknown hosts, secrets, assertion removal and deleted tests", () => {
    const r = tmp();
    write(r, "tests/api/a.spec.ts", "expect(a).toBe(1);\nexpect(b).toBe(2);\n");
    write(r, "tests/api/gone.spec.ts", "expect(1).toBe(1);\n");
    gitInit(r);
    const start = sh(r, "rev-parse", "HEAD").trim();
    write(r, "tests/api/a.spec.ts", "expect(a).toBe(1);\nconst u = 'https://api.prod.bank.com/x';\nconst ok = 'https://qa.internal/x';\nconst t = 'glpat-abcdefghijklmnopqrstu';\n");
    fs.rmSync(path.join(r, "tests/api/gone.spec.ts"));
    const changes = workingChanges(r);
    const f = checkContent(changes, { repo: r, ref: start, allowedHosts: ["localhost"], baseUrl: "https://qa.internal", assertionRemoval: "warn" });
    const rules = f.map((x) => `${x.level}:${x.rule}`).sort();
    expect(rules).toEqual(["violation:secret", "violation:url-host", "warning:assertion-removed", "warning:test-deleted"]);
    expect(f.find((x) => x.rule === "url-host")?.message).toContain("api.prod.bank.com");
    const strict = checkContent(changes, { repo: r, ref: start, allowedHosts: ["localhost", "*.prod.bank.com"], baseUrl: "https://qa.internal", assertionRemoval: "fail" });
    expect(strict.filter((x) => x.level === "violation").map((x) => x.rule).sort()).toEqual(["assertion-removed", "secret", "test-deleted"]);
  });
  it("hostAllowed supports wildcards", () => {
    expect(hostAllowed("a.example.com", ["*.example.com"])).toBe(true);
    expect(hostAllowed("example.com", ["*.example.com"])).toBe(true);
    expect(hostAllowed("evil.com", ["*.example.com"])).toBe(false);
  });
  it("counts assertions across styles", () => {
    expect(countAssertions("expect(a).toBe(1); expect.soft(b).toBe(2); assert.equal(1,1); expectSchema(x, s)")).toBe(4);
  });
  it("detects agent changes to the read-only service repo, ignoring pre-existing local files", () => {
    const r = tmp();
    write(r, "src/a.ts", "1");
    gitInit(r);
    write(r, "node_modules/x/index.js", "pre-existing, untracked");
    const before = snapshotTree(r);
    expect(checkServiceUntouched(r, "svc", before)).toEqual([]);
    write(r, "src/a.ts", "2");
    expect(checkServiceUntouched(r, "svc", before)).toEqual([expect.objectContaining({ rule: "service-repo-modified", file: "svc/src/a.ts" })]);
  });
  it("changesSince includes committed, uncommitted and untracked changes", () => {
    const r = tmp();
    write(r, "a.ts", "1");
    gitInit(r);
    const base = sh(r, "rev-parse", "HEAD").trim();
    write(r, "b.ts", "2");
    sh(r, "add", "-A");
    sh(r, "commit", "-qm", "b");
    write(r, "c.ts", "3");
    write(r, "a.ts", "changed");
    expect(changesSince(r, base).map((c) => `${c.status}:${c.path}`).sort()).toEqual(["?:c.ts", "A:b.ts", "M:a.ts"]);
  });
});

describe("requirements", () => {
  const story = "# SHOP-42 Choose a delivery slot\nAs a customer…\n\nAcceptance criteria:\n1. deliverySlot is required.\n2. A past slot returns 400.\n3. A slot accepts at most 3 orders;\n   the 4th gets 409.\n\n## Notes\n- not an AC\n";
  it("parses AC items and story keys", () => {
    expect(parseAcceptanceCriteria(story)).toEqual([
      { id: "AC-1", text: "deliverySlot is required." },
      { id: "AC-2", text: "A past slot returns 400." },
      { id: "AC-3", text: "A slot accepts at most 3 orders; the 4th gets 409." },
    ]);
    expect(extractStoryKey("[A-Z][A-Z0-9]+-\\d+", undefined, "feature/PAY-7-refunds")).toBe("PAY-7");
  });
  it("prefers a story file, records provenance, and says plainly when nothing is found", async () => {
    const d = tmp();
    write(d, "story.md", story);
    const c = config();
    const s = await resolveRequirements(c, { storyFile: path.join(d, "story.md") });
    expect(s).toMatchObject({ source: "story-file", storyKey: "SHOP-42", approvalStatus: "unverified" });
    expect(s.revision).toMatch(/^sha256:/);
    expect(storyMarkdown(s)).toContain("AC-1, AC-2, AC-3");
    const none = await resolveRequirements(c, {});
    expect(none.source).toBe("none");
    expect(storyMarkdown(none)).toContain("Oracle status: MISSING");
    const mr = await resolveRequirements(c, { mr: { title: "SHOP-9 thing", description: "Acceptance criteria\n- a\n- b", url: "https://g/mr/1" } });
    expect(mr).toMatchObject({ source: "gitlab-mr", storyKey: "SHOP-9", sourceUrl: "https://g/mr/1" });
    expect(mr.acceptanceCriteria).toHaveLength(2);
  });
});

describe("verification", () => {
  const junit = `<?xml version="1.0"?><testsuites><testsuite name="a">
    <testcase name="creates &quot;order&quot;" classname="orders.spec.ts" time="0.1"></testcase>
    <testcase name="rejects" classname="orders.spec.ts"><failure message="expected 400 got 201">stack</failure></testcase>
    <testcase name="cap" classname="orders.spec.ts"><skipped/></testcase>
    <testcase name="env" classname="x"><failure message="connect ECONNREFUSED 127.0.0.1:1"/></testcase>
  </testsuite></testsuites>`;
  it("parses JUnit", () => {
    const cases = parseJUnit(junit);
    expect(cases.map((c) => c.status)).toEqual(["passed", "failed", "skipped", "failed"]);
    expect(cases[0].name).toBe('creates "order"');
    expect(cases[1].message).toBe("expected 400 got 201");
  });
  it("never reports blocked or not-run as verified", () => {
    expect(overallStatus([{ name: "tests", status: "passed", detail: "" }])).toBe("VERIFIED");
    expect(overallStatus([{ name: "preflight", status: "blocked", detail: "" }, { name: "tests", status: "not-run", detail: "" }])).toBe("BLOCKED");
    expect(overallStatus([{ name: "typecheck", status: "failed", detail: "" }, { name: "tests", status: "passed", detail: "" }])).toBe("FAILED");
    expect(overallStatus([{ name: "typecheck", status: "passed", detail: "" }])).toBe("NOT_RUN");
    expect(overallStatus([{ name: "tests", status: "not-run", detail: "" }])).toBe("NOT_RUN");
  });
  it("is BLOCKED when the base URL is missing or unreachable, and runs tests when it answers", async () => {
    const r = tmp();
    write(r, "tests/api/a.spec.ts", "x");
    gitInit(r);
    const c = config({ tests: { api: { framework: "other", dir: "tests/api", helpersDir: "src/api", runCommand: "node -e 'process.exit(0)' --" } }, verification: { typecheck: "never" } });
    const changes = [{ path: "tests/api/a.spec.ts", status: "M" }];
    const missing = await verifyChanges({ cwd: r, c, changes, runDir: tmp(), env: { PATH: process.env.PATH } });
    expect(missing.status).toBe("BLOCKED");
    const down = await verifyChanges({ cwd: r, c, changes, runDir: tmp(), env: { PATH: process.env.PATH, QA_BASE_URL: "http://127.0.0.1:1" } });
    expect(down.status).toBe("BLOCKED");
    const server = http.createServer((_q, s) => s.end("ok")).listen(0);
    const port = (server.address() as any).port;
    try {
      const up = await verifyChanges({ cwd: r, c, changes, runDir: tmp(), env: { PATH: process.env.PATH, QA_BASE_URL: `http://127.0.0.1:${port}` } });
      expect(up.status).toBe("VERIFIED");
      const failing = config({ tests: { api: { framework: "other", dir: "tests/api", helpersDir: "src/api", runCommand: "node -e 'process.exit(3)' --" } }, verification: { typecheck: "never" } });
      const bad = await verifyChanges({ cwd: r, c: failing, changes, runDir: tmp(), env: { PATH: process.env.PATH, QA_BASE_URL: `http://127.0.0.1:${port}` } });
      expect(bad.status).toBe("FAILED");
    } finally {
      server.close();
    }
  });
  it("lists fixme/skip tests with their QA-AGENT note as unresolved discrepancies", () => {
    const r = tmp();
    write(r, "tests/api/o.spec.ts", "test('old', () => {});\n");
    gitInit(r);
    const start = sh(r, "rev-parse", "HEAD").trim();
    write(r, "tests/api/o.spec.ts", "test('old', () => {});\n// QA-AGENT: AC-3 expects 409 on 4th order; service allows 5\ntest.fixme('returns 409 for the 4th order @story:SHOP-42', async () => {});\n");
    const d = findDiscrepancies(r, start, workingChanges(r));
    expect(d).toEqual([{ file: "tests/api/o.spec.ts", test: "returns 409 for the 4th order", note: "AC-3 expects 409 on 4th order; service allows 5" }]);
  });
  it("keeps a QA-AGENT note that spans several comment lines", () => {
    const r = tmp();
    write(r, "tests/api/p.spec.ts", "test('old', () => {});\n");
    gitInit(r);
    const start = sh(r, "rev-parse", "HEAD").trim();
    write(r, "tests/api/p.spec.ts", "test('old', () => {});\n// QA-AGENT: AC-2 says total refunds never exceed the authorised amount,\n// but the service only checks each refund on its own | see server.js:26\ntest.fixme('cumulative refunds over the amount return 422', async () => {});\n");
    const [d] = findDiscrepancies(r, start, workingChanges(r));
    expect(d.note).toBe("AC-2 says total refunds never exceed the authorised amount, but the service only checks each refund on its own \\| see server.js:26");
  });
});

describe("runner limits and publishing", () => {
  it("kills a process that exceeds its timeout", async () => {
    const r = await runProcess("node", ["-e", "setTimeout(()=>{}, 60000)"], { cwd: process.cwd(), env: process.env, timeoutMs: 300 });
    expect(r.timedOut).toBe(true);
    expect(r.durationMs).toBeLessThan(5000);
  });
  it("maps Claude result subtypes", () => {
    expect(statusFromJson({ subtype: "success" }, 0)).toBe("ok");
    expect(statusFromJson({ subtype: "error_max_turns", is_error: true }, 1)).toBe("max-turns");
    expect(statusFromJson({ subtype: "error_max_budget_usd" }, 1)).toBe("max-budget");
    expect(statusFromJson({ subtype: "success", is_error: true }, 0)).toBe("error");
  });
  it("builds a one-off push URL and never for numeric project ids", () => {
    expect(pushUrl("https://gitlab.example.com", "grp/qa-tests", { QA_SENTINEL_GITLAB_TOKEN: "t/k" })).toBe("https://oauth2:t%2Fk@gitlab.example.com/grp/qa-tests.git");
    expect(pushUrl("https://gitlab.example.com", "123", { QA_SENTINEL_GITLAB_TOKEN: "t" })).toBeUndefined();
    expect(pushUrl("https://gitlab.example.com", "grp/x", {})).toBeUndefined();
  });
  it("MR description puts verified facts first and labels agent claims", () => {
    const md = mrDescription({
      service: "orders",
      sha: "abcdef1234567890",
      version: "0.1.1",
      requirements: { schemaVersion: 1, source: "none", acceptanceCriteria: [], approvalStatus: "missing", rawText: "", capturedAt: "" },
      verification: { status: "BLOCKED", checks: [{ name: "preflight", status: "blocked", detail: "QA_BASE_URL is not set" }], specs: [], cases: [], counts: { total: 0, passed: 0, failed: 0, skipped: 0 } },
      findings: [],
      discrepancies: [{ file: "a.spec.ts", test: "cap", note: "AC-3" }],
      agentSummary: "All 9 tests pass!",
      usage: "",
      runId: "r1",
    });
    expect(md.indexOf("⛔ BLOCKED")).toBeLessThan(md.indexOf("All 9 tests pass!"));
    expect(md).toContain("Unresolved product discrepancies (1");
    expect(md).toContain("superseded by the verification table");
    expect(md).toContain("Requirements:** none found");
  });
});
