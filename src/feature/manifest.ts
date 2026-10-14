import fs from "node:fs";
import path from "node:path";
import type { Config, ServiceConfig } from "../config.js";
import { git, isGitRepo } from "../git.js";
import { call, type GitLabContext } from "../scm/gitlab.js";

/**
 * Feature manifest: one story, many services. Assembled automatically (nobody hand-writes YAML per feature):
 * the story key is found in merge requests (GitLab) or in branch names and commit messages (local git), and each
 * service's deployed commit is read from its version endpoint in an environment. A feature is ready for its
 * end-to-end tests only when every service's change is merged AND deployed to that environment.
 */

export interface ServicePart {
  service: string;
  source: "gitlab-mr" | "git";
  mr?: { iid: number; url: string; state: string; title: string };
  branch?: string;
  /** The commit that carries the change on the target branch (merge commit) or the branch tip when not merged. */
  sha?: string;
  merged: boolean;
  deployed?: { environment: string; sha?: string; includesChange?: boolean; error?: string };
}

export type FeatureStatus = "no-changes-found" | "in-development" | "waiting-for-deployment" | "ready-for-feature-tests" | "merged";

export interface FeatureManifest {
  story: string;
  environment?: string;
  parts: ServicePart[];
  status: FeatureStatus;
  notes: string[];
}

const keyRe = (key: string) => new RegExp(`(^|[^A-Za-z0-9])${key.replace(/[-]/g, "\\-")}(?![0-9])`, "i");

/** Local git: branches named after the story, or commits that mention it. */
export function partFromGit(repo: string, s: ServiceConfig, story: string, targetBranch: string): ServicePart | undefined {
  if (!isGitRepo(repo)) return undefined;
  const re = keyRe(story);
  const branches = git(repo, ["for-each-ref", "--format=%(refname:short)%09%(objectname)", "refs/heads", "refs/remotes"])
    .split("\n")
    .filter(Boolean)
    .map((l) => l.split("\t"))
    .filter(([name]) => re.test(name));
  // git's --grep matches substrings (SHOP-1 would find SHOP-106), so check each message with the exact-key regex.
  const commits = git(repo, ["log", "--all", "--format=%H%x09%s %b%x1e", "-i", `--grep=${story}`])
    .split("\x1e")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.split("\t"))
    .filter(([, msg]) => re.test(msg ?? ""))
    .map(([sha]) => sha);
  if (!branches.length && !commits.length) return undefined;
  const target = ["origin/" + targetBranch, targetBranch].find((b) => {
    try {
      git(repo, ["rev-parse", "--verify", "-q", b]);
      return true;
    } catch {
      return false;
    }
  });
  const tip = branches[0]?.[1] ?? commits[0];
  const onTarget = (sha: string) => {
    if (!target) return false;
    try {
      git(repo, ["merge-base", "--is-ancestor", sha, target]);
      return true;
    } catch {
      return false;
    }
  };
  // The tip of the story's work: a deployment includes the change exactly when it contains this commit.
  return { service: s.name, source: "git", branch: branches[0]?.[0], sha: tip, merged: onTarget(tip) };
}

/** GitLab: merge requests whose title, description or source branch carry the story key. */
export async function partFromGitLab(ctx: GitLabContext, s: ServiceConfig, story: string): Promise<ServicePart | undefined> {
  if (!s.gitlabProject) return undefined;
  const { data } = await call(ctx, "GET", `/projects/${encodeURIComponent(s.gitlabProject)}/merge_requests?search=${encodeURIComponent(story)}&in=title,description&state=all&per_page=50`);
  const re = keyRe(story);
  const mrs = (data as any[]).filter((m) => re.test(m.title ?? "") || re.test(m.source_branch ?? "") || re.test(m.description ?? "")).filter((m) => m.state !== "closed");
  if (!mrs.length) return undefined;
  // Prefer an open MR (work still going on), else the latest merged one.
  const mr = mrs.find((m) => m.state === "opened") ?? mrs.sort((a, b) => String(b.merged_at).localeCompare(String(a.merged_at)))[0];
  const merged = mr.state === "merged";
  return {
    service: s.name,
    source: "gitlab-mr",
    mr: { iid: mr.iid, url: mr.web_url, state: mr.state, title: mr.title },
    branch: mr.source_branch,
    sha: merged ? (mr.merge_commit_sha ?? mr.squash_commit_sha ?? mr.sha) : mr.sha,
    merged,
  };
}

const pick = (obj: any, dotPath: string) => dotPath.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);

/** Ask the environment which commit is deployed, and whether it includes the change. */
export async function checkDeployment(part: ServicePart, s: ServiceConfig, environment: string, baseUrl: string, repo?: string): Promise<ServicePart["deployed"]> {
  if (!s.version) return { environment, error: "no version endpoint configured (workspace.services[].version)" };
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}${s.version.path}`, { headers: { Accept: "application/json" } });
    if (!res.ok) return { environment, error: `${s.version.path} answered ${res.status}` };
    const deployed = String(pick(await res.json(), s.version.field) ?? "");
    if (!deployed) return { environment, error: `no "${s.version.field}" in ${s.version.path}` };
    let includesChange: boolean | undefined = !!part.sha && (deployed.startsWith(part.sha) || part.sha.startsWith(deployed));
    if (!includesChange && part.sha && repo && isGitRepo(repo)) {
      try {
        git(repo, ["merge-base", "--is-ancestor", part.sha, deployed]);
        includesChange = true;
      } catch {
        includesChange = false;
      }
    }
    return { environment, sha: deployed, includesChange };
  } catch (e) {
    return { environment, error: (e as Error).message };
  }
}

export function featureStatus(parts: ServicePart[], environment?: string): FeatureStatus {
  if (!parts.length) return "no-changes-found";
  if (parts.some((p) => !p.merged)) return "in-development";
  if (!environment) return "merged";
  return parts.every((p) => p.deployed?.includesChange) ? "ready-for-feature-tests" : "waiting-for-deployment";
}

export async function assembleFeature(i: {
  c: Config;
  cwd: string;
  story: string;
  gitlab?: GitLabContext;
  environment?: string;
  baseUrl?: string;
}): Promise<FeatureManifest> {
  const notes: string[] = [];
  const parts: ServicePart[] = [];
  for (const s of i.c.workspace.services) {
    const repo = path.resolve(i.cwd, s.path);
    let part: ServicePart | undefined;
    try {
      if (i.gitlab && s.gitlabProject) part = await partFromGitLab(i.gitlab, s, i.story);
      else if (fs.existsSync(repo)) part = partFromGit(repo, s, i.story, i.c.ci.targetBranch);
    } catch (e) {
      notes.push(`${s.name}: could not look for ${i.story}: ${(e as Error).message}`);
    }
    if (!part) continue;
    if (i.environment && i.baseUrl && part.merged) part.deployed = await checkDeployment(part, s, i.environment, i.baseUrl, fs.existsSync(repo) ? repo : undefined);
    parts.push(part);
  }
  return { story: i.story, environment: i.environment, parts, status: featureStatus(parts, i.environment), notes };
}

const STATUS_TEXT: Record<FeatureStatus, string> = {
  "no-changes-found": "⬜ No service changes found for this story",
  "in-development": "🛠️ In development: not every service change is merged",
  merged: "🔀 All service changes merged (no environment checked)",
  "waiting-for-deployment": "⏳ Merged, waiting for every service to be deployed",
  "ready-for-feature-tests": "✅ Every service change is deployed: ready for the feature's end-to-end tests",
};

export function featureMarkdown(m: FeatureManifest, extra: string[] = []): string {
  const lines = [
    `### Feature ${m.story}${m.environment ? ` · ${m.environment.toUpperCase()}` : ""}`,
    "",
    `**Status:** ${STATUS_TEXT[m.status]}`,
  ];
  if (m.parts.length) {
    lines.push("", `| Service | Change | Merged | ${m.environment ? `Deployed on ${m.environment}` : "Deployed"} |`, "| --- | --- | --- | --- |");
    for (const p of m.parts) {
      const change = p.mr ? `[!${p.mr.iid}](${p.mr.url}) ${p.mr.title}` : `${p.branch ?? "commits"} @ \`${(p.sha ?? "").slice(0, 8)}\``;
      const dep = !m.environment ? "–" : !p.merged ? "–" : p.deployed?.error ? `❔ ${p.deployed.error}` : p.deployed?.includesChange ? `✅ \`${p.deployed.sha?.slice(0, 8)}\`` : `⏳ running \`${p.deployed?.sha?.slice(0, 8)}\``;
      lines.push(`| ${p.service} | ${change} | ${p.merged ? "✅" : "🛠️ not yet"} | ${dep} |`);
    }
  }
  lines.push(...extra);
  if (m.notes.length) lines.push("", ...m.notes.map((n) => `- ${n}`));
  return lines.join("\n");
}
