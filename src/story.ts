import path from "node:path";
import type { Config, ServiceConfig } from "./config.js";
import { type ChangeSet, changeSet, git } from "./git.js";
import { matchesAny } from "./fsutil.js";
import { assembleFeature, targetRefOf, type FeatureManifest } from "./feature/manifest.js";
import type { GitLabContext } from "./scm/gitlab.js";

/**
 * Story mode: one analysis (and one test MR) for everything a story changed, across all its service repos.
 * The parts come from the feature manifest (merge requests, or branches and commits carrying the story key);
 * each part's range runs from just before its first story commit to the story's tip in that repo.
 */
export interface StoryPart {
  service: ServiceConfig;
  repo: string;
  /** The service's whole change for the story: its files (each once) and the diffs of all its ranges. `head` is the first range's tip. */
  cs: ChangeSet;
  /** The tip of every range of this service (the merged work, and each branch still open). */
  heads: string[];
  relevant: string[];
  merged: boolean;
}

const keyRe = (key: string) => new RegExp(`(^|[^A-Za-z0-9])${key.replace(/[-]/g, "\\-")}(?![0-9])`, "i");

const tryGit = (repo: string, args: string[]) => {
  try {
    return git(repo, args);
  } catch {
    return "";
  }
};

/**
 * The story's change in one repo, without unrelated work from the main branch:
 * - merged (tip on the main line): walk back along the main line over the story's own commits — commits whose
 *   message names the story, and merge commits whose merged side does — and take that run's net change
 *   (a merge commit's M^1..M, a squash commit's S^..S, fast-forwarded commits in a row);
 * - not merged (a branch): from the parent of the oldest commit naming the story to the tip.
 */
export function storyRange(repo: string, story: string, tip: string, merged = false): { base: string; head: string } | undefined {
  const re = keyRe(story);
  const msg = (sha: string) => tryGit(repo, ["log", "-1", "--format=%s %b", sha]);
  if (merged) {
    const line = tryGit(repo, ["rev-list", "--first-parent", "--parents", tip]).split("\n").filter(Boolean);
    let base: string | undefined;
    for (const row of line) {
      const [sha, ...parents] = row.split(" ");
      const own = re.test(msg(sha));
      const mergedSide = parents.length > 1 && tryGit(repo, ["log", `${parents[0]}..${parents[1]}`, "--format=%s %b%x1e"]).split("\x1e").some((m) => re.test(m));
      if (!own && !mergedSide) break;
      base = parents[0] ?? sha;
    }
    if (base) return { base, head: tip };
  }
  const commits = tryGit(repo, ["log", tip, "--format=%H%x09%P%x09%s %b%x1e"])
    .split("\x1e")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.split("\t"))
    .filter(([, , m]) => re.test(m ?? ""));
  if (!commits.length) return undefined;
  const oldest = commits[commits.length - 1];
  const parent = (oldest[1] ?? "").split(" ")[0];
  return { base: parent || oldest[0], head: tip };
}

/**
 * A branch still open: from where it left the target branch to its tip. Walking back from the tip along commit
 * messages would pick up the story's earlier, merged commits and with them the unrelated work merged in between.
 */
export function openRange(repo: string, story: string, tip: string, target: string | undefined): { base: string; head: string } | undefined {
  if (target) {
    const base = tryGit(repo, ["merge-base", target, tip]).trim();
    if (base && base !== tip) return { base, head: tip };
  }
  return storyRange(repo, story, tip, false);
}

export async function storyParts(i: { c: Config; cwd: string; story: string; gitlab?: GitLabContext }): Promise<{ parts: StoryPart[]; manifest: FeatureManifest; notes: string[] }> {
  // Local clones are the source of truth for diffs; GitLab only helps find parts whose repo isn't checked out.
  const manifest = await assembleFeature({ c: i.c, cwd: i.cwd, story: i.story });
  const notes = [...manifest.notes];
  // One entry per service: the mainline range for the merged work, and one range for each branch still open.
  const byService = new Map<string, { service: ServiceConfig; repo: string; ranges: { base: string; head: string; merged: boolean }[] }>();
  for (const p of manifest.parts) {
    const service = i.c.workspace.services.find((s) => s.name === p.service)!;
    const repo = path.resolve(i.cwd, service.path);
    if (!p.sha) {
      notes.push(`${p.service}: no commit found for ${i.story}`);
      continue;
    }
    const range = p.merged ? storyRange(repo, i.story, p.sha, true) : openRange(repo, i.story, p.sha, targetRefOf(repo, i.c.ci.targetBranch));
    if (!range) {
      notes.push(`${p.service}: no commit message mentions ${i.story}; skipped`);
      continue;
    }
    const entry = byService.get(service.name) ?? { service, repo, ranges: [] };
    if (!entry.ranges.some((r) => r.base === range.base && r.head === range.head)) entry.ranges.push({ ...range, merged: p.merged });
    byService.set(service.name, entry);
  }
  const parts: StoryPart[] = [];
  for (const { service, repo, ranges } of byService.values()) {
    const sets = ranges.map((r) => changeSet(repo, r.base, r.head));
    const files = [...new Set(sets.flatMap((x) => x.files))];
    const diff = sets.length === 1 ? sets[0].diff : sets.map((x) => `# ----- ${x.base.slice(0, 8)}..${x.head.slice(0, 8)} -----\n${x.diff}`).join("\n");
    const cs: ChangeSet = { base: sets[0].base, head: sets[0].head, files, diff };
    parts.push({ service, repo, cs, heads: sets.map((x) => x.head), relevant: files.filter((f) => !matchesAny(f, i.c.agent.skipPaths)), merged: ranges.every((r) => r.merged) });
  }
  return { parts, manifest, notes };
}

/** The combined view the planner and the author see: one diff with a header per service, files prefixed by service. */
export function combinedChange(story: string, parts: StoryPart[]): { cs: ChangeSet; relevant: string[]; service: ServiceConfig } {
  const diff = parts.map((p) => `# ===== service: ${p.service.name} (${p.service.path}) ${p.cs.base.slice(0, 8)}..${p.cs.head.slice(0, 8)} =====\n${p.cs.diff}`).join("\n");
  const relevant = parts.flatMap((p) => p.relevant.map((f) => `${p.service.name}/${f}`));
  const service: ServiceConfig = {
    name: `story-${story}`,
    path: parts[0]?.service.path ?? ".",
    // The story is tested through the UI its parts have: web first, then the app, else the API.
    kind: parts.some((p) => p.service.kind === "web") ? "web" : parts.some((p) => p.service.kind === "mobile") ? "mobile" : "api",
    routes: [...new Set(parts.flatMap((p) => p.service.routes))],
    dependsOn: [...new Set(parts.flatMap((p) => p.service.dependsOn))],
  };
  return { cs: { base: parts.map((p) => p.cs.base.slice(0, 8)).join(","), head: story, files: relevant, diff }, relevant, service };
}
