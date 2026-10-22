import fs from "node:fs";
import { z } from "zod";
import type { Config } from "./config.js";
import { type GitLabContext, mergeRequestsForCommit } from "./scm/gitlab.js";
import { fetchIssue, isJiraNotFound, jiraContext } from "./scm/jira.js";
import { type IssueCache, type KeyResolution, resolveKeysCached } from "./stories/resolve.js";
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
  /** The Jira card's components (mapped to services by requirements.jira.components). */
  components: z.array(z.string()).optional(),
  /** The card the MR or commits named when it is not the feature itself (a bug, task or sub-task). Its text is in `context`, as evidence only. */
  workKey: z.string().optional(),
  /** How the work card reached the feature. */
  resolvedVia: z.enum(["parent", "link"]).optional(),
  /** Why the card was (or was not) attached to a feature, in words: "SHOP-210 (Bug) → SHOP-12 via parent", or "SHOP-1012 is not in Jira". */
  resolveNote: z.string().optional(),
  capturedAt: z.string(),
});
export type RequirementSnapshot = z.infer<typeof RequirementSnapshotSchema>;

/**
 * Every distinct story key (e.g. SHOP-42) in the given strings, in the order they are found: the texts in the order
 * given, and within one text left to right. The match is on whole keys, so SHOP-1 is not found inside SHOP-106.
 */
export function extractStoryKeys(pattern: string, ...texts: (string | undefined)[]): string[] {
  const re = new RegExp(`\\b(${pattern})\\b`, "g");
  const out: string[] = [];
  for (const t of texts) for (const m of t?.matchAll(re) ?? []) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

/**
 * The keys of a merge request: its title and description by whole key; its branch name the way PR 1's branch scan reads it
 * (case-insensitive for the configured projects, a key may be followed by anything but a digit: feature/shop-106-x, SHOP-106_notice), uppercased.
 */
export function extractMrKeys(pattern: string, m: { title?: string; source_branch?: string; description?: string }, projects: string[] = []): string[] {
  const out = extractStoryKeys(pattern, m.title);
  const add = (k: string) => {
    if (!out.includes(k)) out.push(k);
  };
  // A lower-case key counts only for a known project ("work-3" in a branch name is not a card).
  const known = new Set(projects.map((p) => p.toUpperCase()));
  for (const x of (m.source_branch ?? "").matchAll(new RegExp(`(?:^|[^A-Za-z0-9])(${pattern})(?![0-9])`, "gi"))) {
    const exact = x[1] === x[1].toUpperCase();
    if (exact || known.has(x[1].replace(/-\d+$/, "").toUpperCase())) add(x[1].toUpperCase());
  }
  for (const k of extractStoryKeys(pattern, m.description)) add(k);
  return out;
}

/** Pull the first story key (e.g. SHOP-42) out of any of the given strings. */
export function extractStoryKey(pattern: string, ...texts: (string | undefined)[]): string | undefined {
  return extractStoryKeys(pattern, ...texts)[0];
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
  /** Resolve this key (one of the keys the MR names) instead of the first one found. Used when an MR names several. */
  storyKey?: string;
  /**
   * Opt in: the caller has code that names this card (gap-report, generate), so a bug, task or sub-task is attached to its
   * feature (stories/resolve.ts). Without it the key is used as it is, like before linking: review-story, spec and the
   * expected-behaviour check read the card they were given.
   */
  hasCode?: boolean;
  /** Already resolved by the caller (a merge request that names several stories): the first is the card to resolve, the others are more cards of the same feature. No Jira read for these. */
  resolved?: KeyResolution[];
  /** The Jira reads of this run (see resolveKeysCached). */
  cache?: IssueCache;
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

  let note: string | undefined;
  if (c.requirements.source === "jira") {
    const keys = [o.mr?.title, o.mr?.sourceBranch, looked?.title, looked?.source_branch, ...(o.keyHints ?? []), o.mr?.description, looked?.description];
    const key = o.storyKey ?? extractStoryKey(jiraKeyPattern(c), ...keys);
    const jctx = jiraContext(c.requirements.jira.baseUrl, env);
    if (key && jctx) {
      const branch = o.mr?.sourceBranch ?? looked?.source_branch;
      try {
        // A bug, task or sub-task is tested and reported under its feature (fixed rules, see stories/resolve.ts). The card's own text stays as evidence.
        const given = o.resolved?.find((x) => x.work.toLowerCase() === key.toLowerCase());
        const [r] = given ? [given] : o.hasCode && c.requirements.jira.featureIssueTypes.length ? await resolveKeysCached(c, jctx, [key], { hasCode: true, cache: o.cache }) : [undefined];
        if (r?.notFound) throw Object.assign(new Error(r.explain), { notFound: true });
        const featureKey = r?.feature ?? key;
        const issue = r?.featureIssue ?? r?.workIssue ?? (await fetchIssue(jctx, featureKey, c.requirements.jira.acceptanceCriteriaField, c.requirements.jira.scopeFields.map((f) => f.field)));
        const moved = featureKey.toLowerCase() !== key.toLowerCase() && r?.workIssue;
        const text = jiraIssueText(c, issue);
        const snap = snapshot("jira", text, c, {
          sourceUrl: issue.url,
          revision: issue.updated,
          title: issue.summary,
          trackerStatus: issue.status,
          ...(issue.components?.length ? { components: issue.components } : {}),
          storyKey: issue.key,
          ...(issue.issueType ? { issueType: issue.issueType } : {}),
          ...(branch ? { sourceBranch: branch } : {}),
          ...(moved ? { workKey: key, resolvedVia: r!.via as "parent" | "link" } : {}),
          ...(r && r.via !== "self" ? { resolveNote: r.explain } : {}),
        });
        // Every card of the feature the merge request names is evidence, not only the first.
        const cards = moved ? [{ key, issue: r!.workIssue! }] : [];
        for (const x of o.resolved ?? []) if (x.work.toLowerCase() !== key.toLowerCase() && x.work.toLowerCase() !== issue.key.toLowerCase() && x.workIssue && !cards.some((k) => k.key.toLowerCase() === x.work.toLowerCase())) cards.push({ key: x.work, issue: x.workIssue });
        const withWork = cards.length ? { ...snap, context: [...snap.context, ...cards.map((k) => ({ name: `Work card ${k.key}`, text: jiraIssueText(c, k.issue) }))] } : snap;
        const approved = c.requirements.jira.approvedStatuses.some((s) => s.toLowerCase() === issue.status.toLowerCase());
        return { ...withWork, approvalStatus: snap.rawText.trim() ? (approved ? "approved" : "unverified") : "missing" };
      } catch (e) {
        // A key that is not in Jira (a typo) is said so, never guessed at; the MR text below is used as before.
        if ((e as { notFound?: boolean }).notFound || isJiraNotFound(e)) note = `${key} is not in Jira or not visible to this user (check the key); requirements are taken from the merge request text`;
        else throw e;
      }
    }
  }

  if (o.mr && (o.mr.title || o.mr.description)) {
    return snapshot("gitlab-mr", [o.mr.title && `# ${o.mr.title}`, o.mr.description].filter(Boolean).join("\n\n"), c, {
      sourceUrl: o.mr.url,
      revision: o.mr.updatedAt,
      title: o.mr.title,
      ...(o.mr.sourceBranch ? { sourceBranch: o.mr.sourceBranch } : {}),
      ...(note ? { resolveNote: note } : {}),
      keyHints: [o.mr.sourceBranch, ...(o.keyHints ?? [])],
    });
  }

  if (looked) {
    return snapshot("gitlab-mr", [`# ${looked.title}`, looked.description ?? ""].join("\n\n"), c, {
      sourceUrl: looked.web_url,
      revision: looked.updated_at,
      title: looked.title,
      ...(looked.source_branch ? { sourceBranch: looked.source_branch } : {}),
      ...(note ? { resolveNote: note } : {}),
      keyHints: [looked.source_branch, ...(o.keyHints ?? [])],
    });
  }
  return note ? { ...emptySnapshot(c), resolveNote: note } : emptySnapshot(c);
}

/** Restrict story keys to the configured Jira projects when given (avoids matching e.g. UTF-8). */
export function jiraKeyPattern(c: Config): string {
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
  // The bug, task or sub-task that led to this story: evidence for the agents, never an acceptance criterion or an expected value.
  const work = (s.context ?? []).filter((x) => x.name.startsWith("Work card ") && x.text.trim());
  const workText = work.map((x) => `\n\n---\n## ${x.name} (evidence only: not an acceptance criterion; if it contradicts an AC, ask the product owner)\n${x.text}`).join("");
  return header.join("\n") + s.rawText + workText;
}

export function requirementsLine(s: RequirementSnapshot): string {
  if (s.source === "none") return `**Requirements:** none found${s.resolveNote ? ` (${s.resolveNote})` : ""}. Tests can only be checked against the API contract and code.`;
  const where = s.sourceUrl ? `[${s.source}](${s.sourceUrl})` : s.source;
  const status = s.trackerStatus ? ` (status "${s.trackerStatus}")` : "";
  const via = s.resolveNote ? ` · ${s.resolveNote}` : "";
  return `**Requirements:** ${s.storyKey ?? s.title ?? "story"} from ${where}${s.revision ? ` @ ${s.revision}` : ""} · ${s.acceptanceCriteria.length} AC parsed${s.scopeItems?.length ? ` · ${s.scopeItems.length} scope item(s)` : ""} · approval ${s.approvalStatus}${status}${via}`;
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
