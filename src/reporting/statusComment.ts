import type { Config } from "../config.js";
import { findIssueComment, type JiraContext, upsertIssueComment, writeIssueComment } from "../scm/jira.js";

/**
 * One QA status comment per story. Everything qa-sentinel says about a story on Jira (feature readiness, the gap
 * report of each service, the story review, proposed bugs, post-deploy results) lives in ONE comment made of
 * sections. A command replaces only its own section and leaves the others; the comment is edited in place, so the
 * story's activity does not fill up with qa-sentinel comments. (The showcase comment stays separate: it @mentions
 * people, and an edited comment does not notify anyone.)
 */

export const STATUS_MARKER = "qa-sentinel:status";
const SECTION_RE = /^(.*?)(?:\{color:#97a0af\})?Updated ([^{]*?) · qa-sentinel:section=([A-Za-z0-9:._-]+)(?:\{color\})?\s*$/;
/** Jira rejects comments over 32,767 characters. */
const HARD_LIMIT = 32_000;

export interface Section {
  name: string;
  /** Wiki text, starting with its heading. */
  wiki: string;
  updated: string;
}

/** Fixed order in the comment: the feature first, then gap reports, then the rest. */
const rank = (name: string) => (name === "feature" ? 0 : name.startsWith("gap-report:") ? 1 : name === "story-review" ? 2 : name === "bugs" ? 3 : name === "post-deploy" ? 4 : 5);

/** The sections of an existing status comment (anything before the status marker line is the header). */
export function parseStatus(body: string): Section[] {
  const lines = body.split("\n");
  const start = lines.findIndex((l) => l.includes(STATUS_MARKER));
  const out: Section[] = [];
  let acc: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const m = SECTION_RE.exec(line);
    if (m) {
      if (m[1].trim()) acc.push(m[1]);
      out.push({ name: m[3], wiki: acc.join("\n").trim(), updated: m[2].trim() });
      acc = [];
    } else acc.push(line);
  }
  return out;
}

const stamp = (d: Date) => `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;

/** Shorten the biggest sections until the comment fits Jira's limit. */
function fit(sections: Section[], header: string): Section[] {
  const size = (ss: Section[]) => header.length + ss.reduce((n, x) => n + x.wiki.length + 120, 0);
  let out = sections;
  while (size(out) > HARD_LIMIT) {
    const big = [...out].sort((a, b) => b.wiki.length - a.wiki.length)[0];
    if (big.wiki.length < 600) break;
    const keep = Math.floor(big.wiki.length * 0.7);
    const cut = big.wiki.slice(0, keep);
    out = out.map((x) => (x === big ? { ...x, wiki: `${cut.slice(0, Math.max(0, cut.lastIndexOf("\n")))}\n\n_Shortened to fit Jira's comment size. The full text is in the CI artifact._` } : x));
  }
  return out;
}

export function renderStatus(story: string, sections: Section[]): string {
  const header = `h2. QA status · ${story}\n_One comment, kept up to date by qa-sentinel. Each part is replaced when its check runs again._\n{color:#97a0af}${STATUS_MARKER}{color}\n`;
  const ordered = [...sections].sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
  return [header, ...fit(ordered, header).map((x) => `${x.wiki}\n{color:#97a0af}Updated ${x.updated} · qa-sentinel:section=${x.name}{color}\n`)].join("\n");
}

/** Replace (or add) one section. Pure. */
export function withSection(existing: Section[], name: string, wiki: string, now = new Date()): Section[] {
  return [...existing.filter((s) => s.name !== name), { name, wiki: wiki.trim(), updated: stamp(now) }];
}

/**
 * Put a section into the story's status comment. Jira has no compare-and-set, so the comment is read right before
 * it is written; two runners updating different sections at the same moment could still lose one of them, and the
 * next run of that check restores it.
 */
export async function upsertStatusSection(ctx: JiraContext, story: string, name: string, wiki: string, visibility?: { type: "role" | "group"; value: string }, now = new Date()) {
  const existing = await findIssueComment(ctx, story, STATUS_MARKER);
  const sections = withSection(existing ? parseStatus(existing.body) : [], name, wiki, now);
  return writeIssueComment(ctx, story, existing?.id, renderStatus(story, sections), visibility);
}

/**
 * What every command calls to say something on a story. `reporting.jira.layout`: "single" (default) puts it in the
 * status comment; "separate" is the old behaviour, one comment per kind, with its own marker.
 */
export async function postToStory(c: Config, ctx: JiraContext, story: string, o: { name: string; wiki: string; legacyKind: string; legacyMarker?: string }) {
  const j = c.reporting.jira;
  if (j.layout === "separate") return upsertIssueComment(ctx, story, o.legacyKind, o.wiki, j.visibility, o.legacyMarker);
  return upsertStatusSection(ctx, story, o.name, o.wiki, j.visibility);
}
