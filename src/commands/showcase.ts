import { readManualCards } from "../manualTests.js";
import { type PiiFinding, piiMarkdown, scanEvidence } from "../showcase/pii.js";
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
} from "../scm/jira.js";
import { jiraMode } from "../config.js";
import { mentionOf, notifyStory } from "../reporting/notify.js";
import { postToStory } from "../reporting/statusComment.js";
import { openStore } from "../stories/start.js";
import { jiraIssueText, parseStoryFor } from "../requirements.js";
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
  /** Mobile result files (written by the mobile evidence hooks); default test-results/mobile. */
  mobileResults?: string;
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
  const mobileDir = c.tests.mobile.enabled ? path.resolve(cwd, o.mobileResults ?? "test-results/mobile") : undefined;
  const haveMobile = Boolean(mobileDir && fs.existsSync(mobileDir) && fs.statSync(mobileDir).isDirectory());
  if (!fs.existsSync(resultsFile) && !haveMobile) throw new Error(`No test results at ${path.relative(cwd, resultsFile)}. Run the suite first (Playwright: add the json reporter, see the scaffold's playwright.config.ts).`);
  const results = [...(fs.existsSync(resultsFile) ? readRunResults(resultsFile) : []), ...(haveMobile ? readRunResults(mobileDir!) : [])];
  const index = indexTests(cwd, c);
  const ctx = jiraContext(c.requirements.jira);
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
          ? await issueText(ctx, c, story)
          : { text: "", title: undefined };
      const parsed = parseStoryFor(c, src.text);
      const acs = parsed.acceptanceCriteria;
      const r = assessStory(c, index, results, story, acs, readManualCards(cwd, c.tests.manualDir));
      report.push(...readinessMarkdown(r), "");
      if (!r.ready) {
        log.info(`  ${story}: not ready – ${r.blockers.join("; ")}`);
        continue;
      }
      if (!ctx || o.dryRun) {
        // Nothing goes to Jira: keep what would be attached in a local folder so it can be checked first.
        const { files, skipped } = await evidence(cwd, c, r, { title: src.title, environment, commit, runUrl: process.env.CI_PIPELINE_URL, at, approach: parsed.showcase });
        const dir = path.join(path.dirname(path.resolve(cwd, o.out ?? "qa-showcase.md")), "qa-showcase", story);
        fs.rmSync(dir, { recursive: true, force: true });
        fs.mkdirSync(dir, { recursive: true });
        for (const f of files) fs.writeFileSync(path.join(dir, f.name), f.data);
        skipped.forEach((x) => log.warn(`  ${story}: would not attach: ${x}`));
        const pii = piiGuard(cwd, c, r, files);
        if (pii.length) {
          report.push(`**Personal data in the evidence** (would ${c.showcase.pii.mode === "block" ? "not be attached" : "be attached, mode warn"}):`, "", piiMarkdown(pii), "");
          log.warn(`  ${story}: ${pii.length} value(s) that look like personal data in the evidence (${[...new Set(pii.map((f) => f.kind))].join(", ")})`);
        }
        log.ok(`  ${story}: ready (all ${r.acs.length} AC passed); ${ctx ? "dry run" : "Jira not configured"}: ${files.length} evidence file(s) saved in ${path.relative(cwd, dir)}`);
        continue;
      }
      const previous = await getIssueProperty<ShowcaseRecord>(ctx, story, SHOWCASE_PROPERTY);
      const labels = await issueLabels(ctx, story);
      const basisNow = ctx ? await currentBasis(cwd, c, story) : undefined;
      // The code or the ACs moved on after the evidence was attached.
      const older = Boolean(previous?.basis && basisNow && previous.basis !== basisNow);
      const refresh = o.force || labels.includes(c.showcase.refreshLabel) || (older && c.showcase.reattachOnChange);
      if (previous && !refresh) {
        log.dim(`  ${story}: already showcased on ${previous.attachedAt}; add the label "${c.showcase.refreshLabel}" to attach fresh evidence${older ? ". The evidence is older than the latest change" : ""}`);
        report.push(`_Already showcased on ${previous.attachedAt}; skipped.${older ? " Evidence older than the latest change: add the refresh label, or set showcase.reattachOnChange." : ""}_`, "");
        continue;
      }
      const { files, skipped } = await evidence(cwd, c, r, { title: src.title, environment, commit, runUrl: process.env.CI_PIPELINE_URL, at, approach: parsed.showcase });
      skipped.forEach((s) => log.warn(`  ${story}: ${s}`));
      const pii = piiGuard(cwd, c, r, files);
      if (pii.length) {
        report.push(`**Personal data in the evidence** (${c.showcase.pii.mode === "block" ? "nothing attached" : "attached anyway: showcase.pii.mode is warn"}):`, "", piiMarkdown(pii), "");
        log.warn(`  ${story}: ${pii.length} value(s) that look like personal data in the evidence (${[...new Set(pii.map((f) => f.kind))].join(", ")}); see ${o.out ?? "qa-showcase.md"}`);
        if (c.showcase.pii.mode === "block") {
          log.info("  Use test data, or allow known test values in showcase.pii.allow / allowEmailDomains, then run again.");
          continue;
        }
      }
      if (previous && c.showcase.replaceOnRefresh) {
        for (const a of previous.attachments) await deleteAttachment(ctx, a.id).catch((e) => log.warn(`  could not delete old attachment ${a.filename}: ${(e as Error).message}`));
      }
      const done = [];
      for (const f of files) done.push(await attachFile(ctx, story, f.name, f.data, f.contentType));
      const rec: ShowcaseRecord = { version: 1, attachedAt: at, environment, commit, attachments: done, tests: r.acs.flatMap((a) => a.tests.map((t) => t.test.id)), ...(basisNow ? { basis: basisNow } : {}) };
      await setIssueProperty(ctx, story, SHOWCASE_PROPERTY, rec);
      const mentions = c.showcase.notify.map(mentionOf);
      const comment = markdownToJiraWiki(showcaseComment(r, rec, c.showcase.refreshLabel));
      const ready = `this story is ready for your review: ${attachedWhat(done.map((d) => d.filename))} attached.`;
      if (jiraMode(c) === "status") {
        // The summary is a section of the status comment; the mention is a short new comment of its own (an edit notifies nobody).
        await postToStory(c, ctx, story, { name: "showcase", wiki: comment, legacyKind: "showcase", legacyMarker: "qa-sentinel:showcase", cwd });
        await notifyStory(cwd, c, story, "showcase-ready", ready, `${at}`);
      } else {
        await postToStory(c, ctx, story, { name: "showcase", wiki: mentions.length ? `${mentions.join(" ")} ${ready}\n\n${comment}` : comment, legacyKind: "showcase", legacyMarker: "qa-sentinel:showcase", cwd });
      }
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

/** The story's basis now, from its record (undefined when there is none). */
async function currentBasis(cwd: string, c: Config, story: string): Promise<string | undefined> {
  try {
    return (await openStore(cwd, c).load(story))?.basis;
  } catch {
    return undefined;
  }
}

async function issueText(ctx: NonNullable<ReturnType<typeof jiraContext>>, c: Config, key: string): Promise<{ text: string; title?: string }> {
  const issue = await fetchIssue(ctx, key, c.requirements.jira.acceptanceCriteriaField, c.requirements.jira.scopeFields.map((f) => f.field));
  return { title: issue.summary, text: jiraIssueText(c, issue) };
}

function storyFromFile(text: string): { text: string; title?: string } {
  const h = text.match(/^#\s+(.+)$/m)?.[1]?.trim();
  return { text, title: h?.replace(/^[A-Z][A-Z0-9]+-\d+:\s*/, "") };
}

/** Personal data in what would be attached: text files, the pack's HTML (PDF source, title cards) and the API logs. */
export function piiGuard(cwd: string, c: Config, r: StoryReadiness, files: EvidenceFile[]): PiiFinding[] {
  if (c.showcase.pii.mode === "off") return [];
  const items: { where: string; text: string; json?: boolean }[] = [];
  for (const f of files)
    if (/^text\/|json|html|xml|yaml/i.test(f.contentType ?? "") || /\.(md|txt|json|html?|csv|ya?ml|log)$/i.test(f.name)) items.push({ where: f.name, text: f.data.toString("utf8"), json: /\.json$/i.test(f.name) });
  const work = path.join(cwd, ".qa-sentinel", "showcase", r.story);
  if (fs.existsSync(work)) for (const f of fs.readdirSync(work).filter((x) => /\.html?$/i.test(x))) items.push({ where: `${f} (video card / PDF)`, text: fs.readFileSync(path.join(work, f), "utf8") });
  for (const a of r.acs)
    for (const t of a.tests)
      for (const ev of t.result?.evidence ?? [])
        if (ev.kind === "api-log" && fs.existsSync(ev.path)) items.push({ where: `API evidence of "${t.test.title}"`, text: fs.readFileSync(ev.path, "utf8"), json: true });
  return scanEvidence(items, c.showcase.pii);
}

/**
 * What goes to the story. pack: one video of the whole story + one PDF (falls back to the run's own videos when
 * the video can't be built). files: the run's own evidence, one attachment each.
 */
async function evidence(cwd: string, c: Config, r: StoryReadiness, meta: { title?: string; environment?: string; commit?: string; runUrl?: string; at: string; approach?: string }): Promise<{ files: EvidenceFile[]; skipped: string[] }> {
  if (c.showcase.format === "files") return collectEvidence(c, r, meta);
  log.step(`  ${r.story}: building the showcase pack (video + PDF)`);
  const pack = await buildShowcasePack({ cwd, c, r, meta, workDir: path.join(cwd, ".qa-sentinel", "showcase", r.story), env: testEnv(c) });
  const notes = [...pack.notes];
  let files = pack.files;
  // A story proven only by API tests (a backend change): the PDF with the requests and responses is the showcase.
  if (pack.noUi && files.some((f) => f.contentType === "application/pdf")) {
    /* no video to fall back to */
  } else if (!pack.video || !files.some((f) => f.contentType === "application/pdf")) {
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
  const icon = { passed: "✅", failed: "❌", "not-run": "⚪", "no-test": "⬜", manual: "✋" } as const;
  return [
    `## ${r.story} · ${r.ready ? "✅ ready to showcase" : "not ready"}`,
    "",
    "| AC | Result | Tests |",
    "| --- | --- | --- |",
    ...r.acs.map((a) => `| ${a.id} | ${icon[a.status]} ${a.status} | ${a.tests.map((t) => `${t.test.title} (${t.result?.status ?? "not run"})`).join("<br>") || "–"}${a.pending.length ? `<br>+ ${a.pending.length} waiting for a fix` : ""} |`),
    ...(r.blockers.length ? ["", ...r.blockers.map((b) => `- ${b}`)] : []),
  ];
}

/** What the mention says is attached, from the files that actually were. */
export function attachedWhat(names: string[]): string {
  const video = names.some((n) => /-showcase\.mp4$/.test(n));
  const pdf = names.some((n) => /\.pdf$/i.test(n));
  const media = names.filter((n) => /\.(webm|mp4|png|jpe?g)$/i.test(n) && !/-showcase\.mp4$/.test(n)).length;
  const parts = [video ? "the showcase video" : media ? `${media} test recording(s) and screenshot(s)` : undefined, pdf ? "the evidence PDF" : names.some((n) => n.endsWith(".md")) ? "the test evidence" : undefined].filter(Boolean);
  const plural = parts.length > 1 || (!video && media > 0 && parts[0] === `${media} test recording(s) and screenshot(s)`);
  return parts.length ? `${parts.join(" and ")} ${plural ? "are" : "is"}` : "the test results are";
}
