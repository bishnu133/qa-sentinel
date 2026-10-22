import fs from "node:fs";
import path from "node:path";
import type { Config, ServiceConfig } from "../config.js";
import { git, isGitRepo } from "../git.js";
import { call, getAll, type GitLabContext } from "../scm/gitlab.js";
import { extractMrKeys, extractStoryKeys, jiraKeyPattern } from "../requirements.js";
import { findCherryPicks, findRevert } from "../release/git.js";

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
  /** The commit on the target branch that reverts this change (found in the local clone, when there is one). */
  reverted?: string;
  /** Every non-revert commit of the story found in the clone, and the merge commit that brought it to the target branch: what a revert may name. */
  related?: string[];
  deployed?: { environment: string; sha?: string; includesChange?: boolean; error?: string };
  /** Every story key the MR (title, branch, description) or the commits name. */
  keys?: string[];
  /** The Jira card that led here when it is not the story itself (a bug or task of the feature). */
  workKey?: string;
  /** GitLab: the merge commit, the squash commit and the diff refs of the MR, and when it was merged (what a story's change is cut from). */
  mergeSha?: string;
  squashSha?: string;
  diffRefs?: { base: string; head: string; start: string };
  mergedAt?: string;
  /** A closed MR: the work was dropped. Kept to be shown, never counted in status or readiness. */
  dropped?: boolean;
}

export type FeatureStatus = "no-changes-found" | "reverted" | "in-development" | "waiting-for-deployment" | "ready-for-feature-tests" | "merged";

export interface FeatureManifest {
  story: string;
  environment?: string;
  /** Every change of the story, one entry per merge request (or branch): a service may have several. Dropped (closed) ones are in `dropped`. */
  parts: ServicePart[];
  /** Closed merge requests that named the story: shown, but not part of the status. */
  dropped?: ServicePart[];
  status: FeatureStatus;
  notes: string[];
}

const keyRe = (key: string) => new RegExp(`(^|[^A-Za-z0-9])${key.replace(/[-]/g, "\\-")}(?![0-9])`, "i");

export const targetRefOf = (repo: string, targetBranch: string): string | undefined =>
  ["origin/" + targetBranch, targetBranch].find((b) => {
    try {
      git(repo, ["rev-parse", "--verify", "-q", b]);
      return true;
    } catch {
      return false;
    }
  });

const isAncestor = (repo: string, a: string, b: string) => {
  try {
    git(repo, ["merge-base", "--is-ancestor", a, b]);
    return true;
  } catch {
    return false;
  }
};

/**
 * Local git: the story's changes in one repo. One part for each branch that names the story and is not on the
 * target branch yet (work still going on), and one "mainline" part for the work that is on the target branch
 * (merged branches, and commits that name the story). A branch counts as merged when its tip is on the target
 * branch or was cherry-picked there (a hotfix).
 */
export function partsFromGit(repo: string, s: ServiceConfig, story: string, targetBranch: string): ServicePart[] {
  if (!isGitRepo(repo)) return [];
  const re = keyRe(story);
  const target = targetRefOf(repo, targetBranch);
  const onTarget = (sha: string) => !!target && isAncestor(repo, sha, target);

  // Branches whose name carries the key. A remote copy and its local branch are one branch.
  const byName = new Map<string, string[]>();
  for (const l of git(repo, ["for-each-ref", "--format=%(refname)%09%(objectname)", "refs/heads", "refs/remotes"]).split("\n").filter(Boolean)) {
    const [ref, sha] = l.split("\t");
    const name = ref.startsWith("refs/heads/") ? ref.slice(11) : ref.replace(/^refs\/remotes\/[^/]+\//, "");
    if (name === "HEAD" || !re.test(name)) continue;
    byName.set(name, [...(byName.get(name) ?? []), sha]);
  }
  const branches = [...byName.entries()].map(([name, shas]) => ({ name, sha: shas.find((x) => shas.every((y) => y === x || isAncestor(repo, y, x))) ?? shas[0] })).filter((b) => b.name !== targetBranch);

  // git's --grep matches substrings (SHOP-1 would find SHOP-106), so check each message with the exact-key regex.
  const commits = git(repo, ["log", "--all", "--format=%H%x09%s %b%x1e", "-i", `--grep=${story}`])
    .split("\x1e")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.split("\t"))
    .filter(([, msg]) => re.test(msg ?? ""))
    .filter(([, msg]) => !/^Revert\b/i.test((msg ?? "").trim()))
    .map(([sha]) => sha);
  if (!branches.length && !commits.length) return [];

  const picksOf = (tip: string): string[] => {
    if (!target) return [];
    try {
      return findCherryPicks(repo, tip, target).map((p) => p.commit);
    } catch {
      return []; // no cherry-pick found
    }
  };
  // A hotfix is branched from production and cherry-picked: its branch never merges, but the change is on the target branch.
  const classify = (tip: string) => {
    const picks = onTarget(tip) ? [] : picksOf(tip);
    return { merged: onTarget(tip) || picks.length > 0, picks };
  };

  const open: ServicePart[] = [];
  const mergedTips: { tip: string; branch?: string; picks: string[] }[] = [];
  for (const b of branches) {
    const k = classify(b.sha);
    if (k.merged) mergedTips.push({ tip: b.sha, branch: b.name, picks: k.picks });
    else open.push({ service: s.name, source: "git", branch: b.name, sha: b.sha, merged: false, related: [...new Set([b.sha, ...commits.filter((c) => isAncestor(repo, c, b.sha))])], keys: [story] });
  }

  // Commits that name the story but sit on no branch named after it: on the target branch (mainline), or on some other branch (one part per branch).
  const covered = (c: string) => branches.some((b) => isAncestor(repo, c, b.sha));
  const mainlineCommits: string[] = [];
  const stray = new Map<string, string[]>();
  for (const c of commits) {
    if (onTarget(c)) mainlineCommits.push(c);
    else if (!covered(c)) {
      const all = git(repo, ["for-each-ref", "--contains", c, "--format=%(refname:short)", "refs/heads", "refs/remotes"]).split("\n").filter((x) => x && !/\/HEAD$/.test(x));
      // Local commits on the target branch that are not pushed yet are not "a branch still open": they are skipped, never an open part named after the target.
      const elsewhere = all.filter((x) => x !== targetBranch && x !== `origin/${targetBranch}`);
      if (all.length && !elsewhere.length) continue;
      const where = elsewhere[0] ?? "(no branch)";
      stray.set(where, [...(stray.get(where) ?? []), c]);
    }
  }
  for (const [where, cs] of stray) {
    const tip = cs[0];
    const picks = picksOf(tip);
    if (picks.length) mainlineCommits.push(...picks);
    else open.push({ service: s.name, source: "git", branch: where === "(no branch)" ? undefined : where, sha: tip, merged: false, related: [...new Set(cs)], keys: [story] });
  }

  const parts: ServicePart[] = [];
  if (mergedTips.length || mainlineCommits.length) {
    const newest = (shas: string[]) => shas.map((x) => ({ x, t: Number(tryGit(repo, ["log", "-1", "--format=%ct", x])) || 0 })).sort((a, b) => b.t - a.t)[0].x;
    const tipBranch = mergedTips.length ? mergedTips.find((m) => m.tip === newest(mergedTips.map((x) => x.tip))) : undefined;
    const tip = tipBranch?.tip ?? mainlineCommits[0];
    const related = [...new Set([tip, ...commits.filter(onTarget), ...mergedTips.flatMap((m) => [m.tip, ...m.picks]), ...mainlineCommits])];
    if (target) {
      try {
        const m = git(repo, ["log", "--ancestry-path", "--merges", "--format=%H", `${tip}..${target}`]).split("\n").filter(Boolean).pop();
        if (m) related.push(m);
      } catch {
        /* no merge commit: a fast-forward or squash */
      }
    }
    parts.push({ service: s.name, source: "git", branch: tipBranch?.branch, sha: tip, merged: true, related, keys: [story] });
  }
  return [...parts, ...open.sort((a, b) => String(a.branch).localeCompare(String(b.branch)))];
}

const tryGit = (repo: string, args: string[]) => {
  try {
    return git(repo, args);
  } catch {
    return "";
  }
};

/** The first of a service's parts, the way the single-part form always answered: work still going on first, else the merged work. */
export function partFromGit(repo: string, s: ServiceConfig, story: string, targetBranch: string): ServicePart | undefined {
  const parts = partsFromGit(repo, s, story, targetBranch);
  return parts.find((p) => !p.merged) ?? parts[0];
}

/** One GitLab merge request (as the API lists it) as a part of its service. */
export function mrToPart(service: string, m: any, keyPattern = "[A-Z][A-Z0-9]+-\\d+", projects: string[] = []): ServicePart {
  const merged = m.state === "merged";
  return {
    service,
    source: "gitlab-mr",
    mr: { iid: m.iid, url: m.web_url, state: m.state, title: m.title },
    branch: m.source_branch,
    sha: merged ? (m.merge_commit_sha ?? m.squash_commit_sha ?? m.sha) : m.sha,
    merged,
    keys: extractMrKeys(keyPattern, m, projects),
    ...(m.merge_commit_sha ? { mergeSha: m.merge_commit_sha } : {}),
    ...(m.squash_commit_sha ? { squashSha: m.squash_commit_sha } : {}),
    ...(m.diff_refs?.base_sha && m.diff_refs?.head_sha ? { diffRefs: { base: m.diff_refs.base_sha, head: m.diff_refs.head_sha, start: m.diff_refs.start_sha ?? m.diff_refs.base_sha } } : {}),
    ...(m.merged_at ? { mergedAt: m.merged_at } : {}),
    ...(m.state === "closed" ? { dropped: true } : {}),
  };
}

/**
 * GitLab: every merge request that carries the story key. Two lookups, merged by MR number:
 *  1. the text search over titles and descriptions (every page);
 *  2. the MRs updated in the last `lookbackDays` days, kept when the source branch names the story (the search does not read branches).
 * Closed MRs are kept, marked `dropped`. Open MRs come first, then merged ones (newest first), then dropped ones.
 */
/**
 * The recent merge requests of a project, read once per run: every story of a multi-story merge request filters the same list locally.
 * Keyed by project and lookback window; the value is the scan (and whether it was cut off at the page limit).
 */
export type MrScanCache = Map<string, Promise<{ mrs: any[]; truncated: boolean }>>;
export const MR_SCAN_PAGES = 5;

export async function partsFromGitLab(
  ctx: GitLabContext,
  s: ServiceConfig,
  story: string,
  o: { lookbackDays?: number; keyPattern?: string; projectKeys?: string[]; now?: Date; scanCache?: MrScanCache; /** Facts the caller should show (a scan that was cut off). */ notes?: string[] } = {},
): Promise<ServicePart[]> {
  if (!s.gitlabProject) return [];
  const project = encodeURIComponent(s.gitlabProject);
  const re = keyRe(story);
  const found = new Map<number, any>();
  for (const m of await getAll(ctx, `/projects/${project}/merge_requests?search=${encodeURIComponent(story)}&in=title,description&state=all`, 10)) {
    if (re.test(m.title ?? "") || re.test(m.source_branch ?? "") || re.test(m.description ?? "")) found.set(m.iid, m);
  }
  const days = o.lookbackDays ?? 30;
  const scanKey = `${s.gitlabProject}|${days}`;
  const scan = async () => {
    const since = new Date((o.now ?? new Date()).getTime() - days * 86_400_000).toISOString();
    const info: { truncated?: boolean } = {};
    const mrs = await getAll(ctx, `/projects/${project}/merge_requests?state=all&updated_after=${encodeURIComponent(since)}&order_by=updated_at&sort=desc`, MR_SCAN_PAGES, info);
    return { mrs, truncated: Boolean(info.truncated) };
  };
  let scanned: Promise<{ mrs: any[]; truncated: boolean }>;
  if (o.scanCache) {
    if (!o.scanCache.has(scanKey)) o.scanCache.set(scanKey, scan());
    scanned = o.scanCache.get(scanKey)!;
  } else scanned = scan();
  const { mrs: recent, truncated } = await scanned;
  for (const m of recent) {
    if (re.test(m.source_branch ?? "") && !found.has(m.iid)) found.set(m.iid, m);
  }
  if (truncated) o.notes?.push(`${s.name}: only the newest ${MR_SCAN_PAGES * 100} merge requests updated in the last ${days} days were checked for a branch naming ${story}; an older one may be missing (requirements.jira.search.mrLookbackDays)`);
  const pattern = o.keyPattern ?? "[A-Z][A-Z0-9]+-\\d+";
  const parts = [...found.values()].map((m) => mrToPart(s.name, m, pattern, o.projectKeys));
  const rank = (p: ServicePart) => (p.dropped ? 2 : p.merged ? 1 : 0);
  return parts.sort((a, b) => rank(a) - rank(b) || String(b.mergedAt ?? "").localeCompare(String(a.mergedAt ?? "")) || (b.mr?.iid ?? 0) - (a.mr?.iid ?? 0));
}

/** GitLab: the one merge request that stands for the service: an open one, else the latest merged one. */
export async function partFromGitLab(ctx: GitLabContext, s: ServiceConfig, story: string): Promise<ServicePart | undefined> {
  const parts = (await partsFromGitLab(ctx, s, story)).filter((p) => !p.dropped);
  return parts.find((p) => !p.merged) ?? parts[0];
}

const pick = (obj: any, dotPath: string) => dotPath.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);

/** Ask the environment which commit is deployed, and whether it includes the change. */
/** GitLab: does `deployed` contain `sha`? (compare deployed…sha: no commits = contained). Unknown on any error. */
async function gitlabContains(ctx: GitLabContext, project: string, sha: string, deployed: string): Promise<boolean | undefined> {
  try {
    const { data } = await call(ctx, "GET", `/projects/${encodeURIComponent(project)}/repository/compare?from=${encodeURIComponent(deployed)}&to=${encodeURIComponent(sha)}&straight=true`, undefined, 1);
    return Array.isArray(data?.commits) ? data.commits.length === 0 : undefined;
  } catch {
    return undefined;
  }
}

export async function checkDeployment(part: ServicePart, s: ServiceConfig, environment: string, baseUrl: string, repo?: string, gitlab?: GitLabContext): Promise<ServicePart["deployed"]> {
  if (!s.version) return { environment, error: "no version endpoint configured (workspace.services[].version)" };
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}${s.version.path}`, { headers: { Accept: "application/json" } });
    if (!res.ok) return { environment, error: `${s.version.path} answered ${res.status}` };
    const deployed = String(pick(await res.json(), s.version.field) ?? "");
    if (!deployed) return { environment, error: `no "${s.version.field}" in ${s.version.path}` };
    // Same commit: deployed. Otherwise ask git whether the deployed commit contains the change; when that can't be
    // decided here (no clone, or the deployed commit isn't in it), it's unknown, never "not deployed".
    let includesChange: boolean | undefined = !!part.sha && (deployed.startsWith(part.sha) || part.sha.startsWith(deployed)) ? true : undefined;
    if (!includesChange && part.sha && repo && isGitRepo(repo)) {
      const known = (sha: string) => {
        try {
          git(repo, ["cat-file", "-e", `${sha}^{commit}`]);
          return true;
        } catch {
          return false;
        }
      };
      if (known(part.sha) && known(deployed)) {
        try {
          git(repo, ["merge-base", "--is-ancestor", part.sha, deployed]);
          includesChange = true;
        } catch {
          includesChange = false;
        }
      }
    }
    if (includesChange === undefined && part.sha && gitlab && s.gitlabProject) includesChange = await gitlabContains(gitlab, s.gitlabProject, part.sha, deployed);
    return { environment, sha: deployed, includesChange };
  } catch (e) {
    return { environment, error: (e as Error).message };
  }
}

/** Is `a` newer than `b`? By merge time, else by merge request number; parts of one clone (no MRs) are one part per service. */
const newerThan = (a: ServicePart, b: ServicePart) => (a.mergedAt && b.mergedAt ? a.mergedAt > b.mergedAt : a.mr && b.mr ? a.mr.iid > b.mr.iid : true);

/**
 * The parts whose change is gone. A reverted part counts only while its service has no newer merged part that is
 * not reverted: a change that was reverted and then landed again (a new MR, or the revert reverted) is back.
 */
export function revertedParts(parts: ServicePart[]): ServicePart[] {
  const live = parts.filter((p) => !p.dropped);
  return live.filter((p) => p.reverted && !live.some((q) => q !== p && q.service === p.service && q.merged && !q.reverted && newerThan(q, p)));
}

/** The parts that count: not dropped, and not a reverted change that a newer part of the same service replaced. */
export function activeParts(parts: ServicePart[]): ServicePart[] {
  const gone = new Set(revertedParts(parts));
  return parts.filter((p) => !p.dropped && (!p.reverted || gone.has(p)));
}

export function featureStatus(parts: ServicePart[], environment?: string): FeatureStatus {
  const all = parts.filter((p) => !p.dropped);
  parts = activeParts(parts);
  if (!all.length) return "no-changes-found";
  if (revertedParts(all).length) return "reverted";
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
  /** Also ask the environment about changes that are not on the main branch yet (a hotfix is deployed before it is cherry-picked). */
  checkUnmerged?: boolean;
  /** The recent-MR scans of this run (shared by the stories of a merge request). */
  scanCache?: MrScanCache;
}): Promise<FeatureManifest> {
  const notes: string[] = [];
  const parts: ServicePart[] = [];
  const dropped: ServicePart[] = [];
  for (const s of i.c.workspace.services) {
    const repo = path.resolve(i.cwd, s.path);
    let found: ServicePart[] = [];
    try {
      if (i.gitlab && s.gitlabProject) found = await partsFromGitLab(i.gitlab, s, i.story, { lookbackDays: i.c.requirements.jira.search.mrLookbackDays, keyPattern: jiraKeyPattern(i.c), projectKeys: i.c.requirements.jira.projectKeys, scanCache: i.scanCache, notes });
      else if (fs.existsSync(repo)) found = partsFromGit(repo, s, i.story, i.c.ci.targetBranch);
    } catch (e) {
      notes.push(`${s.name}: could not look for ${i.story}: ${(e as Error).message}`);
    }
    const target = fs.existsSync(repo) && isGitRepo(repo) ? targetRefOf(repo, i.c.ci.targetBranch) : undefined;
    for (const part of found) {
      if (part.dropped) {
        dropped.push(part);
        continue;
      }
      if (part.merged && part.sha && target) {
        try {
          part.reverted = findRevert(repo, [part.sha, ...(part.mergeSha ? [part.mergeSha] : []), ...(part.squashSha ? [part.squashSha] : []), ...(part.related ?? [])], target);
        } catch (e) {
          notes.push(`${s.name}: could not check whether ${i.story} was reverted: ${(e as Error).message.split("\n")[0]}`);
        }
      }
      if (i.environment && i.baseUrl && (part.merged || i.checkUnmerged) && !part.reverted) part.deployed = await checkDeployment(part, s, i.environment, i.baseUrl, fs.existsSync(repo) ? repo : undefined, i.gitlab);
      parts.push(part);
    }
  }
  return { story: i.story, environment: i.environment, parts, ...(dropped.length ? { dropped } : {}), status: featureStatus(parts, i.environment), notes };
}

const STATUS_TEXT: Record<FeatureStatus, string> = {
  "no-changes-found": "⬜ No service changes found for this story",
  reverted: "↩️ A change of this story was reverted: its tests are held back (never deleted) until it lands again",
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
  if (m.parts.length || m.dropped?.length) {
    lines.push("", `| Service | Change | Merged | ${m.environment ? `Deployed on ${m.environment}` : "Deployed"} |`, "| --- | --- | --- | --- |");
    for (const p of m.parts) {
      const change = p.mr ? `[!${p.mr.iid}](${p.mr.url}) ${p.mr.title}` : `${p.branch ?? "commits"} @ \`${(p.sha ?? "").slice(0, 8)}\``;
      const dep = !m.environment ? "–" : p.reverted ? "–" : !p.merged ? "–" : p.deployed?.error ? `❔ ${p.deployed.error}` : p.deployed?.includesChange ? `✅ \`${p.deployed.sha?.slice(0, 8)}\`` : p.deployed?.includesChange === undefined ? `❔ running \`${p.deployed?.sha?.slice(0, 8)}\` (can't tell if it includes the change)` : `⏳ running \`${p.deployed?.sha?.slice(0, 8)}\``;
      lines.push(`| ${p.service} | ${change} | ${p.reverted ? `↩️ reverted by \`${p.reverted.slice(0, 8)}\`` : p.merged ? "✅" : "🛠️ not yet"} | ${dep} |`);
    }
    for (const p of m.dropped ?? []) lines.push(`| ${p.service} | ${p.mr ? `[!${p.mr.iid}](${p.mr.url}) ${p.mr.title}` : (p.branch ?? "commits")} | 🗑️ dropped (closed) | – |`);
  }
  lines.push(...extra);
  if (m.notes.length) lines.push("", ...m.notes.map((n) => `- ${n}`));
  return lines.join("\n");
}
