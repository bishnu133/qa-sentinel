#!/usr/bin/env node
import { Command, Option } from "commander";
import { initCommand } from "./commands/init.js";
import { learnCommand } from "./commands/learn.js";
import { doctorCommand } from "./commands/doctor.js";
import { gapReportCommand } from "./commands/gapReport.js";
import { generateCommand } from "./commands/generate.js";
import { traceCommand } from "./commands/trace.js";
import { showcaseCommand } from "./commands/showcase.js";
import { featureCommand } from "./commands/feature.js";
import { verifyCommand } from "./commands/verify.js";
import { VERSION } from "./run.js";
import { log } from "./log.js";
import { API_FRAMEWORKS } from "./config.js";

const program = new Command();
program
  .name("qa-sentinel")
  .description("AI QA agents for your test repo: gap reports and API test generation from dev changes.")
  .version(VERSION)
  .option("-C, --cwd <dir>", "test repository root", process.cwd());

const cwd = () => program.opts().cwd as string;
const wrap =
  <A extends unknown[]>(fn: (...args: A) => Promise<unknown> | unknown) =>
  async (...args: A) => {
    try {
      const r = await fn(...args);
      if (typeof r === "number") process.exitCode = r;
    } catch (e) {
      log.fail((e as Error).message);
      process.exitCode = 1;
    }
  };

program
  .command("init")
  .description("set up qa-sentinel in this test repo (existing project or from scratch)")
  .addOption(new Option("--mode <mode>", "existing | scratch").choices(["existing", "scratch"]))
  .addOption(new Option("--ci <platform>", "gitlab | jenkins").choices(["gitlab", "jenkins"]))
  .addOption(new Option("--level <level>", "intelligence (read-only, default) | maintenance (also generate tests)").choices(["intelligence", "maintenance"]))
  .addOption(new Option("--api-framework <name>").choices([...API_FRAMEWORKS]))
  .option("--workspace <dir>", "folder containing the service repos", "..")
  .option("--name <name>", "project name")
  .option("-y, --yes", "accept detected defaults, no prompts")
  .option("--force", "overwrite generated files")
  .action(
    wrap(async (o) => {
      await initCommand({ cwd: cwd(), ...o });
    }),
  );

program
  .command("learn")
  .description("agent pass: learn test conventions and draft test-map.yaml (review the diff)")
  .option("--dry-run", "print the Claude command instead of running it")
  .action(wrap(async (o) => learnCommand({ cwd: cwd(), dryRun: o.dryRun })));

program
  .command("doctor")
  .description("check configuration, access and agent readiness")
  .option("--online", "also call GitLab to check the token can reach the test and service projects")
  .action(wrap(async (o) => doctorCommand(cwd(), { online: o.online })));

program
  .command("gap-report")
  .description("Phase 1: analyse a service change and report impacted tests, gaps and AC mismatches")
  .requiredOption("-s, --service <name|path>", "service name from the config, or a path to its repo")
  .option("--service-path <dir>", "override where the service repo is checked out (useful in CI)")
  .option("--base <ref>", "base ref (default: MR diff base in CI, else origin/<targetBranch>)")
  .option("--head <ref>", "head ref", "HEAD")
  .option("--checkout", "check out the head commit in the service repo if it is not already there (CI)")
  .option("--story-file <file>", "file with the story / acceptance criteria")
  .option("-o, --out <file>", "where to write the report", "qa-gap-report.md")
  .option("--post", "post or update the report as a GitLab MR comment")
  .option("--dry-run", "do everything except call Claude")
  .action(wrap(async (o) => (await gapReportCommand({ cwd: cwd(), ...o })).exitCode));

program
  .command("generate")
  .description("Phase 2: add or update API tests for a service change and commit them on a branch")
  .requiredOption("-s, --service <name|path>", "service name from the config, or a path to its repo")
  .option("--service-path <dir>", "override where the service repo is checked out (useful in CI)")
  .option("--base <ref>", "base ref in the service repo", "HEAD~1")
  .option("--head <ref>", "head ref in the service repo", "HEAD")
  .option("--checkout", "check out the head commit in the service repo if it is not already there (CI)")
  .option("--story-file <file>", "file with the story / acceptance criteria")
  .option("--push", "push the branch and open a GitLab merge request")
  .option("--env <name>", "run the tests against this environment from `environments:` (e.g. dev, sit) before pushing")
  .option("--dry-run", "do everything except call Claude and commit")
  .action(wrap(async (o) => generateCommand({ cwd: cwd(), ...o })));

program
  .command("trace")
  .description("requirement traceability from test tags: which tests prove which acceptance criteria, and test-map.yaml consistency")
  .option("--story <key>", "story key, e.g. SHOP-102")
  .option("--story-file <file>", "story with acceptance criteria (otherwise the ACs claimed by the tests are listed)")
  .option("--json", "print the full index as JSON")
  .action(wrap(async (o) => traceCommand({ cwd: cwd(), ...o })));

program
  .command("feature <story>")
  .description("one story across services: which changes are merged and deployed, AC coverage, and (--run) the story's end-to-end tests once all parts are deployed")
  .option("--env <name>", "environment to check deployments in (from `environments:`)")
  .option("--story-file <file>", "acceptance criteria from a file instead of Jira")
  .option("--run", "run the story's tests when every part is deployed")
  .option("--force", "with --run: run even if not every part is deployed")
  .option("--post", "post the feature status on the Jira story")
  .option("--json", "print the manifest as JSON")
  .action(wrap(async (story, o) => featureCommand({ cwd: cwd(), story, ...o })));

program
  .command("showcase")
  .description("after a test run: attach evidence to each story whose acceptance criteria all passed (once per story)")
  .option("--story <key...>", "only these stories (default: every story tagged in the tests)")
  .option("--story-file <file>", "acceptance criteria from a file instead of Jira (one story)")
  .option("--results <file>", "test results with attachments (default: test-results/results.json, else junit.xml)")
  .option("--env <name>", "environment the run used, shown on the story")
  .option("--force", "attach again even if this story was already showcased")
  .option("--dry-run", "assess and list the files, attach nothing")
  .option("-o, --out <file>", "summary file", "qa-showcase.md")
  .action(wrap(async (o) => showcaseCommand({ cwd: cwd(), ...o })));

program
  .command("verify")
  .description("independent checks on changed tests (policy, type-check, lint, changed specs); exit 0 only when VERIFIED")
  .option("--base <ref>", "compare with this ref (default: MR diff base in CI, else origin/<targetBranch>)")
  .option("--policy", "also enforce the agent write policy (use on qa-sentinel/* branches)")
  .option("-o, --out <file>", "write the verification summary (markdown) here")
  .option("--env <name>", "run against this environment from `environments:`")
  .action(wrap(async (o) => verifyCommand({ cwd: cwd(), ...o })));

program.parseAsync();
