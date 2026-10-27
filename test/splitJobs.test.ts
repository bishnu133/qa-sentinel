import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import { spawnSync } from "node:child_process";
import { initCommand } from "../src/commands/init.js";

const made: string[] = [];
afterEach(() => made.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

async function rendered(level: "maintenance" | "intelligence" = "maintenance") {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "qas-split-"));
  made.push(repo);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  await initCommand({ cwd: repo, yes: true, mode: "scratch", ci: "gitlab", level, name: "t" });
  const read = (f: string) => YAML.parse(fs.readFileSync(path.join(repo, "ci/qa-sentinel", f), "utf8"), { logLevel: "error" });
  return { tests: read("tests.gitlab-ci.yml"), service: read("service.gitlab-ci.yml") };
}
const scriptOf = (job: { script: unknown[] }) => job.script.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join("\n");

describe("split CI jobs (opt-in QA_SPLIT_JOBS)", () => {
  it("the test repo template has an analysis job with a read token and a publish job with the write token and no model key", async () => {
    const { tests } = await rendered();
    const gen = scriptOf(tests["qa-generate"]);
    // Default form is unchanged: one job pushes. The split form defers publishing and uses only the read token.
    expect(gen).toContain('QA_PUBLISH_ARG="--push"');
    expect(gen).toContain('QA_PUBLISH_ARG="--defer-publish"');
    expect(gen).toContain('QA_SENTINEL_GITLAB_TOKEN="${QA_SENTINEL_GITLAB_READ_TOKEN:?');
    expect(gen).toMatch(/unset QA_SENTINEL_GITLAB_WRITE_TOKEN/);
    expect(gen).toContain("claude-code"); // the analysis job installs the agent runtime

    const pub = tests["qa-generate-publish"];
    expect(pub.needs).toEqual([{ job: "qa-generate", artifacts: true }]);
    expect(pub.rules.some((r: { if: string }) => r.if.includes('$QA_SPLIT_JOBS == "true"'))).toBe(true);
    const ps = scriptOf(pub);
    expect(ps).toContain("qa-sentinel publish --kind generate --run all");
    expect(ps).toContain('QA_SENTINEL_GITLAB_TOKEN="${QA_SENTINEL_GITLAB_WRITE_TOKEN:?');
    expect(ps).toMatch(/unset ANTHROPIC_API_KEY/);
    expect(ps).not.toContain("claude-code"); // no agent runtime in the publish job
    expect(ps).not.toMatch(/\$\{?ANTHROPIC_API_KEY/); // the model key is never used there
    expect(pub.artifacts).toBeUndefined();
  });
  it("the service template has the same split for the gap report", async () => {
    const { service } = await rendered();
    const gap = scriptOf(service["qa-gap-report"]);
    expect(gap).toContain('QA_POST_ARG="--defer-publish"');
    expect(gap).toContain('QA_POST_ARG="--post"');
    expect(service["qa-gap-report"].artifacts.paths).toContain("qa-runs/");
    const pub = service["qa-gap-report-publish"];
    expect(pub.needs).toEqual([{ job: "qa-gap-report", artifacts: true }]);
    const ps = scriptOf(pub);
    expect(ps).toContain('publish --kind gap-report --run all');
    expect(ps).toMatch(/unset ANTHROPIC_API_KEY/);
    expect(ps).not.toContain("claude-code");
  });
  it("the analysis job has its own after_script: it sources nothing from the work tree in split mode and drops the publish secrets (an unset in script does not reach after_script)", async () => {
    const { tests } = await rendered();
    const gen = tests["qa-generate"];
    expect(Array.isArray(gen.after_script)).toBe(true);
    const after = gen.after_script.filter((x: unknown) => typeof x === "string") as string[];
    const block = after.find((x) => x.includes('sed -n'))!;
    expect(block).toMatch(/unset [^\n]*QA_SENTINEL_GITLAB_WRITE_TOKEN/);
    // The work-tree file is never sourced, in either mode: it is read through the same whitelist sed.
    expect(block).not.toMatch(/(^|\s)\.\s+"?\$CI_PROJECT_DIR\/\.qa-env\.sh/);
    expect(block).not.toContain("elif");
    expect(block).toContain("sed -n");
    const nodeAfter = (tests[".qa-node"].after_script as unknown[]).filter((x) => typeof x === "string").join("\n");
    expect(nodeAfter).toContain("sed -n");
    expect(nodeAfter).not.toMatch(/(^|\s)\.\s+"?\$CI_PROJECT_DIR\/\.qa-env\.sh/);
    // Both after_script blocks drop every write and model secret first, in either mode, before anything of the work tree is read or run.
    const SECRETS = ["QA_SENTINEL_GITLAB_TOKEN", "QA_SENTINEL_GITLAB_WRITE_TOKEN", "QA_JIRA_PUBLISH_PAT", "JIRA_PAT", "JIRA_API_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "AWS_SECRET_ACCESS_KEY", "CLAUDE_CODE_USE_BEDROCK", "CI_JOB_TOKEN"];
    const nodeBlock = (tests[".qa-node"].after_script as unknown[]).find((x) => typeof x === "string" && x.includes("sed -n")) as string;
    for (const b of [block, nodeBlock]) {
      expect(b.indexOf("unset ")).toBeGreaterThanOrEqual(0);
      expect(b.indexOf("unset ")).toBeLessThan(b.indexOf("sed -n"));
      const penv = Object.fromEntries(SECRETS.map((k) => [k, "secret"]));
      const probe = spawnSync("sh", ["-c", `${b}\nenv`], { encoding: "utf8", env: { PATH: process.env.PATH, CI_PROJECT_DIR: os.tmpdir(), ...penv } });
      for (const k of SECRETS) expect(probe.stdout, k).not.toContain(`${k}=`);
    }
    // Run it for real: a hostile .qa-env.sh (written by generated code) is not executed, and the write token is gone.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qas-after-"));
    made.push(dir);
    const marker = path.join(dir, "pwned");
    fs.writeFileSync(path.join(dir, ".qa-env.sh"), `touch ${marker}\nexport QA_BASE_URL='https://qa.example'; touch ${marker}\n`);
    const url = /export (\w+)="\$qa_url"/.exec(block)![1];
    const r = spawnSync("sh", ["-c", `${block}\necho "token=\${QA_SENTINEL_GITLAB_WRITE_TOKEN:-gone} jira=\${QA_JIRA_PUBLISH_PAT:-gone} url=\${${url}:-none}"`], { encoding: "utf8", env: { PATH: process.env.PATH, CI_PROJECT_DIR: dir, QA_SPLIT_JOBS: "true", QA_SENTINEL_GITLAB_WRITE_TOKEN: "w", QA_JIRA_PUBLISH_PAT: "p" } });
    expect(fs.existsSync(marker)).toBe(false);
    expect(r.stdout.trim()).toBe("token=gone jira=gone url=none");
    // A well-formed line is read as text (not executed).
    fs.writeFileSync(path.join(dir, ".qa-env.sh"), `export ${url}='https://qa.example/x'\n`);
    const ok = spawnSync("sh", ["-c", `${block}\necho "url=\${${url}:-none}"`], { encoding: "utf8", env: { PATH: process.env.PATH, CI_PROJECT_DIR: dir, QA_SPLIT_JOBS: "true" } });
    expect(ok.stdout.trim()).toBe("url=https://qa.example/x");
    // The same in the ordinary (non-split) mode: still text, still not executed.
    fs.writeFileSync(path.join(dir, ".qa-env.sh"), `touch ${marker}\nexport ${url}='https://qa.example/y'\n`);
    const plain = spawnSync("sh", ["-c", `${block}\necho "url=\${${url}:-none}"`], { encoding: "utf8", env: { PATH: process.env.PATH, CI_PROJECT_DIR: dir } });
    expect(plain.stdout.trim()).toBe("url=https://qa.example/y");
    expect(fs.existsSync(marker)).toBe(false);
  });
  it("publish jobs run one at a time, in their own environment, with full history, and pick the Jira publishing login themselves", async () => {
    const { tests, service } = await rendered();
    expect(tests["qa-generate-publish"].resource_group).toBe("qa-sentinel-generate");
    expect(tests["qa-generate-publish"].variables.GIT_DEPTH).toBe(0);
    expect(service["qa-gap-report-publish"].resource_group).toContain("qa-gap-report-publish");
    expect(service["qa-gap-report-publish"].resource_group).toContain("$CI_MERGE_REQUEST_IID");
    for (const [job, env] of [[tests["qa-generate-publish"], "qa-publish"], [service["qa-gap-report-publish"], "qa-publish"], [tests["qa-generate"], "qa-analysis"], [service["qa-gap-report"], "qa-analysis"]] as const) expect(job.environment).toMatchObject({ name: env, action: "prepare" });
    for (const job of [tests["qa-generate-publish"], service["qa-gap-report-publish"]]) expect(scriptOf(job)).not.toMatch(/export JIRA_(PAT|API_TOKEN|EMAIL)=/);
  });
  it("nothing changes at the intelligence level for the default (non-split) gap report job", async () => {
    const { service, tests } = await rendered("intelligence");
    expect(scriptOf(service["qa-gap-report"])).toContain('QA_POST_ARG="--post"');
    expect(tests["qa-generate-publish"]).toBeUndefined(); // there is no generation at this level
  });
});
