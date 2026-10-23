import { execFileSync } from "node:child_process";
import { git } from "../git.js";

/**
 * Git facts for releases and hotfixes, worked out by code (no AI): which commit on the main branch is the
 * cherry-pick of a hotfix commit, which commits revert another, and whether a commit is part of a release tag.
 */

const FULL = /^[0-9a-f]{40}$/i;
const ok = (repo: string, args: string[]) => {
  try {
    git(repo, args);
    return true;
  } catch {
    return false;
  }
};

/** The commit a `git cherry-pick -x` line names. */
export const cherryPickedFrom = (message: string): string[] => [...message.matchAll(/\(cherry picked from commit ([0-9a-f]{7,40})\)/gi)].map((m) => m[1].toLowerCase());

/** The commits a revert message names ("This reverts commit <sha>."). */
export const revertedBy = (message: string): string[] => [...message.matchAll(/This reverts commit ([0-9a-f]{7,40})/gi)].map((m) => m[1].toLowerCase());

/** `git patch-id --stable` of one commit: the same change on another branch has the same id, whatever its line numbers. */
export function patchId(repo: string, sha: string): string | undefined {
  try {
    const diff = execFileSync("git", ["show", "--no-color", sha], { cwd: repo, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
    const out = execFileSync("git", ["patch-id", "--stable"], { cwd: repo, input: diff, encoding: "utf8" }).trim();
    return out.split(/\s+/)[0] || undefined;
  } catch {
    return undefined;
  }
}

/** Patch ids of the latest `limit` non-merge commits on `ref`: patch id → commit. */
function patchIdsOn(repo: string, ref: string, limit: number): Map<string, string[]> {
  const out = new Map<string, string[]>();
  try {
    const log = execFileSync("git", ["log", "-p", "--no-color", "--no-merges", "-n", String(limit), ref], { cwd: repo, encoding: "utf8", maxBuffer: 1024 * 1024 * 1024 });
    const ids = execFileSync("git", ["patch-id", "--stable"], { cwd: repo, input: log, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    for (const line of ids.split("\n")) {
      const [id, commit] = line.trim().split(/\s+/);
      if (id && commit) out.set(id, [...(out.get(id) ?? []), commit]);
    }
  } catch {
    /* an empty ref or a repo without history: no matches */
  }
  return out;
}

export interface CherryPick {
  /** The commit on the target branch. */
  commit: string;
  how: "cherry-pick -x line" | "same change (patch id)";
}

/**
 * The commits on `target` that are cherry-picks of `sha`: those whose message says "(cherry picked from commit sha)"
 * and those with the same patch id (a plain `git cherry-pick`, or one that resolved conflicts the same way).
 */
export function findCherryPicks(repo: string, sha: string, target: string, limit = 500): CherryPick[] {
  const full = git(repo, ["rev-parse", "--verify", `${sha}^{commit}`]);
  const found = new Map<string, CherryPick>();
  const messages = git(repo, ["log", "-n", String(limit), "--format=%H%x09%B%x1e", target]).split("\x1e").map((x) => x.trim()).filter(Boolean);
  for (const m of messages) {
    const [commit, ...rest] = m.split("\t");
    if (commit === full) continue;
    if (cherryPickedFrom(rest.join("\t")).some((p) => full.startsWith(p))) found.set(commit, { commit, how: "cherry-pick -x line" });
  }
  const id = patchId(repo, full);
  if (id) for (const c of patchIdsOn(repo, target, limit).get(id) ?? []) if (c !== full && !found.has(c)) found.set(c, { commit: c, how: "same change (patch id)" });
  return [...found.values()];
}

/** Refs come from the command line: never let one be read by git as an option. */
export function safeRef(ref: string, what = "ref"): string {
  if (!ref || ref.startsWith("-") || /[\0\n]/.test(ref)) throw new Error(`Not a valid ${what}: ${JSON.stringify(ref)}`);
  return ref;
}

const isShallow = (repo: string) => {
  try {
    return git(repo, ["rev-parse", "--is-shallow-repository"]) === "true";
  } catch {
    return false;
  }
};

/**
 * Is any of these commits reverted by a commit on `target`? Returns the reverting commit. A revert that is itself
 * reverted (the change landed again) does not count. Commits that are not in this clone are ignored.
 */
export interface RevertEntry {
  commit: string;
  reverts: string[];
}

/** The commits of `target` with the commits each one reverts: read once per run and shared (`suite` asks for many stories). */
export function revertEntries(repo: string, target: string, limit = 1000): RevertEntry[] {
  return git(repo, ["log", "-n", String(limit), "--format=%H%x09%B%x1e", target]).split("\x1e").map((x) => x.trim()).filter(Boolean).map((m) => {
    const [commit, ...rest] = m.split("\t");
    return { commit, reverts: revertedBy(rest.join("\t")) };
  });
}

export function findRevert(repo: string, shas: string | string[], target: string, limit = 1000, known?: RevertEntry[]): string | undefined {
  const full: string[] = [];
  for (const sha of Array.isArray(shas) ? shas : [shas]) {
    if (!sha || sha.startsWith("-") || !ok(repo, ["cat-file", "-e", `${sha}^{commit}`])) continue;
    full.push(git(repo, ["rev-parse", "--verify", `${sha}^{commit}`]));
  }
  if (!full.length) return undefined;
  const entries = known ?? revertEntries(repo, target, limit);
  const revertedNow = (sha: string, depth: number): string | undefined =>
    entries.filter((e) => e.reverts.some((r) => sha.startsWith(r))).find((e) => depth > 5 || !revertedNow(e.commit, depth + 1))?.commit;
  for (const sha of full) {
    const r = revertedNow(sha, 0);
    if (r) return r;
  }
  return undefined;
}

/** Is the commit part of `ref` (a release tag or a branch)? undefined when the ref or the commit is not in this clone. */
export function inRef(repo: string, sha: string, ref: string): boolean | undefined {
  if (ref.startsWith("-") || isShallow(repo)) return undefined;
  if (!ok(repo, ["rev-parse", "--verify", "-q", `${ref}^{commit}`]) || !ok(repo, ["cat-file", "-e", `${sha}^{commit}`])) return undefined;
  return ok(repo, ["merge-base", "--is-ancestor", sha, ref]);
}

/** Story keys named in the commit messages between two refs (what a release contains). */
export function storyKeysBetween(repo: string, from: string | undefined, to: string, keyPattern: string): { key: string; commits: string[] }[] {
  const range = from ? `${safeRef(from, "tag")}..${safeRef(to, "tag")}` : safeRef(to, "tag");
  const log = git(repo, ["log", "--format=%H%x09%s %b%x1e", range]).split("\x1e").map((x) => x.trim()).filter(Boolean);
  const re = new RegExp(`(?<![A-Za-z0-9])(${keyPattern})(?![0-9])`, "g");
  const by = new Map<string, string[]>();
  for (const m of log) {
    const [commit, ...rest] = m.split("\t");
    if (/^Revert\b/i.test(rest.join("\t").trim())) continue; // a revert names the story but does not deliver it
    for (const k of new Set([...rest.join("\t").matchAll(re)].map((x) => x[1].toUpperCase()))) by.set(k, [...(by.get(k) ?? []), commit]);
  }
  return [...by].map(([key, commits]) => ({ key, commits })).sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }));
}
