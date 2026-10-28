import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../config.js";
import { indexTests } from "../analysis/testIndex.js";
import { defectStatuses, removeAllMarkers, type DefectStatus } from "../analysis/markers.js";
import { readRunResults } from "../showcase/results.js";
import { git, workingChanges } from "../git.js";
import { matchesAny } from "../fsutil.js";
import { ARTIFACT_GLOBS } from "../run.js";
import { createOrUpdateMergeRequest, gitlabContext, pushUrl } from "../scm/gitlab.js";
import { log } from "../log.js";
import { requireGitlab } from "../scm/provider.js";

export interface KnownDefectsOptions {
  cwd: string;
  results?: string;
  /** Edit the test files: take `test.fail` and the QA-BUG / QA-AGENT comment lines off tests whose bug is fixed. */
  apply?: boolean;
  /** Also commit the edit on a new branch (needs --apply). */
  commit?: boolean;
  /** Also push the branch and open a merge request (needs --commit). */
  push?: boolean;
  branch?: string;
}

const where = (s: DefectStatus) => `${s.test.file}:${s.test.line}`;

/**
 * `qa-sentinel known-defects` (no AI): after a test run, say which known-defect tests (test.fail + a bug link)
 * now pass because the product bug was fixed, and with --apply prepare the change that takes the markers off.
 * Nothing is merged: a person reviews the change, which is the gate.
 */
export async function knownDefectsCommand(o: KnownDefectsOptions): Promise<number> {
  const cwd = path.resolve(o.cwd);
  const c = loadConfig(cwd);
  requireGitlab(c, "known-defects");
  if (o.commit && !o.apply) throw new Error("--commit needs --apply");
  if (o.push && !o.commit) throw new Error("--push needs --commit");
  const file = path.resolve(cwd, o.results ?? "test-results/results.json");
  if (!fs.existsSync(file)) throw new Error(`No test results at ${path.relative(cwd, file)}: run the suite first (PLAYWRIGHT_JSON_OUTPUT_NAME=test-results/results.json npx playwright test --reporter=json; a shell ">" redirect into test-results/ does not work because Playwright empties that folder), or pass --results <file>`);
  const results = readRunResults(file);
  const index = indexTests(cwd, c);
  const all = defectStatuses(index, results);
  if (!all.length) {
    log.info("no known-defect tests (test.fail with a QA-BUG link) found; nothing to do");
    return 0;
  }
  const by = (s: string) => all.filter((x) => x.state === s);
  const fixed = by("fixed");
  log.info(`${all.length} known defect(s): ${fixed.length} fixed, ${by("still-failing").length} still failing (as expected), ${by("inconclusive").length} inconclusive, ${by("not-run").length} not run`);
  for (const s of by("still-failing")) log.dim(`  still there  ${where(s)}  ${s.test.title}${s.test.bug ? `  (${s.test.bug})` : ""}`);
  for (const s of by("not-run")) log.dim(`  not run      ${where(s)}  ${s.test.title} (${s.detail})`);
  for (const s of by("inconclusive")) log.warn(`  inconclusive ${where(s)}  ${s.test.title}: ${s.detail?.slice(0, 160)} (the test failed for another reason; check it before trusting the marker)`);
  for (const s of fixed) log.ok(`  FIXED        ${where(s)}  ${s.test.title}${s.test.bug ? `  (${s.test.bug})` : ""}`);
  if (!fixed.length) return 0;
  if (!o.apply) {
    log.info("run again with --apply to take the markers off the fixed tests (then review the change)");
    return 0;
  }

  if (o.commit) {
    const dirty = workingChanges(cwd).filter((d) => !matchesAny(d.path, [...ARTIFACT_GLOBS, "test-results/**", "playwright-report/**"]));
    if (dirty.length) throw new Error(`--commit needs a clean working tree; these files have changes: ${dirty.slice(0, 5).map((d) => d.path).join(", ")}`);
  }
  const byFile = new Map<string, DefectStatus[]>();
  for (const s of fixed) byFile.set(s.test.file, [...(byFile.get(s.test.file) ?? []), s]);
  const changed: string[] = [];
  const manual: string[] = [];
  const doneTests: DefectStatus[] = [];
  for (const [rel, list] of byFile) {
    const abs = path.resolve(cwd, rel);
    const source = fs.readFileSync(abs, "utf8");
    const r = removeAllMarkers(source, list.map((s) => s.test));
    for (const s of list) {
      if (r.done.has(s.test.line)) doneTests.push(s);
      else manual.push(`${where(s)}: ${r.reasons.get(s.test.line)}`);
    }
    if (r.text !== source) {
      fs.writeFileSync(abs, r.text);
      changed.push(rel);
      log.ok(`  edited ${rel}: ${r.done.size} test(s) now plain tests`);
    }
  }
  manual.forEach((m) => log.warn(`  by hand  ${m}`));
  if (!changed.length) return manual.length ? 1 : 0;
  log.info("review the change (git diff). Run the suite once more: the tests should now pass as normal tests.");
  if (!o.commit) return manual.length ? 1 : 0;

  const date = new Date().toISOString().slice(0, 10);
  const branch = o.branch ?? `qa-sentinel/defect-fixed-${date}`;
  git(cwd, ["checkout", "-q", "-B", branch]);
  git(cwd, ["add", "-A", "--", ...changed]);
  const list = doneTests.map((s) => `- ${s.test.title} (${s.test.bug ?? "no bug link"})`).join("\n");
  const summary = `## Known defects fixed\n\nThese tests were marked as known defects (\`test.fail\`) and now pass because the product bug was fixed. The marker and its \`QA-BUG\` note are removed so they run as normal tests again.\n\n${list}\n${manual.length ? `\nNeeds a person (not changed):\n${manual.map((m) => `- ${m}`).join("\n")}\n` : ""}`;
  git(cwd, ["commit", "-q", "-m", `test: remove known-defect markers (${doneTests.length} fixed)\n\nGenerated by qa-sentinel known-defects; only test.fail markers and QA-BUG notes removed.\n\n${list}`]);
  log.ok(`committed on ${branch}: ${doneTests.length} test(s)`);
  if (o.push) {
    const ctx = gitlabContext(c.ci.gitlabUrl);
    const projectPath = c.ci.testRepoProject && !/^\d+$/.test(c.ci.testRepoProject) ? c.ci.testRepoProject : process.env.CI_PROJECT_PATH;
    git(cwd, ["push", "--force", pushUrl(c.ci.gitlabUrl, projectPath) ?? "origin", `HEAD:refs/heads/${branch}`]);
    const project = c.ci.testRepoProject ?? process.env.CI_PROJECT_ID;
    if (ctx && project) {
      const mr = await createOrUpdateMergeRequest(ctx, project, { source: branch, target: c.ci.targetBranch, title: "QA agent: remove known-defect markers (bugs fixed)", description: summary, labels: ["qa-agent", "qa-sentinel::defects"] });
      log.ok(`merge request ${mr.action}: ${mr.web_url}`);
    }
  }
  return manual.length ? 1 : 0;
}
