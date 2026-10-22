import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";
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
    expect(ps).toContain("qa-sentinel publish --run all");
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
    expect(ps).toContain('publish --run all');
    expect(ps).toMatch(/unset ANTHROPIC_API_KEY/);
    expect(ps).not.toContain("claude-code");
  });
  it("nothing changes at the intelligence level for the default (non-split) gap report job", async () => {
    const { service, tests } = await rendered("intelligence");
    expect(scriptOf(service["qa-gap-report"])).toContain('QA_POST_ARG="--post"');
    expect(tests["qa-generate-publish"]).toBeUndefined(); // there is no generation at this level
  });
});
