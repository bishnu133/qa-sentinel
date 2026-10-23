import type { Config } from "../config.js";
import { execFileSync } from "node:child_process";
import { latestMrForBranch, pushUrl, type GitLabContext } from "../scm/gitlab.js";
import { log } from "../log.js";

/**
 * The story's test branch: one long-lived branch (and one merge request) per story, `<generation.branchPrefix><KEY>`.
 * It is built on, never rebuilt: each run continues from the branch as it is on the server (reviewers may have added
 * commits), merges the main branch into it, and is pushed only if nobody has pushed to it in the meantime
 * (`--force-with-lease` with the commit the run started from). A plain force push is never used on this branch.
 */

export const storyBranchName = (c: Pick<Config, "generation">, story: string) => `${c.generation.branchPrefix}${story.toUpperCase()}`;

/** A git error with any `user:token@` part of a URL taken out (the push URL carries the token). */
export const redact = (text: string) => text.replace(/\/\/[^@\s/]+@/g, "//***@");

/** git with its messages kept for us to read (a missing remote is expected, not something to print). */
const git = (cwd: string, args: string[], env?: NodeJS.ProcessEnv): string => execFileSync("git", args, { cwd, encoding: "utf8", env: env ?? process.env, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }).trim();

const tryGit = (cwd: string, args: string[], env?: NodeJS.ProcessEnv): string | undefined => {
  try {
    return git(cwd, args, env);
  } catch {
    return undefined;
  }
};

const isAncestor = (cwd: string, a: string, b: string, env?: NodeJS.ProcessEnv) => tryGit(cwd, ["merge-base", "--is-ancestor", a, b], env) !== undefined;

/** Where to fetch from and push to: the test repo's project with the token in a one-off URL (never in .git/config), else `origin`. */
export function remoteFor(c: Config, env: NodeJS.ProcessEnv = process.env): string {
  const projectPath = c.ci.testRepoProject && !/^\d+$/.test(c.ci.testRepoProject) ? c.ci.testRepoProject : env.CI_PROJECT_PATH;
  const url = pushUrl(c.ci.gitlabUrl, projectPath, env);
  if (url?.startsWith("http://") && !warnedHttp) {
    warnedHttp = true;
    log.warn("the push URL is plain http://: the GitLab token travels unencrypted. Use https:// in ci.gitlabUrl.");
  }
  return url ?? "origin";
}
let warnedHttp = false;

export interface RemoteBranch {
  /** The commit the branch is at on the server (undefined: there is no such branch, or the server could not be reached). */
  sha?: string;
  /** The local ref the fetch put it in. */
  ref: string;
  /** The server could not be asked. */
  unreachable?: string;
}

/** Fetch one branch of the remote into `refs/remotes/origin/<name>` (not into .git/config: the URL may carry the token). */
export function fetchBranch(cwd: string, remote: string, name: string, env?: NodeJS.ProcessEnv): RemoteBranch {
  const ref = `refs/remotes/origin/${name}`;
  let listed: string;
  try {
    listed = git(cwd, ["ls-remote", remote, `refs/heads/${name}`], env);
  } catch (e) {
    return { ref, unreachable: redact((e as Error).message.split("\n")[0]), sha: tryGit(cwd, ["rev-parse", "--verify", "-q", ref], env) };
  }
  if (!listed) return { ref };
  try {
    git(cwd, ["fetch", "-q", remote, `+refs/heads/${name}:${ref}`], env);
  } catch (e) {
    return { ref, unreachable: redact((e as Error).message.split("\n")[0]), sha: tryGit(cwd, ["rev-parse", "--verify", "-q", ref], env) };
  }
  return { ref, sha: tryGit(cwd, ["rev-parse", "--verify", "-q", ref], env) };
}

export type PrepareResult =
  | {
      ok: true;
      branch: string;
      /** The commit the branch stands at before this run adds anything (the new commits go on top). */
      base: string;
      /** The branch had work in it already (the server's, or a local one not pushed yet); false: started now from the main branch. */
      existing: boolean;
      /** The commit the branch was at on the server when this run started: the lease for the push (undefined: not on the server). */
      remoteSha?: string;
      /** The earlier test merge request of this story when it was merged or closed (so this branch started again). */
      previousMr?: { iid: number; url: string; state: string };
      /** The main branch was merged into the story branch in this run. */
      mergedMain: boolean;
      notes: string[];
    }
  | { ok: false; reason: "conflict" | "diverged"; branch: string; message: string; files: string[] };

export interface PrepareOptions {
  gitlab?: GitLabContext;
  env?: NodeJS.ProcessEnv;
  /** The test repo's GitLab project (id or path), to ask whether the story's test merge request is still open. */
  project?: string | number;
}

/**
 * Put the test repo on the story's test branch, ready to be built on:
 *  - the branch and its merge request are open: continue from the server's branch (or from a local branch that has
 *    commits not pushed yet), then merge the main branch into it when it is behind;
 *  - there is no branch, or its merge request was merged or closed: start a new one from the main branch.
 * The main branch is never rebased in and nothing is force-pushed. A merge that conflicts is aborted and reported;
 * a person resolves it. Conflicts are never resolved by the AI.
 */
export async function prepareStoryBranch(cwd: string, c: Config, story: string, o: PrepareOptions = {}): Promise<PrepareResult> {
  const env = o.env ? { ...process.env, ...o.env } : undefined;
  const branch = storyBranchName(c, story);
  const target = c.ci.targetBranch;
  const remote = remoteFor(c, o.env ?? process.env);
  const notes: string[] = [];
  const origin = tryGit(cwd, ["symbolic-ref", "-q", "--short", "HEAD"], env) ?? git(cwd, ["rev-parse", "HEAD"], env);

  const t = fetchBranch(cwd, remote, target, env);
  if (t.unreachable) notes.push(`could not fetch ${target} (${t.unreachable}); using the copy already here`);
  const targetRef = t.sha ? t.ref : tryGit(cwd, ["rev-parse", "--verify", "-q", target], env) ? target : undefined;
  if (!targetRef) throw new Error(`The test repo has no ${target} branch (ci.targetBranch) to build the story branch from`);
  const remoteBranch = fetchBranch(cwd, remote, branch, env);
  if (remoteBranch.unreachable) notes.push(`could not fetch ${branch} (${remoteBranch.unreachable})`);
  const localSha = tryGit(cwd, ["rev-parse", "--verify", "-q", `refs/heads/${branch}`], env);

  // Is the story's test merge request still open? The server decides; without GitLab the branch is taken as open.
  let previousMr: { iid: number; url: string; state: string } | undefined;
  let fresh = false;
  if (o.gitlab && o.project !== undefined) {
    try {
      const mr = await latestMrForBranch(o.gitlab, o.project, branch, target);
      if (mr && mr.state !== "opened") {
        previousMr = { iid: mr.iid, url: mr.web_url, state: mr.state };
        fresh = true;
      }
    } catch (e) {
      notes.push(`could not ask GitLab about the merge request of ${branch}: ${(e as Error).message.split("\n")[0]}`);
    }
  }

  let startAt: string | undefined;
  if (!fresh) {
    if (remoteBranch.sha && localSha && remoteBranch.sha !== localSha) {
      if (isAncestor(cwd, remoteBranch.sha, localSha, env)) startAt = localSha; // unpushed commits of a local run
      else if (isAncestor(cwd, localSha, remoteBranch.sha, env)) startAt = remoteBranch.sha;
      else
        return { ok: false, reason: "diverged", branch, files: [], message: `${branch} exists here and on the server with different commits (neither contains the other). A person must reconcile them (for example: git checkout ${branch} && git merge ${remoteBranch.ref}), then run again.` };
    } else startAt = remoteBranch.sha ?? localSha;
    // A branch that holds nothing of ours (all of it is on the main branch already) starts again from the main branch.
    if (startAt && isAncestor(cwd, startAt, targetRef, env)) startAt = undefined;
  }
  const existing = startAt !== undefined;
  git(cwd, ["checkout", "-q", "-B", branch, startAt ?? targetRef], env);

  let mergedMain = false;
  if (existing && !isAncestor(cwd, targetRef, "HEAD", env)) {
    try {
      git(cwd, ["merge", "--no-edit", "-q", targetRef], env);
      mergedMain = true;
    } catch (e) {
      const files = (tryGit(cwd, ["diff", "--name-only", "--diff-filter=U"], env) ?? "").split("\n").filter(Boolean);
      tryGit(cwd, ["merge", "--abort"], env);
      tryGit(cwd, ["checkout", "-q", origin], env);
      return {
        ok: false,
        reason: "conflict",
        branch,
        files,
        message: `merging ${target} into ${branch} conflicts${files.length ? ` in ${files.join(", ")}` : ""}${files.length ? "" : `: ${redact((e as Error).message.split("\n")[0])}`}. A person must resolve it (merge ${target} into ${branch} and push); the AI never resolves conflicts.`,
      };
    }
  }
  const base = git(cwd, ["rev-parse", "HEAD"], env);
  if (previousMr) notes.push(`the earlier test merge request !${previousMr.iid} was ${previousMr.state}; this branch starts again from ${target}`);
  return { ok: true, branch, base, existing, ...(remoteBranch.sha ? { remoteSha: remoteBranch.sha } : {}), ...(previousMr ? { previousMr } : {}), mergedMain, notes };
}

export interface PushResult {
  /** The push needed a second try because somebody pushed to the branch meanwhile. */
  retried: boolean;
  head: string;
}

/**
 * Push HEAD to the story branch only if the server still has the commit this run started from (`expect`; undefined:
 * the branch must not exist yet). If a reviewer pushed meanwhile, fetch their commits, merge them in and try once more.
 * Never a plain `--force`.
 */
export function pushStoryBranch(cwd: string, o: { branch: string; remote: string; expect?: string; env?: NodeJS.ProcessEnv }): PushResult {
  const env = o.env ? { ...process.env, ...o.env } : undefined;
  const push = (expect: string | undefined) => git(cwd, ["push", "-q", `--force-with-lease=refs/heads/${o.branch}:${expect ?? ""}`, o.remote, `HEAD:refs/heads/${o.branch}`], env);
  try {
    push(o.expect);
    return { retried: false, head: git(cwd, ["rev-parse", "HEAD"], env) };
  } catch (first) {
    log.warn(`push of ${o.branch} was refused (${redact((first as Error).message.split("\n").filter((l) => /rejected|stale|fetch first|declined|denied/i.test(l))[0] ?? "see the git message").trim()}); fetching what is there and trying once more`);
    const now = fetchBranch(cwd, o.remote, o.branch, env);
    if (now.sha && !isAncestor(cwd, now.sha, "HEAD", env)) {
      try {
        git(cwd, ["merge", "--no-edit", "-q", now.ref], env);
      } catch {
        tryGit(cwd, ["merge", "--abort"], env);
        throw new Error(`${o.branch} changed on the server while this run was working and the new commits conflict with this run's. Nothing was pushed; a person must merge origin/${o.branch} by hand, then run again.`);
      }
    }
    try {
      push(now.sha);
    } catch (second) {
      throw new Error(`${o.branch} could not be pushed after fetching the server's commits (${redact((second as Error).message.split("\n")[0])}). Nothing was overwritten; run again.`);
    }
    return { retried: true, head: git(cwd, ["rev-parse", "HEAD"], env) };
  }
}
