import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../config.js";
import { git, resolveSha, workingChanges } from "../git.js";
import { matchesAny } from "../fsutil.js";
import { ARTIFACT_GLOBS, createRunDir } from "../run.js";
import { engineFor } from "../engines/ClaudeCodeEngine.js";
import type { AgentEngine } from "../engines/AgentEngine.js";
import { addUsage } from "../engines/AgentEngine.js";
import { formatUsage } from "../claude.js";
import { createOrUpdateMergeRequest, gitlabContext, pushUrl } from "../scm/gitlab.js";
import { agentCommits, parseSince, targetRef } from "./metrics.js";
import { LESSONS_FILE, applyLessons, learnLessons, lessonHeadings, processedCommits, reviewerEdits } from "../review/lessons.js";
import { ensureAgentFiles } from "./init.js";
import { log } from "../log.js";

export interface LessonsOptions {
  cwd: string;
  since?: string;
  push?: boolean;
  dryRun?: boolean;
  /** Tests inject a fake engine. */
  engine?: AgentEngine;
}

/**
 * `qa-sentinel lessons`: learn from how QA engineers edited agent MRs before merging them. Finds agent commits merged
 * with edits that haven't been learned from yet, asks an agent for general rules (one-off fixes are skipped), and
 * proposes them in kb/review-lessons.md on a branch (and an MR with --push). Every agent reads kb/ on its next run.
 */
export async function lessonsCommand(o: LessonsOptions): Promise<number> {
  const cwd = path.resolve(o.cwd);
  const c = loadConfig(cwd);
  const target = targetRef(cwd, c.ci.targetBranch);
  if (!target) throw new Error(`target branch ${c.ci.targetBranch} not found; fetch it first`);
  const lessonsPath = path.join(c.knowledge.dir, LESSONS_FILE);
  const current = fs.existsSync(path.join(cwd, lessonsPath)) ? fs.readFileSync(path.join(cwd, lessonsPath), "utf8") : undefined;
  const done = processedCommits(current);
  const commits = agentCommits(cwd, target, parseSince(o.since)).filter((x) => x.state === "merged-edited" && !done.has(x.sha.slice(0, 8)));
  const edits = reviewerEdits(cwd, commits);
  log.step(`lessons: ${edits.length} agent MR(s) merged with reviewer edits not learned from yet${done.size ? ` (${done.size} already in ${lessonsPath})` : ""}`);
  if (!edits.length) {
    log.ok("nothing new to learn: no agent MR was edited before merge since the last run");
    return 0;
  }
  // qa-sentinel's own agents and skills may be new after an upgrade (not committed yet): not the team's work in progress.
  const OWN = [".claude/agents/**", ".claude/skills/**"];
  if (workingChanges(cwd).some((x) => !matchesAny(x.path, [...ARTIFACT_GLOBS, ...OWN]))) throw new Error("The test repo has uncommitted changes; commit or stash them first.");
  const run = createRunDir(cwd, "lessons");
  if (o.dryRun) {
    for (const e of edits) log.info(`  ${e.sha.slice(0, 8)} ${e.subject} (${e.how}; reviewer changed ${e.files.join(", ")})`);
    return 0;
  }
  ensureAgentFiles(cwd, c);
  const start = resolveSha(cwd, "HEAD");
  // What was already changed before the agent ran (e.g. a skill this version just added) is not the agent's doing.
  const before = new Set(workingChanges(cwd).map((x) => x.path));
  const r = await learnLessons({ cwd, c, run, engine: o.engine ?? engineFor(c), edits, lessonsPath, existingHeadings: lessonHeadings(current) });
  const usage = formatUsage(addUsage(...r.runs));
  // Read-only agent: nothing in the repo may have changed but its output in the run directory.
  const touched = workingChanges(cwd).filter((x) => !matchesAny(x.path, ARTIFACT_GLOBS) && !before.has(x.path));
  if (touched.length) {
    log.fail(`the agent changed files it must not touch: ${touched.map((x) => x.path).join(", ")}; nothing proposed`);
    git(cwd, ["checkout", "-q", "-f", start]);
    return 1;
  }
  if (!r.lessons) {
    log.fail(`lessons rejected: ${r.errors.slice(0, 3).join("; ")}`);
    return 1;
  }
  const l = r.lessons;
  r.lessons.skipped.forEach((s) => log.dim(`  skipped ${s.commit}: ${s.reason}`));
  // Record every reviewed commit (also the skipped ones), so the next run starts after them.
  const next = applyLessons(current, l, edits.map((e) => e.sha));
  const branch = "qa-sentinel/review-lessons";
  git(cwd, ["checkout", "-q", "-B", branch]);
  fs.mkdirSync(path.dirname(path.join(cwd, lessonsPath)), { recursive: true });
  fs.writeFileSync(path.join(cwd, lessonsPath), next);
  git(cwd, ["add", "--", lessonsPath]);
  const summary = [
    `## Review lessons from ${edits.length} agent MR(s)`,
    "",
    l.lessons.length
      ? `Reviewers changed agent-written tests before merging them. ${l.lessons.length} general lesson(s) for the agents (they read \`${lessonsPath}\` on every run):`
      : "The reviewer edits were one-off fixes; nothing general to learn. The reviewed commits are recorded so they aren't looked at again.",
    "",
    ...l.lessons.map((x) => `- ${x.updates ? `_strengthens_ "${x.updates}"` : `**${x.lesson}**`} (${x.appliesTo}; from ${x.sources.map((s) => s.slice(0, 8)).join(", ")}): ${x.why}`),
    ...(l.skipped.length ? ["", "Skipped:", ...l.skipped.map((s) => `- ${s.commit}: ${s.reason}`)] : []),
    "",
    "Edit or drop any lesson before merging: what is merged is what the agents learn.",
    "",
    `<sub>${usage}</sub>`,
  ].join("\n");
  git(cwd, ["commit", "-q", "-m", `docs(kb): review lessons from ${edits.length} agent MR(s)\n\nProposed by qa-sentinel lessons; a human reviews before merge.`]);
  fs.writeFileSync(path.join(run.dir, "summary.md"), summary);
  fs.writeFileSync(path.join(cwd, "qa-lessons.md"), summary);
  log.ok(`${l.lessons.length} lesson(s), ${l.skipped.length} skipped · committed on ${branch} (${lessonsPath})${usage ? ` · ${usage}` : ""}`);
  if (o.push) {
    const ctx = gitlabContext(c.ci.gitlabUrl);
    const projectPath = c.ci.testRepoProject && !/^\d+$/.test(c.ci.testRepoProject) ? c.ci.testRepoProject : process.env.CI_PROJECT_PATH;
    git(cwd, ["push", "--force", pushUrl(c.ci.gitlabUrl, projectPath) ?? "origin", `HEAD:refs/heads/${branch}`]);
    const project = c.ci.testRepoProject ?? process.env.CI_PROJECT_ID;
    if (ctx && project) {
      const mr = await createOrUpdateMergeRequest(ctx, project, { source: branch, target: c.ci.targetBranch, title: "QA agent: lessons from review", description: summary, labels: ["qa-agent", "qa-sentinel::lessons"] });
      log.ok(`merge request ${mr.action}: ${mr.web_url}`);
    }
  }
  return 0;
}
