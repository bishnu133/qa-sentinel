import fs from "node:fs";
import { z } from "zod";
import type { Config } from "./config.js";
import { type GitLabContext, mergeRequestsForCommit } from "./scm/gitlab.js";

/**
 * A frozen copy of the requirements a run used, with where they came from.
 * Analysis and generation both record theirs, so a reviewer can see which revision the tests were written against.
 */
export const RequirementSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  /** Where the text came from. `none` means no requirements were found. */
  source: z.enum(["story-file", "gitlab-mr", "none"]),
  sourceUrl: z.string().optional(),
  /** Revision of the source: MR updated_at, or a file content hash. */
  revision: z.string().optional(),
  storyKey: z.string().optional(),
  title: z.string().optional(),
  acceptanceCriteria: z.array(z.object({ id: z.string(), text: z.string() })),
  /**
   * qa-sentinel cannot tell whether a description was approved; only a tracker (e.g. Jira status) can.
   * `unverified` = text found but approval unknown; `missing` = nothing usable found.
   */
  approvalStatus: z.enum(["approved", "unverified", "missing"]),
  rawText: z.string(),
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
}

/**
 * Resolve requirements in priority order: explicit story file → MR context → MR found from the merged commit.
 * Never throws for missing requirements; the caller decides (see `requirements.required`).
 */
export async function resolveRequirements(c: Config, o: ResolveOptions): Promise<RequirementSnapshot> {
  if (c.requirements.source === "none") return emptySnapshot(c);

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

  if (o.mr && (o.mr.title || o.mr.description)) {
    return snapshot("gitlab-mr", [o.mr.title && `# ${o.mr.title}`, o.mr.description].filter(Boolean).join("\n\n"), c, {
      sourceUrl: o.mr.url,
      revision: o.mr.updatedAt,
      title: o.mr.title,
      keyHints: [o.mr.sourceBranch],
    });
  }

  if (o.lookup) {
    const mrs = await mergeRequestsForCommit(o.lookup.ctx, o.lookup.project, o.lookup.sha);
    const merged = mrs.find((m) => m.state === "merged") ?? mrs[0];
    if (merged) {
      return snapshot("gitlab-mr", [`# ${merged.title}`, merged.description ?? ""].join("\n\n"), c, {
        sourceUrl: merged.web_url,
        revision: merged.updated_at,
        title: merged.title,
        keyHints: [merged.source_branch],
      });
    }
  }
  return emptySnapshot(c);
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
  return `**Requirements:** ${s.storyKey ?? s.title ?? "story"} from ${where}${s.revision ? ` @ ${s.revision}` : ""} · ${s.acceptanceCriteria.length} AC parsed · approval ${s.approvalStatus}`;
}
