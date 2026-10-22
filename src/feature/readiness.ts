import type { ExpectedFile } from "../expected/format.js";
import { activeParts, type FeatureManifest } from "./manifest.js";

/**
 * Per-AC readiness for the end-to-end tests. A story's ACs often touch different services, so one slow service must
 * not hold back the ACs that don't need it. An AC is ready when every service it names has its change merged AND
 * deployed in the environment, and (when known) the Jira card is in a ready status. An AC that names no service
 * needs every part of the story. Decided by fixed rules from facts, never by an AI.
 */
export type AcState = "ready" | "reverted" | "not-merged" | "waiting-for-status" | "waiting-for-deployment" | "undetermined";

export interface AcReadiness {
  ac: string;
  state: AcState;
  /** The services this AC depends on (those with a change in this story). */
  services: string[];
  /** Why it is not ready, or how it was decided. */
  reason: string;
}

export function acReadiness(m: FeatureManifest, expected: ExpectedFile | undefined, acIds: string[], jiraReady?: boolean): AcReadiness[] {
  const namedBy = new Map((expected?.acs ?? []).map((a) => [a.id, a.services]));
  return acIds.map((ac) => {
    const named = namedBy.get(ac) ?? [];
    // A service can have several parts (one per merge request): it counts as merged only when none of them is still open.
    const live = activeParts(m.parts);
    const parts = named.length ? live.filter((p) => named.some((n) => n.toLowerCase() === p.service.toLowerCase())) : live;
    const services = [...new Set(parts.map((p) => p.service))];
    // A named service the story did not change has nothing to wait for; it is said so rather than dropped silently.
    const ignored = named.filter((n) => !live.some((p) => p.service.toLowerCase() === n.toLowerCase()));
    const note = ignored.length && parts.length ? ` (${ignored.join(", ")} named by the AC, not changed in this story: not waited for)` : "";
    const done = (state: AcState, reason: string): AcReadiness => ({ ac, state, services, reason: reason + note });
    if (!parts.length) return done("undetermined", named.length ? `the story has no change in ${named.join(", ")}, which this AC names (check "Services" for ${ac} in the expected-behaviour file)` : "no service change found for the story");
    const gone = parts.filter((p) => p.reverted);
    if (gone.length) return done("reverted", `reverted: ${gone.map((p) => `${p.service} (by ${p.reverted!.slice(0, 8)})`).join(", ")}`);
    const open = parts.filter((p) => !p.merged);
    if (open.length) return done("not-merged", `not merged yet: ${[...new Set(open.map((p) => `${p.service}${p.mr ? ` !${p.mr.iid}` : p.branch ? ` (${p.branch})` : ""}`))].join(", ")}`);
    if (jiraReady === false) return done("waiting-for-status", "the Jira card is not in a ready status yet");
    if (!m.environment) return done("undetermined", "merged; pass --env to check what is deployed");
    const behind = parts.filter((p) => p.deployed?.includesChange === false);
    if (behind.length) return done("waiting-for-deployment", `not deployed yet: ${behind.map((p) => p.service).join(", ")}`);
    const unknown = parts.filter((p) => p.deployed?.includesChange === undefined);
    if (unknown.length) return done("undetermined", `cannot tell if deployed: ${unknown.map((p) => `${p.service}${p.deployed?.error ? ` (${p.deployed.error})` : ""}`).join(", ")}`);
    return done("ready", `deployed: ${services.join(", ")}`);
  });
}

const ICON: Record<AcState, string> = { ready: "✅ ready", reverted: "↩️ reverted", "not-merged": "🛠️ not merged", "waiting-for-status": "⏳ waiting for Jira status", "waiting-for-deployment": "⏳ waiting for deployment", undetermined: "❔ can't tell" };

export function readinessMarkdown(rows: AcReadiness[]): string[] {
  if (!rows.length) return [];
  return ["", "#### Ready for end-to-end tests, per acceptance criterion", "", "| AC | State | Depends on | Why |", "| --- | --- | --- | --- |", ...rows.map((r) => `| ${r.ac} | ${ICON[r.state]} | ${r.services.join(", ") || "–"} | ${r.reason} |`)];
}

/** A test may run when every AC it names is ready; a test naming none runs only when every AC is ready. */
export function testRunnable(testAcs: string[], rows: AcReadiness[]): boolean {
  const ready = new Set(rows.filter((r) => r.state === "ready").map((r) => r.ac));
  if (!testAcs.length) return rows.length > 0 && rows.every((r) => r.state === "ready");
  return testAcs.every((a) => ready.has(a));
}

/**
 * Write-time readiness: can the tests of this AC be WRITTEN now? (`acReadiness` above says whether they can be RUN:
 * it needs an environment and a deployment.) Tests are written after a merge, so the gate is merged code, and for an
 * AC that needs several services also the Jira status (by default). Decided by fixed rules from facts, never by an AI.
 */
export type WriteState = "ready" | "waiting-merge" | "waiting-service" | "waiting-status" | "reverted" | "held-override-none";

export interface AcWriteReadiness {
  ac: string;
  /** single: one service builds it, its tests are written when that service merges. cross: several services, written once they are all merged. */
  kind: "single" | "cross";
  /** The services this AC needs. */
  services: string[];
  state: WriteState;
  reason: string;
  /** Short: what a waiting AC waits for ("the merge of storefront !7"). Empty when it is ready. */
  waitingFor: string;
}

export interface WriteReadinessOptions {
  /** Is the Jira card in a ready status? undefined: not known (story files), taken as ready. */
  jiraReady?: boolean;
  mode: "when-ready-status" | "when-ac-complete";
  /** Services named by the card's Jira components (requirements.jira.components). */
  components?: string[];
  /** ACs a person marked ready by hand (`/qa ready AC-n`). */
  overrides?: { ac: string }[];
}

const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function acWriteReadiness(parts: FeatureManifest["parts"], expected: ExpectedFile | undefined, acIds: string[], o: WriteReadinessOptions): AcWriteReadiness[] {
  const live = activeParts(parts);
  const withParts = [...new Set(live.map((p) => p.service))];
  const named = new Map((expected?.acs ?? []).filter((a) => !a.removed).map((a) => [a.id, a.services]));
  const overridden = new Set((o.overrides ?? []).map((x) => x.ac.toUpperCase()));
  return acIds.map((ac) => {
    // Services the AC names; else the services of the card's components plus every service with a change in the story.
    const explicit = named.get(ac) ?? [];
    const services = explicit.length ? explicit : [...new Set([...(o.components ?? []), ...withParts])];
    const kind: AcWriteReadiness["kind"] = services.length > 1 ? "cross" : "single";
    const row = (state: WriteState, reason: string, waitingFor = ""): AcWriteReadiness => ({ ac, kind, services, state, reason, waitingFor });
    const mine = (svc: string) => live.filter((p) => sameName(p.service, svc));
    const forced = overridden.has(ac.toUpperCase());
    if (!services.length) return row("waiting-service", "the story has no service change yet", "a service change");
    const gone = services.flatMap((s) => mine(s).filter((p) => p.reverted).map((p) => `${p.service} (by ${p.reverted!.slice(0, 8)})`));
    if (gone.length) return row("reverted", `reverted: ${gone.join(", ")}`, "the revert to be undone");
    // An open merge request holds the AC back, override or not: the code it builds is not on the main branch yet.
    const open = services.flatMap((s) => mine(s).filter((p) => !p.merged).map((p) => `${p.service}${p.mr ? ` !${p.mr.iid}` : p.branch ? ` (${p.branch})` : ""}`));
    if (open.length) return row("waiting-merge", `not merged yet: ${[...new Set(open)].join(", ")}${forced ? " (a person marked it ready, but an open merge request is never skipped)" : ""}`, `the merge of ${[...new Set(open)].join(", ")}`);
    const missing = services.filter((s) => !mine(s).length);
    if (missing.length === services.length && forced) return row("held-override-none", `marked ready by a person, but none of ${services.join(", ")} has a change in this story: nothing to write tests against`, `a change in ${services.join(" or ")}`);
    if (missing.length && !forced) return row("waiting-service", `no change found yet in ${missing.join(", ")}`, `a change in ${missing.join(", ")}`);
    if (kind === "cross" && !forced && o.mode === "when-ready-status" && o.jiraReady === false) return row("waiting-status", `merged in ${services.filter((s) => mine(s).length).join(", ")}; waiting for the Jira card to reach a ready status (generation.crossService: when-ac-complete skips this wait)`, "the Jira card to reach a ready status");
    const note = kind === "cross" && !forced && o.mode === "when-ready-status" && o.jiraReady === undefined ? "; Jira status not known" : "";
    return row("ready", forced && missing.length ? `marked ready by a person (${missing.join(", ")} has no change)` : `merged in ${services.join(", ")}${note}`);
  });
}

/** The services of an AC that have merged work: the commits its tests were written against. Sorted, so equal states give equal text. */
export function mergedHeadsOf(parts: FeatureManifest["parts"], services: string[]): string[] {
  return activeParts(parts)
    .filter((p) => p.merged && !p.reverted && services.some((s) => sameName(s, p.service)))
    .map((p) => `${p.service}:${p.mergeSha ?? p.squashSha ?? p.sha ?? ""}`)
    .sort();
}
