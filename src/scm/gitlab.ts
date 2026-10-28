/** Thin GitLab REST client: MR notes, MR creation/update, commit→MR lookup. Retries transient failures. */
import { maskSecrets } from "../secrets.js";
import { netFetch, looksLikeHtml } from "../net.js";

const WEB_PAGE_HINT = "a login or SSO proxy in front of GitLab? Check ci.gitlabUrl / CI_API_V4_URL and the token";
export interface GitLabContext {
  apiUrl: string; // e.g. https://gitlab.com/api/v4
  token: string;
}

export function gitlabToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.QA_SENTINEL_GITLAB_TOKEN ?? env.GITLAB_TOKEN;
}

export function gitlabContext(gitlabUrl: string, env: NodeJS.ProcessEnv = process.env): GitLabContext | undefined {
  const token = gitlabToken(env);
  if (!token) return undefined;
  const apiUrl = env.CI_API_V4_URL ?? `${gitlabUrl.replace(/\/+$/, "")}/api/v4`;
  return { apiUrl, token };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class GitLabError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/**
 * GitLab runs a line that starts with "/" in a note or a merge request description as a quick action (/approve, /merge, /target_branch, /assign ...),
 * as the user whose token posted it. Text from a model or a run folder must never do that, so such a line gets a zero-width space in front: it reads
 * the same, and GitLab does not see a command. (qa-sentinel's own reading of "/qa ready" ignores the zero-width space.)
 */
export const neutraliseQuickActions = (text: string) => text.replace(/(^[ \t]*|>)\/(?=\S)/gm, "$1\u200b/");

function safeBody(body: unknown): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const o = { ...(body as Record<string, unknown>) };
  for (const k of ["body", "description"]) if (typeof o[k] === "string") o[k] = neutraliseQuickActions(o[k] as string);
  return o;
}

/** One request with up to 3 retries on 429/5xx/network errors (exponential backoff, honours Retry-After). */
export async function call(ctx: GitLabContext, method: string, route: string, body?: unknown, attempts = 4): Promise<{ data: any; headers: Headers }> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await netFetch(`${ctx.apiUrl}${route}`, {
        method,
        headers: { "PRIVATE-TOKEN": ctx.token, "Content-Type": "application/json" },
        // Agent-written text may carry a credential the tests needed: masked before it is published.
        body: body ? maskSecrets(JSON.stringify(safeBody(body))) : undefined,
      });
      const text = await res.text();
      const html = looksLikeHtml(text, res.headers.get("content-type"));
      if (res.ok) {
        if (html) throw new GitLabError(`GitLab ${method} ${route} answered with a web page, not JSON (${WEB_PAGE_HINT})`, res.status);
        let data: any;
        try {
          data = text ? JSON.parse(text) : undefined;
        } catch {
          throw new GitLabError(`GitLab ${method} ${route} answered something that is not JSON (${WEB_PAGE_HINT}): ${text.slice(0, 80).replace(/\s+/g, " ")}`, res.status);
        }
        return { data, headers: res.headers };
      }
      const err = new GitLabError(`GitLab ${method} ${route} failed: ${res.status} ${html ? `(a web page, not JSON: ${WEB_PAGE_HINT})` : text.slice(0, 300)}`, res.status);
      if (res.status !== 429 && res.status < 500) throw err;
      lastErr = err;
      const retryAfter = Number(res.headers.get("retry-after"));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** i);
    } catch (e) {
      if (e instanceof GitLabError && e.status !== 429 && e.status < 500) throw e;
      lastErr = e;
      await sleep(500 * 2 ** i);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** GET every page of a list endpoint. `info.truncated` is set when `maxPages` was reached and GitLab says more follows. */
export async function getAll(ctx: GitLabContext, route: string, maxPages = 50, info?: { truncated?: boolean }): Promise<any[]> {
  const out: any[] = [];
  const sep = route.includes("?") ? "&" : "?";
  for (let page = 1; page <= maxPages; page++) {
    const { data, headers } = await call(ctx, "GET", `${route}${sep}per_page=100&page=${page}`);
    out.push(...(data ?? []));
    const next = headers.get("x-next-page");
    // GitLab says whether another page follows (an empty x-next-page = last page). Without that header, a short page is the last.
    if (!Array.isArray(data) || (next === null ? data.length < 100 : !next)) break;
    if (page === maxPages && info) info.truncated = true;
  }
  return out;
}

const enc = (p: string | number) => encodeURIComponent(String(p));

export const MARKER = "<!-- qa-sentinel:gap-report -->";

/** The notes written by the token's own user (anyone can paste the marker into a comment; only ours counts). Without a user id, all notes. */
async function ownNotes(ctx: GitLabContext, notes: any[]): Promise<any[]> {
  try {
    const me = (await call(ctx, "GET", "/user", undefined, 1)).data?.id;
    return me === undefined ? notes : notes.filter((n) => n.author?.id === me);
  } catch {
    return notes;
  }
}

/** The body of the qa-sentinel gap-report note on an MR, if there is one. */
export async function getMrNoteBody(ctx: GitLabContext, project: string | number, mrIid: string | number): Promise<string | undefined> {
  const notes = await getAll(ctx, `/projects/${enc(project)}/merge_requests/${enc(mrIid)}/notes?sort=asc`);
  return (await ownNotes(ctx, notes)).find((n) => typeof n.body === "string" && n.body.includes(MARKER))?.body;
}

/** Create or update the single qa-sentinel note on an MR (searches all pages of notes). */
export async function upsertMrNote(ctx: GitLabContext, project: string | number, mrIid: string | number, body: string) {
  const base = `/projects/${enc(project)}/merge_requests/${enc(mrIid)}/notes`;
  const notes = await getAll(ctx, `${base}?sort=asc`);
  const existing = (await ownNotes(ctx, notes)).find((n) => typeof n.body === "string" && n.body.includes(MARKER));
  const full = `${MARKER}\n${body}`;
  if (existing) {
    await call(ctx, "PUT", `${base}/${existing.id}`, { body: full });
    return { action: "updated" as const, id: existing.id };
  }
  const { data } = await call(ctx, "POST", base, { body: full });
  return { action: "created" as const, id: data.id };
}

export interface MrOptions {
  source: string;
  target: string;
  title: string;
  description: string;
  labels?: string[];
}

/** Create the MR, or update the open MR that already exists for the same source branch (safe to retry). */
export async function createOrUpdateMergeRequest(
  ctx: GitLabContext,
  project: string | number,
  o: MrOptions,
): Promise<{ web_url: string; iid: number; action: "created" | "updated" }> {
  const route = `/projects/${enc(project)}/merge_requests`;
  const { data: open } = await call(ctx, "GET", `${route}?state=opened&source_branch=${enc(o.source)}&target_branch=${enc(o.target)}`);
  const fields = { title: o.title, description: o.description, labels: (o.labels ?? []).join(",") };
  if (Array.isArray(open) && open.length) {
    const { data } = await call(ctx, "PUT", `${route}/${open[0].iid}`, fields);
    return { web_url: data.web_url, iid: data.iid, action: "updated" };
  }
  const { data } = await call(ctx, "POST", route, {
    ...fields,
    source_branch: o.source,
    target_branch: o.target,
    remove_source_branch: true,
  });
  return { web_url: data.web_url, iid: data.iid, action: "created" };
}

/**
 * The merge request that says what happened to a source branch: an OPEN one if there is any (work is going on, whatever
 * else was closed or merged before), else the newest by creation time (not by last update: a late comment on an old
 * closed one must not make the branch look closed). Undefined when the branch has no merge request.
 */
export async function latestMrForBranch(ctx: GitLabContext, project: string | number, source: string, target?: string): Promise<{ iid: number; web_url: string; state: string; title?: string } | undefined> {
  const { data } = await call(ctx, "GET", `/projects/${enc(project)}/merge_requests?state=all&source_branch=${enc(source)}${target ? `&target_branch=${enc(target)}` : ""}&order_by=created_at&sort=desc&per_page=100`);
  if (!Array.isArray(data) || !data.length) return undefined;
  const open = data.find((m: any) => m.state === "opened");
  if (open) return open;
  const stamp = (m: any) => (typeof m.created_at === "string" ? Date.parse(m.created_at) : NaN);
  return [...data].sort((a: any, b: any) => (Number.isNaN(stamp(b)) || Number.isNaN(stamp(a)) ? 0 : stamp(b) - stamp(a)))[0];
}

/** Open merge requests carrying a label (the QA agent's own: `qa-agent`). */
export async function openMrsWithLabel(ctx: GitLabContext, project: string | number, label: string): Promise<{ iid: number; web_url: string; source_branch: string; title: string }[]> {
  return getAll(ctx, `/projects/${enc(project)}/merge_requests?state=opened&labels=${enc(label)}`, 5);
}

/**
 * One note on an MR, found by its own marker line and edited in place (the token's own notes only): a schedule that
 * finds the same problem again changes nothing instead of piling up notes. Returns whether it wrote anything.
 */
export async function upsertMarkedNote(ctx: GitLabContext, project: string | number, mrIid: string | number, marker: string, body: string): Promise<"created" | "updated" | "same"> {
  const base = `/projects/${enc(project)}/merge_requests/${enc(mrIid)}/notes`;
  const existing = (await ownNotes(ctx, await getAll(ctx, `${base}?sort=asc`))).find((n) => typeof n.body === "string" && n.body.includes(marker));
  const full = neutraliseQuickActions(`${marker}\n${body}`); // what GitLab will hold, so an unchanged note compares equal
  if (existing) {
    if (existing.body === full) return "same";
    await call(ctx, "PUT", `${base}/${existing.id}`, { body: full });
    return "updated";
  }
  await call(ctx, "POST", base, { body: full });
  return "created";
}

/** MRs that contain a commit (used after merge to recover the story/AC the dev wrote). */
export async function mergeRequestsForCommit(ctx: GitLabContext, project: string, sha: string): Promise<any[]> {
  const { data } = await call(ctx, "GET", `/projects/${enc(project)}/repository/commits/${enc(sha)}/merge_requests`);
  return Array.isArray(data) ? data : [];
}

/** Emoji reactions on one merge request note (GET .../notes/:id/award_emoji): who reacted with which emoji. */
export async function noteAwards(ctx: GitLabContext, project: string | number, mrIid: string | number, noteId: number): Promise<{ name: string; user?: { id?: number; username?: string } }[]> {
  return getAll(ctx, `/projects/${enc(project)}/merge_requests/${enc(mrIid)}/notes/${enc(noteId)}/award_emoji`);
}

export async function getProject(ctx: GitLabContext, project: string | number): Promise<any> {
  return (await call(ctx, "GET", `/projects/${enc(project)}`, undefined, 1)).data;
}

export async function currentUser(ctx: GitLabContext): Promise<any> {
  return (await call(ctx, "GET", "/user", undefined, 1)).data;
}

/** GitLab treats these title prefixes as a draft: "Draft:", "Draft -", "[Draft]", "(Draft)". */
export const isDraftTitle = (title: string | undefined) => /^\s*(\[draft\]|\(draft\)|draft\s*:|draft\s+-(\s|$))/i.test(title ?? "");

/**
 * Is this merge request still a draft? Asks GitLab (a retried pipeline keeps the title it started with); when that
 * can't be asked, the title from the pipeline is used. Unknown is "not a draft" so a report is never lost by accident.
 */
export async function mrIsDraft(ctx: GitLabContext | undefined, project: string | undefined, iid: string | undefined, titleFromEnv: string | undefined): Promise<boolean> {
  if (ctx && project && iid) {
    try {
      const { data } = await call(ctx, "GET", `/projects/${encodeURIComponent(project)}/merge_requests/${encodeURIComponent(iid)}`, undefined, 2);
      if (typeof data?.draft === "boolean") return data.draft;
      if (typeof data?.work_in_progress === "boolean") return data.work_in_progress;
      if (typeof data?.title === "string") return isDraftTitle(data.title);
    } catch {
      /* fall back to the title below */
    }
  }
  return isDraftTitle(titleFromEnv);
}

/** MR context when running inside a GitLab merge request pipeline (or Jenkins with the GitLab plugin). */
export function gitlabMrFromEnv(env: NodeJS.ProcessEnv = process.env) {
  const project = env.CI_PROJECT_ID ?? env.gitlabMergeRequestTargetProjectId;
  const mrIid = env.CI_MERGE_REQUEST_IID ?? env.gitlabMergeRequestIid;
  return {
    project,
    mrIid,
    base: env.CI_MERGE_REQUEST_DIFF_BASE_SHA ?? env.CI_MERGE_REQUEST_TARGET_BRANCH_NAME,
    targetBranch: env.CI_MERGE_REQUEST_TARGET_BRANCH_NAME ?? env.gitlabTargetBranch,
    title: env.CI_MERGE_REQUEST_TITLE ?? env.gitlabMergeRequestTitle,
    description: env.CI_MERGE_REQUEST_DESCRIPTION ?? env.gitlabMergeRequestDescription,
    sourceBranch: env.CI_MERGE_REQUEST_SOURCE_BRANCH_NAME ?? env.gitlabSourceBranch,
    url: env.CI_MERGE_REQUEST_PROJECT_URL && mrIid ? `${env.CI_MERGE_REQUEST_PROJECT_URL}/-/merge_requests/${mrIid}` : undefined,
  };
}

/**
 * HTTPS push URL with the token embedded, built only at push time so the token never lands in .git/config
 * (which the agent could read). Returns undefined when we can't build one (then `origin` is used).
 */
export function pushUrl(gitlabUrl: string, projectPath: string | undefined, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const token = gitlabToken(env);
  if (!token || !projectPath || /^\d+$/.test(projectPath)) return undefined;
  const host = new URL(env.CI_SERVER_URL ?? gitlabUrl);
  // A GitLab under a sub-path (https://corp.example/gitlab) keeps that path: the project lives below it.
  const base = host.pathname.replace(/\/+$/, "");
  return `${host.protocol}//oauth2:${encodeURIComponent(token)}@${host.host}${base}/${projectPath.replace(/^\/|\.git$/g, "")}.git`;
}

/** A file's raw content at a ref, or undefined when it doesn't exist. */
export async function rawFile(ctx: GitLabContext, project: string | number, file: string, ref: string): Promise<string | undefined> {
  const res = await netFetch(`${ctx.apiUrl}/projects/${enc(project)}/repository/files/${enc(file)}/raw?ref=${enc(ref)}`, { headers: { "PRIVATE-TOKEN": ctx.token } });
  if (res.status === 404) return undefined;
  if (!res.ok) throw new GitLabError(`GitLab GET ${file} in ${project}: ${res.status}`, res.status);
  // GitLab serves raw files as text/plain. A web page (single sign-on, a proxy login) comes as text/html and would be taken for the file.
  if (/text\/html/i.test(res.headers.get("content-type") ?? "")) throw new GitLabError(`GitLab GET ${file} in ${project} answered with a web page, not the file (${WEB_PAGE_HINT})`, res.status);
  return res.text();
}

/** Projects of a group (and its subgroups), not archived. */
export async function groupProjects(ctx: GitLabContext, group: string, subgroups = true): Promise<any[]> {
  return getAll(ctx, `/groups/${enc(group)}/projects?include_subgroups=${subgroups}&archived=false&order_by=path&sort=asc&simple=true`);
}

/** Every file path in a project at a ref (blobs only), capped. */
export async function projectFiles(ctx: GitLabContext, project: string | number, ref: string, maxPages = 30): Promise<string[]> {
  const items = await getAll(ctx, `/projects/${enc(project)}/repository/tree?recursive=true&ref=${enc(ref)}`, maxPages);
  return items.filter((i) => i.type === "blob").map((i) => String(i.path));
}
