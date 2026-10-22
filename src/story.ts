import fs from "node:fs";
import path from "node:path";
import type { Config, ServiceConfig } from "./config.js";
import { type ChangeSet, changeSet, git } from "./git.js";
import { matchesAny } from "./fsutil.js";
import { assembleFeature, featureStatus, targetRefOf, type FeatureManifest, type ServicePart } from "./feature/manifest.js";
import { pushUrl, type GitLabContext } from "./scm/gitlab.js";
import { inputToServicePart } from "./stories/parts.js";
import type { StoryRecord } from "./stories/record.js";
import { isGitRepo } from "./git.js";

/**
 * Story mode: one analysis (and one test MR) for everything a story changed, across all its service repos.
 * The parts come from the story record (kept by the merge-request sweep) or the feature manifest (merge requests, or
 * branches and commits carrying the story key). Each merge request is its own range: the story's change is the union
 * of the ranges, never "everything since the first story commit", so unrelated work merged in between is left out.
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
  /** Which range this is: "orders-service !12 merged". */
  label: string;
}

const keyRe = (key: string) => new RegExp(`(^|[^A-Za-z0-9])${key.replace(/[-]/g, "\\-")}(?![0-9])`, "i");

const tryGit = (repo: string, args: string[]) => {
  try {
    return git(repo, args);
  } catch {
    return "";
  }
};

const known = (repo: string, sha: string | undefined) => !!sha && tryGit(repo, ["rev-parse", "--verify", "-q", `${sha}^{commit}`]) !== "";

export interface StoryRangeRef {
  base: string;
  head: string;
}

/**
 * Local fallback for work that is on the target branch: walk the first-parent line (the last `limit` commits) from
 * `tip`; every commit whose message names the story, or whose merged side does, is its own range (a merge commit's
 * M^1..M, a squash commit's S^..S). Commits in a row make one range. The ranges are NOT required to touch: unrelated
 * work between two of them stays out. Revert commits are not story work. Newest first.
 */
export function storyRanges(repo: string, story: string, tip: string, limit = 500): StoryRangeRef[] {
  const re = keyRe(story);
  const rows = tryGit(repo, ["log", "--first-parent", "-n", String(limit), tip, "--format=%H%x09%P%x09%s %b%x1e"])
    .split("\x1e")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.split("\t"));
  const out: StoryRangeRef[] = [];
  for (const [sha, parentLine = "", message = ""] of rows) {
    const parents = parentLine.split(" ").filter(Boolean);
    if (/^Revert\b/i.test(message.trim())) continue;
    const mergedSide = parents.length > 1 && tryGit(repo, ["log", `${parents[0]}..${parents[1]}`, "--format=%s %b%x1e"]).split("\x1e").some((m) => re.test(m));
    if (!re.test(message) && !mergedSide) continue;
    const last = out[out.length - 1];
    if (last && last.base === sha) last.base = parents[0] ?? sha; // the commit just below the previous range: one range
    else out.push({ base: parents[0] ?? sha, head: sha });
  }
  return out;
}

/**
 * The story's change in one repo, for callers that have only a tip:
 * - merged (tip on the main line): the newest range from `storyRanges`;
 * - not merged (a branch): from the parent of the oldest commit naming the story to the tip.
 */
export function storyRange(repo: string, story: string, tip: string, merged = false): { base: string; head: string } | undefined {
  const re = keyRe(story);
  if (merged) {
    const r = storyRanges(repo, story, tip)[0];
    if (r) return r;
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

/** An open merge request's head: fetched with a one-off token URL (the token never goes into .git/config), else the commit we already know. */
function fetchMrHead(repo: string, c: Config, service: ServiceConfig, p: ServicePart): string | undefined {
  if (p.mr) {
    const projectPath = service.gitlabProject && !/^\d+$/.test(service.gitlabProject) ? service.gitlabProject : undefined;
    const remote = pushUrl(c.ci.gitlabUrl, projectPath) ?? "origin";
    try {
      git(repo, ["fetch", "-q", remote, `refs/merge-requests/${p.mr.iid}/head`]);
      return git(repo, ["rev-parse", "FETCH_HEAD"]);
    } catch {
      // not fetchable (no token, no such ref): use the commit we know
    }
  }
  return known(repo, p.sha) ? p.sha : undefined;
}

export async function storyParts(i: { c: Config; cwd: string; story: string; gitlab?: GitLabContext; record?: StoryRecord }): Promise<{ parts: StoryPart[]; manifest: FeatureManifest; notes: string[] }> {
  // Local clones are the source of truth for diffs; the record or GitLab only say which merge requests belong to the story.
  const fromRecord = (i.record?.parts ?? []).filter((p) => p.state !== "closed");
  let manifest: FeatureManifest;
  if (fromRecord.length) {
    const parts = fromRecord.map(inputToServicePart);
    manifest = { story: i.story, parts, status: featureStatus(parts), notes: [] };
  } else manifest = await assembleFeature({ c: i.c, cwd: i.cwd, story: i.story, gitlab: i.gitlab });
  const notes = [...manifest.notes];
  // One entry per service: the mainline range of each merged MR, and one range for each branch still open.
  const byService = new Map<string, { service: ServiceConfig; repo: string; ranges: { base: string; head: string; merged: boolean; label: string }[] }>();
  const add = (service: ServiceConfig, repo: string, r: StoryRangeRef, merged: boolean, label: string) => {
    const entry = byService.get(service.name) ?? { service, repo, ranges: [] };
    if (!entry.ranges.some((x) => x.base === r.base && x.head === r.head)) entry.ranges.push({ base: r.base, head: r.head, merged, label });
    byService.set(service.name, entry);
  };
  for (const p of manifest.parts) {
    if (p.dropped) continue;
    const service = i.c.workspace.services.find((s) => s.name === p.service);
    if (!service) continue;
    const repo = path.resolve(i.cwd, service.path);
    const name = `${p.service}${p.mr ? ` !${p.mr.iid}` : p.branch ? ` ${p.branch}` : ""}`;
    if (p.reverted) {
      notes.push(`${name} was reverted on the main branch; its change is left out`);
      continue;
    }
    if (!fs.existsSync(repo) || !isGitRepo(repo)) {
      notes.push(`${name}: ${service.path} is not a git clone here; its change is left out`);
      continue;
    }
    const target = targetRefOf(repo, i.c.ci.targetBranch);
    if (p.merged) {
      if (p.source === "gitlab-mr") {
        const sha = p.mergeSha ?? p.squashSha;
        if (sha && known(repo, sha)) add(service, repo, { base: `${sha}^1`, head: sha }, true, `${name} merged`);
        else if (!sha && p.diffRefs && known(repo, p.diffRefs.base) && known(repo, p.diffRefs.head)) add(service, repo, { base: p.diffRefs.base, head: p.diffRefs.head }, true, `${name} merged`);
        else notes.push(`${name}: its commit is not in the clone of ${service.path} (fetch the target branch); skipped`);
      } else {
        const ranges = storyRanges(repo, i.story, target ?? p.sha ?? "HEAD");
        if (!ranges.length) notes.push(`${p.service}: no commit message on ${i.c.ci.targetBranch} mentions ${i.story}; skipped`);
        for (const r of ranges) add(service, repo, r, true, `${name} merged`);
      }
    } else {
      const head = fetchMrHead(repo, i.c, service, p);
      const range = head ? openRange(repo, i.story, head, target) : undefined;
      if (!range) {
        notes.push(`${name}: ${!head ? "its head commit is not in the clone" : `no common commit with ${i.c.ci.targetBranch}`}; skipped`);
        continue;
      }
      add(service, repo, range, false, `${name} open`);
    }
  }
  const parts: StoryPart[] = [];
  for (const { service, repo, ranges } of byService.values()) {
    const sets = ranges.map((r) => changeSet(repo, r.base, r.head));
    const files = [...new Set(sets.flatMap((x) => x.files))];
    const diff = sets.length === 1 ? sets[0].diff : sets.map((x) => `# ----- ${x.base.slice(0, 8)}..${x.head.slice(0, 8)} -----\n${x.diff}`).join("\n");
    const cs: ChangeSet = { base: sets[0].base, head: sets[0].head, files, diff };
    parts.push({ service, repo, cs, heads: sets.map((x) => x.head), relevant: files.filter((f) => !matchesAny(f, i.c.agent.skipPaths)), merged: ranges.every((r) => r.merged), label: ranges.length === 1 ? ranges[0].label : `${service.name} ${ranges.map((r) => r.label.slice(service.name.length).trim()).join(", ")}` });
  }
  return { parts, manifest, notes };
}

/** The combined view the planner and the author see: one diff with a header per range, files prefixed by service. */
export function combinedChange(story: string, parts: StoryPart[]): { cs: ChangeSet; relevant: string[]; service: ServiceConfig } {
  const diff = parts.map((p) => `# ===== service: ${p.service.name} (${p.service.path})${p.label ? ` · ${p.label.startsWith(p.service.name) ? p.label.slice(p.service.name.length).trim() || "change" : p.label}` : ""} ${p.cs.base.slice(0, 8)}..${p.cs.head.slice(0, 8)} =====\n${p.cs.diff}`).join("\n");
  const relevant = [...new Set(parts.flatMap((p) => p.relevant.map((f) => `${p.service.name}/${f}`)))];
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
