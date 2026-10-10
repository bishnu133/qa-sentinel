import type { Config } from "../config.js";
import type { ContractDiff } from "./contractDiff.js";
import type { IndexedTest } from "./testIndex.js";
import type { TestPlan } from "../plan/schema.js";
import type { RiskedChange } from "../plan/risk.js";

/**
 * Regression selection, computed in code: which EXISTING tests should run for this change, and why.
 *
 * Sources, strongest first:
 *  1. tests the plan names (impacted tests, tests reused or updated by a decision),
 *  2. tests tagged with a changed endpoint (plan changes + the computed contract diff), or mapped to it in test-map.yaml,
 *  3. consumer tests: services that depend on this one, when the change breaks a contract or is cross-service,
 *  4. the whole service's tests, when a change can't be pinned to an endpoint (internal refactors, shared code).
 * Every selected test carries its reasons, so a reviewer can see why it is in the list.
 */

export type SelectionReason = "named-by-plan" | "changed-endpoint" | "test-map" | "consumer" | "service-wide";

export interface SelectedTest {
  test: IndexedTest;
  reasons: SelectionReason[];
  detail: string[];
}

export interface RegressionSelection {
  tests: SelectedTest[];
  /** Selection ran out of precise signals and fell back to the service's whole suite. */
  serviceWide: boolean;
  /** Set when even the service-wide fallback found nothing: run the full suite. */
  runFullSuite: boolean;
  args: string[]; // file:line arguments for the test runner
  notes: string[];
}

/** "post /payments/{id}/refund/" and "POST /payments/{}/refund" are the same endpoint. */
export const normEndpoint = (e: string) => {
  const m = e.trim().match(/^([A-Za-z]+)\s+(\S+)$/);
  if (!m) return e.trim();
  return `${m[1].toUpperCase()} ${m[2].replace(/\{[^}]*\}/g, "{}").replace(/\/+$/, "") || "/"}`;
};

type MapLike = { services?: Record<string, { endpoints?: Record<string, string[]> }> } | undefined;

export function selectRegression(i: {
  c: Config;
  service: string;
  plan?: TestPlan;
  risked?: RiskedChange[];
  contract?: ContractDiff;
  index: IndexedTest[];
  map: MapLike;
}): RegressionSelection {
  const picked = new Map<string, SelectedTest>();
  const notes: string[] = [];
  const add = (t: IndexedTest, reason: SelectionReason, detail: string) => {
    if (t.status !== "active") return; // fixme/skip tests don't run; they're reported as discrepancies elsewhere
    const s = picked.get(t.id) ?? { test: t, reasons: [], detail: [] };
    if (!s.reasons.includes(reason)) s.reasons.push(reason);
    if (!s.detail.includes(detail)) s.detail.push(detail);
    picked.set(t.id, s);
  };
  const byFileRef = (ref: string) => {
    const [file, line] = ref.split(/:(?=\d+$)/);
    return i.index.filter((t) => t.file === file && (!line || t.line === Number(line)));
  };
  const serviceTests = (svc: string) => {
    const mapped = new Set(Object.values(i.map?.services?.[svc]?.endpoints ?? {}).flat());
    return i.index.filter((t) => t.services.includes(svc) || mapped.has(t.file));
  };

  // 1. Named by the plan.
  const short = (s: string) => (s.length > 90 ? `${s.slice(0, 87)}…` : s);
  for (const t of i.plan?.impactedTests ?? []) for (const x of byFileRef(t.file)) add(x, "named-by-plan", short(t.reason));
  for (const d of i.plan?.decisions ?? []) {
    if (d.decision === "reuse" || d.decision === "update")
      for (const ref of d.existingTests) for (const x of byFileRef(ref)) add(x, "named-by-plan", `${d.changeId}: ${d.decision}`);
  }

  // 2. Changed endpoints.
  const endpoints = new Set<string>();
  for (const ch of i.plan?.changes ?? []) if (ch.endpoint && ch.type !== "suspicious-instruction") endpoints.add(normEndpoint(ch.endpoint));
  for (const ch of i.contract?.changes ?? []) if (ch.endpoint) endpoints.add(normEndpoint(ch.endpoint));
  const mapForService = i.map?.services?.[i.service]?.endpoints ?? {};
  for (const ep of endpoints) {
    for (const t of i.index) if (t.endpoints.some((e) => normEndpoint(e) === ep)) add(t, "changed-endpoint", ep);
    for (const [mapped, files] of Object.entries(mapForService))
      if (normEndpoint(mapped) === ep) for (const f of files) for (const t of i.index.filter((x) => x.file === f && !x.endpoints.length)) add(t, "test-map", ep);
  }

  // 3. Consumers of a breaking or cross-service change.
  const crossService = (i.risked ?? []).some((r) => r.factors?.includes("breaking-contract") || r.factors?.includes("cross-service")) || (i.contract?.changes ?? []).some((c) => c.breaking);
  if (crossService) {
    const consumers = i.c.workspace.services.filter((s) => s.dependsOn.includes(i.service)).map((s) => s.name);
    for (const svc of consumers) for (const t of serviceTests(svc)) add(t, "consumer", `${svc} depends on ${i.service}`);
    if (consumers.length) notes.push(`breaking or cross-service change: added tests of ${consumers.join(", ")}`);
  }

  // 4. Changes we can't pin to an endpoint → the service's whole suite.
  const unpinned = (i.plan?.changes ?? []).filter((ch) => ch.type !== "suspicious-instruction" && !ch.endpoint);
  let serviceWide = false;
  if (unpinned.length || (!picked.size && !endpoints.size)) {
    serviceWide = true;
    for (const t of serviceTests(i.service)) add(t, "service-wide", unpinned.length ? `${unpinned.map((u) => u.id).join(", ")}: not tied to one endpoint` : "no endpoint-level signal");
    notes.push(unpinned.length ? `${unpinned.length} change(s) not tied to an endpoint: ran selection over the whole ${i.service} suite` : "no endpoint-level signal: selected the whole service suite");
  }

  const tests = [...picked.values()].sort((a, b) => a.test.file.localeCompare(b.test.file) || a.test.line - b.test.line);
  const runFullSuite = tests.length === 0;
  if (runFullSuite) notes.push("nothing could be selected from tags or test-map.yaml: run the full suite");
  return { tests, serviceWide, runFullSuite, args: tests.map((s) => `${s.test.file}:${s.test.line}`), notes };
}

const REASON_LABEL: Record<SelectionReason, string> = {
  "named-by-plan": "named by the plan",
  "changed-endpoint": "changed endpoint",
  "test-map": "test-map.yaml",
  consumer: "consumer service",
  "service-wide": "service-wide",
};

export function regressionMarkdown(sel: RegressionSelection, runCommand?: string): string {
  if (sel.runFullSuite) return "**Regression selection:** no precise signal; run the full API suite.";
  const files = new Set(sel.tests.map((s) => s.test.file)).size;
  const lines = [
    `**Regression selection** (computed by qa-sentinel): ${sel.tests.length} existing test(s) in ${files} file(s)${sel.serviceWide ? ", including the service-wide fallback" : ""}`,
    "",
    "<details><summary>Selected tests and why</summary>",
    "",
    "| Test | Why |",
    "| --- | --- |",
    ...sel.tests.map((s) => `| \`${s.test.file}:${s.test.line}\` ${s.test.title.replace(/\|/g, "\\|")} | ${s.reasons.map((r) => REASON_LABEL[r]).join(", ")}: ${s.detail.join("; ").replace(/\|/g, "\\|")} |`),
    "",
    ...(runCommand ? ["```", `${runCommand} ${sel.args.join(" ")}`, "```", ""] : []),
    ...sel.notes.map((n) => `- ${n}`),
    "</details>",
  ];
  return lines.join("\n");
}
