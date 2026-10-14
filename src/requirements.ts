import fs from "node:fs";
import { z } from "zod";
import type { Config } from "./config.js";
import { type GitLabContext, mergeRequestsForCommit } from "./scm/gitlab.js";
import { fetchIssue, jiraContext } from "./scm/jira.js";

/**
 * A frozen copy of the requirements a run used, with where they came from.
 * Analysis and generation both record theirs, so a reviewer can see which revision the tests were written against.
 */
export const RequirementSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  /** Where the text came from. `none` means no requirements were found. */
  source: z.enum(["story-file", "jira", "gitlab-mr", "none"]),
  sourceUrl: z.string().optional(),
  /** Revision of the source: MR updated_at, or a file content hash. */
  revision: z.string().optional(),
  storyKey: z.string().optional(),
  title: z.string().optional(),
  acceptanceCriteria: z.array(z.object({ id: z.string(), text: z.string() })),
  /**
   * Only a tracker can say a story is approved: Jira stories in requirements.jira.approvedStatuses are `approved`.
   * `unverified` = text found but approval unknown (MR text, story files, other Jira statuses); `missing` = nothing found.
   */
  approvalStatus: z.enum(["approved", "unverified", "missing"]),
  rawText: z.string(),
  /** Tracker status at capture time (Jira). */
  trackerStatus: z.string().optional(),
  capturedAt: z.string(),
});
export type RequirementSnapshot = z.infer<typeof RequirementSnapshotSchema>;

/** Pull the first story key (e.g. SHOP-42) out of any of the given strings. */
export function extractStoryKey(pattern: string, ...texts: (string | undefined)[]): string | undefined {
  const re = new RegExp(`\\b(${pattern})\\b`);
  for (const t of texts) {
    const m = t?.match(re);
    if (m) return m[1];
  }
  return undefined;
}

/**
 * Parse acceptance criteria from markdown/plain text: numbered or bulleted items under a heading or line
 * containing "acceptance criteria" (case-insensitive). Falls back to "Given/When/Then" blocks.
 */
export function parseAcceptanceCriteria(text: string): { id: string; text: string }[] {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /acceptance criteria/i.test(l));
  const items: string[] = [];
  if (start >= 0) {
    for (const raw of lines.slice(start + 1)) {
      const l = raw.trim();
      if (/^#{1,6}\s/.test(l) && items.length) break; // next section
      const m = l.match(/^(?:\d+[.)]|[-*+]|AC-?\d+[:.)]?)\s+(.*)$/i);
      if (m) items.push(m[1].trim());
      else if (l && items.length && /^\s{2,}/.test(raw)) items[items.length - 1] += " " + l; // continuation line
      else if (!l && items.length) continue;
    }
  }
  if (!items.length) {
    const gwt = text.match(/(?:^|\n)\s*Given[\s\S]*?Then[^\n]*/gi);
    gwt?.forEach((g) => items.push(g.trim().replace(/\s+/g, " ")));
  }
  return items.map((t, i) => ({ id: `AC-${i + 1}`, text: t }));
}

function snapshot(
  source: RequirementSnapshot["source"],
  rawText: string,
  c: Config,
  extra: Partial<RequirementSnapshot> & { keyHints?: (string | undefined)[] } = {},
): RequirementSnapshot {
  const { keyHints = [], ...rest } = extra;
  const acceptanceCriteria = parseAcceptanceCriteria(rawText);
  const hasText = rawText.trim().length > 0;
  return RequirementSnapshotSchema.parse({
    schemaVersion: 1,
    source,
    acceptanceCriteria,
    approvalStatus: hasText ? "unverified" : "missing",
    rawText,
    capturedAt: new Date().toISOString(),
    storyKey: extractStoryKey(c.requirements.storyKeyPattern, rest.title, rawText, ...keyHints),
    ...rest,
  });
}

export function emptySnapshot(c: Config): RequirementSnapshot {
  return snapshot("none", "", c);
}

export interface ResolveOptions {
  storyFile?: string;
  /** MR context available in merge-request pipelines (gap-report). */
  mr?: { title?: string; description?: string; url?: string; updatedAt?: string; sourceBranch?: string };
  /** For post-merge generation: look up the MR that introduced this commit. */
  lookup?: { ctx: GitLabContext; project: string; sha: string };
  /** Extra places a story key may appear: branch names, commit messages. */
  keyHints?: (string | undefined)[];
  env?: NodeJS.ProcessEnv;
}

/**
 * Resolve requirements in priority order: explicit story file → Jira story (when source is jira) →
 * MR context → MR found from the merged commit. Never throws for missing requirements; the caller decides
 * (see `requirements.required`).
 */
export async function resolveRequirements(c: Config, o: ResolveOptions): Promise<RequirementSnapshot> {
  if (c.requirements.source === "none") return emptySnapshot(c);
  const env = o.env ?? process.env;

  if (o.storyFile) {
    if (!fs.existsSync(o.storyFile)) throw new Error(`--story-file not found: ${o.storyFile}`);
    const text = fs.readFileSync(o.storyFile, "utf8");
    const { createHash } = await import("node:crypto");
    return snapshot("story-file", text, c, {
      sourceUrl: o.storyFile,
      revision: `sha256:${createHash("sha256").update(text).digest("hex").slice(0, 16)}`,
      title: text.match(/^#\s+(.+)$/m)?.[1],
    });
  }

  // The MR behind a merged commit is needed both as a fallback and as a source of the story key.
  let looked: any;
  if (o.lookup && !(o.mr && (o.mr.title || o.mr.description))) {
    const mrs = await mergeRequestsForCommit(o.lookup.ctx, o.lookup.project, o.lookup.sha);
    looked = mrs.find((m) => m.state === "merged") ?? mrs[0];
  }

  if (c.requirements.source === "jira") {
    const keys = [o.mr?.title, o.mr?.sourceBranch, looked?.title, looked?.source_branch, ...(o.keyHints ?? []), o.mr?.description, looked?.description];
    const key = extractStoryKey(jiraKeyPattern(c), ...keys);
    const jctx = jiraContext(c.requirements.jira.baseUrl, env);
    if (key && jctx) {
      const issue = await fetchIssue(jctx, key, c.requirements.jira.acceptanceCriteriaField);
      const text = [`# ${issue.key} ${issue.summary}`, issue.description, issue.acceptanceCriteria ? `## Acceptance criteria\n${issue.acceptanceCriteria}` : ""].filter(Boolean).join("\n\n");
      const snap = snapshot("jira", text, c, { sourceUrl: issue.url, revision: issue.updated, title: issue.summary, trackerStatus: issue.status, storyKey: issue.key });
      const approved = c.requirements.jira.approvedStatuses.some((s) => s.toLowerCase() === issue.status.toLowerCase());
      return { ...snap, approvalStatus: snap.rawText.trim() ? (approved ? "approved" : "unverified") : "missing" };
    }
  }

  if (o.mr && (o.mr.title || o.mr.description)) {
    return snapshot("gitlab-mr", [o.mr.title && `# ${o.mr.title}`, o.mr.description].filter(Boolean).join("\n\n"), c, {
      sourceUrl: o.mr.url,
      revision: o.mr.updatedAt,
      title: o.mr.title,
      keyHints: [o.mr.sourceBranch, ...(o.keyHints ?? [])],
    });
  }

  if (looked) {
    return snapshot("gitlab-mr", [`# ${looked.title}`, looked.description ?? ""].join("\n\n"), c, {
      sourceUrl: looked.web_url,
      revision: looked.updated_at,
      title: looked.title,
      keyHints: [looked.source_branch, ...(o.keyHints ?? [])],
    });
  }
  return emptySnapshot(c);
}

/** Restrict story keys to the configured Jira projects when given (avoids matching e.g. UTF-8). */
function jiraKeyPattern(c: Config): string {
  const keys = c.requirements.jira.projectKeys;
  return keys.length ? `(?:${keys.map((k) => k.replace(/[^A-Z0-9]/gi, "")).join("|")})-\\d+` : c.requirements.storyKeyPattern;
}

/** Markdown fed to the agents as story.md. States plainly when requirements are missing. */
export function storyMarkdown(s: RequirementSnapshot): string {
  if (s.source === "none") {
    return [
      "# No requirements found",
      "",
      "No story, MR description or acceptance criteria were available for this change.",
      "Oracle status: MISSING. Do not invent expected business behaviour. Only assert behaviour backed by an",
      "independent source (the API contract or existing approved tests), and report what needs a human decision.",
    ].join("\n");
  }
  const header = [
    `<!-- source: ${s.source}${s.sourceUrl ? ` ${s.sourceUrl}` : ""}${s.revision ? ` @ ${s.revision}` : ""}; approval: ${s.approvalStatus} -->`,
    s.acceptanceCriteria.length
      ? `Parsed acceptance criteria: ${s.acceptanceCriteria.map((a) => a.id).join(", ")} (cite these ids).`
      : "No numbered acceptance criteria could be parsed; treat expected behaviour as AMBIGUOUS unless the text states it precisely.",
    "",
  ];
  return header.join("\n") + s.rawText;
}

export function requirementsLine(s: RequirementSnapshot): string {
  if (s.source === "none") return "**Requirements:** none found. Tests can only be checked against the API contract and code.";
  const where = s.sourceUrl ? `[${s.source}](${s.sourceUrl})` : s.source;
  const status = s.trackerStatus ? ` (status "${s.trackerStatus}")` : "";
  return `**Requirements:** ${s.storyKey ?? s.title ?? "story"} from ${where}${s.revision ? ` @ ${s.revision}` : ""} · ${s.acceptanceCriteria.length} AC parsed · approval ${s.approvalStatus}${status}`;
}
