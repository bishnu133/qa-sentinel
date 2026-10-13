import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../config.js";
import { indexTests } from "../analysis/testIndex.js";
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
import { testEnv, useEnvironment } from "../run.js";
import { buildShowcasePack } from "../showcase/pack.js";
import type { EvidenceFile } from "../showcase/showcase.js";
import type { Config } from "../config.js";
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
  const index = indexTests(cwd, c);
  const ctx = jiraContext(c.requirements.jira.baseUrl);
  const stories = o.story?.length ? o.story : [...new Set(index.flatMap((t) => t.stories))].sort();
  log.step(`showcase: ${results.length} results, ${stories.length} stor${stories.length === 1 ? "y" : "ies"} tagged in the tests${environment ? `, environment ${environment}` : ""}`);
  if (!ctx && !o.dryRun) log.warn("Jira is not configured (requirements.jira.baseUrl + JIRA_EMAIL/JIRA_API_TOKEN or JIRA_PAT): assessing only");
  // Biz should only see evidence from the agreed environment(s), never from a local or PR run.
  if (c.showcase.environments.length && (!environment || !c.showcase.environments.includes(environment))) {
    log.warn(`showcase: this run is on ${environment ?? "no named environment"}; showcase.environments allows only ${c.showcase.environments.join(", ")}. Assessing only.`);
    o = { ...o, dryRun: true };
  }

  const report: string[] = ["# Showcase", ""];
  const at = new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC";
  const commit = process.env.CI_COMMIT_SHA;
  let attached = 0;

  for (const story of stories) {
    try {
      const src = o.storyFile
        ? storyFromFile(fs.readFileSync(path.resolve(cwd, o.storyFile), "utf8"))
        : ctx
          ? await issueText(ctx, story, c.requirements.jira.acceptanceCriteriaField)
          : { text: "", title: undefined };
      const acs = parseAcceptanceCriteria(src.text);
      const r = assessStory(c, index, results, story, acs);
      report.push(...readinessMarkdown(r), "");
      if (!r.ready) {
        log.info(`  ${story}: not ready – ${r.blockers.join("; ")}`);
        continue;
      }
      if (!ctx || o.dryRun) {
        // Nothing goes to Jira: keep what would be attached in a local folder so it can be checked first.
        const { files, skipped } = await evidence(cwd, c, r, { title: src.title, environment, commit, runUrl: process.env.CI_PIPELINE_URL, at });
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
      const { files, skipped } = await evidence(cwd, c, r, { title: src.title, environment, commit, runUrl: process.env.CI_PIPELINE_URL, at });
      skipped.forEach((s) => log.warn(`  ${story}: ${s}`));
      if (previous && c.showcase.replaceOnRefresh) {
        for (const a of previous.attachments) await deleteAttachment(ctx, a.id).catch((e) => log.warn(`  could not delete old attachment ${a.filename}: ${(e as Error).message}`));
      }
      const done = [];
      for (const f of files) done.push(await attachFile(ctx, story, f.name, f.data, f.contentType));
      const rec: ShowcaseRecord = { version: 1, attachedAt: at, environment, commit, attachments: done, tests: r.acs.flatMap((a) => a.tests.map((t) => t.test.id)) };
      await setIssueProperty(ctx, story, SHOWCASE_PROPERTY, rec);
      const mentions = c.showcase.notify.map((u) => (/^[0-9a-f]{12,}$|:/.test(u) ? `[~accountid:${u}]` : `[~${u}]`));
      const comment = markdownToJiraWiki(showcaseComment(r, rec, c.showcase.refreshLabel));
      await upsertIssueComment(ctx, story, "showcase", mentions.length ? `${mentions.join(" ")} this story is ready for your review: the video and the evidence PDF are attached.\n\n${comment}` : comment, c.reporting.jira.visibility, "qa-sentinel:showcase");
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

async function issueText(ctx: NonNullable<ReturnType<typeof jiraContext>>, key: string, acField?: string): Promise<{ text: string; title?: string }> {
  const issue = await fetchIssue(ctx, key, acField);
  return { title: issue.summary, text: [issue.description, issue.acceptanceCriteria ? `## Acceptance criteria\n${issue.acceptanceCriteria}` : ""].join("\n\n") };
}

function storyFromFile(text: string): { text: string; title?: string } {
  const h = text.match(/^#\s+(.+)$/m)?.[1]?.trim();
  return { text, title: h?.replace(/^[A-Z][A-Z0-9]+-\d+:\s*/, "") };
}

/**
 * What goes to the story. pack: one video of the whole story + one PDF (falls back to the run's own videos when
 * the video can't be built). files: the run's own evidence, one attachment each.
 */
async function evidence(cwd: string, c: Config, r: StoryReadiness, meta: { title?: string; environment?: string; commit?: string; runUrl?: string; at: string }): Promise<{ files: EvidenceFile[]; skipped: string[] }> {
  if (c.showcase.format === "files") return collectEvidence(c, r, meta);
  log.step(`  ${r.story}: building the showcase pack (video + PDF)`);
  const pack = await buildShowcasePack({ cwd, c, r, meta, workDir: path.join(cwd, ".qa-sentinel", "showcase", r.story), env: testEnv(c) });
  const notes = [...pack.notes];
  let files = pack.files;
  if (!pack.video || !files.some((f) => f.contentType === "application/pdf")) {
    // Fallback: the run's own evidence (videos/screenshots), plus the markdown summary when the PDF is missing.
    const fallback = collectEvidence(c, r, meta);
    const hasPdf = files.some((f) => f.contentType === "application/pdf");
    files = [...files, ...fallback.files.filter((f) => (hasPdf ? f.contentType !== "text/markdown" : true) && (pack.video ? f.contentType === "text/markdown" : true))];
    notes.push(...fallback.skipped);
  }
  const big = files.filter((f) => f.data.length > c.showcase.maxFileMb * 1024 * 1024);
  for (const f of big) notes.push(`${f.name}: ${(f.data.length / 1024 / 1024).toFixed(1)} MB is over showcase.maxFileMb (${c.showcase.maxFileMb})`);
  return { files: files.filter((f) => !big.includes(f)).slice(0, c.showcase.maxFiles), skipped: notes };
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
