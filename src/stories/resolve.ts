import type { Config } from "../config.js";
import type { JiraIssue, JiraLink } from "../scm/jira.js";

/**
 * Which feature a Jira card belongs to. A bug, task or sub-task is tested and reported under its story, but a wrong
 * link would pull an unrelated bug into a feature, so the rules are strict and fixed (not configurable):
 *  1. only cards with code are resolved (the caller says so: a bug that merely links to a story is not part of it)
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
