/**
 * Minimal Jira REST client (Cloud and Server/Data Center, API v2). Only the CLI talks to Jira;
 * credentials never reach agents (they are scrubbed from the agent environment).
 *
 * Auth: Cloud → JIRA_EMAIL + JIRA_API_TOKEN (basic); Server/DC → JIRA_PAT (bearer).
 */
export interface JiraContext {
  baseUrl: string;
  authHeader: string;
}

export function jiraContext(baseUrl: string | undefined, env: NodeJS.ProcessEnv = process.env): JiraContext | undefined {
  if (!baseUrl) return undefined;
  if (env.JIRA_PAT) return { baseUrl: baseUrl.replace(/\/$/, ""), authHeader: `Bearer ${env.JIRA_PAT}` };
  if (env.JIRA_EMAIL && env.JIRA_API_TOKEN) {
    return { baseUrl: baseUrl.replace(/\/$/, ""), authHeader: `Basic ${Buffer.from(`${env.JIRA_EMAIL}:${env.JIRA_API_TOKEN}`).toString("base64")}` };
  }
  return undefined;
}

export interface JiraIssue {
  key: string;
  summary: string;
  description: string;
  acceptanceCriteria?: string;
  status: string;
  url: string;
  updated?: string;
}

export async function fetchIssue(ctx: JiraContext, key: string, acField?: string): Promise<JiraIssue> {
  const fields = ["summary", "description", "status", "updated", ...(acField ? [acField] : [])].join(",");
  const res = await fetch(`${ctx.baseUrl}/rest/api/2/issue/${encodeURIComponent(key)}?fields=${fields}`, {
    headers: { Authorization: ctx.authHeader, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Jira GET ${key} failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const j: any = await res.json();
  const f = j.fields ?? {};
  return {
    key: j.key ?? key,
    summary: String(f.summary ?? ""),
    description: toText(f.description),
    acceptanceCriteria: acField ? toText(f[acField]) || undefined : undefined,
    status: String(f.status?.name ?? ""),
    url: `${ctx.baseUrl}/browse/${j.key ?? key}`,
    updated: f.updated,
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
      const h = l.match(/^h([1-6])\.\s+(.*)$/);
      if (h) return `${"#".repeat(Number(h[1]))} ${h[2]}`;
      return l.replace(/^#+\s+/, "1. ").replace(/^\*+\s+/, "- "); // wiki numbered / bulleted lists
    })
    .join("\n");
}

function adfToText(node: any, depth = 0): string {
  if (!node) return "";
  if (node.type === "text") return node.text ?? "";
  const inner = (node.content ?? []).map((c: any) => adfToText(c, depth + 1)).join("");
  switch (node.type) {
    case "paragraph":
      return inner + "\n";
    case "heading":
      return `${"#".repeat(node.attrs?.level ?? 2)} ${inner}\n`;
    case "listItem":
      return `- ${inner.trim()}\n`;
    case "orderedList":
      return (node.content ?? []).map((c: any, i: number) => `${i + 1}. ${adfToText(c, depth + 1).replace(/^- /, "").trim()}\n`).join("");
    case "hardBreak":
      return "\n";
    default:
      return inner;
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

async function jiraCall(ctx: JiraContext, method: string, route: string, body?: unknown): Promise<any> {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`${ctx.baseUrl}${route}`, {
      method,
      headers: { Authorization: ctx.authHeader, Accept: "application/json", "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      const wait = Number(res.headers.get("retry-after")) * 1000 || 500 * 2 ** attempt;
      await new Promise((r) => setTimeout(r, Math.min(wait, 10_000)));
      continue;
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`Jira ${method} ${route}: ${res.status} ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : {};
  }
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
  const marker = markerText;
  const base = `/rest/api/2/issue/${encodeURIComponent(key)}/comment`;
  let existing: any;
  for (let startAt = 0; !existing; ) {
    const page = await jiraCall(ctx, "GET", `${base}?startAt=${startAt}&maxResults=100`);
    const comments: any[] = page.comments ?? [];
    existing = comments.find((cm) => typeof cm.body === "string" && cm.body.includes(marker));
    startAt += comments.length;
    if (!comments.length || startAt >= (page.total ?? 0)) break;
  }
  // The marker is plain text (wiki markup has no hidden comments); keep it small and grey at the end.
  const body = `${wikiBody}\n\n{color:#97a0af}${marker}{color}`;
  const payload = { body, ...(visibility ? { visibility } : {}) };
  if (existing) {
    await jiraCall(ctx, "PUT", `${base}/${existing.id}`, payload);
    return { action: "updated", id: String(existing.id), url: `${ctx.baseUrl}/browse/${key}?focusedCommentId=${existing.id}` };
  }
  const created = await jiraCall(ctx, "POST", base, payload);
  return { action: "created", id: String(created.id), url: `${ctx.baseUrl}/browse/${key}?focusedCommentId=${created.id}` };
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
  form.append("file", new Blob([new Uint8Array(data)], { type: contentType }), fileName);
  const res = await fetch(`${ctx.baseUrl}/rest/api/2/issue/${encodeURIComponent(key)}/attachments`, {
    method: "POST",
    headers: { Authorization: ctx.authHeader, Accept: "application/json", "X-Atlassian-Token": "no-check" },
    body: form,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Jira attach ${fileName} to ${key}: ${res.status} ${text.slice(0, 200)}`);
  const [a] = JSON.parse(text);
  return { id: String(a.id), filename: a.filename };
}

export async function deleteAttachment(ctx: JiraContext, id: string): Promise<void> {
  await jiraCall(ctx, "DELETE", `/rest/api/2/attachment/${encodeURIComponent(id)}`);
}
