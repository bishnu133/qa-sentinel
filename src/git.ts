import { execFileSync } from "node:child_process";
import path from "node:path";

export function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: env ?? process.env, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/**
 * Git reports paths from the repository root; qa-sentinel works with paths relative to its folder (the test repo may
 * be a folder of a monorepo, e.g. packages/api-tests). These convert root paths to folder paths: files elsewhere in the
 * repo come back as ../…, so guards see them as outside the test repo.
 */
const prefixes = new Map<string, string>();
export function repoPrefix(cwd: string): string {
  const key = cwd;
  if (!prefixes.has(key)) {
    let p = "";
    try {
      p = git(cwd, ["rev-parse", "--show-prefix"]);
    } catch {
      // not a repo: no prefix
    }
    prefixes.set(key, p.replace(/\/$/, ""));
  }
  return prefixes.get(key)!;
}
export function fromRoot(cwd: string, p: string): string {
  const prefix = repoPrefix(cwd);
  if (!prefix) return p;
  if (p === prefix) return ".";
  if (p.startsWith(`${prefix}/`)) return p.slice(prefix.length + 1);
  return path.posix.relative(prefix, p);
}

export function toplevel(cwd: string): string | undefined {
  try {
    return git(cwd, ["rev-parse", "--show-toplevel"]);
  } catch {
    return undefined;
  }
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
  // --relative: a service that is a folder of a monorepo sees only its own changes, with paths from its folder.
  const files = git(repo, ["-c", "core.quotePath=false", "diff", "--relative", "--name-only", range]).split("\n").filter(Boolean);
  const diff = git(repo, ["diff", "--relative", "--unified=5", range]);
  return { base, head, files, diff };
}

export function shortSha(repo: string, ref = "HEAD"): string {
  return git(repo, ["rev-parse", "--short", ref]);
}

/**
 * Make sure the working tree the agent reads is exactly `sha`. Without this the agent could read newer code
 * than the diff it was given. With `checkout`, a clean tree is moved to a detached HEAD at `sha`.
 */
export function ensureAtCommit(repo: string, sha: string, checkout: boolean, testRepo?: string): void {
  const current = resolveSha(repo, "HEAD");
  if (current === sha) return;
  // A service and the test repo in one repository: checking out the service's commit would move the tests too.
  if (checkout && testRepo && toplevel(repo) && toplevel(repo) === toplevel(testRepo))
    throw new Error(`${repo} and the test repo are in the same repository; check out ${sha.slice(0, 12)} yourself (CI already has it) and run without --checkout.`);
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

/** Files the OS drops into folders (Finder, Explorer): never anyone's work, so never a change. */
export const OS_JUNK = /(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini)$/i;

/** Uncommitted changes (tracked + untracked), parsed from `git status -z` so paths are never mangled. OS junk is skipped. */
export function workingChanges(repo: string): FileChange[] {
  const raw = execFileSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const out: FileChange[] = [];
  const entries = raw.split("\0").filter(Boolean);
  for (let i = 0; i < entries.length; i++) {
    const xy = entries[i].slice(0, 2);
    const p = entries[i].slice(3);
    const letter = xy === "??" ? "?" : (xy.trim()[0] ?? "M");
    if (letter === "R" || letter === "C") {
      out.push({ path: fromRoot(repo, p), status: letter, from: fromRoot(repo, entries[i + 1]) });
      i++;
    } else {
      out.push({ path: fromRoot(repo, p), status: letter });
    }
  }
  return out.filter((c) => !OS_JUNK.test(c.path));
}

/** Paths with uncommitted changes, including both sides of renames. */
export function changedFiles(repo: string): string[] {
  return [...new Set(workingChanges(repo).flatMap((c) => (c.from && c.status === "R" ? [c.path, c.from] : [c.path])))];
}

/** Files changed between `base` and the working tree (committed + uncommitted), with status. */
export function changesSince(repo: string, base: string): FileChange[] {
  const raw = execFileSync("git", ["diff", "--name-status", "-z", "-M", base], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const parts = raw.split("\0").filter(Boolean);
  const out: FileChange[] = [];
  for (let i = 0; i < parts.length; i++) {
    const letter = parts[i][0];
    if (letter === "R" || letter === "C") {
      out.push({ path: fromRoot(repo, parts[i + 2]), status: letter, from: fromRoot(repo, parts[i + 1]) });
      i += 2;
    } else {
      out.push({ path: fromRoot(repo, parts[i + 1]), status: letter });
      i += 1;
    }
  }
  const untracked = workingChanges(repo).filter((c) => c.status === "?");
  return [...out, ...untracked.filter((u) => !out.some((o) => o.path === u.path))];
}

/**
 * Files changed between two commits (no working tree), in the WHOLE repository: in a monorepo the test repo is a
 * folder, and a change outside it (../ci/deploy.sh) must still reach the write policy, which sees it as outside.
 */
export function changesBetween(repo: string, from: string, to: string): FileChange[] {
  const raw = execFileSync("git", ["diff", "--name-status", "-z", "-M", from, to], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const parts = raw.split("\0").filter(Boolean);
  const out: FileChange[] = [];
  for (let i = 0; i < parts.length; i++) {
    const letter = parts[i][0];
    if (letter === "R" || letter === "C") {
      out.push({ path: fromRoot(repo, parts[i + 2]), status: letter, from: fromRoot(repo, parts[i + 1]) });
      i += 2;
    } else {
      out.push({ path: fromRoot(repo, parts[i + 1]), status: letter });
      i += 1;
    }
  }
  return out;
}

/** Paths whose mode in `to` is a symbolic link (120000) or a submodule (160000): the write policy never allows an agent to add those. */
export function specialModes(repo: string, from: string, to: string): { path: string; kind: "symlink" | "submodule" }[] {
  const raw = execFileSync("git", ["diff", "--raw", "-z", "--no-renames", from, to], { cwd: repo, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  const parts = raw.split("\0").filter(Boolean);
  const out: { path: string; kind: "symlink" | "submodule" }[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const newMode = parts[i].split(" ")[1];
    if (newMode === "120000") out.push({ path: fromRoot(repo, parts[i + 1]), kind: "symlink" });
    else if (newMode === "160000") out.push({ path: fromRoot(repo, parts[i + 1]), kind: "submodule" });
  }
  return out;
}

/** File content at a ref, or undefined if it did not exist there. */
export function showFile(repo: string, ref: string, file: string): string | undefined {
  try {
    // ref:./path is relative to the folder we're in (ref:path would be from the repo root).
    return execFileSync("git", ["show", `${ref}:./${file}`], { cwd: repo, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return undefined;
  }
}

export function hasChanges(repo: string): boolean {
  // Only this folder: in a monorepo, work in other packages is not ours to worry about.
  return git(repo, ["status", "--porcelain", "--", "."]).length > 0;
}

/** Commit subjects and bodies in base..head (story keys often live here). */
export function commitMessages(repo: string, base: string, head: string): string[] {
  try {
    return execFileSync("git", ["log", "--format=%B%x00", `${base}..${head}`], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
      .split("\0")
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 50);
  } catch {
    return [];
  }
}

/**
 * The working tree must contain `sha` (story mode reads the code as of the story's tip): fine when HEAD is that
 * commit or a descendant (e.g. main after the merge); else check it out when allowed.
 */
export function atLeast(repo: string, sha: string, checkout: boolean, testRepo?: string): void {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", sha, "HEAD"], { cwd: repo, stdio: "ignore" });
    return;
  } catch {
    ensureAtCommit(repo, sha, checkout, testRepo);
  }
}
