import { execFileSync } from "node:child_process";

export function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();
}

export function isGitRepo(cwd: string): boolean {
  try {
    git(cwd, ["rev-parse", "--is-inside-work-tree"]);
    return true;
  } catch {
    return false;
  }
}

export interface ChangeSet {
  base: string;
  head: string;
  files: string[];
  diff: string;
}

/** Diff between merge-base(base, head) and head, like an MR diff. */
export function changeSet(repo: string, base: string, head: string): ChangeSet {
  const range = `${base}...${head}`;
  const files = git(repo, ["diff", "--name-only", range]).split("\n").filter(Boolean);
  const diff = git(repo, ["diff", "--unified=5", range]);
  return { base, head, files, diff };
}

export function shortSha(repo: string, ref = "HEAD"): string {
  return git(repo, ["rev-parse", "--short", ref]);
}

/** Paths with uncommitted changes (tracked or untracked), parsed from `git status -z` without trimming. */
export function changedFiles(repo: string): string[] {
  const raw = execFileSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: repo, encoding: "utf8" });
  const out: string[] = [];
  const entries = raw.split("\0").filter(Boolean);
  for (let i = 0; i < entries.length; i++) {
    const status = entries[i].slice(0, 2);
    out.push(entries[i].slice(3));
    if (status.startsWith("R") || status.startsWith("C")) i++; // skip the rename source
  }
  return out;
}

export function hasChanges(repo: string): boolean {
  return git(repo, ["status", "--porcelain"]).length > 0;
}
