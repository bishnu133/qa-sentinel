/**
 * Benchmark cases that need no AI (B2): a feature that spans three services is judged by qa-sentinel's own fixed rules
 * (which acceptance criteria can have their tests written now, and what the others wait for), so it is scored in code.
 *
 *   npm run bench -- --features        # free, a few milliseconds
 *
 * Each case is a story whose services merge one after another. At each step the expected state of every AC is written
 * down by a person; the case passes when the rules give exactly that.
 */
import { ConfigSchema } from "../src/config.js";
import { acHash, type ExpectedFile } from "../src/expected/format.js";
import { storyScope } from "../src/generation/storyScope.js";
import type { ServicePart } from "../src/feature/manifest.js";
import type { WriteState } from "../src/feature/readiness.js";

export interface FeatureStep {
  /** What happened, in words. */
  happens: string;
  /** For each service: absent (no change yet), open (a merge request is open), merged. */
  services: Record<string, "none" | "open" | "merged">;
  jiraReady?: boolean;
  /** The expected state of each acceptance criterion at this step. */
  expect: Record<string, WriteState>;
  /** The ACs a generate run would plan at this step. */
  planned: string[];
}

export interface FeatureCase {
  id: string;
  covers: string;
  story: string;
  acs: { id: string; text: string; services: string[] }[];
  steps: FeatureStep[];
}

export const FEATURE_CASES: FeatureCase[] = [
  {
    id: "feature-three-services",
    covers: "Feature spans three microservices: a cross-service AC is held until every service it needs is merged, then planned (and the Jira status is waited for)",
    story: "SHOP-70",
    acs: [
      { id: "AC-1", text: "An order can carry a gift message (orders only).", services: ["orders-service"] },
      { id: "AC-2", text: "Paying a gift order sends a gift receipt by email (orders, payments and notifications).", services: ["orders-service", "payments-service", "notifications-service"] },
      { id: "AC-3", text: "A refunded gift order cancels the gift receipt (payments and notifications).", services: ["payments-service", "notifications-service"] },
    ],
    steps: [
      { happens: "orders merges; payments has an open merge request; notifications has no change yet", services: { "orders-service": "merged", "payments-service": "open", "notifications-service": "none" }, jiraReady: false, expect: { "AC-1": "ready", "AC-2": "waiting-merge", "AC-3": "waiting-merge" }, planned: ["AC-1"] },
      { happens: "payments merges; notifications still has no change", services: { "orders-service": "merged", "payments-service": "merged", "notifications-service": "none" }, jiraReady: false, expect: { "AC-1": "ready", "AC-2": "waiting-service", "AC-3": "waiting-service" }, planned: ["AC-1"] },
      { happens: "notifications merges, the Jira card is not in a ready status yet", services: { "orders-service": "merged", "payments-service": "merged", "notifications-service": "merged" }, jiraReady: false, expect: { "AC-1": "ready", "AC-2": "waiting-status", "AC-3": "waiting-status" }, planned: ["AC-1"] },
      { happens: "the Jira card reaches a ready status", services: { "orders-service": "merged", "payments-service": "merged", "notifications-service": "merged" }, jiraReady: true, expect: { "AC-1": "ready", "AC-2": "ready", "AC-3": "ready" }, planned: ["AC-1", "AC-2", "AC-3"] },
    ],
  },
];

export interface FeatureStepResult {
  case: string;
  step: number;
  happens: string;
  pass: boolean;
  /** The states the rules gave, and the ACs planned. */
  got: Record<string, WriteState>;
  planned: string[];
  problems: string[];
}

const config = () => ConfigSchema.parse({ version: 1, mode: "existing", project: { name: "bench" }, tests: { api: { framework: "mocha", runCommand: "x" } }, ci: { platform: "gitlab" } });

/** Run one case through qa-sentinel's rules. */
export function runFeatureCase(fc: FeatureCase): FeatureStepResult[] {
  const expected: ExpectedFile = { version: 1, story: fc.story, acs: fc.acs.map((a) => ({ id: a.id, hash: acHash(a.text), text: a.text, services: a.services, behaviours: [] })) };
  return fc.steps.map((st, i) => {
    const parts: ServicePart[] = Object.entries(st.services)
      .filter(([, s]) => s !== "none")
      .map(([service, s]) => ({ service, source: "git" as const, sha: `${service.slice(0, 3)}${i}0000000`, merged: s === "merged", keys: [fc.story], ...(s === "open" ? { branch: `feature/${fc.story}` } : {}) }));
    const scope = storyScope({ c: config(), acs: fc.acs.map((a) => ({ id: a.id, text: a.text })), expected, parts, jiraReady: st.jiraReady }, acHash);
    const got = Object.fromEntries(scope.readiness.map((r) => [r.ac, r.state])) as Record<string, WriteState>;
    const problems: string[] = [];
    for (const [ac, want] of Object.entries(st.expect)) if (got[ac] !== want) problems.push(`${ac}: expected ${want}, got ${got[ac] ?? "nothing"}`);
    if (JSON.stringify(scope.acScope) !== JSON.stringify(st.planned)) problems.push(`planned [${scope.acScope.join(", ")}], expected [${st.planned.join(", ")}]`);
    return { case: fc.id, step: i + 1, happens: st.happens, pass: problems.length === 0, got, planned: scope.acScope, problems };
  });
}

export function featureMarkdown(results: FeatureStepResult[]): string {
  const rows = results.map((r) => `| ${r.case} | ${r.step} | ${r.happens} | ${Object.entries(r.got).map(([a, s]) => `${a} ${s}`).join(", ")} | ${r.planned.join(", ") || "–"} | ${r.pass ? "✅" : `❌ ${r.problems.join("; ")}`} |`);
  return ["# qa-sentinel feature cases (no AI)", "", "| Case | Step | What happened | State of each AC | Planned now | Result |", "| --- | --- | --- | --- | --- | --- |", ...rows].join("\n");
}
