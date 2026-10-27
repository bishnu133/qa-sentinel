#!/usr/bin/env node
import { postDeployCommand } from "./commands/postDeploy.js";
import { discoverCommand } from "./commands/discover.js";
import { coverageCommand } from "./commands/coverage.js";
import { backfillCommand } from "./commands/backfill.js";
import { dataStatusCommand, dataSweepCommand } from "./commands/data.js";
import { contractCheckCommand } from "./commands/contractCheck.js";
import { ClaudeAccessError } from "./claude.js";
import { Command, Option } from "commander";
import { addDataLedgerCommand, addMobileCommand, addWebCommand, initCommand, upgradeCommand } from "./commands/init.js";
import { mobileRunCommand } from "./commands/mobileRun.js";
import { healedCommand } from "./commands/healed.js";
import { specCommand } from "./commands/spec.js";
import { storiesCommand } from "./commands/stories.js";
import { reviewStoryCommand } from "./commands/reviewStoryCmd.js";
import { bugsCommand } from "./commands/bugs.js";
import { knownDefectsCommand } from "./commands/knownDefects.js";
import { tagCommand } from "./commands/tag.js";
import { metricsCommand } from "./commands/metrics.js";
import { publishCommand } from "./commands/publish.js";
import { storyCheckCommand } from "./commands/storyCheck.js";
import { lessonsCommand } from "./commands/lessons.js";
import { learnCommand } from "./commands/learn.js";
import { doctorCommand } from "./commands/doctor.js";
import { gapReportCommand } from "./commands/gapReport.js";
import { generateCommand } from "./commands/generate.js";
import { traceCommand } from "./commands/trace.js";
import { showcaseCommand } from "./commands/showcase.js";
import { featureCommand } from "./commands/feature.js";
import { hotfixCommand } from "./commands/hotfix.js";
import { suiteCommand } from "./commands/suite.js";
import { releaseFeaturesCommand } from "./commands/releaseFeatures.js";
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
/** gap-report/generate need either a service or --story. */
function needService<T extends { service?: string; story?: string }>(o: T): T & { service: string } {
  if (!o.service && !o.story) throw new Error("pass --service <name> (one service change) or --story <KEY> (everything a story changed)");
  return { ...o, service: o.service ?? "" };
}
const wrap =
  <A extends unknown[]>(fn: (...args: A) => Promise<unknown> | unknown) =>
  async (...args: A) => {
    try {
      const r = await fn(...args);
      if (typeof r === "number") process.exitCode = r;
    } catch (e) {
      log.fail((e as Error).message);
      // 3 = Claude can't be used at all (no credentials, no credit, key not allowed): callers can stop early.
      process.exitCode = e instanceof ClaudeAccessError ? 3 : 1;
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
  .option("--web", "also set up web (Playwright UI) tests: page objects, ui helper, fixtures")
  .option("--mobile", "also set up mobile (WebdriverIO + Appium) tests: screen objects, ui helper, evidence hooks")
  .addOption(new Option("--requirements <source>", "where stories come from").choices(["jira", "mr-description", "none"]))
  .option("--jira-url <url>", "Jira site, e.g. https://yourco.atlassian.net")
  .option("--jira-projects <keys>", "Jira project keys this repo covers, comma-separated (PAY,CARD)", (v) => v.split(/[\s,]+/).map((k) => k.trim().toUpperCase()).filter(Boolean))
  .option("--gitlab-url <url>", "GitLab URL (self-hosted or https://gitlab.com)")
  .option("--test-repo-project <path>", "this test repo's GitLab project path, e.g. group/qa-tests")
  .option("-y, --yes", "accept detected defaults, no prompts")
  .option("--force", "overwrite generated files")
  .action(
    wrap(async (o) => {
      await initCommand({ cwd: cwd(), ...o });
    }),
  );

program
  .command("upgrade")
  .description("after updating qa-sentinel: refresh its agents, skills, CI templates and project context (keeps your learned conventions)")
  .action(wrap(async () => upgradeCommand({ cwd: cwd() })));

program
  .command("add-web")
  .description("add the web (Playwright UI) test layer to an existing qa-sentinel project")
  .addOption(new Option("--healing <mode>", "none | bubblegum (runtime locator healing in scheduled runs)").choices(["none", "bubblegum"]))
  .action(wrap(async (o) => void addWebCommand({ cwd: cwd(), healing: o.healing })));

program
  .command("add-data-ledger")
  .description("existing projects: track the test data tests create and delete it afterwards (writes ledger.ts, sets testData.cleanup: ledger)")
  .option("--dir <dir>", "where to write ledger.ts (default: your data/fixtures folder, else the API helpers folder)")
  .action(wrap(async (o) => void addDataLedgerCommand({ cwd: cwd(), dir: o.dir })));

program
  .command("add-mobile")
  .description("add the mobile (WebdriverIO + Appium) test layer to an existing qa-sentinel project")
  .addOption(new Option("--platform <platform>", "android | ios (default when QA_MOBILE_PLATFORM is not set)").choices(["android", "ios"]))
  .action(wrap(async (o) => void addMobileCommand({ cwd: cwd(), platform: o.platform })));

program
  .command("mobile-run")
  .description("run the mobile suite with a target from tests.mobile.targets (iOS, a device farm): your command, no vendor API; no AI")
  .requiredOption("--target <name>", "a key of tests.mobile.targets")
  .option("--spec <file...>", "only these spec files (default: all)")
  .option("--dry-run", "show the command, run nothing")
  .action(wrap(async (o) => mobileRunCommand(cwd(), { target: o.target, specs: o.spec, dryRun: o.dryRun })));

program
  .command("review-story")
  .description("review a story before development: ambiguous ACs, missing negative/edge cases, scope without an AC")
  .option("--story <key>", "Jira story key")
  .option("--story-file <path>", "story as a markdown file")
  .option("--post", "post the review as a comment on the Jira story (updated in place)")
  .option("-o, --out <file>", "markdown output", "qa-story-review.md")
  .option("--dry-run", "prepare the inputs without calling the agent")
  .action(wrap(async (o) => reviewStoryCommand({ cwd: cwd(), story: o.story, storyFile: o.storyFile, post: o.post, out: o.out, dryRun: o.dryRun })));

program
  .command("spec")
  .description("write or update expected/<STORY>.md: what each AC means in testable terms, from the story alone (code-blind)")
  .option("--story <key>", "Jira story key")
  .option("--story-file <path>", "story as a markdown file")
  .option("--commit", "commit the file on the current branch")
  .option("--dry-run", "prepare the inputs without calling the agent")
  .option("--force", "run even if the same job (same ACs) finished, failed too often or looks to be running; budgets still apply")
  .option("--once", "skip the AI run if the same job already finished (the default in CI)")
  .action(wrap(async (o) => specCommand({ cwd: cwd(), story: o.story, storyFile: o.storyFile, commit: o.commit, dryRun: o.dryRun, force: o.force, once: o.once })));

program
  .command("stories")
  .description("background check, no AI: for each story, what it needs next (expected behaviour, tests, QA triage) and who does it")
  .option("--story <key...>", "these Jira stories (default: search Jira, see requirements.jira.search)")
  .option("--stories-dir <dir>", "read stories from markdown files in this folder instead of Jira")
  .option("--all", "also list the stories that are left alone (opted out, not approved, not a feature)")
  .option("--json", "print JSON (state, next step, tasks per story) for a pipeline to act on")
  .option("--no-record", "don't update the story records")
  .option("--no-sweep", "don't look at merge requests first (GitLab)")
  .option("--rebuild", "fill the story records again from GitLab and Jira (the merge request sweep looks back 365 days)")
  .option("--act", "also start the AI steps that are due (expected behaviour, tests, end-to-end tests), at most automation.act.maxJobsPerCheck; exit 4 if a limit stopped one")
  .option("--dry-run", "with --act: say what would be started and start nothing")
  .option("--clone-services", "clone the service repositories (workspace.services[].gitlabProject) that are not at their path yet, using CI_JOB_TOKEN or the GitLab token (for a CI job that starts with the test repo only)")
  .option("-o, --out <file>", "markdown output", "qa-stories.md")
  .action(wrap(async (o) => storiesCommand({ cwd: cwd(), story: o.story, storiesDir: o.storiesDir, all: o.all, json: o.json, noRecord: o.record === false, noSweep: o.sweep === false, rebuild: o.rebuild, act: o.act, dryRun: o.dryRun, cloneServices: o.cloneServices, out: o.out })));

program
  .command("known-defects")
  .description("no AI: find known-defect tests (test.fail + QA-BUG) that now pass because the bug is fixed; --apply takes the markers off")
  .option("--results <file>", "Playwright JSON report", "test-results/results.json")
  .option("--apply", "edit the test files (test.fail -> test, remove QA-BUG / QA-AGENT note lines)")
  .option("--commit", "also commit on a new branch (needs --apply)")
  .option("--push", "also push and open a merge request (needs --commit)")
  .option("--branch <name>", "branch for --commit")
  .action(wrap(async (o) => knownDefectsCommand({ cwd: cwd(), results: o.results, apply: o.apply, commit: o.commit, push: o.push, branch: o.branch })));

program
  .command("bugs")
  .description("after a suite run: raise a bug per story requirement whose tests fail (bugs.mode), once; note fixes on earlier bugs")
  .option("--story <key...>", "only these stories")
  .option("--results <file>", "Playwright JSON report", "test-results/results.json")
  .option("--env <name>", "environment the run used")
  .option("--dry-run", "list what would be raised")
  .action(wrap(async (o) => bugsCommand({ cwd: cwd(), story: o.story, results: o.results, env: o.env, dryRun: o.dryRun })));

program
  .command("tag")
  .description("one-off: add @service/@endpoint/@page tags to existing tests (only titles change; checked) on a branch")
  .option("--push", "push the branch and open a merge request")
  .option("--limit <n>", "at most this many tests", (v) => Number(v))
  .option("--dry-run", "list the untagged tests")
  .action(wrap(async (o) => tagCommand({ cwd: cwd(), push: o.push, limit: o.limit, dryRun: o.dryRun })));

program
  .command("post-deploy")
  .description("after a deployment: for each story it touches, check every service is deployed, run the story's tests there, report (and re-check later)")
  .requiredOption("--env <name>", "environment from `environments:` that was deployed to")
  .option("--story <key...>", "these stories")
  .option("--service <name>", "the service just deployed (its stories come from its commits)")
  .option("--service-path <path>", "where that service is checked out (CI)")
  .option("--sha <sha>", "the deployed commit of --service")
  .option("--before <sha>", "the commit deployed before it (only stories in between count)")
  .option("--wait <minutes>", "keep checking this long while a part isn't deployed yet", (v) => Number(v))
  .option("--mrs", "also re-verify open agent MRs that were waiting for deployment (GitLab)")
  .option("--post", "comment the results on the Jira stories")
  .option("-o, --out <file>", "markdown report", "qa-post-deploy.md")
  .action(
    wrap(async (o) => postDeployCommand({ cwd: cwd(), env: o.env, stories: o.story, service: o.service, servicePath: o.servicePath, sha: o.sha, before: o.before, waitMinutes: o.wait, mrs: o.mrs, post: o.post, out: o.out })),
  );

program
  .command("discover")
  .description("list a GitLab group's projects and draft service entries: kind, OpenAPI spec, dependencies with evidence")
  .requiredOption("--gitlab-group <group>", "group path or id, e.g. acme/platform")
  .option("--no-subgroups", "only the group itself")
  .option("--limit <n>", "at most this many projects", (v) => Number(v))
  .option("--apply", "add the services not configured yet to qa-sentinel.config.yaml")
  .option("-o, --out <file>", "draft YAML (a .md with the evidence next to it)", "qa-services.draft.yaml")
  .action(wrap(async (o) => discoverCommand({ cwd: cwd(), group: o.gitlabGroup, subgroups: o.subgroups, limit: o.limit, apply: o.apply, out: o.out })));

program
  .command("coverage")
  .description("every endpoint (and page) with the tests that exercise it; untested ones ranked by risk (no agent, no cost)")
  .option("--service <name>", "only this service")
  .option("--service-path <path>", "where that service is checked out (CI)")
  .option("--json", "print the result as JSON")
  .option("-o, --out <file>", "markdown output (a .json next to it)", "qa-coverage.md")
  .action(wrap(async (o) => coverageCommand({ cwd: cwd(), service: o.service, servicePath: o.servicePath, json: o.json, out: o.out })));

program
  .command("backfill")
  .description("write tests for the riskiest untested endpoints of a service, a small reviewed batch per run")
  .requiredOption("--service <name>", "service from qa-sentinel.config.yaml")
  .option("--service-path <path>", "service checkout (CI)")
  .option("--batch <n>", "endpoints per run (one MR)", (v) => Number(v), 5)
  .addOption(new Option("--min-risk <level>", "only gaps at this risk or above").choices(["low", "medium", "high", "critical"]))
  .option("--include-weak", "also endpoints whose tests only check the status or are all fixme/skip")
  .option("--endpoint <endpoint...>", 'exactly these, e.g. "POST /orders"')
  .option("--checkout", "check the service out at its current commit if needed")
  .option("--push", "push the branch and open a merge request")
  .option("--env <name>", "environment from `environments` to verify against")
  .option("--dry-run", "show the batch without generating")
  .action(
    wrap(async (o) =>
      backfillCommand({ cwd: cwd(), service: o.service, servicePath: o.servicePath, batch: o.batch, minRisk: o.minRisk, includeWeak: o.includeWeak, endpoints: o.endpoint, checkout: o.checkout, push: o.push, env: o.env, dryRun: o.dryRun }),
    ),
  );

const data = program.command("data").description("test data the tests created (testData.cleanup: ledger)");
data
  .command("status")
  .description("list records the tests created and haven't deleted yet")
  .option("--older-than <minutes>", "only records from runs idle this long", (v) => Number(v))
  .action(wrap(async (o) => dataStatusCommand({ cwd: cwd(), olderThan: o.olderThan })));
data
  .command("sweep")
  .description("delete what killed runs left behind, newest first, on the test environment")
  .option("--dry-run", "list what would be deleted")
  .option("--older-than <minutes>", "skip runs active in the last N minutes, which may still use their data (default 30; 0 right after your own run)", (v) => Number(v))
  .option("-o, --out <file>", "markdown report")
  .option("--config-from <file>", "read the config from this file (CI: the pipeline's own commit) instead of the work tree")
  .action(wrap(async (o) => dataSweepCommand({ cwd: cwd(), dryRun: o.dryRun, olderThan: o.olderThan, out: o.out, configFrom: o.configFrom })));

program
  .command("contract-check")
  .description("spec-first: check each service's implemented OpenAPI spec against its agreed spec (`contract`), every endpoint")
  .option("--service <name>", "only this service")
  .option("--service-path <path>", "where that service is checked out (CI)")
  .option("--story <key>", "Jira story (for contracts attached to the story)")
  .option("--ref <ref>", "service commit, branch or tag to check", "HEAD")
  .option("--strict", "exit 1 on any mismatch (CI gate)")
  .option("--json", "print the result as JSON")
  .option("-o, --out <file>", "markdown output", "qa-contract-check.md")
  .action(wrap(async (o) => contractCheckCommand({ cwd: cwd(), service: o.service, servicePath: o.servicePath, story: o.story, ref: o.ref, strict: o.strict, json: o.json, out: o.out })));

program
  .command("story-check")
  .description("onboarding: how qa-sentinel reads one of your stories (ACs, scope, out of scope, context) and what to configure")
  .option("--story <key>", "Jira story key")
  .option("--story-file <path>", "story as a markdown or text file")
  .option("--fields", "also list the Jira issue's fields with their ids (to find the AC / tech-scope custom fields)")
  .option("--json", "print the parsed story as JSON")
  .option("-o, --out <file>", "markdown output", "qa-story-check.md")
  .action(wrap(async (o) => storyCheckCommand({ cwd: cwd(), story: o.story, storyFile: o.storyFile, fields: o.fields, json: o.json, out: o.out })));

program
  .command("lessons")
  .description("learn from review: what QA engineers changed in agent MRs before merging, as rules in kb/review-lessons.md (on a branch / MR)")
  .option("--since <when>", "only agent MRs merged since: 30d, 12w or a date")
  .option("--push", "push the branch and open a merge request")
  .option("--dry-run", "list the edited agent MRs without calling the agent")
  .action(wrap(async (o) => lessonsCommand({ cwd: cwd(), since: o.since, push: o.push, dryRun: o.dryRun })));

program
  .command("metrics")
  .description("how the agents are doing: verification rate, merged-without-edits rate, cost, plan repairs (qa-metrics.md)")
  .option("--runs <dir...>", "extra folders with run manifests (e.g. downloaded CI artifacts)")
  .option("--records <dir...>", "extra folders with story records (e.g. a downloaded CI cache), for the budget suggestions")
  .option("--since <when>", "30d, 12w or a date")
  .option("-o, --out <file>", "markdown output", "qa-metrics.md")
  .option("--json", "print the numbers as JSON instead")
  .option("--no-fetch", "don't fetch merge request heads from origin")
  .option("--online", "ask GitLab for the 👍 and 👎 on the gap report comments (needs a token)")
  .action(wrap(async (o) => metricsCommand({ cwd: cwd(), runs: o.runs, records: o.records, since: o.since, out: o.out, json: o.json, fetch: o.fetch, online: o.online })));

program
  .command("healed")
  .description("after a run with QA_HEALING=bubblegum: list healed steps as page-object fixes (qa-healed.md/.json)")
  .option("--results <file>", "Playwright JSON report", "test-results/results.json")
  .option("-o, --out <file>", "markdown output", "qa-healed.md")
  .option("--fail-on-heal", "exit 1 when any step was healed (default: tests.web.bubblegum.failOnHeal)")
  .action(wrap(async (o) => healedCommand({ cwd: cwd(), results: o.results, out: o.out, failOnHeal: o.failOnHeal })));

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
  .description("Phase 1: analyse a service change (or a whole story across services) and report impacted tests, gaps and AC mismatches")
  .option("-s, --service <name|path>", "service name from the config, or a path to its repo")
  .option("--story <key>", "story mode: analyse everything this story changed, across all its service repos")
  .option("--service-path <dir>", "override where the service repo is checked out (useful in CI)")
  .option("--base <ref>", "base ref (default: MR diff base in CI, else origin/<targetBranch>)")
  .option("--head <ref>", "head ref", "HEAD")
  .option("--checkout", "check out the head commit in the service repo if it is not already there (CI)")
  .option("--story-file <file>", "file with the story / acceptance criteria")
  .option("-o, --out <file>", "where to write the report", "qa-gap-report.md")
  .option("--post", "post or update the report as a GitLab MR comment")
  .option("--defer-publish", "do not post: write publish.json in the run folder for `qa-sentinel publish` (needs no write token; implies --post)")
  .option("--dry-run", "do everything except call Claude")
  .option("--even-if-draft", "make the report even if the merge request is still a draft")
  .option("--refresh", "make a new report even if nothing changed since the one on the merge request")
  .action(wrap(async (o) => (await gapReportCommand({ cwd: cwd(), ...needService(o) })).exitCode));

program
  .command("generate")
  .description("Phase 2: add or update tests for a service change (or a whole story across services) and commit them on a branch")
  .option("-s, --service <name|path>", "service name from the config, or a path to its repo")
  .option("--story <key>", "story mode: one plan and one branch/MR for everything this story changed, across all its service repos")
  .option("--acs <ids>", "with --story: plan only these acceptance criteria (comma list); one that still waits is refused unless --force")
  .option("--service-path <dir>", "override where the service repo is checked out (useful in CI)")
  .option("--base <ref>", "base ref in the service repo", "HEAD~1")
  .option("--head <ref>", "head ref in the service repo", "HEAD")
  .option("--checkout", "check out the head commit in the service repo if it is not already there (CI)")
  .option("--story-file <file>", "file with the story / acceptance criteria")
  .option("--push", "push the branch and open a GitLab merge request")
  .option("--defer-publish", "do not push: leave the branch as branch.bundle and the rest in publish.json for `qa-sentinel publish` (needs no write token; implies --push)")
  .option("--env <name>", "run the tests against this environment from `environments:` (e.g. dev, sit) before pushing")
  .option("--dry-run", "do everything except call Claude and commit")
  .option("--force", "run even if the same job (same story, ACs and commit) finished, failed too often or looks to be running; budgets still apply")
  .option("--once", "skip the run if the same job already finished (the default in CI)")
  .action(wrap(async (o) => generateCommand({ cwd: cwd(), ...needService(o), acs: typeof o.acs === "string" ? o.acs.split(",").map((x: string) => x.trim()).filter(Boolean) : undefined })));

program
  .command("publish")
  .description("the second half of the split CI jobs: publish what gap-report/generate --defer-publish left in a run folder (merge request, comments, Jira); uses write tokens, no model key")
  .option("--run <id|dir|all>", "a run id, a run folder, or all runs still waiting", "all")
  .option("--target <target>", "only one part: gitlab-mr (merge request comments), jira, or mr-create (push the branch and open the merge request)")
  .option("--kind <kind>", "accept only this job's runs: gap-report or generate (the CI templates pass it; a run of the other kind is refused)")
  .action(wrap(async (o) => {
    if (o.kind && !["gap-report", "generate"].includes(o.kind)) throw new Error(`--kind: gap-report or generate (got "${o.kind}")`);
    if (o.target && !["gitlab-mr", "jira", "mr-create"].includes(o.target)) throw new Error(`--target: gitlab-mr, jira or mr-create (got "${o.target}")`);
    return publishCommand({ cwd: cwd(), run: o.run, target: o.target, kind: o.kind });
  }));

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
  .command("suite")
  .description("no AI: the tests that fit what an environment has deployed (--env) or what a release contains (--tag); features not there yet are left out with the reason")
  .option("--env <name>", "environment from `environments:`; asks each service which commit it runs")
  .option("--tag <ref>", "release tag or branch: what that release contains")
  .option("--run", "run the selected tests")
  .option("--json", "print JSON")
  .option("-o, --out <base>", "output file name without extension", "qa-suite")
  .action(wrap(async (o) => suiteCommand({ cwd: cwd(), ...o })));

program
  .command("hotfix")
  .description("no AI: where a hotfix stands: its cherry-pick on the main branch (by -x line or patch id) and whether tests were written from it")
  .requiredOption("-s, --service <name|path>", "service the hotfix is in")
  .option("--service-path <dir>", "override where the service repo is checked out")
  .option("--commit <sha>", "a hotfix commit (repeat the option for more)", (v: string, prev: string[] = []) => [...prev, v])
  .option("--range <range>", "or a range, e.g. production..hotfix/orders-1")
  .option("--story <key>", "the story (default: from the commit message)")
  .option("--post", "put the status in the Jira story's QA status comment")
  .option("--json", "print JSON")
  .option("--fail-if-waiting", "exit 75 (still waiting) while a hotfix commit is not on the main branch yet")
  .option("--strict", "--fail-if-waiting, and exit 1 when a commit is on the main branch but has no tests after --grace-days")
  .option("--grace-days <n>", "with --strict: days allowed between landing on the main branch and tests (default 2)", (v: string) => Number(v))
  .action(wrap(async (o) => hotfixCommand({ cwd: cwd(), ...o })));

program
  .command("release-features")
  .description("no AI: which stories a release contains (story keys in commits between two tags, per service)")
  .requiredOption("--tag <ref>", "the release tag")
  .option("--from <ref>", "the previous tag")
  .option("--json", "print JSON")
  .action(wrap(async (o) => releaseFeaturesCommand({ cwd: cwd(), ...o })));

program
  .command("showcase")
  .description("after a test run: attach evidence to each story whose acceptance criteria all passed (once per story)")
  .option("--story <key...>", "only these stories (default: every story tagged in the tests)")
  .option("--story-file <file>", "acceptance criteria from a file instead of Jira (one story)")
  .option("--results <file>", "test results with attachments (default: test-results/results.json, else junit.xml)")
  .option("--mobile-results <dir>", "mobile result files (default: test-results/mobile, when the mobile layer is on)")
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
