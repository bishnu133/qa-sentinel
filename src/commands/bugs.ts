import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../config.js";
import { indexTests } from "../analysis/testIndex.js";
import { matchResult, readRunResults } from "../showcase/results.js";
import { bugsFromResults, fileBugs, noteFixedBugs } from "../bugs/bugs.js";
import { fetchIssue, jiraContext } from "../scm/jira.js";
import { jiraIssueText, parseStoryFor } from "../requirements.js";
import { runCommandsFor } from "../layers.js";
import { useEnvironment } from "../run.js";
import { log } from "../log.js";

export interface BugsOptions {
  cwd: string;
  story?: string[];
  results?: string;
  env?: string;
  dryRun?: boolean;
}

/**
 * `qa-sentinel bugs`: after a suite run on a lower environment, raise a bug for every story requirement whose
 * tests fail (bugs.mode: suggest | create), once; and note "verified fixed" on earlier bugs whose tests now pass.
 */
export async function bugsCommand(o: BugsOptions): Promise<number> {
  const cwd = path.resolve(o.cwd);
  const c = loadConfig(cwd);
  if (c.bugs.mode === "off" && !o.dryRun) {
    log.info("bugs.mode is off in qa-sentinel.config.yaml (suggest | create); nothing to do. Use --dry-run to preview.");
    return 0;
  }
  const environment = o.env || c.verification.defaultEnvironment ? useEnvironment(c, o.env, {}) : undefined;
  const file = path.resolve(cwd, o.results ?? "test-results/results.json");
  const mobileDir = c.tests.mobile.enabled ? path.join(cwd, "test-results/mobile") : undefined;
  const haveMobile = Boolean(mobileDir && fs.existsSync(mobileDir));
  if (!fs.existsSync(file) && !haveMobile) throw new Error(`No test results at ${path.relative(cwd, file)}`);
  const results = [...(fs.existsSync(file) ? readRunResults(file) : []), ...(haveMobile ? readRunResults(mobileDir!) : [])];
  const index = indexTests(cwd, c);
  const ctx = jiraContext(c.requirements.jira.baseUrl);
  if (!ctx && !o.dryRun) throw new Error("Jira is not configured (requirements.jira.baseUrl + JIRA_EMAIL/JIRA_API_TOKEN or JIRA_PAT)");
  const stories = o.story?.length ? o.story : [...new Set(index.flatMap((t) => t.stories))].sort();
  let raised = 0;
  for (const story of stories) {
    try {
      const issue = ctx ? await fetchIssue(ctx, story, c.requirements.jira.acceptanceCriteriaField, c.requirements.jira.scopeFields.map((f) => f.field)) : undefined;
      const text = issue ? jiraIssueText(c, issue) : "";
      const parsed = parseStoryFor(c, text);
      const items = [...parsed.acceptanceCriteria, ...parsed.scopeItems];
      const candidates = bugsFromResults(c, story, items, index, results, { environment, runCommand: (t) => runCommandsFor(c, [`${t.file}:${t.line}`])[0] });
      if (o.dryRun || !ctx) {
        candidates.forEach((b) => log.info(`  ${story} ${b.item}: would raise "${b.title}" (actual: ${b.actual})`));
        continue;
      }
      const r = await fileBugs(ctx, c, story, candidates);
      raised += r.created.length;
      if (r.created.length) log.ok(`  ${story}: bug(s) created ${r.created.join(", ")}`);
      if (r.suggested) log.ok(`  ${story}: ${r.suggested} bug(s) proposed in a comment`);
      r.skipped.forEach((s) => log.dim(`  ${story}: ${s}`));
      // Requirements whose tests all ran and passed in this run: earlier bugs get a "now passes" note.
      const passing = items
        .map((it) => it.id)
        .filter((id) => {
          const ts = index.filter((t) => t.stories.includes(story) && t.acs.includes(id) && t.status === "active");
          return ts.length > 0 && ts.every((t) => matchResult(results, t)?.status === "passed");
        });
      const fixed = await noteFixedBugs(ctx, story, passing, environment);
      if (fixed.length) log.ok(`  ${story}: noted as passing on ${fixed.join(", ")}`);
    } catch (e) {
      log.warn(`  ${story}: ${(e as Error).message}`);
    }
  }
  log.ok(`bugs: ${raised} created`);
  return 0;
}
