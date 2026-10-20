import path from "node:path";
import { loadConfig } from "../config.js";
import { isFeature, resolveRequirements } from "../requirements.js";
import { createRunDir, VERSION } from "../run.js";
import { engineFor } from "../engines/ClaudeCodeEngine.js";
import { formatUsage } from "../claude.js";
import { addUsage } from "../engines/AgentEngine.js";
import { git, workingChanges } from "../git.js";
import { log } from "../log.js";
import { expectedPath, readExpected, renderExpected, writeExpected } from "../expected/format.js";
import { expectedCommitMessage, poQuestions, runSpecPass, specDenyRead } from "../expected/spec.js";
import { expectedDirOf } from "../expected/lock.js";

export interface SpecOptions {
  cwd: string;
  story?: string;
  storyFile?: string;
  /** Commit the file on the current branch (as qa-sentinel's commit). */
  commit?: boolean;
  dryRun?: boolean;
}

/**
 * `qa-sentinel spec --story SHOP-101`: write or update expected/SHOP-101.md from the story alone (code-blind).
 * Usable before development starts. Unchanged ACs keep their reviewed entries; only new or changed ACs are asked
 * for; nothing is sent to the AI when every AC already has a current expectation.
 */
export async function specCommand(o: SpecOptions): Promise<number> {
  const cwd = path.resolve(o.cwd);
  const c = loadConfig(cwd);
  if (!o.story && !o.storyFile) throw new Error("Pass --story KEY (from Jira) or --story-file path");
  const req = await resolveRequirements(c, { storyFile: o.storyFile, keyHints: [o.story] });
  const story = (req.storyKey ?? o.story ?? path.basename(o.storyFile ?? "story", ".md")).toUpperCase();
  if (!isFeature(c, req)) throw new Error(`${story} is a ${req.issueType}, not one of requirements.jira.featureIssueTypes (${c.requirements.jira.featureIssueTypes.join(", ")}): expected behaviour is written for features only`);
  if (!req.acceptanceCriteria.length) throw new Error(`${story} has no acceptance criteria that qa-sentinel can read (see: qa-sentinel story-check --story ${story})`);
  const dir = expectedDirOf(c.tests.expectedDir);
  const rel = expectedPath(dir, story);
  if (o.commit && workingChanges(cwd).some((x) => x.path === rel)) throw new Error(`${rel} has uncommitted changes; commit or discard them first`);
  const stored = readExpected(cwd, dir, story);
  log.step(`expected behaviour: ${story} (${req.acceptanceCriteria.length} AC, ${req.source}${stored ? `, ${rel} exists` : ""})`);
  const run = createRunDir(cwd, `spec-${story}`);
  const r = await runSpecPass({ cwd, c, engine: engineFor(c), req, story, stored, runDir: run.dir, denyRead: specDenyRead(cwd, c), dryRun: o.dryRun });
  const usage = formatUsage(addUsage(...r.runs));
  if (r.errors.length) {
    log.fail(`requirements pass failed: ${r.errors.slice(0, 5).join("; ")}`);
    return 1;
  }
  if (!r.file) return 0;
  r.changes.forEach((x) => log.warn(`  ${x}`));
  if (stored && renderExpected(stored) === renderExpected(r.file)) {
    log.ok(`${rel} is up to date${r.skipped ? " (no AI run needed)" : ""}`);
    return 0;
  }
  writeExpected(cwd, dir, r.file);
  const unspecified = poQuestions(r.file);
  log.ok(`wrote ${rel}${usage ? ` (${usage})` : ""}`);
  if (unspecified.length) log.info(`Questions for the PO (not tested until answered):\n${unspecified.map((q) => `  - ${q}`).join("\n")}`);
  if (o.commit) {
    git(cwd, ["add", "--", rel]);
    git(cwd, ["commit", "-q", "-m", expectedCommitMessage(req.storyKey ?? story, req.acceptanceCriteria, VERSION, run.id)]);
    log.ok(`committed ${rel}`);
  } else log.info(`Review ${rel} (merging it approves its ready values), then commit it in a merge request.`);
  return 0;
}
