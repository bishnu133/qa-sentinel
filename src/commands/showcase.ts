import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../config.js";
import { buildTestIndex } from "../analysis/testIndex.js";
import { readRunResults } from "../showcase/results.js";
import { assessStory, collectEvidence, showcaseComment, SHOWCASE_PROPERTY, type ShowcaseRecord, type StoryReadiness } from "../showcase/showcase.js";
import {
  attachFile,
  deleteAttachment,
  fetchIssue,
  getIssueProperty,
  issueLabels,
  jiraContext,
  markdownToJiraWiki,
  removeLabel,
  setIssueProperty,
  upsertIssueComment,
} from "../scm/jira.js";
import { parseAcceptanceCriteria } from "../requirements.js";
import { useEnvironment } from "../run.js";
import { log } from "../log.js";

export interface ShowcaseOptions {
  cwd: string;
  story?: string[];
  storyFile?: string;
  results?: string;
  env?: string;
  force?: boolean;
  dryRun?: boolean;
  out?: string;
}

/**
 * `qa-sentinel showcase`: after a test run, attach evidence to every story whose acceptance criteria all passed,
 * once per story. Safe to run after every suite run: stories already showcased are skipped unless QA asks again.
 */
export async function showcaseCommand(o: ShowcaseOptions): Promise<number> {
  const cwd = path.resolve(o.cwd);
  const c = loadConfig(cwd);
  const environment = o.env || c.verification.defaultEnvironment ? useEnvironment(c, o.env, {}) : undefined;
  const resultsFile = path.resolve(cwd, o.results ?? (fs.existsSync(path.join(cwd, "test-results/results.json")) ? "test-results/results.json" : "test-results/junit.xml"));
  if (!fs.existsSync(resultsFile)) throw new Error(`No test results at ${path.relative(cwd, resultsFile)}. Run the suite first (Playwright: add the json reporter, see the scaffold's playwright.config.ts).`);
  const results = readRunResults(resultsFile);
  const index = buildTestIndex(cwd, c.tests.api.dir);
  const ctx = jiraContext(c.requirements.jira.baseUrl);
  const stories = o.story?.length ? o.story : [...new Set(index.flatMap((t) => t.stories))].sort();
  log.step(`showcase: ${results.length} results, ${stories.length} stor${stories.length === 1 ? "y" : "ies"} tagged in the tests${environment ? `, environment ${environment}` : ""}`);
  if (!ctx && !o.dryRun) log.warn("Jira is not configured (requirements.jira.baseUrl + JIRA_EMAIL/JIRA_API_TOKEN or JIRA_PAT): assessing only");

  const report: string[] = ["# Showcase", ""];
  const at = new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC";
  const commit = process.env.CI_COMMIT_SHA;
  let attached = 0;

  for (const story of stories) {
    try {
      const acs = o.storyFile
        ? parseAcceptanceCriteria(fs.readFileSync(path.resolve(cwd, o.storyFile), "utf8"))
        : ctx
          ? parseAcceptanceCriteria(await issueText(ctx, story, c.requirements.jira.acceptanceCriteriaField))
          : [];
      const r = assessStory(c, index, results, story, acs);
      report.push(...readinessMarkdown(r), "");
      if (!r.ready) {
        log.info(`  ${story}: not ready – ${r.blockers.join("; ")}`);
        continue;
      }
      if (!ctx || o.dryRun) {
        // Nothing goes to Jira: keep what would be attached in a local folder so it can be checked first.
        const { files, skipped } = collectEvidence(c, r, { environment, commit, runUrl: process.env.CI_PIPELINE_URL, at });
        const dir = path.join(path.dirname(path.resolve(cwd, o.out ?? "qa-showcase.md")), "qa-showcase", story);
        fs.rmSync(dir, { recursive: true, force: true });
        fs.mkdirSync(dir, { recursive: true });
        for (const f of files) fs.writeFileSync(path.join(dir, f.name), f.data);
        skipped.forEach((x) => log.warn(`  ${story}: would not attach: ${x}`));
        log.ok(`  ${story}: ready (all ${r.acs.length} AC passed); ${ctx ? "dry run" : "Jira not configured"}: ${files.length} evidence file(s) saved in ${path.relative(cwd, dir)}`);
        continue;
      }
      const previous = await getIssueProperty<ShowcaseRecord>(ctx, story, SHOWCASE_PROPERTY);
      const labels = await issueLabels(ctx, story);
      const refresh = o.force || labels.includes(c.showcase.refreshLabel);
      if (previous && !refresh) {
        log.dim(`  ${story}: already showcased on ${previous.attachedAt}; add the label "${c.showcase.refreshLabel}" to attach fresh evidence`);
        report.push(`_Already showcased on ${previous.attachedAt}; skipped._`, "");
        continue;
      }
      const { files, skipped } = collectEvidence(c, r, { environment, commit, runUrl: process.env.CI_PIPELINE_URL, at });
      skipped.forEach((s) => log.warn(`  ${story}: not attached: ${s}`));
      if (previous && c.showcase.replaceOnRefresh) {
        for (const a of previous.attachments) await deleteAttachment(ctx, a.id).catch((e) => log.warn(`  could not delete old attachment ${a.filename}: ${(e as Error).message}`));
      }
      const done = [];
      for (const f of files) done.push(await attachFile(ctx, story, f.name, f.data, f.contentType));
      const rec: ShowcaseRecord = { version: 1, attachedAt: at, environment, commit, attachments: done, tests: r.acs.flatMap((a) => a.tests.map((t) => t.test.id)) };
      await setIssueProperty(ctx, story, SHOWCASE_PROPERTY, rec);
      await upsertIssueComment(ctx, story, "showcase", markdownToJiraWiki(showcaseComment(r, rec, c.showcase.refreshLabel)), c.reporting.jira.visibility, "qa-sentinel:showcase");
      if (labels.includes(c.showcase.refreshLabel)) await removeLabel(ctx, story, c.showcase.refreshLabel);
      attached++;
      log.ok(`  ${story}: evidence attached (${done.map((d) => d.filename).join(", ")})`);
    } catch (e) {
      log.warn(`  ${story}: ${(e as Error).message}`);
    }
  }
  const out = path.resolve(cwd, o.out ?? "qa-showcase.md");
  fs.writeFileSync(out, report.join("\n"));
  log.ok(`showcase: ${attached} stor${attached === 1 ? "y" : "ies"} attached · summary in ${path.relative(cwd, out)}`);
  return 0;
}

async function issueText(ctx: NonNullable<ReturnType<typeof jiraContext>>, key: string, acField?: string): Promise<string> {
  const issue = await fetchIssue(ctx, key, acField);
  return [issue.description, issue.acceptanceCriteria ? `## Acceptance criteria\n${issue.acceptanceCriteria}` : ""].join("\n\n");
}

function readinessMarkdown(r: StoryReadiness): string[] {
  const icon = { passed: "✅", failed: "❌", "not-run": "⚪", "no-test": "⬜" } as const;
  return [
    `## ${r.story} · ${r.ready ? "✅ ready to showcase" : "not ready"}`,
    "",
    "| AC | Result | Tests |",
    "| --- | --- | --- |",
    ...r.acs.map((a) => `| ${a.id} | ${icon[a.status]} ${a.status} | ${a.tests.map((t) => `${t.test.title} (${t.result?.status ?? "not run"})`).join("<br>") || "–"}${a.pending.length ? `<br>+ ${a.pending.length} waiting for a fix` : ""} |`),
    ...(r.blockers.length ? ["", ...r.blockers.map((b) => `- ${b}`)] : []),
  ];
}
