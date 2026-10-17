import { readManualCards } from "../manualTests.js";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { loadConfig } from "../config.js";
import { assembleFeature, featureMarkdown } from "../feature/manifest.js";
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
  const acs = o.storyFile
    ? parseStoryFor(c, fs.readFileSync(path.resolve(cwd, o.storyFile), "utf8")).acceptanceCriteria
    : jira
      ? await fetchIssue(jira, story, c.requirements.jira.acceptanceCriteriaField, c.requirements.jira.scopeFields.map((f) => f.field))
          .then((i) => parseStoryFor(c, jiraIssueText(c, i)).acceptanceCriteria)
          .catch(() => [])
      : [];
  const index = indexTests(cwd, c);
  const tests = index.filter((t) => t.stories.includes(story));
  const active = tests.filter((t) => t.status === "active");
  const extra = ["", `**Feature tests:** ${active.length} tagged @story:${story}${tests.length > active.length ? ` (+${tests.length - active.length} waiting for a product fix)` : ""}, across ${new Set(tests.flatMap((t) => t.services)).size} service(s).`];
  if (acs.length) extra.push("", traceMarkdown(story, traceStory(index, story, acs, readManualCards(cwd, c.tests.manualDir))).replace(/^### /, "#### "));
  const md = featureMarkdown(manifest, extra);

  const base = path.join(cwd, `qa-feature-${story}`);
  fs.writeFileSync(`${base}.md`, md + "\n");
  fs.writeFileSync(`${base}.json`, JSON.stringify({ ...manifest, tests: tests.map((t) => t.id), acs }, null, 2));
  if (o.json) process.stdout.write(JSON.stringify(manifest, null, 2) + "\n");
  else log.info(md);

  if (o.post) {
    if (!jira) log.warn("--post: Jira is not configured");
    else {
      const r = await upsertIssueComment(jira, story, "feature", markdownToJiraWiki(md), c.reporting.jira.visibility, "qa-sentinel:feature");
      log.ok(`Jira ${story}: feature status ${r.action}`);
    }
  }

  if (o.run) {
    if (manifest.status !== "ready-for-feature-tests" && !o.force) {
      log.warn(`not running the feature tests: ${manifest.status}${environment ? "" : " (pass --env to check deployments)"}; use --force to run anyway`);
      return 2;
    }
    if (!active.length) {
      log.warn(`no active tests tagged @story:${story}`);
      return 2;
    }
    log.step(`running ${active.length} feature test(s)${environment ? ` on ${environment}` : ""}`);
    // API and web tests in one run where possible; healing is allowed here: these are existing, reviewed tests.
    let status = 0;
    for (const cmd of runCommandsFor(c, active.map((t) => `${t.file}:${t.line}`))) {
      const r = spawnSync(cmd, { cwd, shell: true, stdio: "inherit", env: testEnv(c, process.env, { healing: true }) });
      if ((r.status ?? 1) !== 0) status = r.status ?? 1;
    }
    return status;
  }
  return 0;
}
