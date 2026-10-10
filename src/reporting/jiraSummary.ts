import type { TestPlan, RiskLevel } from "../plan/schema.js";
import type { RequirementSnapshot } from "../requirements.js";
import type { AcTrace } from "../analysis/testIndex.js";

/**
 * Plain-language summaries for the Jira story. The MR gets the full technical report; the story gets what a PO,
 * developer or QA lead needs at a glance: what changed, how risky it is, where each acceptance criterion stands,
 * and what needs a human decision. Markdown here, converted to Jira wiki markup when posted.
 */

const RISK = { critical: "🔴 Critical", high: "🟠 High", medium: "🟡 Medium", low: "🟢 Low" } as const;
const link = (label: string, url?: string) => (url ? `[${label}](${url})` : label);

export type AcStanding = "conflict" | "needs-tests" | "covered" | "not-affected";
const STANDING: Record<AcStanding, string> = {
  conflict: "⚠️ Code and story disagree, needs a decision",
  "needs-tests": "🆕 Tests to add or update",
  covered: "✅ Existing tests cover it",
  "not-affected": "– Not touched by this change",
};

/** Where each acceptance criterion stands after the analysis (gap report). */
export function acStandings(plan: TestPlan, acIds: string[]): Map<string, AcStanding> {
  const out = new Map<string, AcStanding>();
  const decisionFor = new Map(plan.decisions.map((d) => [d.changeId, d]));
  for (const ac of acIds) {
    const changes = plan.changes.filter((c) => c.requirementIds.includes(ac));
    const scenarioHit = plan.decisions.some((d) => ["create", "update", "review"].includes(d.decision) && d.proposedScenarios.some((s) => s.requirementIds.includes(ac)));
    if (plan.acMismatches.some((m) => m.requirementId === ac) || changes.some((c) => c.oracleStatus === "conflicting")) out.set(ac, "conflict");
    else if (scenarioHit || changes.some((c) => ["create", "update", "review"].includes(decisionFor.get(c.id)?.decision ?? ""))) out.set(ac, "needs-tests");
    else if (changes.some((c) => decisionFor.get(c.id)?.decision === "reuse")) out.set(ac, "covered");
    else out.set(ac, "not-affected");
  }
  return out;
}

export function gapSummary(i: {
  service: string;
  plan: TestPlan;
  risk: RiskLevel;
  req: RequirementSnapshot;
  mrUrl?: string;
  reportUrl?: string;
  regressionTests?: number;
}): string {
  const standings = acStandings(i.plan, i.req.acceptanceCriteria.map((a) => a.id));
  const lines = [
    `### QA check · ${i.service} · ${RISK[i.risk]} risk`,
    `Stage: *analysed the code change* ${i.mrUrl ? `(${link("merge request", i.mrUrl)})` : ""}`.trim(),
    "",
    `**What changed:** ${i.plan.verdict}`,
    "",
    `**What QA will do:** ${i.plan.recommendedAction}`,
  ];
  if (standings.size) {
    lines.push("", "| Acceptance criterion | Status |", "| --- | --- |");
    for (const ac of i.req.acceptanceCriteria) lines.push(`| ${ac.id}: ${short(ac.text)} | ${STANDING[standings.get(ac.id)!]} |`);
  }
  if (i.plan.acMismatches.length) {
    lines.push("", "**Needs a decision (PO / dev):**");
    for (const m of i.plan.acMismatches) lines.push(`- ${m.requirementId ? `${m.requirementId}: ` : ""}story says "${short(m.requirement, 120)}", the code does: ${short(m.observed, 160)}`);
  }
  const questions = i.plan.openQuestions.slice(0, 3);
  if (questions.length) lines.push("", "**Open questions:**", ...questions.map((q) => `- ${short(q, 200)}`));
  if (i.regressionTests) lines.push("", `Existing tests to re-run for this change: ${i.regressionTests}.`);
  lines.push("", `_${link("Full technical report", i.reportUrl ?? i.mrUrl)} · posted by qa-sentinel_`);
  return lines.join("\n");
}

export function generationSummary(i: {
  service: string;
  risk: RiskLevel;
  verification: string;
  environment?: string;
  mrUrl?: string;
  trace?: AcTrace[];
  acText?: Map<string, string>;
  discrepancies: { test: string; note?: string }[];
  weakTests?: number;
}): string {
  const env = i.environment ? ` on ${i.environment.toUpperCase()}` : "";
  const ok = i.verification === "VERIFIED";
  const lines = [
    `### QA check · ${i.service} · ${RISK[i.risk]} risk`,
    `Stage: *tests written and run${env}* · ${ok ? "✅ all passed" : `⚠️ ${i.verification}`} · ${link("tests for review", i.mrUrl)}`,
  ];
  if (i.trace?.length) {
    const words: Record<AcTrace["status"], string> = {
      covered: "✅ Tested, passing",
      weak: "🟠 Tested, but the test is weak",
      discrepancy: "⚠️ Tested; product doesn't match the story yet",
      "pending-only": "⏸️ Test written, waiting for a product fix",
      "not-traced": "⬜ No test yet",
    };
    lines.push("", "| Acceptance criterion | Status | Tests |", "| --- | --- | --- |");
    for (const r of i.trace) lines.push(`| ${r.ac}${i.acText?.get(r.ac) ? `: ${short(i.acText.get(r.ac)!)}` : ""} | ${words[r.status]} | ${r.active.length} passing${r.pending.length ? `, ${r.pending.length} waiting` : ""} |`);
  }
  if (i.discrepancies.length) {
    lines.push("", "**Product doesn't match the story (needs a decision):**");
    for (const d of i.discrepancies.slice(0, 5)) lines.push(`- ${d.test}${d.note ? `: ${short(d.note, 200)}` : ""}`);
  }
  if (i.weakTests) lines.push("", `The independent review flagged ${i.weakTests} test(s) to strengthen before merge.`);
  lines.push("", `_A QA engineer reviews the tests before they are merged · posted by qa-sentinel_`);
  return lines.join("\n");
}

function short(s: string, n = 80): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}
