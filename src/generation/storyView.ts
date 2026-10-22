import fs from "node:fs";
import path from "node:path";
import type { Config } from "../config.js";
import { buildTestIndexAt, indexTests, type IndexedTest } from "../analysis/testIndex.js";
import { expectedDirOf } from "../expected/lock.js";
import { type ExpectedFile, expectedPath, parseExpected } from "../expected/format.js";
import { showFile } from "../git.js";
import { layers } from "../layers.js";
import { latestMrForBranch, type GitLabContext } from "../scm/gitlab.js";
import { fetchBranch, remoteFor, storyBranchName } from "./storyBranch.js";
import { execFileSync } from "node:child_process";

/**
 * What the story's test branch holds, as `stories` and `generate` BOTH read it (one source, so they decide alike):
 * the expected-behaviour file and the tests that are on the branch, not only the ones on the main branch. The branch
 * counts only while it is live: its merge request is open (or there is none yet and the branch exists). When that
 * merge request was merged or closed, the branch is the past: the next run starts again from the main branch.
 */
export interface StoryBranchView {
  branch: string;
  /** The branch exists on the server (or locally) and is not the past of a closed or merged merge request. */
  live: boolean;
  /** The ref to read it at when live. */
  ref?: string;
  /** What GitLab says about the branch's merge request, when asked. */
  mr?: { iid: number; state: string; url: string };
  /** An open merge request exists, but its branch does not. */
  branchGone: boolean;
  notes: string[];
}

export interface ViewOptions {
  gitlab?: GitLabContext;
  project?: string | number;
  env?: NodeJS.ProcessEnv;
}

const rev = (cwd: string, ref: string): string | undefined => {
  try {
    return execFileSync("git", ["rev-parse", "--verify", "-q", ref], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
  } catch {
    return undefined;
  }
};

export async function storyBranchView(cwd: string, c: Config, story: string, o: ViewOptions = {}): Promise<StoryBranchView> {
  const env = o.env ? { ...process.env, ...o.env } : undefined;
  const branch = storyBranchName(c, story);
  const notes: string[] = [];
  const fetched = fetchBranch(cwd, remoteFor(c, o.env ?? process.env), branch, env);
  if (fetched.unreachable) notes.push(`could not fetch ${branch} (${fetched.unreachable}); reading the copy already here`);
  const ref = fetched.sha ? fetched.ref : rev(cwd, `refs/heads/${branch}`) ? `refs/heads/${branch}` : undefined;
  let mr: StoryBranchView["mr"];
  if (o.gitlab && o.project !== undefined) {
    try {
      const m = await latestMrForBranch(o.gitlab, o.project, branch, c.ci.targetBranch);
      if (m) mr = { iid: m.iid, state: m.state, url: m.web_url };
    } catch (e) {
      notes.push(`could not ask GitLab about the merge request of ${branch}: ${(e as Error).message.split("\n")[0]}`);
    }
  }
  const past = mr !== undefined && mr.state !== "opened";
  return { branch, live: Boolean(ref) && !past, ...(ref ? { ref } : {}), ...(mr ? { mr } : {}), branchGone: mr?.state === "opened" && !ref, notes };
}

/**
 * The story's expected-behaviour file: from the live story branch (a reviewer may have edited it there), else from the
 * working tree. `undefined`: none. An unreadable file is `error`, not thrown.
 */
export function storyExpected(cwd: string, c: Config, story: string, view: StoryBranchView | undefined): { file?: ExpectedFile; error?: string } {
  const rel = expectedPath(expectedDirOf(c.tests.expectedDir), story.toUpperCase());
  let text: string | undefined;
  if (view?.live && view.ref) text = showFile(cwd, view.ref, rel);
  if (text === undefined && fs.existsSync(path.join(cwd, rel))) text = fs.readFileSync(path.join(cwd, rel), "utf8");
  if (text === undefined) return {};
  try {
    return { file: parseExpected(text, rel) };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

/** The tests of the working tree plus those of the live story branch (its files win: it has the main branch merged in). */
export function storyTests(cwd: string, c: Config, view: StoryBranchView | undefined): IndexedTest[] {
  const main = indexTests(cwd, c);
  if (!view?.live || !view.ref) return main;
  const onBranch = buildTestIndexAt(cwd, view.ref, layers(c).map((l) => l.dir));
  const files = new Set(onBranch.map((t) => t.file));
  return [...main.filter((t) => !files.has(t.file)), ...onBranch];
}
