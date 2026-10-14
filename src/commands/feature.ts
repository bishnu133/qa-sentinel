import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { loadConfig } from "../config.js";
import { assembleFeature, featureMarkdown } from "../feature/manifest.js";
import { buildTestIndex, traceMarkdown, traceStory } from "../analysis/testIndex.js";
import { parseAcceptanceCriteria } from "../requirements.js";
import { gitlabContext } from "../scm/gitlab.js";
import { fetchIssue, jiraContext, markdownToJiraWiki, upsertIssueComment } from "../scm/jira.js";
import { testEnv, useEnvironment } from "../run.js";
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
    ? parseAcceptanceCriteria(fs.readFileSync(path.resolve(cwd, o.storyFile), "utf8"))
    : jira
      ? await fetchIssue(jira, story, c.requirements.jira.acceptanceCriteriaField).then((i) => parseAcceptanceCriteria([i.description, i.acceptanceCriteria ?? ""].join("\n\n"))).catch(() => [])
      : [];
  const index = buildTestIndex(cwd, c.tests.api.dir);
  const tests = index.filter((t) => t.stories.includes(story));
  const active = tests.filter((t) => t.status === "active");
  const extra = ["", `**Feature tests:** ${active.length} tagged @story:${story}${tests.length > active.length ? ` (+${tests.length - active.length} waiting for a product fix)` : ""}, across ${new Set(tests.flatMap((t) => t.services)).size} service(s).`];
  if (acs.length) extra.push("", traceMarkdown(story, traceStory(index, story, acs)).replace(/^### /, "#### "));
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
    const r = spawnSync(`${c.tests.api.runCommand} ${active.map((t) => `${t.file}:${t.line}`).join(" ")}`, { cwd, shell: true, stdio: "inherit", env: testEnv(c) });
    return r.status ?? 1;
  }
  return 0;
}
