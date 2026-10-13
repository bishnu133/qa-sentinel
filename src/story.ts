import path from "node:path";
import type { Config, ServiceConfig } from "./config.js";
import { type ChangeSet, changeSet, git } from "./git.js";
import { matchesAny } from "./fsutil.js";
import { assembleFeature, type FeatureManifest } from "./feature/manifest.js";
import type { GitLabContext } from "./scm/gitlab.js";

/**
 * Story mode: one analysis (and one test MR) for everything a story changed, across all its service repos.
 * The parts come from the feature manifest (merge requests, or branches and commits carrying the story key);
 * each part's range runs from just before its first story commit to the story's tip in that repo.
 */
export interface StoryPart {
  service: ServiceConfig;
  repo: string;
  cs: ChangeSet;
  relevant: string[];
  merged: boolean;
}

const keyRe = (key: string) => new RegExp(`(^|[^A-Za-z0-9])${key.replace(/[-]/g, "\\-")}(?![0-9])`, "i");

/** From the parent of the oldest commit mentioning the story (reachable from tip) to the tip. */
export function storyRange(repo: string, story: string, tip: string): { base: string; head: string } | undefined {
  const re = keyRe(story);
  const commits = git(repo, ["log", tip, "--format=%H%x09%P%x09%s %b%x1e"])
    .split("\x1e")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.split("\t"))
    .filter(([, , msg]) => re.test(msg ?? ""));
  if (!commits.length) return undefined;
  const oldest = commits[commits.length - 1];
  const parent = (oldest[1] ?? "").split(" ")[0];
  return { base: parent || oldest[0], head: tip };
}

export async function storyParts(i: { c: Config; cwd: string; story: string; gitlab?: GitLabContext }): Promise<{ parts: StoryPart[]; manifest: FeatureManifest; notes: string[] }> {
  // Local clones are the source of truth for diffs; GitLab only helps find parts whose repo isn't checked out.
  const manifest = await assembleFeature({ c: i.c, cwd: i.cwd, story: i.story });
  const notes = [...manifest.notes];
  const parts: StoryPart[] = [];
  for (const p of manifest.parts) {
    const service = i.c.workspace.services.find((s) => s.name === p.service)!;
    const repo = path.resolve(i.cwd, service.path);
    if (!p.sha) {
      notes.push(`${p.service}: no commit found for ${i.story}`);
      continue;
    }
    const range = storyRange(repo, i.story, p.sha);
    if (!range) {
      notes.push(`${p.service}: no commit message mentions ${i.story}; skipped`);
      continue;
    }
    const cs = changeSet(repo, range.base, range.head);
    parts.push({ service, repo, cs, relevant: cs.files.filter((f) => !matchesAny(f, i.c.agent.skipPaths)), merged: p.merged });
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
    kind: parts.some((p) => p.service.kind === "web") ? "web" : "api",
    routes: [...new Set(parts.flatMap((p) => p.service.routes))],
    dependsOn: [...new Set(parts.flatMap((p) => p.service.dependsOn))],
  };
  return { cs: { base: parts.map((p) => p.cs.base.slice(0, 8)).join(","), head: story, files: relevant, diff }, relevant, service };
}
