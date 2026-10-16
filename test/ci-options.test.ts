import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { ConfigSchema } from "../src/config.js";
import { skippedBranch } from "../src/requirements.js";
import { initCommand } from "../src/commands/init.js";

const cfg = (skipBranches?: string[]) =>
  ConfigSchema.parse({ version: 1, mode: "scratch", project: { name: "p" }, tests: { api: { framework: "playwright", runCommand: "x" } }, ci: { platform: "gitlab", ...(skipBranches ? { skipBranches } : {}) } });

describe("skipping dependency-bot changes (ci.skipBranches)", () => {
  it("matches branch names and merge-commit messages, never ordinary text", () => {
    const c = cfg();
    expect(skippedBranch(c, "renovate/lodash-4.x")).toBe("renovate/lodash-4.x");
    expect(skippedBranch(c, "Merge branch 'dependabot/npm_and_yarn/axios-1.7.4' into 'main'")).toBe("dependabot/npm_and_yarn/axios-1.7.4");
    expect(skippedBranch(c, "feature/SHOP-12-renovate-cart")).toBeUndefined();
    expect(skippedBranch(c, "fix: bump renovate/ config docs")).toBeUndefined();
    expect(skippedBranch(cfg([]), "renovate/x")).toBeUndefined();
    expect(skippedBranch(cfg(["^chore/deps-"]), "chore/deps-weekly")).toBe("chore/deps-weekly");
  });

  it("renders GitLab rules for it, and the option to generate after deployment instead of the merge", async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "qas-ci-"));
    execFileSync("git", ["init", "-q"], { cwd: repo });
    await initCommand({ cwd: repo, yes: true, mode: "scratch", ci: "gitlab", level: "maintenance", name: "t" });
    const y = YAML.parse(fs.readFileSync(path.join(repo, "ci/qa-sentinel/service.gitlab-ci.yml"), "utf8"));
    expect(y["qa-gap-report"].rules[0]).toEqual({ if: "$CI_MERGE_REQUEST_SOURCE_BRANCH_NAME =~ /^renovate\\/|^dependabot\\//", when: "never" });
    const gen = y["qa-trigger-generation"];
    expect(gen.extends).toBe(".qa-trigger-generation");
    expect(gen.rules[0]).toEqual({ if: '$QA_GENERATE_AFTER == "deploy"', when: "never" });
    expect(gen.rules[1].if).toBe("$CI_COMMIT_MESSAGE =~ /Merge branch '(?:renovate\\/|dependabot\\/)/");
    expect(y[".qa-trigger-generation"].trigger.project).toBe("$QA_TESTS_PROJECT");
  });
});
