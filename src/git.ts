import { execFileSync } from "node:child_process";

export function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: env ?? process.env }).trim();
}

export function isGitRepo(cwd: string): boolean {
  try {
    git(cwd, ["rev-parse", "--is-inside-work-tree"]);
    return true;
  } catch {
    return false;
  }
}

/** Resolve any ref to a full 40-char commit SHA, with a clear error if it is unknown. */
export function resolveSha(repo: string, ref: string): string {
  try {
    return git(repo, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  } catch {
    throw new Error(`Unknown ref "${ref}" in ${repo}. Is the clone deep enough (GIT_DEPTH=0 / fetch-depth: 0)?`);
  }
}

export interface ChangeSet {
  base: string; // full SHA of the merge base side given
  head: string; // full SHA
  files: string[];
  diff: string;
}

/** Diff between merge-base(base, head) and head, like an MR diff. Refs are resolved to full SHAs first. */
export function changeSet(repo: string, baseRef: string, headRef: string): ChangeSet {
  const base = resolveSha(repo, baseRef);
  const head = resolveSha(repo, headRef);
  const range = `${base}...${head}`;
  const files = git(repo, ["diff", "--name-only", range]).split("\n").filter(Boolean);
  const diff = git(repo, ["diff", "--unified=5", range]);
  return { base, head, files, diff };
}

export function shortSha(repo: string, ref = "HEAD"): string {
  return git(repo, ["rev-parse", "--short", ref]);
}

/**
 * Make sure the working tree the agent reads is exactly `sha`. Without this the agent could read newer code
 * than the diff it was given. With `checkout`, a clean tree is moved to a detached HEAD at `sha`.
 */
export function ensureAtCommit(repo: string, sha: string, checkout: boolean): void {
  const current = resolveSha(repo, "HEAD");
  if (current === sha) return;
  if (!checkout) {
    throw new Error(
      `${repo} is at ${current.slice(0, 12)} but the change being analysed is ${sha.slice(0, 12)}. ` +
        `Check out that commit (git checkout ${sha.slice(0, 12)}) or pass --checkout.`,
    );
  }
  if (hasChanges(repo)) throw new Error(`${repo} has uncommitted changes; refusing to check out ${sha.slice(0, 12)}.`);
  git(repo, ["checkout", "--quiet", "--detach", sha]);
  if (resolveSha(repo, "HEAD") !== sha) throw new Error(`Failed to check out ${sha} in ${repo}`);
}

export interface FileChange {
  path: string;
  /** git status letter: A added, M modified, D deleted, R renamed, C copied, ? untracked */
  status: string;
  /** For renames/copies: the original path (which is also removed for renames). */
  from?: string;
}

/** Uncommitted changes (tracked + untracked), parsed from `git status -z` so paths are never mangled. */
export function workingChanges(repo: string): FileChange[] {
  const raw = execFileSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: repo, encoding: "utf8" });
  const out: FileChange[] = [];
  const entries = raw.split("\0").filter(Boolean);
  for (let i = 0; i < entries.length; i++) {
    const xy = entries[i].slice(0, 2);
    const p = entries[i].slice(3);
    const letter = xy === "??" ? "?" : (xy.trim()[0] ?? "M");
    if (letter === "R" || letter === "C") {
      out.push({ path: p, status: letter, from: entries[i + 1] });
      i++;
    } else {
      out.push({ path: p, status: letter });
    }
  }
  return out;
}

/** Paths with uncommitted changes, including both sides of renames. */
export function changedFiles(repo: string): string[] {
  return [...new Set(workingChanges(repo).flatMap((c) => (c.from && c.status === "R" ? [c.path, c.from] : [c.path])))];
}

/** Files changed between `base` and the working tree (committed + uncommitted), with status. */
export function changesSince(repo: string, base: string): FileChange[] {
  const raw = execFileSync("git", ["diff", "--name-status", "-z", "-M", base], { cwd: repo, encoding: "utf8" });
  const parts = raw.split("\0").filter(Boolean);
  const out: FileChange[] = [];
  for (let i = 0; i < parts.length; i++) {
    const letter = parts[i][0];
    if (letter === "R" || letter === "C") {
      out.push({ path: parts[i + 2], status: letter, from: parts[i + 1] });
      i += 2;
    } else {
      out.push({ path: parts[i + 1], status: letter });
      i += 1;
    }
  }
  const untracked = workingChanges(repo).filter((c) => c.status === "?");
  return [...out, ...untracked.filter((u) => !out.some((o) => o.path === u.path))];
}

/** File content at a ref, or undefined if it did not exist there. */
export function showFile(repo: string, ref: string, file: string): string | undefined {
  try {
    return execFileSync("git", ["show", `${ref}:${file}`], { cwd: repo, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return undefined;
  }
}

export function hasChanges(repo: string): boolean {
  return git(repo, ["status", "--porcelain"]).length > 0;
}

/** Commit subjects and bodies in base..head (story keys often live here). */
export function commitMessages(repo: string, base: string, head: string): string[] {
  try {
    return execFileSync("git", ["log", "--format=%B%x00", `${base}..${head}`], { cwd: repo, encoding: "utf8" })
      .split("\0")
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 50);
  } catch {
    return [];
  }
}
