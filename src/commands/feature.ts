import { readManualCards } from "../manualTests.js";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { loadConfig } from "../config.js";
import { assembleFeature, featureMarkdown } from "../feature/manifest.js";
import { acReadiness, readinessMarkdown, testRunnable } from "../feature/readiness.js";
import { readExpected } from "../expected/format.js";
import { expectedDirOf } from "../expected/lock.js";
import { isReadyStatus } from "../stories/resolve.js";
import { indexTests, traceMarkdown, traceStory } from "../analysis/testIndex.js";
import { jiraIssueText, parseStoryFor } from "../requirements.js";
import { gitlabContext } from "../scm/gitlab.js";
import { fetchIssue, jiraContext, markdownToJiraWiki, upsertIssueComment } from "../scm/jira.js";
import { testEnv, useEnvironment } from "../run.js";
import { runCommandsFor } from "../layers.js";
import { log } from "../log.js";

export interface FeatureOptions {
  cwd: string;
  story: string;
  env?: string;
  storyFile?: string;
  run?: boolean;
  force?: boolean;
  post?: boolean;
  json?: boolean;
}

/**
 * `qa-sentinel feature <STORY>`: which services the story changes, whether each change is merged and deployed in
 * an environment, which acceptance criteria have tests, and (with --run) the story's end-to-end tests once every
 * part is deployed.
 */
export async function featureCommand(o: FeatureOptions): Promise<number> {
  const cwd = path.resolve(o.cwd);
  const c = loadConfig(cwd);
  const story = o.story.toUpperCase();
  const environment = useEnvironment(c, o.env);
  const baseUrl = environment ? process.env[c.tests.api.baseUrlEnv] : undefined;
  const gl = c.workspace.services.some((s) => s.gitlabProject) ? gitlabContext(c.ci.gitlabUrl) : undefined;
  const manifest = await assembleFeature({ c, cwd, story, gitlab: gl, environment, baseUrl });

  const jira = jiraContext(c.requirements.jira.baseUrl);
  let acs: ReturnType<typeof parseStoryFor>["acceptanceCriteria"] = [];
  // Whether the Jira card is in a ready status; unknown (undefined) with a story file or when Jira can't be read.
  let jiraReady: boolean | undefined;
  if (o.storyFile) acs = parseStoryFor(c, fs.readFileSync(path.resolve(cwd, o.storyFile), "utf8")).acceptanceCriteria;
  else if (jira) {
    const issue = await fetchIssue(jira, story, c.requirements.jira.acceptanceCriteriaField, c.requirements.jira.scopeFields.map((f) => f.field)).catch(() => undefined);
    if (issue) {
      acs = parseStoryFor(c, jiraIssueText(c, issue)).acceptanceCriteria;
      jiraReady = isReadyStatus(c, story, issue.status, issue.statusCategory);
    } else log.warn(`could not read ${story} from Jira; the ready status is not checked`);
  }
  let expected;
  try {
    expected = readExpected(cwd, expectedDirOf(c.tests.expectedDir), story);
  } catch (e) {
    log.warn(`${(e as Error).message}; ignoring the expected-behaviour file`);
  }
  const readiness = acReadiness(manifest, expected, acs.map((a) => a.id), jiraReady);
  const index = indexTests(cwd, c);
  const tests = index.filter((t) => t.stories.includes(story));
  const active = tests.filter((t) => t.status === "active");
  const extra = ["", `**Feature tests:** ${active.length} tagged @story:${story}${tests.length > active.length ? ` (+${tests.length - active.length} waiting for a product fix)` : ""}, across ${new Set(tests.flatMap((t) => t.services)).size} service(s).`];
  if (acs.length) extra.push("", traceMarkdown(story, traceStory(index, story, acs, readManualCards(cwd, c.tests.manualDir))).replace(/^### /, "#### "));
  extra.push(...readinessMarkdown(readiness));
  const md = featureMarkdown(manifest, extra);

  const base = path.join(cwd, `qa-feature-${story}`);
  fs.writeFileSync(`${base}.md`, md + "\n");
  fs.writeFileSync(`${base}.json`, JSON.stringify({ ...manifest, jiraReady, readiness, tests: tests.map((t) => t.id), acs }, null, 2));
  if (o.json) process.stdout.write(JSON.stringify({ ...manifest, jiraReady, readiness }, null, 2) + "\n");
  else log.info(md);

  if (o.post) {
    if (!jira) log.warn("--post: Jira is not configured");
    else {
      const r = await upsertIssueComment(jira, story, "feature", markdownToJiraWiki(md), c.reporting.jira.visibility, "qa-sentinel:feature");
      log.ok(`Jira ${story}: feature status ${r.action}`);
    }
  }

  if (o.run) {
    // Per AC: a test runs when every AC it names is ready. Without ACs to go by (no Jira, no story file), the whole-feature rule applies.
    const byAc = readiness.length > 0;
    const wholeReady = manifest.status === "ready-for-feature-tests" && jiraReady !== false;
    const runnable = o.force ? active : byAc ? active.filter((t) => testRunnable(t.acs, readiness)) : wholeReady ? active : [];
    if (!active.length) {
      log.warn(`no active tests tagged @story:${story}`);
      return 2;
    }
    if (!runnable.length) {
      log.warn(`not running the feature tests: ${byAc ? "no acceptance criterion is ready" : manifest.status}${environment ? "" : " (pass --env to check deployments)"}; use --force to run anyway`);
      return 2;
    }
    if (runnable.length < active.length) log.info(`running ${runnable.length} of ${active.length} test(s); the rest wait for their ACs to be ready (${readiness.filter((r) => r.state !== "ready").map((r) => r.ac).join(", ")})`);
    log.step(`running ${runnable.length} feature test(s)${environment ? ` on ${environment}` : ""}`);
    // API and web tests in one run where possible; healing is allowed here: these are existing, reviewed tests.
    let status = 0;
    for (const cmd of runCommandsFor(c, runnable.filter((t) => !t.bdd).map((t) => `${t.file}:${t.line}`))) {
      const r = spawnSync(cmd, { cwd, shell: true, stdio: "inherit", env: testEnv(c, process.env, { healing: true }) });
      if ((r.status ?? 1) !== 0) status = r.status ?? 1;
    }
    return status;
  }
  return 0;
}
