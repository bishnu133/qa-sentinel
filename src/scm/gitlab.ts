/** Thin GitLab REST client: MR notes, MR creation/update, commit→MR lookup. Retries transient failures. */
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
  const apiUrl = env.CI_API_V4_URL ?? `${gitlabUrl.replace(/\/$/, "")}/api/v4`;
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

/** One request with up to 3 retries on 429/5xx/network errors (exponential backoff, honours Retry-After). */
export async function call(ctx: GitLabContext, method: string, route: string, body?: unknown, attempts = 4): Promise<{ data: any; headers: Headers }> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`${ctx.apiUrl}${route}`, {
        method,
        headers: { "PRIVATE-TOKEN": ctx.token, "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      if (res.ok) return { data: text ? JSON.parse(text) : undefined, headers: res.headers };
      const err = new GitLabError(`GitLab ${method} ${route} failed: ${res.status} ${text.slice(0, 300)}`, res.status);
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

/** GET every page of a list endpoint. */
async function getAll(ctx: GitLabContext, route: string, maxPages = 50): Promise<any[]> {
  const out: any[] = [];
  const sep = route.includes("?") ? "&" : "?";
  for (let page = 1; page <= maxPages; page++) {
    const { data, headers } = await call(ctx, "GET", `${route}${sep}per_page=100&page=${page}`);
    out.push(...(data ?? []));
    const next = headers.get("x-next-page");
    if (!next || !Array.isArray(data) || data.length < 100) break;
  }
  return out;
}

const enc = (p: string | number) => encodeURIComponent(String(p));

export const MARKER = "<!-- qa-sentinel:gap-report -->";

/** Create or update the single qa-sentinel note on an MR (searches all pages of notes). */
export async function upsertMrNote(ctx: GitLabContext, project: string | number, mrIid: string | number, body: string) {
  const base = `/projects/${enc(project)}/merge_requests/${enc(mrIid)}/notes`;
  const notes = await getAll(ctx, `${base}?sort=asc`);
  const existing = notes.find((n) => typeof n.body === "string" && n.body.includes(MARKER));
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

/** MRs that contain a commit (used after merge to recover the story/AC the dev wrote). */
export async function mergeRequestsForCommit(ctx: GitLabContext, project: string, sha: string): Promise<any[]> {
  const { data } = await call(ctx, "GET", `/projects/${enc(project)}/repository/commits/${enc(sha)}/merge_requests`);
  return Array.isArray(data) ? data : [];
}

export async function getProject(ctx: GitLabContext, project: string | number): Promise<any> {
  return (await call(ctx, "GET", `/projects/${enc(project)}`, undefined, 1)).data;
}

export async function currentUser(ctx: GitLabContext): Promise<any> {
  return (await call(ctx, "GET", "/user", undefined, 1)).data;
}

/** MR context when running inside a GitLab merge request pipeline (or Jenkins with the GitLab plugin). */
export function gitlabMrFromEnv(env: NodeJS.ProcessEnv = process.env) {
  const project = env.CI_PROJECT_ID ?? env.gitlabMergeRequestTargetProjectId;
  const mrIid = env.CI_MERGE_REQUEST_IID ?? env.gitlabMergeRequestIid;
  return {
    project,
    mrIid,
    base: env.CI_MERGE_REQUEST_DIFF_BASE_SHA ?? env.CI_MERGE_REQUEST_TARGET_BRANCH_NAME,
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
  return `${host.protocol}//oauth2:${encodeURIComponent(token)}@${host.host}/${projectPath.replace(/^\/|\.git$/g, "")}.git`;
}
