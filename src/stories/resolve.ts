import type { Config } from "../config.js";
import { fetchIssue, isJiraNotFound, type JiraContext, type JiraIssue, type JiraLink } from "../scm/jira.js";

/**
 * Which feature a Jira card belongs to. A bug, task or sub-task is tested and reported under its story, but a wrong
 * link would pull an unrelated bug into a feature, so the rules are strict and fixed (not configurable):
 *  1. only cards with code are resolved: a caller that knows passes hasCode (false stops it; a bug that merely links
 *     to a story is not part of it). `stories --story` and `story-check` do not look for code yet, so they resolve by Jira alone
 *  2. one hop: card → feature, never card → task → story → epic
 *  3. the parent comes first; links are used only when the card has no parent that is a feature
 *  4. the target must be a feature type, in one of `projectKeys`
 *  5. a card that reaches two features is attached to neither
 * Every answer says how it was reached, so a report can print it.
 */
export type Resolution =
  | { kind: "feature"; work: string; feature: string; via: "self"; explain: string }
  | { kind: "resolved"; work: string; feature: string; via: "parent" | "link"; explain: string }
  | { kind: "ambiguous"; work: string; candidates: string[]; explain: string }
  | { kind: "none"; work: string; explain: string };

const same = (a: string | undefined, b: string | undefined) => (a ?? "").toLowerCase() === (b ?? "").toLowerCase();
export const projectOf = (key: string) => key.replace(/-\d+$/, "");

/** Is this issue type a feature? No configured types: every type is (the setting that turns linking on is featureIssueTypes). */
export function isFeatureType(c: Config, issueType: string | undefined): boolean {
  const types = c.requirements.jira.featureIssueTypes;
  return !types.length || !issueType || types.some((t) => same(t, issueType));
}

const inProjects = (c: Config, key: string) => !c.requirements.jira.projectKeys.length || c.requirements.jira.projectKeys.some((p) => same(p, projectOf(key)));

/** Does a configured link entry apply to this link on a card of this type? */
export function linkApplies(entry: { name: string; from: string[] }, link: Pick<JiraLink, "type" | "inward" | "outward" | "direction">, cardType: string | undefined): boolean {
  if (entry.from.length && !entry.from.some((t) => same(t, cardType))) return false;
  // "is caused by" is the wording this card sees; the link type's own name matches in both directions.
  const wording = link.direction === "outward" ? link.outward : link.inward;
  return same(entry.name, link.type) || same(entry.name, wording);
}

export async function resolveFeature(c: Config, card: JiraIssue, lookup: (key: string) => Promise<JiraIssue | undefined>, o: { hasCode?: boolean } = {}): Promise<Resolution> {
  const h = c.requirements.jira.hierarchy;
  const label = `${card.key}${card.issueType ? ` (${card.issueType})` : ""}`;
  if (isFeatureType(c, card.issueType)) return { kind: "feature", work: card.key, feature: card.key, via: "self", explain: `${label} is a feature` };
  if (o.hasCode === false) return { kind: "none", work: card.key, explain: `${label} has no code change naming it, so it is not attached to a feature (a link alone is not enough)` };

  const reasons: string[] = [];
  if (h.followParent && card.parent) {
    const p = await lookup(card.parent.key).catch(() => undefined);
    if (p && isFeatureType(c, p.issueType) && inProjects(c, p.key)) return { kind: "resolved", work: card.key, feature: p.key, via: "parent", explain: `${label} → ${p.key} via parent` };
    reasons.push(`its parent ${card.parent.key}${p?.issueType ? ` (${p.issueType})` : ""} is not a feature in ${c.requirements.jira.projectKeys.join(", ") || "any project"}`);
  } else if (h.followParent) reasons.push("it has no parent");

  const targets = new Map<string, JiraLink>();
  for (const l of card.links ?? []) if (h.links.some((e) => linkApplies(e, l, card.issueType))) targets.set(l.key, l);
  const features: string[] = [];
  for (const [key] of targets) {
    const t = await lookup(key).catch(() => undefined);
    if (t && isFeatureType(c, t.issueType) && inProjects(c, t.key)) features.push(t.key);
  }
  if (features.length === 1) return { kind: "resolved", work: card.key, feature: features[0], via: "link", explain: `${label} → ${features[0]} via link "${[...targets.values()].find((l) => l.key === features[0])!.type}"` };
  if (features.length > 1) return { kind: "ambiguous", work: card.key, candidates: features, explain: `${label} links to ${features.join(" and ")}; it is not counted for either (tracked under its own key)` };
  reasons.push(targets.size ? "its configured links don't lead to a feature" : h.links.length ? "it has no matching link" : "no link types are configured (requirements.jira.hierarchy.links)");
  return { kind: "none", work: card.key, explain: `${label} is not attached to a feature: ${reasons.join("; ")}` };
}

/** The status lists for a project key: its own override, else the global ones. */
export function statusSets(c: Config, key: string): { ready: string[]; approved: string[] } {
  const j = c.requirements.jira;
  const own = Object.entries(j.workflow.byProject).find(([p]) => same(p, projectOf(key)))?.[1];
  return { ready: own?.readyStatuses ?? j.workflow.readyStatuses, approved: own?.approvedStatuses ?? j.approvedStatuses };
}

/** Development is done: the status is a ready status for the story's project, or Jira's own "Done" category says so. */
export function isReadyStatus(c: Config, key: string, status: string | undefined, category?: string): boolean {
  return same(category, "done") || statusSets(c, key).ready.some((s) => same(s, status));
}

/** Services named by the card's Jira Components (requirements.jira.components). Unmapped components are returned apart. */
export function servicesFromComponents(c: Config, components: string[] | undefined): { services: string[]; unmapped: string[] } {
  const map = c.requirements.jira.components;
  const services = new Set<string>();
  const unmapped: string[] = [];
  for (const comp of components ?? []) {
    const hit = Object.entries(map).find(([k]) => same(k, comp));
    if (hit) services.add(hit[1]);
    else unmapped.push(comp);
  }
  return { services: [...services], unmapped };
}

/** The answer for one key: where it led, and why. The card and the feature are kept so the caller needs no second read. */
export interface KeyResolution {
  work: string;
  /** The feature the card belongs to. Missing when the card is not attached to one (ambiguous, none), is not in Jira, or could not be read. */
  feature?: string;
  via: "self" | "parent" | "link" | "none" | "ambiguous" | "not-found" | "error";
  explain: string;
  notFound?: boolean;
  workIssue?: JiraIssue;
  featureIssue?: JiraIssue;
}

/** One lookup of a card in Jira, kept for the length of a run. */
export type IssueCache = Map<string, Promise<{ issue?: JiraIssue; notFound?: boolean; error?: string }>>;

/**
 * Resolve several keys to their features with the fixed rules above. Each card is read from Jira once per cache
 * (a new cache per call unless one is given), so an MR that names the same parent twice costs one read.
 * A key that is not in Jira is `not-found`; it is never guessed at.
 */
export async function resolveKeysCached(c: Config, ctx: JiraContext, keys: string[], o: { hasCode?: boolean; cache?: IssueCache; read?: (key: string) => Promise<JiraIssue> } = {}): Promise<KeyResolution[]> {
  const cache: IssueCache = o.cache ?? new Map();
  const j = c.requirements.jira;
  const read = o.read ?? ((key: string) => fetchIssue(ctx, key, j.acceptanceCriteriaField, j.scopeFields.map((f) => f.field)));
  const get = (key: string) => {
    const k = key.toUpperCase();
    if (!cache.has(k))
      cache.set(
        k,
        read(key).then(
          (issue) => ({ issue }),
          (e) => ({ notFound: isJiraNotFound(e), error: (e as Error).message }),
        ),
      );
    return cache.get(k)!;
  };
  const out: KeyResolution[] = [];
  for (const key of [...new Set(keys)]) {
    const card = await get(key);
    if (!card.issue) {
      out.push(card.notFound ? { work: key, via: "not-found", notFound: true, explain: `${key} is not in Jira or not visible to this user` } : { work: key, via: "error", explain: `${key} could not be read from Jira: ${card.error?.slice(0, 160)}` });
      continue;
    }
    const r = await resolveFeature(c, card.issue, async (k) => (await get(k)).issue, { hasCode: o.hasCode });
    if (r.kind === "feature") out.push({ work: key, feature: r.feature, via: "self", explain: r.explain, workIssue: card.issue, featureIssue: card.issue });
    else if (r.kind === "resolved") out.push({ work: key, feature: r.feature, via: r.via, explain: r.explain, workIssue: card.issue, featureIssue: (await get(r.feature)).issue });
    else out.push({ work: key, via: r.kind, explain: r.explain, workIssue: card.issue });
  }
  return out;
}
