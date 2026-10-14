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
