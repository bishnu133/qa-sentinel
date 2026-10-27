/**
 * Thin GitHub REST client for the same jobs src/scm/gitlab.ts does for GitLab: one marker comment on a pull request,
 * opening or updating the test pull request, labels, the draft flag, changed files, reactions on a comment, and the
 * pull request a CI job runs for (GitHub Actions variables and the event payload).
 *
 * Proven only against fake HTTP servers and fixture payloads (test/github.test.ts); not yet run on real GitHub.
 * The token goes in one request header and nowhere else: not in a URL, a log line or an error message.
 */
import fs from "node:fs";
import { maskSecrets } from "../secrets.js";
import { netFetch, looksLikeHtml } from "../net.js";
import { MARKER } from "./gitlab.js";

const WEB_PAGE_HINT = "a login or SSO proxy in front of GitHub? Check ci.githubApiUrl / GITHUB_API_URL and the token";
const API_VERSION = "2022-11-28";

export interface GitHubContext {
  apiUrl: string; // e.g. https://api.github.com, or https://ghe.example/api/v3
  token: string;
  /** The web address, for push URLs (https://github.com, or the GitHub Enterprise host). */
  serverUrl: string;
}

export function githubToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.QA_SENTINEL_GITHUB_TOKEN || env.GITHUB_TOKEN || env.GH_TOKEN || undefined;
}

const trimSlash = (u: string) => u.replace(/\/+$/, "");

/** GitHub.com keeps the API on api.github.com; an Enterprise Server serves it under /api/v3 of the same host. */
function serverFromApi(apiUrl: string): string {
  if (/^https?:\/\/api\.github\.com$/i.test(apiUrl)) return "https://github.com";
  return apiUrl.replace(/\/api\/v3$/i, "");
}

export function githubContext(apiUrlFromConfig: string | undefined, env: NodeJS.ProcessEnv = process.env): GitHubContext | undefined {
  const token = githubToken(env);
  if (!token) return undefined;
  const apiUrl = trimSlash(env.GITHUB_API_URL || apiUrlFromConfig || "https://api.github.com");
  return { apiUrl, token, serverUrl: trimSlash(env.GITHUB_SERVER_URL || serverFromApi(apiUrl)) };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable = false,
  ) {
    super(message);
  }
}

/** One request with up to 3 retries on 429, 5xx, network errors and the secondary rate limit (403 with Retry-After). */
export async function call(ctx: GitHubContext, method: string, route: string, body?: unknown, attempts = 4): Promise<{ data: any; headers: Headers }> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await netFetch(`${ctx.apiUrl}${route}`, {
        method,
        headers: { Authorization: `Bearer ${ctx.token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": API_VERSION, "User-Agent": "qa-sentinel", "Content-Type": "application/json" },
        // Agent-written text may carry a credential the tests needed: masked before it is published.
        body: body ? maskSecrets(JSON.stringify(body)) : undefined,
      });
      const text = await res.text();
      const html = looksLikeHtml(text, res.headers.get("content-type"));
      if (res.ok) {
        if (html) throw new GitHubError(`GitHub ${method} ${route} answered with a web page, not JSON (${WEB_PAGE_HINT})`, res.status);
        let data: any;
        try {
          data = text ? JSON.parse(text) : undefined;
        } catch {
          throw new GitHubError(`GitHub ${method} ${route} answered something that is not JSON (${WEB_PAGE_HINT}): ${text.slice(0, 80).replace(/\s+/g, " ")}`, res.status);
        }
        return { data, headers: res.headers };
      }
      const retryAfter = Number(res.headers.get("retry-after"));
      const limited = res.status === 429 || (res.status === 403 && Number.isFinite(retryAfter) && retryAfter > 0);
      const err = new GitHubError(maskSecrets(`GitHub ${method} ${route} failed: ${res.status} ${html ? `(a web page, not JSON: ${WEB_PAGE_HINT})` : text.slice(0, 300)}`, { GITHUB_TOKEN: ctx.token }), res.status, limited || res.status >= 500);
      if (!err.retryable) throw err;
      lastErr = err;
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** i);
    } catch (e) {
      if (e instanceof GitHubError && !e.retryable) throw e;
      lastErr = e;
      if (!(e instanceof GitHubError)) await sleep(500 * 2 ** i);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** GET every page of a list endpoint, following the Link header's rel="next". `info.truncated` is set when `maxPages` was reached and more follows. */
export async function getAll(ctx: GitHubContext, route: string, maxPages = 50, info?: { truncated?: boolean }): Promise<any[]> {
  const out: any[] = [];
  const sep = route.includes("?") ? "&" : "?";
  let next: string | undefined = `${route}${sep}per_page=100`;
  for (let page = 1; next; page++) {
    const { data, headers } = await call(ctx, "GET", next);
    out.push(...(Array.isArray(data) ? data : []));
    const link = /<([^>]+)>;\s*rel="next"/.exec(headers.get("link") ?? "")?.[1];
    next = undefined;
    if (link) {
      if (page === maxPages) {
        if (info) info.truncated = true;
        break;
      }
      // The link is absolute; the route is what follows the API root. Anything pointing elsewhere is not followed.
      if (link.startsWith(ctx.apiUrl)) next = link.slice(ctx.apiUrl.length);
    }
  }
  return out;
}

const enc = (p: string | number) => encodeURIComponent(String(p));

/** "owner/repo" as the two route parts. */
function repoRoute(project: string | number): string {
  const p = String(project).replace(/^\/|\.git$/g, "");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(p)) throw new Error(`GitHub needs the repository as owner/repo (got "${p.slice(0, 80)}"); set ci.testRepoProject or GITHUB_REPOSITORY`);
  return `/repos/${p}`;
}

/**
 * The comments written by the token's own user (anyone can paste the marker into a comment; only ours counts).
 * `GET /user` is refused for the GITHUB_TOKEN of a workflow run ("Resource not accessible by integration"); then the
 * comments of bot accounts count (the workflow token comments as github-actions[bot]). Not proven on real GitHub.
 */
async function ownComments(ctx: GitHubContext, comments: any[]): Promise<any[]> {
  try {
    const me = (await call(ctx, "GET", "/user", undefined, 1)).data?.id;
    if (me !== undefined) return comments.filter((n) => n.user?.id === me);
  } catch {
    /* fall through to the bot filter */
  }
  return comments.filter((n) => n.user?.type === "Bot");
}

const commentsRoute = (project: string | number, pr: string | number) => `${repoRoute(project)}/issues/${enc(pr)}/comments`;

/** The body of the qa-sentinel gap-report comment on a pull request, if there is one. */
export async function getPrCommentBody(ctx: GitHubContext, project: string | number, pr: string | number): Promise<string | undefined> {
  const all = await getAll(ctx, commentsRoute(project, pr));
  return (await ownComments(ctx, all)).find((n) => typeof n.body === "string" && n.body.includes(MARKER))?.body;
}

/** Create or update the single qa-sentinel comment on a pull request (searches all pages of comments). */
export async function upsertPrComment(ctx: GitHubContext, project: string | number, pr: string | number, body: string) {
  const base = commentsRoute(project, pr);
  const existing = (await ownComments(ctx, await getAll(ctx, base))).find((n) => typeof n.body === "string" && n.body.includes(MARKER));
  const full = `${MARKER}\n${body}`;
  if (existing) {
    await call(ctx, "PATCH", `${repoRoute(project)}/issues/comments/${existing.id}`, { body: full });
    return { action: "updated" as const, id: existing.id as number };
  }
  const { data } = await call(ctx, "POST", base, { body: full });
  return { action: "created" as const, id: data.id as number };
}

/** One comment found by its own marker line and edited in place (own comments only); "same" when nothing changed. */
export async function upsertMarkedPrComment(ctx: GitHubContext, project: string | number, pr: string | number, marker: string, body: string): Promise<"created" | "updated" | "same"> {
  const base = commentsRoute(project, pr);
  const existing = (await ownComments(ctx, await getAll(ctx, base))).find((n) => typeof n.body === "string" && n.body.includes(marker));
  const full = `${marker}\n${body}`;
  if (existing) {
    if (existing.body === full) return "same";
    await call(ctx, "PATCH", `${repoRoute(project)}/issues/comments/${existing.id}`, { body: full });
    return "updated";
  }
  await call(ctx, "POST", base, { body: full });
  return "created";
}

/** Reactions on one comment (GET /issues/comments/:id/reactions): content is "+1", "-1", "heart", ... */
export async function commentReactions(ctx: GitHubContext, project: string | number, commentId: number): Promise<{ content: string; user?: { id?: number; login?: string } }[]> {
  return getAll(ctx, `${repoRoute(project)}/issues/comments/${enc(commentId)}/reactions`);
}

/** The pull request as GitHub has it: refs, state, draft flag. */
export async function getPr(ctx: GitHubContext, project: string | number, pr: string | number, attempts = 4): Promise<any> {
  return (await call(ctx, "GET", `${repoRoute(project)}/pulls/${enc(pr)}`, undefined, attempts)).data;
}

/** The files a pull request changes (filename, status, additions, deletions), all pages. GitHub lists at most 3000. */
export async function prFiles(ctx: GitHubContext, project: string | number, pr: string | number): Promise<{ filename: string; status: string; additions?: number; deletions?: number; previous_filename?: string }[]> {
  return getAll(ctx, `${repoRoute(project)}/pulls/${enc(pr)}/files`, 30);
}

/** The commits a base and head differ by: base sha, head sha, target and source branch, from the pull request itself. */
export async function prDiffRefs(ctx: GitHubContext, project: string | number, pr: string | number): Promise<{ baseSha: string; headSha: string; targetBranch: string; sourceBranch: string }> {
  const p = await getPr(ctx, project, pr);
  return { baseSha: p.base?.sha, headSha: p.head?.sha, targetBranch: p.base?.ref, sourceBranch: p.head?.ref };
}

export async function addLabels(ctx: GitHubContext, project: string | number, pr: string | number, labels: string[]): Promise<void> {
  if (!labels.length) return;
  await call(ctx, "POST", `${repoRoute(project)}/issues/${enc(pr)}/labels`, { labels });
}

export interface PrOptions {
  source: string;
  target: string;
  title: string;
  description: string;
  labels?: string[];
}

/** GitHub has a draft flag instead of a title prefix; the prefixes qa-sentinel puts on GitLab titles become the flag. */
export const DRAFT_PREFIX = /^\s*(\[draft\]|\(draft\)|draft\s*:|draft\s+-(\s|$))\s*/i;

/** Create the pull request, or update the open one that already exists for the same branches (safe to retry). */
export async function createOrUpdatePullRequest(ctx: GitHubContext, project: string | number, o: PrOptions): Promise<{ web_url: string; iid: number; action: "created" | "updated" }> {
  const route = `${repoRoute(project)}/pulls`;
  const owner = String(project).split("/")[0];
  const draft = DRAFT_PREFIX.test(o.title);
  const title = o.title.replace(DRAFT_PREFIX, "");
  const { data: open } = await call(ctx, "GET", `${route}?state=open&head=${enc(`${owner}:${o.source}`)}&base=${enc(o.target)}`);
  let pr: any;
  let action: "created" | "updated";
  if (Array.isArray(open) && open.length) {
    pr = (await call(ctx, "PATCH", `${route}/${open[0].number}`, { title, body: o.description })).data;
    action = "updated";
  } else {
    pr = (await call(ctx, "POST", route, { title, body: o.description, head: o.source, base: o.target, draft })).data;
    action = "created";
  }
  // Labels are added (never replaced): a person's own labels stay.
  await addLabels(ctx, project, pr.number, o.labels ?? []);
  return { web_url: pr.html_url, iid: pr.number, action };
}

/**
 * The pull request that says what happened to a branch: an OPEN one if there is any, else the newest by creation time.
 * `state` is reported in GitLab's words ("opened", "merged", "closed") so callers read both providers alike.
 */
export async function latestPrForBranch(ctx: GitHubContext, project: string | number, source: string, target?: string): Promise<{ iid: number; web_url: string; state: string; title?: string } | undefined> {
  const owner = String(project).split("/")[0];
  const { data } = await call(ctx, "GET", `${repoRoute(project)}/pulls?state=all&head=${enc(`${owner}:${source}`)}${target ? `&base=${enc(target)}` : ""}&sort=created&direction=desc&per_page=100`);
  if (!Array.isArray(data) || !data.length) return undefined;
  const shape = (p: any) => ({ iid: p.number as number, web_url: p.html_url as string, state: p.state === "open" ? "opened" : p.merged_at ? "merged" : "closed", title: p.title as string | undefined });
  const open = data.find((p: any) => p.state === "open");
  if (open) return shape(open);
  const stamp = (p: any) => (typeof p.created_at === "string" ? Date.parse(p.created_at) : NaN);
  return shape([...data].sort((a: any, b: any) => (Number.isNaN(stamp(b)) || Number.isNaN(stamp(a)) ? 0 : stamp(b) - stamp(a)))[0]);
}

/** Open pull requests carrying a label (the QA agent's own: `qa-agent`). */
export async function openPrsWithLabel(ctx: GitHubContext, project: string | number, label: string): Promise<{ iid: number; web_url: string; source_branch: string; title: string }[]> {
  // The issues list has labels; the pull request list does not. Issues that are pull requests carry a pull_request key.
  const items = await getAll(ctx, `${repoRoute(project)}/issues?state=open&labels=${enc(label)}`, 5);
  const prs = items.filter((i) => i.pull_request);
  const out = [];
  for (const i of prs) out.push({ iid: i.number as number, web_url: i.html_url as string, source_branch: (await getPr(ctx, project, i.number)).head?.ref as string, title: i.title as string });
  return out;
}

/** Is this pull request still a draft? Asks GitHub; when that can't be asked, the title prefix decides. Unknown is "not a draft". */
export async function prIsDraft(ctx: GitHubContext | undefined, project: string | undefined, pr: string | undefined, titleFromEnv: string | undefined): Promise<boolean> {
  if (ctx && project && pr) {
    try {
      const data = await getPr(ctx, project, pr, 2);
      if (typeof data?.draft === "boolean") return data.draft;
    } catch {
      /* fall back to the title below */
    }
  }
  return DRAFT_PREFIX.test(titleFromEnv ?? "");
}

/** The pull request number in a GitHub event payload (pull_request, pull_request_target and issue_comment events). */
function prNumberFromPayload(p: any): number | undefined {
  const n = p?.pull_request?.number ?? (p?.issue?.pull_request ? p.issue.number : undefined) ?? (typeof p?.number === "number" ? p.number : undefined);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** Pull request context when running inside GitHub Actions: repository and variables, and the event payload file. */
export function githubPrFromEnv(env: NodeJS.ProcessEnv = process.env) {
  let payload: any;
  try {
    if (env.GITHUB_EVENT_PATH) payload = JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
  } catch {
    /* no payload: the variables below still tell */
  }
  const pr = payload?.pull_request;
  // refs/pull/<n>/merge is the ref of a pull_request run; it names the number when the payload is not there.
  const fromRef = /^refs\/pull\/(\d+)\//.exec(env.GITHUB_REF ?? "")?.[1];
  const num = prNumberFromPayload(payload) ?? (fromRef ? Number(fromRef) : undefined);
  const project = env.GITHUB_REPOSITORY || undefined;
  const server = trimSlash(env.GITHUB_SERVER_URL || "https://github.com");
  return {
    project,
    mrIid: num !== undefined ? String(num) : undefined,
    base: pr?.base?.sha ?? (env.GITHUB_BASE_REF ? `origin/${env.GITHUB_BASE_REF}` : undefined),
    targetBranch: env.GITHUB_BASE_REF || pr?.base?.ref || undefined,
    title: pr?.title as string | undefined,
    description: pr?.body ?? undefined,
    sourceBranch: env.GITHUB_HEAD_REF || pr?.head?.ref || undefined,
    url: pr?.html_url ?? (project && num !== undefined ? `${server}/${project}/pull/${num}` : undefined),
  };
}

/**
 * HTTPS push URL with the token embedded, built only at push time so the token never lands in .git/config
 * (which the agent could read). Undefined when we can't build one (then `origin` is used).
 */
export function githubPushUrl(serverUrl: string, projectPath: string | undefined, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const token = githubToken(env);
  if (!token || !projectPath || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(projectPath.replace(/^\/|\.git$/g, ""))) return undefined;
  const host = new URL(env.GITHUB_SERVER_URL || serverUrl);
  const base = host.pathname.replace(/\/+$/, "");
  return `${host.protocol}//x-access-token:${encodeURIComponent(token)}@${host.host}${base}/${projectPath.replace(/^\/|\.git$/g, "")}.git`;
}

export async function currentUser(ctx: GitHubContext): Promise<any> {
  return (await call(ctx, "GET", "/user", undefined, 1)).data;
}

export async function getRepo(ctx: GitHubContext, project: string | number): Promise<any> {
  return (await call(ctx, "GET", repoRoute(project), undefined, 1)).data;
}
