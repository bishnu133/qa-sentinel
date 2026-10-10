import type { ContractDiff } from "../analysis/contractDiff.js";
import { contractDiffMarkdown } from "../analysis/contractDiff.js";
import type { RiskLevel, TestPlan } from "./schema.js";
import type { RiskedChange } from "./risk.js";

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
}

/** Decision table: the shared core of gap reports and MR descriptions. */
export function decisionTable(plan: TestPlan, changes: RiskedChange[]): string {
  const decisionFor = new Map(plan.decisions.map((d) => [d.changeId, d]));
  const rows = changes
    .filter((c) => c.observable || decisionFor.has(c.id))
    .map((c) => {
      const d = decisionFor.get(c.id);
      const what = `${c.endpoint ? `${c.endpoint} – ` : ""}${c.summary}`;
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

  if (i.regression) out.push(i.regression, "");

  const scenarios = plan.decisions.filter((d) => ["create", "update", "review"].includes(d.decision)).flatMap((d) => d.proposedScenarios.map((s) => ({ d, s })));
  if (scenarios.length) {
    out.push("**Missing or outdated scenarios**");
    for (const { d, s } of scenarios) out.push(`- ${s.title}${s.requirementIds.length ? ` (${s.requirementIds.join(", ")})` : ""} – ${d.decision}`);
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
    out.push(`- **${c.id}** ${c.type}${c.endpoint ? ` ${c.endpoint}` : ""} – ${c.summary}`);
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
