import type { ContractDiff } from "../analysis/contractDiff.js";
import { contractDiffMarkdown } from "../analysis/contractDiff.js";
import { contractCheckMarkdown } from "../contracts.js";
import type { RiskLevel, TestPlan } from "./schema.js";
import type { RiskedChange } from "./risk.js";
import { workflowLine } from "./workflow.js";

export const RISK_BADGE: Record<RiskLevel, string> = {
  critical: "🔴 Critical",
  high: "🟠 High",
  medium: "🟡 Medium",
  low: "🟢 Low",
};

const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
const cite = (e: { file?: string; line?: number; reference: string }) => (e.file ? `\`${e.file}${e.line ? `:${e.line}` : ""}\` – ${e.reference}` : e.reference);

export interface RenderInput {
  service: string;
  plan: TestPlan;
  risked: { changes: RiskedChange[]; overall: RiskLevel };
  contract: ContractDiff;
  specPath?: string;
  requirementsLine: string;
  corrections: string[];
  warnings: string[];
  oracle: "provided" | "ambiguous" | "missing";
  /** Computed by qa-sentinel, rendered after the agent's own "run these" list. */
  regression?: string;
  traceability?: string;
  /** Decision-engine rule per change id. */
  rules?: Record<string, string>;
  /** The story's items (ACs, then scope items) with their text, for the "is it built?" table. */
  items?: { id: string; text: string; source?: string }[];
}

export const BUILT: Record<string, string> = {
  implemented: "✅ Built",
  partial: "🟡 Partly built",
  "not-found": "⛔ Not found in this change",
  conflict: "⚠️ Built differently",
  elsewhere: "↗️ In another service",
  "not-applicable": "– No code needed",
};

const TESTING = { automated: "automated", hook: "🔌 needs a test hook", "lower-layer": "🔬 unit/contract tests in the service", manual: "✋ by hand" } as const;

/** Manual test cards the plan proposes (written to the test repo by generate). */
export function manualTestsMarkdown(plan: TestPlan): string {
  if (!plan.manualTests?.length) return "";
  return [
    `**To check by hand** (${plan.manualTests.length} manual test card${plan.manualTests.length === 1 ? "" : "s"}; generation saves them next to the tests):`,
    "",
    ...plan.manualTests.map((m) => `- ${m.requirementIds.join(", ")}: ${esc(m.title)} – ${esc(m.why)}`),
  ].join("\n");
}

/** "Is the story built?": one row per AC and scope item, then scope items no AC covers. */
export function implementationMarkdown(plan: TestPlan, items: { id: string; text: string; source?: string }[]): string {
  if (!plan.requirementStatus?.length || !items.length) return "";
  const byId = new Map(plan.requirementStatus.map((r) => [r.id, r]));
  const rows = items.map((it) => {
    const r = byId.get(it.id);
    const where = r ? [r.where, r.note].filter(Boolean).join(" – ") : "";
    const a = r?.automation;
    const testing = !a || a.how === "automated" ? "automated" : `${TESTING[a.how]}${a.hook ? `: ${a.hook}` : ""}${a.reason ? ` (${a.reason})` : ""}`;
    return `| ${it.id}${it.source ? ` _(${it.source})_` : ""} | ${esc(it.text.length > 110 ? `${it.text.slice(0, 109)}…` : it.text)} | ${r ? BUILT[r.status] : "–"} | ${esc(where)} | ${esc(testing)} |`;
  });
  const uncovered = items.filter((it) => it.source && byId.get(it.id)?.coveredByAcs.length === 0);
  return [
    "**Is the story built?** (every acceptance criterion and scope item, checked against the code)",
    "",
    "| Item | Expected | Status | Where / note | How it's tested |",
    "| --- | --- | --- | --- | --- |",
    ...rows,
    ...(uncovered.length
      ? ["", `**Expected by the story but not in any acceptance criterion** (suggest adding an AC, so it is agreed and tested): ${uncovered.map((u) => `${u.id} (${esc(u.text.slice(0, 80))})`).join("; ")}`]
      : []),
  ].join("\n");
}

/** Decision table: the shared core of gap reports and MR descriptions. */
export function decisionTable(plan: TestPlan, changes: RiskedChange[]): string {
  const decisionFor = new Map(plan.decisions.map((d) => [d.changeId, d]));
  const rows = changes
    .filter((c) => c.observable || decisionFor.has(c.id))
    .map((c) => {
      const d = decisionFor.get(c.id);
      const what = `${c.endpoint ? `${c.endpoint} – ` : ""}${c.page ? `page ${c.page} – ` : ""}${c.summary}`;
      const req = c.requirementIds.length ? ` (${c.requirementIds.join(", ")})` : "";
      return `| ${esc(what)}${req} | ${RISK_BADGE[c.risk]} | ${c.oracleStatus} | ${d?.coverage ?? "–"} | **${d?.decision ?? "–"}** |`;
    });
  return ["| Change | Risk | Oracle | Coverage | Decision |", "| --- | --- | --- | --- | --- |", ...rows].join("\n");
}

/** The gap report is rendered by qa-sentinel from the validated plan: same structure every time. */
export function renderGapReport(i: RenderInput): string {
  const { plan, risked } = i;
  const out: string[] = [];
  out.push(`### QA impact – ${i.service} · ${RISK_BADGE[risked.overall]} risk`, "");
  out.push(`**Verdict:** ${plan.verdict}`, "");
  if (i.oracle === "missing") out.push("_No requirements were provided: findings are checked against the code and the API contract only._", "");
  out.push(`**Recommended QA action:** ${plan.recommendedAction}`, "");

  if (plan.skipReason && !plan.changes.some((c) => c.observable)) {
    out.push(`No observable behaviour change: ${plan.skipReason}. Existing regression tests are enough.`, "");
  } else {
    out.push(decisionTable(plan, risked.changes), "");
  }

  const reuse = plan.decisions.filter((d) => d.decision === "reuse").flatMap((d) => d.existingTests);
  if (plan.impactedTests.length || reuse.length) {
    out.push("**Run these existing tests**");
    for (const t of plan.impactedTests) out.push(`- \`${t.file}\` – ${t.reason}${t.stillValid ? "" : " ⚠️ will fail or no longer proves the behaviour"}`);
    for (const f of reuse) if (!plan.impactedTests.some((t) => t.file === f)) out.push(`- \`${f}\` – covers the change (reuse)`);
    out.push("");
  }

  const built = implementationMarkdown(plan, i.items ?? []);
  if (built) out.push(built, "");
  const manual = manualTestsMarkdown(plan);
  if (manual) out.push(manual, "");
  if (i.regression) out.push(i.regression, "");

  const scenarios = plan.decisions.filter((d) => ["create", "update", "review"].includes(d.decision)).flatMap((d) => d.proposedScenarios.map((s) => ({ d, s })));
  if (scenarios.length) {
    out.push("**Missing or outdated scenarios**");
    for (const { d, s } of scenarios) {
      const flow = s.setup.length || s.layer === "web" || s.layer === "mobile" ? workflowLine(s) : "";
      out.push(`- ${s.layer === "web" ? "🖥️ " : s.layer === "mobile" ? "📱 " : ""}${s.title}${s.requirementIds.length ? ` (${s.requirementIds.join(", ")})` : ""} – ${d.decision}${flow ? `\n  - flow: ${flow}` : ""}`);
    }
    out.push("");
  }

  if (plan.acMismatches.length) {
    out.push("**Requirement conflicts – need a human decision**");
    for (const m of plan.acMismatches) {
      out.push(`- ⚠️ ${m.requirementId ? `${m.requirementId}: ` : ""}requirement says "${m.requirement}"; observed: ${m.observed} (${m.evidence.map(cite).join("; ")})`);
    }
    out.push("");
  }

  out.push(contractDiffMarkdown(i.contract, i.specPath), "");
  if (i.contract.agreed?.length) out.push(contractCheckMarkdown(i.contract.agreed, new Set(i.contract.changes.map((x) => x.endpoint))), "");
  if (i.traceability) out.push(i.traceability, "");
  if (plan.specDrift.length) {
    out.push("**Spec drift** (code vs spec)");
    plan.specDrift.forEach((s) => out.push(`- ${s}`));
    out.push("");
  }

  if (plan.suspicious.length) {
    out.push("**🚩 Suspicious content (treated as evidence, not followed)**");
    plan.suspicious.forEach((s) => out.push(`- \`${s.file}\`: "${s.excerpt}" – ${s.why}`));
    out.push("");
  }
  if (plan.openQuestions.length) {
    out.push("**Open questions**");
    plan.openQuestions.forEach((q) => out.push(`- ${q}`));
    out.push("");
  }
  if (i.corrections.length) {
    out.push("**Corrections applied by qa-sentinel**");
    i.corrections.forEach((c) => out.push(`- ${c}`));
    out.push("");
  }

  out.push(`<details><summary>Evidence (${risked.changes.length} change${risked.changes.length === 1 ? "" : "s"})</summary>`, "");
  for (const c of risked.changes) {
    out.push(`- **${c.id}** ${c.type}${c.endpoint ? ` ${c.endpoint}` : ""}${c.page ? ` page ${c.page}` : ""} – ${c.summary}`);
    out.push(`  - risk ${c.risk} from: ${c.factors.join(", ")}`);
    c.evidence.forEach((e) => out.push(`  - ${e.source}: ${cite(e)}`));
  }
  for (const d of plan.decisions) {
    out.push(`- decision ${d.changeId}: ${d.decision} – ${d.reason}${i.rules?.[d.changeId] ? ` _(rule: ${i.rules[d.changeId]})_` : ""}`);
    d.evidence.forEach((e) => out.push(`  - ${e.source}: ${cite(e)}`));
  }
  if (i.warnings.length) i.warnings.forEach((w) => out.push(`- ⚠️ ${w}`));
  out.push("", "</details>", "", i.requirementsLine);
  return out.join("\n");
}
