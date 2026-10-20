import fs from "node:fs";
import { z } from "zod";
import type { Config } from "./config.js";
import { type GitLabContext, mergeRequestsForCommit } from "./scm/gitlab.js";
import { fetchIssue, jiraContext } from "./scm/jira.js";
import { type ParsedStory, type TemplateSection, parseStory } from "./storyTemplate.js";

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
  /** Tracker issue type (Jira), e.g. Story or Bug. */
  issueType: z.string().optional(),
  /** Source branch of the MR the text came from (or the MR behind a merged commit). */
  sourceBranch: z.string().optional(),
  acceptanceCriteria: z.array(z.object({ id: z.string(), text: z.string() })),
  /** What the story expects beyond its ACs (tech scope, expected results): TS-1, ER-1, … Not agreed as ACs. */
  scopeItems: z.array(z.object({ id: z.string(), text: z.string(), source: z.string(), service: z.string().optional() })).default([]),
  /** How the ACs were written: a Given/When/Then table, a list, Gherkin text, or not found. */
  acFormat: z.enum(["table", "list", "gherkin", "none"]).optional(),
  /** Explicitly out of scope: never planned as tests, never raised as bugs. */
  outOfScope: z.array(z.string()).default([]),
  /** Other sections the agents should know (assumptions, questions, feature toggles, …). */
  context: z.array(z.object({ name: z.string(), text: z.string() })).default([]),
  /** The story's showcase approach, if it has one. */
  showcase: z.string().optional(),
  /** Configured services the story names (e.g. in its tech notes). */
  servicesNamed: z.array(z.string()).default([]),
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

/** The story template a project uses: legacy `scope.sections` first, then `requirements.template`. */
export function storyTemplateOf(c: Config): TemplateSection[] {
  const legacy: TemplateSection[] = c.requirements.scope.sections.map((x) => ({ role: "scope", name: x.name, headings: x.headings, prefix: x.prefix }));
  const t = [...legacy, ...c.requirements.template];
  return c.requirements.scope.enabled ? t : t.filter((x) => x.role !== "scope");
}

/** Names a story may use for a configured service: its name, and the last part of its repo path / GitLab project. */
export function serviceNamesOf(c: Config): string[] {
  const out = new Set<string>();
  for (const s of c.workspace.services) {
    out.add(s.name);
    if (s.gitlabProject) out.add(s.gitlabProject.split("/").pop()!);
    const base = s.path.replace(/\/+$/, "").split("/").pop();
    if (base && base !== "." && base !== "..") out.add(base);
  }
  return [...out].filter((n) => n.length >= 3);
}

/** Read a story with the project's template. */
export function parseStoryFor(c: Config, text: string): ParsedStory {
  const p = parseStory(text, storyTemplateOf(c), { serviceNames: serviceNamesOf(c) });
  // Map the names found back to configured service names.
  const byAlias = new Map<string, string>();
  for (const s of c.workspace.services) for (const n of [s.name, s.gitlabProject?.split("/").pop(), s.path.replace(/\/+$/, "").split("/").pop()]) if (n) byAlias.set(n.toLowerCase(), s.name);
  const canon = (n?: string) => (n ? (byAlias.get(n.toLowerCase()) ?? n) : undefined);
  return {
    ...p,
    scopeItems: p.scopeItems.map((x) => (x.service ? { ...x, service: canon(x.service) } : x)),
    servicesNamed: [...new Set(p.servicesNamed.map((n) => canon(n)!))],
  };
}

/** Every requirement item a test or plan may cite: the ACs, then the scope items. */
export const requirementItems = (s: Pick<RequirementSnapshot, "acceptanceCriteria" | "scopeItems">) => [...s.acceptanceCriteria, ...(s.scopeItems ?? [])];

/** Acceptance criteria with the default template (tables, lists, Gherkin). Prefer parseStoryFor with a config. */
export function parseAcceptanceCriteria(text: string): { id: string; text: string }[] {
  return parseStory(text).acceptanceCriteria;
}

/** A Jira story as one markdown text: summary, description, the AC field and the configured scope fields as sections. */
export function jiraIssueText(c: Config, issue: { key: string; summary: string; description?: string; acceptanceCriteria?: string; extra?: Record<string, string> }): string {
  const scopeFields = c.requirements.jira.scopeFields.filter((f) => issue.extra?.[f.field]).map((f) => `## ${f.name}\n${issue.extra![f.field]}`);
  return [`# ${issue.key} ${issue.summary}`, issue.description, issue.acceptanceCriteria ? `## Acceptance criteria\n${issue.acceptanceCriteria}` : "", ...scopeFields].filter(Boolean).join("\n\n");
}

function snapshot(
  source: RequirementSnapshot["source"],
  rawText: string,
  c: Config,
  extra: Partial<RequirementSnapshot> & { keyHints?: (string | undefined)[] } = {},
): RequirementSnapshot {
  const { keyHints = [], ...rest } = extra;
  const parsed = parseStoryFor(c, rawText);
  const { acceptanceCriteria, scopeItems, acFormat, outOfScope, context, showcase, servicesNamed } = parsed;
  const hasText = rawText.trim().length > 0;
  return RequirementSnapshotSchema.parse({
    schemaVersion: 1,
    source,
    acceptanceCriteria,
    scopeItems,
    acFormat,
    outOfScope,
    context,
    ...(showcase ? { showcase } : {}),
    servicesNamed,
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
      const issue = await fetchIssue(jctx, key, c.requirements.jira.acceptanceCriteriaField, c.requirements.jira.scopeFields.map((f) => f.field));
      const text = jiraIssueText(c, issue);
      const branch = o.mr?.sourceBranch ?? looked?.source_branch;
      const snap = snapshot("jira", text, c, { sourceUrl: issue.url, revision: issue.updated, title: issue.summary, trackerStatus: issue.status, storyKey: issue.key, ...(issue.issueType ? { issueType: issue.issueType } : {}), ...(branch ? { sourceBranch: branch } : {}) });
      const approved = c.requirements.jira.approvedStatuses.some((s) => s.toLowerCase() === issue.status.toLowerCase());
      return { ...snap, approvalStatus: snap.rawText.trim() ? (approved ? "approved" : "unverified") : "missing" };
    }
  }

  if (o.mr && (o.mr.title || o.mr.description)) {
    return snapshot("gitlab-mr", [o.mr.title && `# ${o.mr.title}`, o.mr.description].filter(Boolean).join("\n\n"), c, {
      sourceUrl: o.mr.url,
      revision: o.mr.updatedAt,
      title: o.mr.title,
      ...(o.mr.sourceBranch ? { sourceBranch: o.mr.sourceBranch } : {}),
      keyHints: [o.mr.sourceBranch, ...(o.keyHints ?? [])],
    });
  }

  if (looked) {
    return snapshot("gitlab-mr", [`# ${looked.title}`, looked.description ?? ""].join("\n\n"), c, {
      sourceUrl: looked.web_url,
      revision: looked.updated_at,
      title: looked.title,
      ...(looked.source_branch ? { sourceBranch: looked.source_branch } : {}),
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
    ...(s.scopeItems?.length
      ? [
          `Scope items (expected behaviour written outside the ACs; cite these ids too, but they are not agreed acceptance criteria):`,
          ...s.scopeItems.map((x) => `- ${x.id} (${x.source}${x.service ? `, ${x.service}` : ""}): ${x.text}`),
        ]
      : []),
    ...(s.outOfScope?.length
      ? ["Explicitly OUT OF SCOPE (do not plan tests for these, do not report them as missing):", ...s.outOfScope.map((x) => `- ${x}`)]
      : []),
    ...(s.servicesNamed?.length ? [`Services this story names: ${s.servicesNamed.join(", ")}.`] : []),
    "",
  ];
  return header.join("\n") + s.rawText;
}

export function requirementsLine(s: RequirementSnapshot): string {
  if (s.source === "none") return "**Requirements:** none found. Tests can only be checked against the API contract and code.";
  const where = s.sourceUrl ? `[${s.source}](${s.sourceUrl})` : s.source;
  const status = s.trackerStatus ? ` (status "${s.trackerStatus}")` : "";
  return `**Requirements:** ${s.storyKey ?? s.title ?? "story"} from ${where}${s.revision ? ` @ ${s.revision}` : ""} · ${s.acceptanceCriteria.length} AC parsed${s.scopeItems?.length ? ` · ${s.scopeItems.length} scope item(s)` : ""} · approval ${s.approvalStatus}${status}`;
}

/**
 * The branch to skip, if this change comes from one listed in ci.skipBranches (dependency bots by default). Candidates
 * are branch names or commit messages: a merge commit names its branch ("Merge branch 'renovate/x' into 'main'").
 */
export function skippedBranch(c: Config, ...candidates: (string | undefined)[]): string | undefined {
  const res = c.ci.skipBranches.map((r) => new RegExp(r));
  for (const x of candidates) {
    if (!x) continue;
    const branch = x.match(/Merge branch '([^']+)'/)?.[1] ?? (/\s/.test(x.trim()) ? undefined : x.trim());
    if (branch && res.some((r) => r.test(branch))) return branch;
  }
  return undefined;
}

/**
 * Is this a feature with acceptance criteria (requirements.jira.featureIssueTypes)? Stories that don't come from
 * Jira (story files, MR text) have no issue type and count as features. Empty list: every type counts.
 */
export function isFeature(c: Config, req: Pick<RequirementSnapshot, "issueType">): boolean {
  const types = c.requirements.jira.featureIssueTypes;
  if (!types.length || !req.issueType) return true;
  return types.some((t) => t.toLowerCase() === req.issueType!.toLowerCase());
}
