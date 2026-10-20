import { exposures } from "./gateway.js";
import type { Config } from "../config.js";
import type { ContractDiff } from "./contractDiff.js";
import { type IndexedTest, normPage } from "./testIndex.js";
import { runCommandsFor } from "../layers.js";
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

export type SelectionReason = "named-by-plan" | "changed-endpoint" | "changed-page" | "test-map" | "consumer" | "service-wide" | "via-gateway";

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

type MapLike = { services?: Record<string, { endpoints?: Record<string, string[]>; screens?: Record<string, string[]> }> } | undefined;

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
    // fixme/skip tests don't run (reported as discrepancies elsewhere). Known defects (test.fail) do: they go red when
    // the product is fixed, which is how the team learns the marker can come off.
    if (t.status !== "active" && t.status !== "known-defect") return;
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
    const mapped = new Set([...Object.values(i.map?.services?.[svc]?.endpoints ?? {}), ...Object.values(i.map?.services?.[svc]?.screens ?? {})].flat());
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

  // 2a. The same endpoints reached through a gateway or BFF: tests that call the BFF, not the service.
  for (const ep of endpoints) {
    for (const x of exposures(i.c, i.service, ep, i.map as never)) {
      for (const t of i.index)
        if (t.endpoints.some((e) => normEndpoint(e) === normEndpoint(x.endpoint)) && (!t.services.length || t.services.includes(x.service))) add(t, "via-gateway", `${ep} as ${x.service} ${x.endpoint}`);
      for (const [mapped, files] of Object.entries(i.map?.services?.[x.service]?.endpoints ?? {}))
        if (normEndpoint(mapped) === normEndpoint(x.endpoint)) for (const f of files) for (const t of i.index.filter((y) => y.file === f && !y.endpoints.length)) add(t, "via-gateway", `${ep} as ${x.service} ${x.endpoint}`);
    }
  }

  // 2b. Changed pages and screens (front ends, apps): UI tests tagged with the page or mapped to it under screens.
  // A page belongs to its service: an app screen "orders/:id" is not the web route /orders/:id of another front end.
  const pages = new Set<string>();
  for (const ch of i.plan?.changes ?? []) if (ch.page && ch.type !== "suspicious-instruction") pages.add(normPage(ch.page));
  const screens = i.map?.services?.[i.service]?.screens ?? {};
  for (const pg of pages) {
    for (const t of i.index) if (t.pages.includes(pg) && (!t.services.length || t.services.includes(i.service))) add(t, "changed-page", pg);
    for (const [mapped, files] of Object.entries(screens))
      if (normPage(mapped) === pg) for (const f of files) for (const t of i.index.filter((x) => x.file === f && !x.pages.length)) add(t, "test-map", pg);
  }

  // 3. Consumers of a breaking or cross-service change.
  const crossService = (i.risked ?? []).some((r) => r.factors?.includes("breaking-contract") || r.factors?.includes("cross-service")) || (i.contract?.changes ?? []).some((c) => c.breaking);
  if (crossService) {
    const consumers = i.c.workspace.services.filter((s) => s.dependsOn.includes(i.service)).map((s) => s.name);
    for (const svc of consumers) for (const t of serviceTests(svc)) add(t, "consumer", `${svc} depends on ${i.service}`);
    if (consumers.length) notes.push(`breaking or cross-service change: added tests of ${consumers.join(", ")}`);
  }

  // 4. Changes we can't pin to an endpoint → the service's whole suite.
  const unpinned = (i.plan?.changes ?? []).filter((ch) => ch.type !== "suspicious-instruction" && !ch.endpoint && !ch.page);
  let serviceWide = false;
  if (unpinned.length || (!picked.size && !endpoints.size && !pages.size)) {
    serviceWide = true;
    for (const t of serviceTests(i.service)) add(t, "service-wide", unpinned.length ? `${unpinned.map((u) => u.id).join(", ")}: not tied to one endpoint or page` : "no endpoint- or page-level signal");
    notes.push(unpinned.length ? `${unpinned.length} change(s) not tied to an endpoint or page: ran selection over the whole ${i.service} suite` : "no endpoint- or page-level signal: selected the whole service suite");
  }

  // Cucumber scenarios are run by the team's BDD job: listed in the notes, not in the commands.
  const bdd = [...picked.values()].filter((p) => p.test.bdd);
  if (bdd.length) notes.push(`${bdd.length} Cucumber scenario(s) also cover this change: run them with your BDD job (${[...new Set(bdd.map((b) => b.test.file))].slice(0, 5).join(", ")})`);
  const tests = [...picked.values()].filter((p) => !p.test.bdd).sort((a, b) => a.test.file.localeCompare(b.test.file) || a.test.line - b.test.line);
  const runFullSuite = tests.length === 0;
  if (runFullSuite) notes.push("nothing could be selected from tags or test-map.yaml: run the full suite");
  return { tests, serviceWide, runFullSuite, args: tests.map((s) => `${s.test.file}:${s.test.line}`), notes };
}

/** Union of several selections (story mode: one per service), reasons merged per test. */
export function mergeSelections(sels: RegressionSelection[]): RegressionSelection {
  const byId = new Map<string, SelectedTest>();
  for (const sel of sels)
    for (const t of sel.tests) {
      const m = byId.get(t.test.id) ?? { test: t.test, reasons: [], detail: [] };
      for (const r of t.reasons) if (!m.reasons.includes(r)) m.reasons.push(r);
      for (const d of t.detail) if (!m.detail.includes(d)) m.detail.push(d);
      byId.set(t.test.id, m);
    }
  const tests = [...byId.values()].sort((a, b) => a.test.file.localeCompare(b.test.file) || a.test.line - b.test.line);
  return {
    tests,
    serviceWide: sels.some((s) => s.serviceWide),
    runFullSuite: tests.length === 0,
    args: tests.map((s) => `${s.test.file}:${s.test.line}`),
    notes: [...new Set(sels.flatMap((s) => s.notes))],
  };
}

const REASON_LABEL: Record<SelectionReason, string> = {
  "named-by-plan": "named by the plan",
  "changed-endpoint": "changed endpoint",
  "via-gateway": "same endpoint through a gateway or BFF",
  "changed-page": "changed page",
  "test-map": "test-map.yaml",
  consumer: "consumer service",
  "service-wide": "service-wide",
};

/** Runner commands for a selection, one per layer (each layer has its own command, e.g. --project=api / web). */
export function regressionCommands(c: Config, sel: RegressionSelection): string[] {
  return runCommandsFor(c, sel.args);
}

export function regressionMarkdown(sel: RegressionSelection, runCommand?: string | string[]): string {
  if (sel.runFullSuite) return "**Regression selection:** no precise signal; run the full suite.";
  const commands = Array.isArray(runCommand) ? runCommand : runCommand ? [`${runCommand} ${sel.args.join(" ")}`] : [];
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
    ...(commands.length ? ["```", ...commands, "```", ""] : []),
    ...sel.notes.map((n) => `- ${n}`),
    "</details>",
  ];
  return lines.join("\n");
}
