import type { Config } from "../config.js";
import { isAuthor, listComments, myself, type JiraContext, type JiraUser } from "../scm/jira.js";
import { log } from "../log.js";
import type { StoryRecord } from "./record.js";

/**
 * `/qa ready AC-1 checked by hand`: a person marks an AC ready by hand, and qa-sentinel treats it as ready when it
 * decides whether tests for it can be written. Read from the story's comments on every check; never from
 * qa-sentinel's own comments (its status text may quote the command). `/qa unready AC-1` takes it back. By default
 * any human may do it; every use is shown in the status comment with the person's name, and
 * `reporting.jira.override.allowed` restricts it to named Jira account ids or usernames.
 */

type Override = StoryRecord["overrides"][number];

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** "/qa ready" -> "/qa unready", "/qa-ready" -> "/qa-unready"; a command not ending in "ready" gets " undo" ("!ok" -> "!ok undo"). */
export const unreadyCommand = (command: string) => (/ready$/i.test(command.trim()) ? command.trim().replace(/ready$/i, (m) => `un${m}`) : `${command.trim()} undo`);

/** The override lines of one comment body, in order. */
export function parseOverrideLines(body: string, command: string): { op: "ready" | "unready"; ac: string; reason?: string }[] {
  const ready = new RegExp(`^\\s*${esc(command.trim())}\\s+(AC-\\d+)(?:\\s+(.*))?$`, "i");
  const unready = new RegExp(`^\\s*${esc(unreadyCommand(command))}\\s+(AC-\\d+)(?:\\s+(.*))?$`, "i");
  const out: { op: "ready" | "unready"; ac: string; reason?: string }[] = [];
  // Text in {code}, {noformat} and {quote} blocks, "bq." lines and "> " quotes is quoted, not said.
  // Blocks nest: a {quote} may hold a {code} block, and the quote is not over when the code ends. Inside {code} and {noformat}
  // only the same tag closes (other tags there are plain text). So the open blocks are a stack.
  const open: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    const tags = [...line.matchAll(/\{(code|noformat|quote)(?::[^}]*)?\}/g)].map((t) => t[1]);
    const inBlock = open.length > 0;
    for (const t of tags) {
      const top = open[open.length - 1];
      if (top === "code" || top === "noformat") {
        if (t === top) open.pop();
      } else if (t === "quote" && top === "quote") open.pop();
      else open.push(t);
    }
    if (inBlock || tags.length) continue;
    if (/^\s*(bq\.|>)/.test(line)) continue;
    const m = unready.exec(line) ?? undefined;
    if (m) {
      out.push({ op: "unready", ac: m[1].toUpperCase() });
      continue;
    }
    const r = ready.exec(line);
    if (r) out.push({ op: "ready", ac: r[1].toUpperCase(), ...(r[2]?.trim() ? { reason: r[2].trim() } : {}) });
  }
  return out;
}

const allowedBy = (allowed: string[], a: JiraUser | undefined) => !allowed.length || [a?.accountId, a?.name, a?.key].some((id) => id && allowed.includes(id));

/**
 * The overrides in force, from the comments (oldest first, so a later `unready` wins). When Jira will not say who
 * qa-sentinel is, nothing is read and `previous` is returned: its own comments could otherwise count as a person's.
 */
export async function readOverrides(c: Config, ctx: JiraContext, story: string, previous: Override[] = []): Promise<Override[]> {
  const me = await myself(ctx);
  if (!me) {
    log.warn(`${story}: /qa ready comments not read: Jira did not say which user the credentials belong to`);
    return previous;
  }
  const { command, allowed } = c.reporting.jira.override;
  const active = new Map<string, Override>();
  for (const cm of await listComments(ctx, story)) {
    if (isAuthor(cm.author, me) || cm.author?.accountType === "app") continue;
    for (const l of parseOverrideLines(cm.body, command)) {
      if (!allowedBy(allowed, cm.author)) continue;
      if (l.op === "unready") active.delete(l.ac);
      else active.set(l.ac, { ac: l.ac, by: cm.author?.displayName ?? cm.author?.name ?? cm.author?.accountId ?? "someone", at: cm.updated ?? cm.created ?? new Date(0).toISOString(), commentId: cm.id });
    }
  }
  return [...active.values()].sort((a, b) => a.ac.localeCompare(b.ac, undefined, { numeric: true }));
}

/** One line per override for the status comment. */
export const overrideLines = (o: Override[]) => o.map((x) => `${x.ac} marked ready by ${escapeWiki(x.by)} on ${x.at.slice(0, 10)}`);

/** A person's display name in wiki text: no markup, no new lines. */
export const escapeWiki = (t: string, max = 80) => t.replace(/[\r\n]+/g, " ").slice(0, max).replace(/([{}[\]|*_~^+\\])/g, "\\$1");

export const sameOverrides = (a: Override[], b: Override[]) => JSON.stringify(a.map((x) => [x.ac, x.by, x.commentId])) === JSON.stringify(b.map((x) => [x.ac, x.by, x.commentId]));
