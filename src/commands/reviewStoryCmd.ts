import { ensureAgentFiles } from "./init.js";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../config.js";
import { resolveRequirements, storyMarkdown } from "../requirements.js";
import { createRunDir } from "../run.js";
import { writeKnowledge } from "../kb.js";
import { engineFor } from "../engines/ClaudeCodeEngine.js";
import type { AgentEngine } from "../engines/AgentEngine.js";
import { withSpend } from "../stories/start.js";
import { formatUsage } from "../claude.js";
import { addUsage } from "../engines/AgentEngine.js";
import { reviewStory, storyReviewMarkdown } from "../review/storyReview.js";
import { jiraContext, markdownToJiraWiki } from "../scm/jira.js";
import { postToStory } from "../reporting/statusComment.js";
import { log } from "../log.js";

export interface ReviewStoryOptions {
  cwd: string;
  story?: string;
  storyFile?: string;
  post?: boolean;
  out?: string;
  dryRun?: boolean;
}

/**
 * `qa-sentinel review-story --story SHOP-12 [--post]`: review the story before development (ambiguous or
 * untestable ACs, missing negative and edge cases, scope without an AC). Read-only; with --post the result is a
 * comment on the story, updated in place when run again (e.g. after the PO edits it).
 */
export async function reviewStoryCommand(o: ReviewStoryOptions): Promise<number> {
  const cwd = path.resolve(o.cwd);
  return withSpend({ cwd, c: loadConfig(cwd), story: o.story, label: "story-review", skip: o.dryRun }, (code) => code, (wrap) => reviewStoryRun(o, wrap), (code) => code);
}

async function reviewStoryRun(o: ReviewStoryOptions, wrap: (e: AgentEngine) => AgentEngine): Promise<number> {
  const cwd = path.resolve(o.cwd);
  const c = loadConfig(cwd);
  ensureAgentFiles(cwd, c);
  if (!o.story && !o.storyFile) throw new Error("Pass --story KEY (from Jira) or --story-file path");
  const req = await resolveRequirements(c, { storyFile: o.storyFile, keyHints: [o.story] });
  if (req.source === "none" || !req.rawText.trim()) throw new Error(`No story found for ${o.story ?? o.storyFile} (Jira configured? requirements.source: jira)`);
  const story = req.storyKey ?? o.story ?? "story";
  log.step(`story review: ${story} (${req.acceptanceCriteria.length} AC${req.scopeItems.length ? `, ${req.scopeItems.length} scope item(s)` : ""}, ${req.source}, ${req.approvalStatus})`);
  const run = createRunDir(cwd, `story-review-${story}`);
  fs.writeFileSync(path.join(run.dir, "story.md"), storyMarkdown(req));
  const knowledge = writeKnowledge(cwd, c, run.dir, run.rel);
  if (o.dryRun) {
    log.info(`dry run: would ask the agent to review ${run.rel}/story.md`);
    return 0;
  }
  const r = await reviewStory({ cwd, c, run, engine: wrap(engineFor(c)), req, knowledge });
  const usage = formatUsage(addUsage(...r.runs));
  if (!r.review) {
    log.fail(`story review failed: ${r.errors.slice(0, 3).join("; ")}`);
    return 1;
  }
  const md = storyReviewMarkdown(story, r.review);
  const out = path.resolve(cwd, o.out ?? "qa-story-review.md");
  fs.writeFileSync(out, `${md}\n\n<sub>${usage}</sub>\n`);
  fs.writeFileSync(path.join(run.dir, "story-review.md"), md);
  log.ok(`story review: ${r.review.findings.length} finding(s), ${r.review.suggestedAcs.length} suggested AC(s) · ${path.relative(cwd, out)}${usage ? ` (${usage})` : ""}`);
  if (o.post) {
    const ctx = jiraContext(c.requirements.jira);
    if (!ctx || !req.storyKey) log.warn("--post: Jira is not configured or the story key is unknown; nothing posted");
    else {
      const res = await postToStory(c, ctx, req.storyKey, { name: "story-review", wiki: markdownToJiraWiki(md), legacyKind: "story-review", legacyMarker: "qa-sentinel:story-review", cwd });
      log.ok(`Jira ${req.storyKey}: story review ${res.action}`);
    }
  }
  return 0;
}
