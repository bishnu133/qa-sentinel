import type { ExpectedFile } from "../expected/format.js";
import type { FeatureManifest } from "./manifest.js";

/**
 * Per-AC readiness for the end-to-end tests. A story's ACs often touch different services, so one slow service must
 * not hold back the ACs that don't need it. An AC is ready when every service it names has its change merged AND
 * deployed in the environment, and (when known) the Jira card is in a ready status. An AC that names no service
 * needs every part of the story. Decided by fixed rules from facts, never by an AI.
 */
export type AcState = "ready" | "not-merged" | "waiting-for-status" | "waiting-for-deployment" | "undetermined";

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
    const parts = named.length ? m.parts.filter((p) => named.some((n) => n.toLowerCase() === p.service.toLowerCase())) : m.parts;
    const services = parts.map((p) => p.service);
    // A named service the story did not change has nothing to wait for; it is said so rather than dropped silently.
    const ignored = named.filter((n) => !m.parts.some((p) => p.service.toLowerCase() === n.toLowerCase()));
    const note = ignored.length && parts.length ? ` (${ignored.join(", ")} named by the AC, not changed in this story: not waited for)` : "";
    const done = (state: AcState, reason: string): AcReadiness => ({ ac, state, services, reason: reason + note });
    if (!parts.length) return done("undetermined", named.length ? `the story has no change in ${named.join(", ")}, which this AC names (check "Services" for ${ac} in the expected-behaviour file)` : "no service change found for the story");
    const open = parts.filter((p) => !p.merged);
    if (open.length) return done("not-merged", `not merged yet: ${open.map((p) => p.service).join(", ")}`);
    if (jiraReady === false) return done("waiting-for-status", "the Jira card is not in a ready status yet");
    if (!m.environment) return done("undetermined", "merged; pass --env to check what is deployed");
    const behind = parts.filter((p) => p.deployed?.includesChange === false);
    if (behind.length) return done("waiting-for-deployment", `not deployed yet: ${behind.map((p) => p.service).join(", ")}`);
    const unknown = parts.filter((p) => p.deployed?.includesChange === undefined);
    if (unknown.length) return done("undetermined", `cannot tell if deployed: ${unknown.map((p) => `${p.service}${p.deployed?.error ? ` (${p.deployed.error})` : ""}`).join(", ")}`);
    return done("ready", `deployed: ${services.join(", ")}`);
  });
}

const ICON: Record<AcState, string> = { ready: "✅ ready", "not-merged": "🛠️ not merged", "waiting-for-status": "⏳ waiting for Jira status", "waiting-for-deployment": "⏳ waiting for deployment", undetermined: "❔ can't tell" };

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
