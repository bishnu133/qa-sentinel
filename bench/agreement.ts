/**
 * B3, consistency: run the same scenario N times (`npm run bench -- --runs 3`) and say how much the runs agree.
 * Pure functions over the results the benchmark already saves, so a saved results JSON can be summarised again for
 * free (`npm run bench -- --summarise bench/results/<file>.json`).
 */

/** What the summary needs from one run of a scenario (the benchmark's ScenarioResult has these fields). */
export interface RunSample {
  id: string;
  run: number;
  planValid: boolean;
  risk?: string;
  /** For each expected change (in the scenario's order): the decisions of the plan changes assigned to it, e.g. "update", "create+review" or "none". */
  perExpected?: { label: string; decision: string }[];
  /** Scenarios (tests) the plan proposes, summed over its decisions. */
  scenarioCount?: number;
  checks: { name: string; pass: boolean }[];
}

export interface ValueAgreement {
  /** What the runs said, most common first, with how often. */
  values: { value: string; runs: number }[];
  /** Share of runs that gave the most common answer, 0..1. */
  agreement: number;
}

export interface ScenarioAgreement {
  id: string;
  runs: number;
  validRuns: number;
  /** True when some runs produced a valid plan and others did not. */
  planValidityChanged: boolean;
  decisions: { label: string; agreement: ValueAgreement }[];
  risk: ValueAgreement | null;
  scenarioCount: { min: number; max: number } | null;
  /** Checks that passed in some runs and failed in others. */
  unstableChecks: string[];
  /** Every comparison agreed: same decisions, same risk, same scenario count, same plan validity, same checks. */
  identical: boolean;
}

const tally = (values: string[]): ValueAgreement => {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  const sorted = [...counts.entries()].map(([value, runs]) => ({ value, runs })).sort((a, b) => b.runs - a.runs || a.value.localeCompare(b.value));
  return { values: sorted, agreement: values.length ? sorted[0].runs / values.length : 0 };
};

/** One entry per scenario that ran at least twice. A run without a valid plan counts as the decision "no plan" so a flip to invalid is visible. */
export function summariseAgreement(results: RunSample[]): ScenarioAgreement[] {
  const ids = [...new Set(results.map((r) => r.id))];
  const out: ScenarioAgreement[] = [];
  for (const id of ids) {
    const runs = results.filter((r) => r.id === id);
    if (runs.length < 2) continue;
    const valid = runs.filter((r) => r.planValid);
    const labels = [...new Set(runs.flatMap((r) => (r.perExpected ?? []).map((e) => e.label)))];
    const decisions = labels.map((label) => ({
      label,
      agreement: tally(runs.map((r) => (r.planValid ? (r.perExpected?.find((e) => e.label === label)?.decision ?? "none") : "no plan"))),
    }));
    const risk = valid.some((r) => r.risk) ? tally(valid.map((r) => r.risk ?? "unknown")) : null;
    const counts = valid.map((r) => r.scenarioCount).filter((n): n is number => typeof n === "number");
    const names = [...new Set(runs.flatMap((r) => r.checks.map((c) => c.name)))];
    const unstableChecks = names.filter((n) => {
      const seen = new Set(runs.map((r) => r.checks.find((c) => c.name === n)?.pass ?? "absent"));
      return seen.size > 1;
    });
    const scenarioCount = counts.length ? { min: Math.min(...counts), max: Math.max(...counts) } : null;
    const planValidityChanged = valid.length > 0 && valid.length < runs.length;
    out.push({
      id,
      runs: runs.length,
      validRuns: valid.length,
      planValidityChanged,
      decisions,
      risk,
      scenarioCount,
      unstableChecks,
      identical: !planValidityChanged && decisions.every((d) => d.agreement.agreement === 1) && (risk?.agreement ?? 1) === 1 && (scenarioCount ? scenarioCount.min === scenarioCount.max : true) && unstableChecks.length === 0,
    });
  }
  return out;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const list = (a: ValueAgreement) => a.values.map((v) => `${v.value}×${v.runs}`).join(", ");

/** The agreement table for the results markdown. Empty when no scenario ran twice. */
export function agreementMarkdown(rows: ScenarioAgreement[]): string[] {
  if (!rows.length) return [];
  const out = [
    "",
    "## Consistency across runs",
    "",
    "Same input, several runs. Agreement is the share of runs that gave the most common answer; 100% everywhere means the runs were identical on these measures.",
    "",
    "| Scenario | Runs (valid plan) | Decision agreement (lowest) | Risk agreement | Scenarios proposed (min–max) | Plan validity | Unstable checks |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const r of rows) {
    const worst = r.decisions.length ? Math.min(...r.decisions.map((d) => d.agreement.agreement)) : undefined;
    out.push(
      `| ${r.id} | ${r.runs} (${r.validRuns}) | ${worst === undefined ? "–" : pct(worst)} | ${r.risk ? `${pct(r.risk.agreement)} (${list(r.risk)})` : "–"} | ${r.scenarioCount ? `${r.scenarioCount.min}–${r.scenarioCount.max}` : "–"} | ${r.planValidityChanged ? "changed between runs" : r.validRuns ? "same" : "never valid"} | ${r.unstableChecks.length ? r.unstableChecks.join("; ") : "none"} |`,
    );
  }
  const detail = rows.flatMap((r) => r.decisions.filter((d) => d.agreement.agreement < 1).map((d) => `- **${r.id}** · ${d.label}: ${list(d.agreement)}`));
  if (detail.length) out.push("", "Decisions that differed between runs:", ...detail);
  out.push("", `${rows.filter((r) => r.identical).length} of ${rows.length} scenario(s) gave identical results in every run.`);
  return out;
}
