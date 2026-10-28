/**
 * Minimal Jira REST client (Cloud and Server/Data Center, API v2). Only the CLI talks to Jira;
 * credentials never reach agents (they are scrubbed from the agent environment).
 *
 * Auth: Cloud → JIRA_EMAIL + JIRA_API_TOKEN (basic); Server/DC → JIRA_PAT (bearer).
 */
import { maskSecrets } from "../secrets.js";
import { netFetch, looksLikeHtml, parseJsonAnswer } from "../net.js";
import { log } from "../log.js";

export interface JiraContext {
  baseUrl: string;
  authHeader: string;
}

export type JiraAuthMode = "auto" | "cloud" | "pat";

const JIRA_WEB_PAGE_HINT = "a login or SSO proxy in front of Jira? Check the baseUrl and the token";

/**
 * How to log in. `auto`: Jira Cloud (JIRA_EMAIL + JIRA_API_TOKEN, Basic) when JIRA_EMAIL is set, else the Data Center
 * personal access token JIRA_PAT (Bearer). Cloud does not take a Bearer PAT, so with both set `auto` goes to Cloud;
 * `pat` and `cloud` force one form. The first argument is the Jira base URL, or the `requirements.jira` config.
 */
export function jiraContext(jira: string | { baseUrl?: string; auth?: JiraAuthMode } | undefined, env: NodeJS.ProcessEnv = process.env): JiraContext | undefined {
  const baseUrl = typeof jira === "string" ? jira : jira?.baseUrl;
  const mode: JiraAuthMode = (typeof jira === "object" && jira?.auth) || "auto";
  if (!baseUrl) return undefined;
  const base = baseUrl.replace(/\/$/, "");
  const cloud = () => (env.JIRA_EMAIL && env.JIRA_API_TOKEN ? { baseUrl: base, authHeader: `Basic ${Buffer.from(`${env.JIRA_EMAIL}:${env.JIRA_API_TOKEN}`).toString("base64")}` } : undefined);
  const pat = () => (env.JIRA_PAT ? { baseUrl: base, authHeader: `Bearer ${env.JIRA_PAT}` } : undefined);
  if (mode === "cloud") return cloud();
  if (mode === "pat") return pat();
  return env.JIRA_EMAIL ? (cloud() ?? pat()) : (pat() ?? cloud());
}

/** True when both login forms are set, which is usually a mistake (`auto` then uses Cloud). */
export const jiraAuthAmbiguous = (env: NodeJS.ProcessEnv = process.env) => !!(env.JIRA_PAT && env.JIRA_EMAIL);

export interface JiraIssue {
  key: string;
  summary: string;
  description: string;
  acceptanceCriteria?: string;
  status: string;
  /** Jira's category of the status: "new", "indeterminate" or "done" (the same in every workflow). */
  statusCategory?: string;
  /** Issue type name (Story, Bug, Task, …). */
  issueType?: string;
  labels?: string[];
  url: string;
  updated?: string;
  /** Extra fields asked for (scope fields), as text. */
  extra?: Record<string, string>;
  /** The parent card (a sub-task's story, a task's epic, …). */
  parent?: { key: string; issueType?: string };
  /** Issue links on this card, with the other card's key and type. */
  links?: JiraLink[];
  /** Jira Components on this card. */
  components?: string[];
}

export interface JiraLink {
  /** The link type's name and both wordings ("Blocks", "blocks", "is blocked by"). */
  type: string;
  inward: string;
  outward: string;
  /** Which way the OTHER card relates to this one: "outward" = this card <outward wording> other. */
  direction: "inward" | "outward";
  key: string;
  issueType?: string;
}

/** Links of an issue as returned by Jira (`fields.issuelinks`). */
export function parseLinks(raw: unknown): JiraLink[] {
  if (!Array.isArray(raw)) return [];
  const out: JiraLink[] = [];
  for (const l of raw as any[]) {
    const t = l?.type ?? {};
    const other = l?.outwardIssue ?? l?.inwardIssue;
    if (!other?.key) continue;
    out.push({ type: String(t.name ?? ""), inward: String(t.inward ?? ""), outward: String(t.outward ?? ""), direction: l.outwardIssue ? "outward" : "inward", key: String(other.key), ...(other.fields?.issuetype?.name ? { issueType: String(other.fields.issuetype.name) } : {}) });
  }
  return out;
}

/** A Jira answer that is not a success. `status` 404 means the key (or the issue) does not exist or is not visible to this user. */
export class JiraHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
export const isJiraNotFound = (e: unknown) => e instanceof JiraHttpError && e.status === 404;

/** How long one card read may take: a Jira that hangs must not hold a CI job until its own timeout (QA_SENTINEL_JIRA_TIMEOUT_MS overrides, in milliseconds). */
const jiraTimeoutMs = () => {
  const n = Number(process.env.QA_SENTINEL_JIRA_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 30_000;
};

export async function fetchIssue(ctx: JiraContext, key: string, acField?: string, extraFields: string[] = []): Promise<JiraIssue> {
  const fields = ["summary", "description", "status", "issuetype", "labels", "updated", "parent", "issuelinks", "components", ...(acField ? [acField] : []), ...extraFields].join(",");
  const res = await netFetch(`${ctx.baseUrl}/rest/api/2/issue/${encodeURIComponent(key)}?fields=${fields}`, {
    headers: { Authorization: ctx.authHeader, Accept: "application/json" },
    signal: AbortSignal.timeout(jiraTimeoutMs()),
  });
  const body = await res.text();
  if (!res.ok) throw new JiraHttpError(`Jira GET ${key} failed: ${res.status} ${looksLikeHtml(body, res.headers.get("content-type")) ? `(a web page, not JSON: ${JIRA_WEB_PAGE_HINT})` : body.slice(0, 200)}`, res.status);
  const j: any = parseJsonAnswer(body, res.headers.get("content-type"), "Jira", JIRA_WEB_PAGE_HINT) ?? {};
  const f = j.fields ?? {};
  return {
    key: j.key ?? key,
    summary: String(f.summary ?? ""),
    description: toText(f.description),
    acceptanceCriteria: acField ? toText(f[acField]) || undefined : undefined,
    status: String(f.status?.name ?? ""),
    ...(f.status?.statusCategory?.key ? { statusCategory: String(f.status.statusCategory.key) } : {}),
    ...(f.issuetype?.name ? { issueType: String(f.issuetype.name) } : {}),
    ...(Array.isArray(f.labels) ? { labels: f.labels.map(String) } : {}),
    ...(f.parent?.key ? { parent: { key: String(f.parent.key), ...(f.parent.fields?.issuetype?.name ? { issueType: String(f.parent.fields.issuetype.name) } : {}) } } : {}),
    links: parseLinks(f.issuelinks),
    components: Array.isArray(f.components) ? f.components.map((x: any) => String(x?.name ?? x)).filter(Boolean) : [],
    url: `${ctx.baseUrl}/browse/${j.key ?? key}`,
    updated: f.updated,
    extra: Object.fromEntries(extraFields.map((x) => [x, toText(f[x])]).filter(([, v]) => v)),
  };
}

/** Jira returns wiki markup (v2) or Atlassian Document Format (some Cloud fields). Normalise both to markdown-ish text. */
export function toText(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return wikiToMarkdown(v);
  if (typeof v === "object") return adfToText(v as any).trim();
  return String(v);
}

export function wikiToMarkdown(s: string): string {
  return s
    .split(/\r?\n/)
    .map((l) => {
      const h = l.match(/^\s*h([1-6])\.\s+(.*)$/);
      if (h) return `${"#".repeat(Number(h[1]))} ${h[2]}`;
      // Wiki lists: ** / ## mark the depth; keep it as indentation so sub-points stay with their parent.
      const b = l.match(/^\s*([*#]+)\s+(.*)$/);
      if (b && !/^\*[^*\s].*\*$/.test(l.trim())) return `${"  ".repeat(b[1].length - 1)}${b[1].endsWith("#") ? "1." : "-"} ${b[2]}`;
      return l;
    })
    .join("\n");
}

/** Atlassian Document Format → markdown: headings, nested lists (indented), tables (| a | b |), panels, code. */
function adfToText(node: any, depth = 0): string {
  if (!node) return "";
  const kids = (n: any, d = depth) => (n.content ?? []).map((c: any) => adfToText(c, d)).join("");
  switch (node.type) {
    case "text":
      return node.text ?? "";
    case "hardBreak":
      return "\n";
    case "paragraph":
      return `${kids(node)}\n`;
    case "heading":
      return `${"#".repeat(node.attrs?.level ?? 2)} ${kids(node)}\n`;
    case "bulletList":
    case "orderedList":
      return (node.content ?? [])
        .map((li: any, i: number) => {
          const marker = node.type === "orderedList" ? `${i + 1}.` : "-";
          const parts = (li.content ?? []).map((c: any) => (c.type === "bulletList" || c.type === "orderedList" ? adfToText(c, depth + 1) : adfToText(c, depth).replace(/\n+$/, " ")));
          const [first, ...rest] = parts;
          return `${"  ".repeat(depth)}${marker} ${(first ?? "").trim()}\n${rest.join("")}`;
        })
        .join("");
    case "table":
      return (
        (node.content ?? [])
          .map((row: any, i: number) => {
            const cells = (row.content ?? []).map((cell: any) => kids(cell, 0).replace(/\s*\n\s*/g, " ").replace(/\|/g, "/").trim());
            const line = `| ${cells.join(" | ")} |`;
            const header = i === 0 && (row.content ?? []).every((c: any) => c.type === "tableHeader");
            return header ? `${line}\n|${cells.map(() => " --- ").join("|")}|` : line;
          })
          .join("\n") + "\n\n"
      );
    default:
      return kids(node);
  }
}

// ---------------------------------------------------------------------------------------------
// Writing: gap reports as Jira comments (REST v2, wiki markup; accepted by Cloud and Server/DC).

/** Hidden-by-convention marker that identifies our comment for one service on a story. */
export const jiraMarker = (service: string) => `qa-sentinel:gap-report:${service}`;

/** Convert the gap report's GitLab-flavoured Markdown to Jira wiki markup. */
export function markdownToJiraWiki(md: string): string {
  const out: string[] = [];
  let inCode = false;
  for (const raw of md.replace(/<!--[\s\S]*?-->/g, "").split(/\r?\n/)) {
    let l = raw;
    if (/^\s*```/.test(l)) {
      out.push("{code}");
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      out.push(l);
      continue;
    }
    // Collapsible sections: keep the summary as a small heading, drop the HTML.
    const summary = l.match(/<summary>(.*?)<\/summary>/);
    if (summary) l = `h4. ${summary[1]}`;
    l = l.replace(/<\/?details>/g, "").replace(/<\/?sub>/g, "").replace(/<br\s*\/?>/g, " ");
    if (/^\s*\|(\s*:?-{3,}:?\s*\|)+\s*$/.test(l)) continue; // table separator row
    const h = l.match(/^(#{1,6})\s+(.*)$/);
    if (h) l = `h${h[1].length}. ${h[2]}`;
    l = l.replace(/^(\s*)[-*]\s+/, (_m, sp: string) => `${"*".repeat(1 + Math.floor(sp.length / 2))} `);
    l = l.replace(/^(\s*)\d+\.\s+/, (_m, sp: string) => `${"#".repeat(1 + Math.floor(sp.length / 2))} `);
    l = inline(l);
    out.push(l);
  }
  // Table header rows: the line before a removed separator becomes ||a||b||.
  return markHeaders(md, out.join("\n")).replace(/\n{3,}/g, "\n\n").trim();
}

function inline(l: string): string {
  return l
    .replace(/`([^`]+)`/g, (_m, c: string) => `{{${c.replace(/[{}]/g, "")}}}`)
    .replace(/\*\*([^*]+)\*\*/g, "*$1*")
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, "[$1|$2]");
}

/** Markdown table headers are the row above a |---| line; render them with || in Jira. */
function markHeaders(md: string, wiki: string): string {
  const lines = md.replace(/<!--[\s\S]*?-->/g, "").split(/\r?\n/);
  const headers = new Set<string>();
  lines.forEach((l, i) => {
    if (i > 0 && /^\s*\|(\s*:?-{3,}:?\s*\|)+\s*$/.test(l)) headers.add(inline(lines[i - 1]));
  });
  return wiki
    .split("\n")
    .map((l) => (headers.has(l) ? l.replace(/^\s*\|/, "||").replace(/\|\s*$/, "||").replace(/\s\|\s/g, " || ") : l))
    .join("\n");
}

/** Keep the comment under Jira's limit: cut at a line boundary and point to the full report. */
export function capForJira(wiki: string, maxChars: number, fullReportUrl?: string): string {
  if (wiki.length <= maxChars) return wiki;
  const note = `\n\n_Report shortened for Jira. Full report: ${fullReportUrl ? `[CI artifact|${fullReportUrl}]` : "see the qa-gap-report.md CI artifact"}._`;
  const cut = wiki.slice(0, maxChars - note.length);
  return cut.slice(0, Math.max(0, cut.lastIndexOf("\n"))) + note;
}

async function jiraCall(ctx: JiraContext, method: string, route: string, body?: unknown, o: { retry?: boolean } = {}): Promise<any> {
  for (let attempt = 1; ; attempt++) {
    const res = await netFetch(`${ctx.baseUrl}${route}`, {
      method,
      headers: { Authorization: ctx.authHeader, Accept: "application/json", "Content-Type": "application/json" },
      body: body ? maskSecrets(JSON.stringify(body)) : undefined,
    });
    if ((res.status === 429 || res.status >= 500) && attempt < 4 && o.retry !== false) {
      const wait = Number(res.headers.get("retry-after")) * 1000 || 500 * 2 ** attempt;
      await new Promise((r) => setTimeout(r, Math.min(wait, 10_000)));
      continue;
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`Jira ${method} ${route}: ${res.status} ${looksLikeHtml(text, res.headers.get("content-type")) ? `(a web page, not JSON: ${JIRA_WEB_PAGE_HINT})` : text.slice(0, 200)}`);
    return parseJsonAnswer(text, res.headers.get("content-type"), "Jira", JIRA_WEB_PAGE_HINT) ?? {};
  }
}

/** Who the token belongs to: Cloud has `accountId`; Data Center has `name` and `key`. */
export interface JiraUser {
  accountId?: string;
  name?: string;
  key?: string;
  displayName?: string;
  accountType?: string;
}

/** Thrown when qa-sentinel is asked to change a comment but Jira will not say which comments are its own. Nothing is written. */
export class JiraIdentityError extends Error {
  constructor(what = "change a comment") {
    super(`Jira did not say which user the credentials belong to (GET /rest/api/2/myself), so qa-sentinel cannot tell its own comments from other people's and will not ${what}. Check the token (doctor --online checks this).`);
    this.name = "JiraIdentityError";
  }
}

const MAX_MYSELF_FAILURES = 3;
const meOk = new Map<string, JiraUser>();
const meFailures = new Map<string, number>();
const meKey = (ctx: JiraContext) => `${ctx.baseUrl}\u0000${ctx.authHeader}`;

/**
 * The user the credentials belong to (GET /rest/api/2/myself). A success is remembered for the whole process (one call
 * per site and login). A failure is NOT remembered: the next call asks again, up to 3 failures in a process, after
 * which Jira is taken as unable to say (the callers then refuse to change comments).
 */
export async function myself(ctx: JiraContext): Promise<JiraUser | undefined> {
  const key = meKey(ctx);
  const known = meOk.get(key);
  if (known) return known;
  if ((meFailures.get(key) ?? 0) >= MAX_MYSELF_FAILURES) return undefined;
  try {
    const u = await jiraCall(ctx, "GET", "/rest/api/2/myself", undefined, { retry: false });
    if (u && (u.accountId || u.name || u.key)) {
      const me: JiraUser = { accountId: u.accountId, name: u.name, key: u.key, displayName: u.displayName };
      meOk.set(key, me);
      return me;
    }
  } catch {
    /* counted below */
  }
  meFailures.set(key, (meFailures.get(key) ?? 0) + 1);
  return undefined;
}

/** The user, or a refusal: for everything that edits or deletes. */
export async function requireMyself(ctx: JiraContext, what?: string): Promise<JiraUser> {
  const me = await myself(ctx);
  if (!me) throw new JiraIdentityError(what);
  return me;
}

/**
 * Is this comment's author `me`? Cloud accounts are compared by accountId, Data Center users by key, then name; the
 * first identifier both sides have decides. (A personal API token makes that person's own comments "ours".)
 */
export function isAuthor(author: JiraUser | undefined, me: JiraUser | undefined): boolean {
  if (!author || !me) return false;
  for (const f of ["accountId", "key", "name"] as const) if (author[f] && me[f]) return author[f] === me[f];
  return false;
}

export interface JiraComment {
  id: string;
  body: string;
  author?: JiraUser;
  created?: string;
  updated?: string;
  visibility?: { type: string; value: string };
}

/** Every comment on a story, oldest first (all pages). */
export async function listComments(ctx: JiraContext, key: string): Promise<JiraComment[]> {
  const base = `/rest/api/2/issue/${encodeURIComponent(key)}/comment`;
  const out: JiraComment[] = [];
  for (let startAt = 0; ; ) {
    const page = await jiraCall(ctx, "GET", `${base}?startAt=${startAt}&maxResults=100`);
    const comments: any[] = page.comments ?? [];
    for (const cm of comments) if (typeof cm.body === "string") out.push({ id: String(cm.id), body: cm.body, author: cm.author, created: cm.created, updated: cm.updated, visibility: cm.visibility });
    startAt += comments.length;
    if (!comments.length || startAt >= (page.total ?? 0)) return out;
  }
}

/**
 * The comments qa-sentinel's own user wrote on a story. Throws JiraIdentityError when Jira will not say who the token
 * belongs to: callers that change or delete comments must not guess.
 */
export async function listOwnComments(ctx: JiraContext, key: string): Promise<JiraComment[]> {
  const me = await requireMyself(ctx, "clean up older comments");
  return (await listComments(ctx, key)).filter((cm) => isAuthor(cm.author, me));
}

/**
 * The first comment on a story that is qa-sentinel's own (written by the token's user) and contains `marker`. Anyone
 * can paste a marker into a comment; that must never get theirs edited. When Jira will not say who the token belongs
 * to this THROWS (JiraIdentityError): no comment is edited, none is created. `ownOnly: false` is for read-only looks.
 */
export async function findIssueComment(ctx: JiraContext, key: string, marker: string, o: { ownOnly?: boolean } = {}): Promise<{ id: string; body: string } | undefined> {
  const me = o.ownOnly === false ? undefined : await requireMyself(ctx);
  const hit = (await listComments(ctx, key)).find((cm) => cm.body.includes(marker) && (!me || isAuthor(cm.author, me)));
  return hit ? { id: hit.id, body: hit.body } : undefined;
}

/** Delete one comment (needs the permission to delete the token user's own comments; callers fall back to editing). */
export async function deleteComment(ctx: JiraContext, key: string, id: string): Promise<void> {
  await jiraCall(ctx, "DELETE", `/rest/api/2/issue/${encodeURIComponent(key)}/comment/${encodeURIComponent(id)}`);
}

/** Write a comment: replace `existingId`, or add a new one. */
export async function writeIssueComment(ctx: JiraContext, key: string, existingId: string | undefined, body: string, visibility?: { type: "role" | "group"; value: string }): Promise<{ action: "created" | "updated"; id: string; url: string }> {
  const base = `/rest/api/2/issue/${encodeURIComponent(key)}/comment`;
  const payload = { body, ...(visibility ? { visibility } : {}) };
  if (existingId) {
    await jiraCall(ctx, "PUT", `${base}/${existingId}`, payload);
    return { action: "updated", id: existingId, url: `${ctx.baseUrl}/browse/${key}?focusedCommentId=${existingId}` };
  }
  const created = await jiraCall(ctx, "POST", base, payload);
  return { action: "created", id: String(created.id), url: `${ctx.baseUrl}/browse/${key}?focusedCommentId=${created.id}` };
}

/** Create or update qa-sentinel's comment for one service on a story (searches every page of comments). */
export async function upsertIssueComment(
  ctx: JiraContext,
  key: string,
  service: string,
  wikiBody: string,
  visibility?: { type: "role" | "group"; value: string },
  markerText: string = jiraMarker(service),
): Promise<{ action: "created" | "updated"; id: string; url: string }> {
  const existing = await findIssueComment(ctx, key, markerText);
  // The marker is plain text (wiki markup has no hidden comments); keep it small and grey at the end.
  return writeIssueComment(ctx, key, existing?.id, `${wikiBody}\n\n{color:#97a0af}${markerText}{color}`, visibility);
}

// ---------------------------------------------------------------------------------------------
// Showcase: labels, issue properties (what we attached) and attachments.

export async function issueLabels(ctx: JiraContext, key: string): Promise<string[]> {
  const j = await jiraCall(ctx, "GET", `/rest/api/2/issue/${encodeURIComponent(key)}?fields=labels`);
  return j.fields?.labels ?? [];
}

export async function removeLabel(ctx: JiraContext, key: string, label: string): Promise<void> {
  await jiraCall(ctx, "PUT", `/rest/api/2/issue/${encodeURIComponent(key)}`, { update: { labels: [{ remove: label }] } });
}

export async function getIssueProperty<T = unknown>(ctx: JiraContext, key: string, prop: string): Promise<T | undefined> {
  try {
    const j = await jiraCall(ctx, "GET", `/rest/api/2/issue/${encodeURIComponent(key)}/properties/${encodeURIComponent(prop)}`);
    return j.value as T;
  } catch (e) {
    if (/: 404 /.test((e as Error).message)) return undefined;
    throw e;
  }
}

export async function setIssueProperty(ctx: JiraContext, key: string, prop: string, value: unknown): Promise<void> {
  await jiraCall(ctx, "PUT", `/rest/api/2/issue/${encodeURIComponent(key)}/properties/${encodeURIComponent(prop)}`, value);
}

/** Upload one file as an attachment (multipart; Jira requires the no-check XSRF header). */
export async function attachFile(ctx: JiraContext, key: string, fileName: string, data: Buffer, contentType = "application/octet-stream"): Promise<{ id: string; filename: string }> {
  const form = new FormData();
  const isText = /^text\/|json|markdown|xml|yaml/i.test(contentType) || /\.(md|txt|json|log|ya?ml|xml|csv|html?)$/i.test(fileName);
  const bytes = isText ? Buffer.from(maskSecrets(data.toString("utf8")), "utf8") : data;
  form.append("file", new Blob([new Uint8Array(bytes)], { type: contentType }), fileName);
  const res = await netFetch(`${ctx.baseUrl}/rest/api/2/issue/${encodeURIComponent(key)}/attachments`, {
    method: "POST",
    headers: { Authorization: ctx.authHeader, Accept: "application/json", "X-Atlassian-Token": "no-check" },
    body: form,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Jira attach ${fileName} to ${key}: ${res.status} ${text.slice(0, 200)}`);
  const [a] = parseJsonAnswer(text, res.headers.get("content-type"), "Jira", JIRA_WEB_PAGE_HINT);
  return { id: String(a.id), filename: a.filename };
}

export async function deleteAttachment(ctx: JiraContext, id: string): Promise<void> {
  await jiraCall(ctx, "DELETE", `/rest/api/2/attachment/${encodeURIComponent(id)}`);
}

// ---------------------------------------------------------------------------------------------
// Bugs: create, link to the story, comment.

export async function projectIssueTypes(ctx: JiraContext, projectKey: string): Promise<string[]> {
  const j = await jiraCall(ctx, "GET", `/rest/api/2/project/${encodeURIComponent(projectKey)}`);
  return (j.issueTypes ?? []).filter((t: any) => !t.subtask).map((t: any) => String(t.name));
}

export async function createIssue(ctx: JiraContext, fields: { project: string; issueType: string; summary: string; description: string; labels?: string[]; priority?: string }): Promise<{ key: string; url: string }> {
  const j = await jiraCall(ctx, "POST", "/rest/api/2/issue", {
    fields: {
      project: { key: fields.project },
      issuetype: { name: fields.issueType },
      summary: fields.summary.slice(0, 250),
      description: fields.description,
      ...(fields.labels?.length ? { labels: fields.labels } : {}),
      ...(fields.priority ? { priority: { name: fields.priority } } : {}),
    },
  });
  return { key: j.key, url: `${ctx.baseUrl}/browse/${j.key}` };
}

export async function linkIssues(ctx: JiraContext, from: string, to: string, type = "Relates"): Promise<void> {
  await jiraCall(ctx, "POST", "/rest/api/2/issueLink", { type: { name: type }, inwardIssue: { key: from }, outwardIssue: { key: to } });
}

export async function addComment(ctx: JiraContext, key: string, body: string): Promise<void> {
  await jiraCall(ctx, "POST", `/rest/api/2/issue/${encodeURIComponent(key)}/comment`, { body });
}

export async function issueStatus(ctx: JiraContext, key: string): Promise<{ status: string; category?: string }> {
  const j = await jiraCall(ctx, "GET", `/rest/api/2/issue/${encodeURIComponent(key)}?fields=status`);
  return { status: String(j.fields?.status?.name ?? ""), category: j.fields?.status?.statusCategory?.key };
}

/**
 * Every non-empty field of an issue with its display name (onboarding: find the custom field that holds the
 * acceptance criteria or the tech scope, e.g. customfield_10045 "Acceptance Criteria").
 */
export async function issueFields(ctx: JiraContext, key: string): Promise<{ id: string; name: string; preview: string }[]> {
  const j = await jiraCall(ctx, "GET", `/rest/api/2/issue/${encodeURIComponent(key)}?expand=names`);
  const names: Record<string, string> = j.names ?? {};
  const out: { id: string; name: string; preview: string }[] = [];
  for (const [id, v] of Object.entries<any>(j.fields ?? {})) {
    if (v == null || v === "" || (Array.isArray(v) && !v.length)) continue;
    const text = typeof v === "string" || v?.type === "doc" ? toText(v) : typeof v === "object" ? (v.name ?? v.value ?? v.displayName ?? JSON.stringify(v)) : String(v);
    out.push({ id, name: names[id] ?? id, preview: String(text).replace(/\s+/g, " ").trim().slice(0, 90) });
  }
  return out.sort((a, b) => Number(b.id.startsWith("customfield_")) - Number(a.id.startsWith("customfield_")) || a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------------------------
// Reading attachments (spec-first contracts attached to the story).

export interface JiraAttachment {
  id: string;
  filename: string;
  /** Download URL. */
  content: string;
  size?: number;
  created?: string;
}

export async function storyAttachments(ctx: JiraContext, key: string): Promise<JiraAttachment[]> {
  const j = await jiraCall(ctx, "GET", `/rest/api/2/issue/${encodeURIComponent(key)}?fields=attachment`);
  return (j.fields?.attachment ?? []).map((a: any) => ({ id: String(a.id), filename: String(a.filename), content: String(a.content), size: a.size, created: a.created }));
}

const MAX_ATTACHMENT = 5 * 1024 * 1024;

/** Download a text attachment. Only from this Jira site: the URL comes from Jira, but the credentials must not follow it elsewhere. */
export async function downloadAttachment(ctx: JiraContext, url: string, size?: number): Promise<string> {
  if (new URL(url).origin !== new URL(ctx.baseUrl).origin) throw new Error(`attachment URL ${new URL(url).origin} is not on the Jira baseUrl origin ${new URL(ctx.baseUrl).origin}, so the login was not sent. Behind a reverse proxy, set requirements.jira.baseUrl to the URL Jira itself reports (its "Base URL" setting), the one the attachment links start with`);
  if (size !== undefined && size > MAX_ATTACHMENT) throw new Error(`attachment larger than ${MAX_ATTACHMENT / 1024 / 1024} MB`);
  const res = await netFetch(url, { headers: { Authorization: ctx.authHeader }, redirect: "follow" });
  if (!res.ok) throw new Error(`Jira attachment download: ${res.status}`);
  // Read with a byte cap: the size Jira reports is not trusted to stop a huge body.
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_ATTACHMENT) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`attachment larger than ${MAX_ATTACHMENT / 1024 / 1024} MB`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// ---------------------------------------------------------------------------------------------
// Finding stories (JQL). Jira Cloud's search was replaced by /rest/api/3/search/jql (token paging);
// Server and Data Center still use /rest/api/2/search (offset paging).

export interface FoundStory {
  key: string;
  summary: string;
  status: string;
  issueType?: string;
  labels: string[];
  updated?: string;
}

const quoteJql = (v: string) => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** The JQL `qa-sentinel stories` asks when none is configured. */
export function storiesJql(o: { projectKeys: string[]; statuses: string[]; issueTypes: string[]; lookbackDays: number }): string {
  if (!o.projectKeys.length) throw new Error("set requirements.jira.projectKeys (or requirements.jira.search.jql): the search must name the projects it covers");
  const parts = [`project in (${o.projectKeys.map(quoteJql).join(", ")})`];
  if (o.statuses.length) parts.push(`status in (${o.statuses.map(quoteJql).join(", ")})`);
  if (o.issueTypes.length) parts.push(`issuetype in (${o.issueTypes.map(quoteJql).join(", ")})`);
  parts.push(`updated >= -${Math.round(o.lookbackDays)}d`);
  return `${parts.join(" AND ")} ORDER BY updated DESC`;
}

const toFound = (i: any): FoundStory => ({
  key: String(i.key),
  summary: String(i.fields?.summary ?? ""),
  status: String(i.fields?.status?.name ?? ""),
  ...(i.fields?.issuetype?.name ? { issueType: String(i.fields.issuetype.name) } : {}),
  labels: Array.isArray(i.fields?.labels) ? i.fields.labels.map(String) : [],
  ...(i.fields?.updated ? { updated: String(i.fields.updated) } : {}),
});

const SEARCH_FIELDS = "summary,status,issuetype,labels,updated";

export async function searchStories(ctx: JiraContext, jql: string, o: { max: number; api?: "auto" | "cloud" | "server" }): Promise<FoundStory[]> {
  const api = o.api ?? "auto";
  const cloud = async () => {
    const out: FoundStory[] = [];
    let token: string | undefined;
    do {
      const q = `jql=${encodeURIComponent(jql)}&fields=${SEARCH_FIELDS}&maxResults=${Math.min(100, o.max - out.length)}${token ? `&nextPageToken=${encodeURIComponent(token)}` : ""}`;
      const page = await jiraCall(ctx, "GET", `/rest/api/3/search/jql?${q}`);
      out.push(...(page.issues ?? []).map(toFound));
      token = page.isLast === true ? undefined : page.nextPageToken;
    } while (token && out.length < o.max);
    return out.slice(0, o.max);
  };
  const server = async () => {
    const out: FoundStory[] = [];
    for (let startAt = 0; out.length < o.max; ) {
      const page = await jiraCall(ctx, "GET", `/rest/api/2/search?jql=${encodeURIComponent(jql)}&fields=${SEARCH_FIELDS}&startAt=${startAt}&maxResults=${Math.min(100, o.max - out.length)}`);
      const issues: any[] = page.issues ?? [];
      out.push(...issues.map(toFound));
      startAt += issues.length;
      if (!issues.length || startAt >= (page.total ?? 0)) break;
    }
    return out.slice(0, o.max);
  };
  if (api === "cloud") return cloud();
  if (api === "server") return server();
  try {
    return await cloud();
  } catch (e) {
    // Server and Data Center have no /search/jql: 404 (or 405). Anything else (bad JQL, no permission) is a real error.
    if (!/ 40[45] /.test((e as Error).message)) throw e;
    return server();
  }
}

/** The statuses a Jira project's workflows use (all issue types), for `doctor` to check the configured names against. */
export async function projectStatuses(ctx: JiraContext, projectKey: string): Promise<string[]> {
  const j = await jiraCall(ctx, "GET", `/rest/api/2/project/${encodeURIComponent(projectKey)}/statuses`);
  return [...new Set((Array.isArray(j) ? j : []).flatMap((t: any) => (t.statuses ?? []).map((x: any) => String(x.name))))] as string[];
}

/** Every link type in the Jira (name and both wordings). */
export async function linkTypes(ctx: JiraContext): Promise<{ name: string; inward: string; outward: string }[]> {
  const j = await jiraCall(ctx, "GET", "/rest/api/2/issueLinkType");
  return (j.issueLinkTypes ?? []).map((t: any) => ({ name: String(t.name), inward: String(t.inward), outward: String(t.outward) }));
}

/** The issue types a Jira project uses (same endpoint as the statuses). */
export async function allIssueTypes(ctx: JiraContext, projectKey: string): Promise<string[]> {
  const j = await jiraCall(ctx, "GET", `/rest/api/2/project/${encodeURIComponent(projectKey)}/statuses`);
  return [...new Set((Array.isArray(j) ? j : []).map((t: any) => String(t.name)))] as string[];
}

/** What the Jira server says about itself (`/rest/api/2/serverInfo`). */
export interface JiraServerInfo {
  deploymentType?: string;
  version?: string;
  baseUrl?: string;
}

export async function serverInfo(ctx: JiraContext): Promise<JiraServerInfo> {
  const j = await jiraCall(ctx, "GET", "/rest/api/2/serverInfo");
  return { deploymentType: j.deploymentType ? String(j.deploymentType) : undefined, version: j.version ? String(j.version) : undefined, baseUrl: j.baseUrl ? String(j.baseUrl) : undefined };
}

/** Cloud answers deploymentType "Cloud"; Server and Data Center both answer "Server". */
export const jiraFlavour = (info: JiraServerInfo): "cloud" | "datacenter" => (/cloud/i.test(info.deploymentType ?? "") ? "cloud" : "datacenter");
