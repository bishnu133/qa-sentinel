import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRunDir } from "../run.js";

/**
 * Deferred publishing (F3). With `--defer-publish`, gap-report and generate do their analysis and leave what they
 * would have published in `<run dir>/publish.json` (and, for generate, the branch as `<run dir>/branch.bundle`).
 * `qa-sentinel publish` reads that and does the writing: it needs the write tokens but no model credentials, while
 * the analysis needs the model key and a read token only. Nothing here calls GitLab or Jira.
 */

export const PUBLISH_FILE = "publish.json";
export const PUBLISHED_FILE = "published.json";
export const BUNDLE_FILE = "branch.bundle";

/** A report for the MR note and/or the story in Jira: what `publish()` posts. */
export interface ReportStep {
  type: "report";
  report: string;
  jiraSummary?: string;
  service: string;
  storyKey?: string;
  mr: { project?: string; mrIid?: string; url?: string; title?: string; sourceBranch?: string; targetBranch?: string };
  targets?: ("gitlab-mr" | "jira")[];
  stamp?: string;
}

export interface MrSeenStep {
  type: "mr-seen";
  args: { feature: string; workKey?: string; service: string; mrIid: string | number | undefined; url?: string; title?: string; branch?: string; headSha?: string; keys?: string[] };
}

export interface BugsStep {
  type: "bugs";
  story: string;
  candidates: unknown[];
}

/** The test branch and its merge request (generate). */
export interface MergeRequestStep {
  type: "merge-request";
  branch: string;
  /** The tip of the branch in branch.bundle. */
  headSha: string;
  /** The commit before this run's commits: the policy check looks at base..head. */
  baseSha: string;
  target: string;
  /** The test repo's GitLab project (id or path); empty: taken from ci.testRepoProject / CI_PROJECT_ID at publish time. */
  project?: string;
  /** story: a story branch (pushed only if the server still has `expectSha`); per-merge: the branch is owned by qa-sentinel and may be overwritten. */
  pushMode: "story" | "per-merge";
  expectSha?: string;
  storyKey?: string;
  storyMode: boolean;
  title: string;
  description: string;
  labels: string[];
  /** The test environment URLs the run used (not secrets): the policy check at publish time allows URLs to these hosts. */
  baseUrls?: string[];
  /** Said in Jira when the merge request exists ({mr} is the merge request URL). */
  notify?: { story: string; event: string; text: string; key: string };
  jira?: { storyKey?: string; service: string; risk: string; verification: string; environment?: string; trace: unknown[]; acText: [string, string][]; discrepancies: { test: string; note?: string }[]; weakTests?: number; report: string };
}

export type PublishStep = ReportStep | MrSeenStep | BugsStep | MergeRequestStep;

export interface PublishFile {
  version: 1;
  kind: "gap-report" | "generate";
  runId: string;
  createdAt: string;
  steps: PublishStep[];
}

/** Add steps to a run directory's publish.json (created on the first call). */
export function deferSteps(runDir: string, kind: PublishFile["kind"], runId: string, steps: PublishStep[]): PublishFile {
  const file = path.join(runDir, PUBLISH_FILE);
  let doc: PublishFile = { version: 1, kind, runId, createdAt: new Date().toISOString(), steps: [] };
  try {
    const old = JSON.parse(fs.readFileSync(file, "utf8")) as PublishFile;
    if (old.version === 1 && Array.isArray(old.steps)) doc = old;
  } catch {
    /* new file */
  }
  doc.steps.push(...steps);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(doc, null, 2) + "\n");
  return doc;
}

/** For steps with no run of their own (the joined comment of a merge request that names several stories, a waiting note). */
export function deferInNewRun(cwd: string, kind: PublishFile["kind"], label: string, steps: PublishStep[]): string {
  const run = createRunDir(cwd, label);
  deferSteps(run.dir, kind, run.id, steps);
  return run.dir;
}

/** `git bundle create` of one branch, with its whole history, so the publish job needs nothing from the analysis job but the artifact. */
export function bundleBranch(cwd: string, runDir: string, branch: string): string {
  const file = path.join(runDir, BUNDLE_FILE);
  execFileSync("git", ["bundle", "create", file, `refs/heads/${branch}`], { cwd, stdio: ["ignore", "pipe", "pipe"] });
  return file;
}
