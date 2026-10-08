/** Thin GitLab REST client: MR notes and MR creation. */
export interface GitLabContext {
  apiUrl: string; // e.g. https://gitlab.com/api/v4
  token: string;
}

export function gitlabContext(gitlabUrl: string): GitLabContext | undefined {
  const token = process.env.QA_SENTINEL_GITLAB_TOKEN ?? process.env.GITLAB_TOKEN;
  if (!token) return undefined;
  const apiUrl = process.env.CI_API_V4_URL ?? `${gitlabUrl.replace(/\/$/, "")}/api/v4`;
  return { apiUrl, token };
}

async function call(ctx: GitLabContext, method: string, route: string, body?: unknown): Promise<any> {
  const res = await fetch(`${ctx.apiUrl}${route}`, {
    method,
    headers: { "PRIVATE-TOKEN": ctx.token, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`GitLab ${method} ${route} failed: ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : undefined;
}

const enc = (p: string | number) => encodeURIComponent(String(p));

export const MARKER = "<!-- qa-sentinel:gap-report -->";

/** Create or update the single qa-sentinel note on an MR. */
export async function upsertMrNote(ctx: GitLabContext, project: string | number, mrIid: string | number, body: string) {
  const notes: any[] = await call(ctx, "GET", `/projects/${enc(project)}/merge_requests/${enc(mrIid)}/notes?per_page=100`);
  const existing = notes.find((n) => typeof n.body === "string" && n.body.includes(MARKER));
  const full = `${MARKER}\n${body}`;
  if (existing) {
    await call(ctx, "PUT", `/projects/${enc(project)}/merge_requests/${enc(mrIid)}/notes/${existing.id}`, { body: full });
    return { action: "updated" as const, id: existing.id };
  }
  const created = await call(ctx, "POST", `/projects/${enc(project)}/merge_requests/${enc(mrIid)}/notes`, { body: full });
  return { action: "created" as const, id: created.id };
}

export async function createMergeRequest(
  ctx: GitLabContext,
  project: string | number,
  opts: { source: string; target: string; title: string; description: string; labels?: string[] },
): Promise<{ web_url: string; iid: number }> {
  return call(ctx, "POST", `/projects/${enc(project)}/merge_requests`, {
    source_branch: opts.source,
    target_branch: opts.target,
    title: opts.title,
    description: opts.description,
    labels: (opts.labels ?? []).join(","),
    remove_source_branch: true,
  });
}

/** MR context when running inside a GitLab merge request pipeline. */
export function gitlabMrFromEnv(): { project?: string; mrIid?: string; base?: string; title?: string; description?: string } {
  return {
    project: process.env.CI_PROJECT_ID,
    mrIid: process.env.CI_MERGE_REQUEST_IID ?? process.env.gitlabMergeRequestIid,
    base: process.env.CI_MERGE_REQUEST_DIFF_BASE_SHA ?? process.env.CI_MERGE_REQUEST_TARGET_BRANCH_NAME,
    title: process.env.CI_MERGE_REQUEST_TITLE ?? process.env.gitlabMergeRequestTitle,
    description: process.env.CI_MERGE_REQUEST_DESCRIPTION ?? process.env.gitlabMergeRequestDescription,
  };
}
