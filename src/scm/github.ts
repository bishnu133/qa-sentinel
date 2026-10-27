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
  /** Login of the account the workflow token comments as, used only when `GET /user` is refused. */
  botLogin: string;
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

export const DEFAULT_BOT_LOGIN = "github-actions[bot]";

/** The token goes to this address in a header: plain http is refused except on this machine (tests, a local proxy). */
function checkApiUrl(apiUrl: string): void {
  let u: URL;
  try {
    u = new URL(apiUrl);
  } catch {
    throw new Error(`GitHub API URL "${apiUrl.slice(0, 80)}" is not a URL (ci.githubApiUrl / GITHUB_API_URL)`);
  }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) throw new Error(`GitHub API URL must be https:// (the token is sent to it); got ${u.protocol}//${u.host}`);
}

export function githubContext(apiUrlFromConfig: string | undefined, env: NodeJS.ProcessEnv = process.env, botLogin?: string): GitHubContext | undefined {
  const token = githubToken(env);
  if (!token) return undefined;
  const apiUrl = trimSlash(env.GITHUB_API_URL || apiUrlFromConfig || "https://api.github.com");
  checkApiUrl(apiUrl);
  return { apiUrl, token, serverUrl: trimSlash(env.GITHUB_SERVER_URL || serverFromApi(apiUrl)), botLogin: botLogin || DEFAULT_BOT_LOGIN };
}

/** Waits are in one place so tests can shorten them. GitHub: wait for the reset time, at least a minute when it says nothing; never longer than the cap. */
export const timing = { sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)), maxWaitMs: 120_000, minRateWaitMs: 60_000 };

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable = false,
    /** How long to wait before the next try (rate limits), in ms. */
    readonly waitMs?: number,
  ) {
    super(message);
  }
}

/** How long GitHub says to wait after a rate-limit answer, capped. Undefined when the answer is not a rate limit. */
function rateLimitWait(status: number, headers: Headers, text: string): number | undefined {
  if (status !== 403 && status !== 429) return undefined;
  const retryAfter = Number(headers.get("retry-after"));
  const remaining = headers.get("x-ratelimit-remaining");
  const reset = Number(headers.get("x-ratelimit-reset"));
  const limited = status === 429 || remaining === "0" || (Number.isFinite(retryAfter) && retryAfter > 0) || /secondary rate limit|rate limit exceeded/i.test(text);
  if (!limited) return undefined;
  let ms: number;
  if (Number.isFinite(retryAfter) && retryAfter > 0) ms = retryAfter * 1000;
  else if (remaining === "0" && Number.isFinite(reset) && reset > 0) ms = Math.max(0, reset * 1000 - Date.now()) + 1000;
  else ms = timing.minRateWaitMs;
  return Math.min(ms, timing.maxWaitMs);
}

/**
 * One request with up to 3 retries. Retried: rate limits (primary and secondary, waiting as GitHub says, capped), and,
 * for reads only, 5xx and network errors. A POST that failed with 5xx or a network error is not repeated: it may have
 * been done already, and a second try could post a second comment or open a second pull request.
 */
export async function call(ctx: GitHubContext, method: string, route: string, body?: unknown, attempts = 4): Promise<{ data: any; headers: Headers }> {
  let lastErr: unknown;
  const safeToRepeat = method !== "POST";
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
      const wait = rateLimitWait(res.status, res.headers, text);
      const retryable = wait !== undefined || (res.status >= 500 && safeToRepeat);
      const err = new GitHubError(maskSecrets(`GitHub ${method} ${route} failed: ${res.status} ${html ? `(a web page, not JSON: ${WEB_PAGE_HINT})` : text.slice(0, 300)}`, { GITHUB_TOKEN: ctx.token }), res.status, retryable, wait);
      if (!retryable) throw err;
      lastErr = err;
      if (i < attempts - 1) await timing.sleep(wait ?? 500 * 2 ** i);
    } catch (e) {
      if (e instanceof GitHubError) {
        if (!e.retryable) throw e;
        lastErr = e;
        continue;
      }
      lastErr = e;
      if (!safeToRepeat) throw e;
      if (i < attempts - 1) await timing.sleep(500 * 2 ** i);
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
      // The link is absolute; the route is what follows the API root. A link to another host (or a host that merely starts
      // with the same text) is not followed: the token would go with it.
      try {
        const u = new URL(link);
        const root = new URL(ctx.apiUrl);
        const prefix = root.pathname.replace(/\/+$/, "");
        if (u.origin === root.origin && (u.pathname + "/").startsWith(prefix + "/") && u.pathname.startsWith(prefix)) next = u.pathname.slice(prefix.length) + u.search;
      } catch {
        /* not a URL: not followed */
      }
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
 * `GET /user` is refused (403, "Resource not accessible by integration") for the GITHUB_TOKEN of a workflow run; only then
 * the comments of the workflow's bot account (`github-actions[bot]`, or ci.githubBotLogin) count. Any other failure of
 * `/user` (a 5xx after its retries, a network error) stops the run: guessing could post a second comment. Not proven on real GitHub.
 */
async function ownComments(ctx: GitHubContext, comments: any[]): Promise<any[]> {
  try {
    const me = (await call(ctx, "GET", "/user")).data?.id;
    if (me === undefined) throw new GitHubError("GitHub GET /user did not say who the token is", 0);
    return comments.filter((n) => n.user?.id === me);
  } catch (e) {
    if (e instanceof GitHubError && e.status === 403) return comments.filter((n) => n.user?.login === ctx.botLogin);
    throw e;
  }
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

/** GraphQL root: api.github.com/graphql, or <host>/api/graphql on Enterprise Server (its REST root is <host>/api/v3). */
function graphqlCtx(ctx: GitHubContext): GitHubContext {
  return { ...ctx, apiUrl: ctx.apiUrl.replace(/\/v3$/, "") };
}

/** REST cannot change the draft state of an existing pull request; GraphQL can. A failure is reported to the caller, not thrown. */
async function setDraft(ctx: GitHubContext, nodeId: string, draft: boolean): Promise<string | undefined> {
  const mutation = draft ? "convertPullRequestToDraft" : "markPullRequestReadyForReview";
  try {
    const { data } = await call(graphqlCtx(ctx), "POST", "/graphql", { query: `mutation($id: ID!) { ${mutation}(input: { pullRequestId: $id }) { pullRequest { isDraft } } }`, variables: { id: nodeId } });
    if (data?.errors?.length) return String(data.errors[0]?.message ?? "GraphQL error").slice(0, 120);
    return undefined;
  } catch (e) {
    return (e as Error).message.split("\n")[0].slice(0, 160);
  }
}

/** Create the pull request, or update the open one that already exists for the same branches (safe to retry). */
export async function createOrUpdatePullRequest(ctx: GitHubContext, project: string | number, o: PrOptions): Promise<{ web_url: string; iid: number; action: "created" | "updated"; note?: string }> {
  const route = `${repoRoute(project)}/pulls`;
  const owner = String(project).split("/")[0];
  const draft = DRAFT_PREFIX.test(o.title);
  const title = o.title.replace(DRAFT_PREFIX, "");
  const { data: open } = await call(ctx, "GET", `${route}?state=open&head=${enc(`${owner}:${o.source}`)}&base=${enc(o.target)}`);
  let pr: any;
  let action: "created" | "updated";
  let note: string | undefined;
  if (Array.isArray(open) && open.length) {
    pr = (await call(ctx, "PATCH", `${route}/${open[0].number}`, { title, body: o.description })).data;
    action = "updated";
    // A GitLab title loses "Draft:" when the run became VERIFIED; here the flag must follow.
    if (typeof pr.draft === "boolean" && pr.draft !== draft && pr.node_id) {
      const failed = await setDraft(ctx, pr.node_id, draft);
      if (failed) note = `could not ${draft ? "convert the pull request to a draft" : "mark the pull request ready for review"}: ${failed}`;
    }
  } else {
    try {
      pr = (await call(ctx, "POST", route, { title, body: o.description, head: o.source, base: o.target, draft })).data;
    } catch (e) {
      // Repositories whose plan has no draft pull requests answer 422: open a normal one.
      if (!(draft && e instanceof GitHubError && e.status === 422)) throw e;
      pr = (await call(ctx, "POST", route, { title, body: o.description, head: o.source, base: o.target })).data;
      note = "draft pull requests are not available here; opened as a normal pull request";
    }
    action = "created";
  }
  // Labels are added (never replaced): a person's own labels stay.
  await addLabels(ctx, project, pr.number, o.labels ?? []);
  return { web_url: pr.html_url, iid: pr.number, action, ...(note ? { note } : {}) };
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
