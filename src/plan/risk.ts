import type { Change, RiskFactor, RiskLevel, TestPlan } from "./schema.js";
import { type ChangeKindFinding, factorsOfKinds } from "../analysis/changeKinds.js";
import type { EndpointHistory, HistoryMap } from "../analysis/history.js";

/**
 * Transparent, rule-based risk. The model only names factors (with evidence); the level is computed here,
 * so the same factors always give the same risk and the rule can be read and changed by the team.
 */
export const RISK_RULES: Record<Exclude<RiskLevel, "low">, RiskFactor[]> = {
  critical: ["auth", "money", "personal-data"],
  high: ["business-rule", "breaking-contract", "write-path-error-handling", "cross-service", "conflicting-oracle", "user-journey", "price-display", "db-migration", "dependency-major"],
  medium: ["new-endpoint", "validation", "non-breaking-contract", "ui-visible", "config-change", "toggle-change", "dependency-bump"],
};

const ORDER: RiskLevel[] = ["low", "medium", "high", "critical"];

export function riskOf(factors: readonly RiskFactor[]): RiskLevel {
  for (const level of ["critical", "high", "medium"] as const) {
    if (factors.some((f) => RISK_RULES[level].includes(f))) return level;
  }
  return "low";
}

export const maxRisk = (levels: RiskLevel[]): RiskLevel => levels.reduce<RiskLevel>((a, b) => (ORDER.indexOf(b) > ORDER.indexOf(a) ? b : a), "low");

/** Factors implied by facts qa-sentinel knows itself, added on top of what the agent chose. */
export function deriveFactors(change: Change, ctx: { breakingEndpoints: Set<string>; crossService: boolean }): RiskFactor[] {
  const f = new Set<RiskFactor>(change.riskFactors);
  if (change.oracleStatus === "conflicting" && change.observable) f.add("conflicting-oracle");
  if (change.endpoint && ctx.breakingEndpoints.has(normaliseEndpoint(change.endpoint))) f.add("breaking-contract");
  // Other services consume this one and the change breaks what they send or receive.
  const breaking = Boolean(change.endpoint && ctx.breakingEndpoints.has(normaliseEndpoint(change.endpoint)));
  if (ctx.crossService && change.observable && (change.type === "removed" || breaking)) f.add("cross-service");
  return [...f];
}

export function normaliseEndpoint(e: string): string {
  const m = e.trim().match(/^([A-Za-z]+)\s+(\S+)/);
  if (!m) return e.trim();
  return `${m[1].toUpperCase()} ${m[2].replace(/\{[^}]+\}/g, "{}").replace(/:\w+/g, "{}").replace(/\/$/, "")}`;
}

export interface RiskedChange extends Change {
  factors: RiskFactor[];
  risk: RiskLevel;
  /** Added by qa-sentinel (the "c0" entry for change types), not in the agent's plan: left out of the decision table. */
  synthetic?: boolean;
}

/** One step up: low to medium to high. History never makes a change critical. */
export const raiseOne = (r: RiskLevel): RiskLevel => (r === "low" ? "medium" : r === "medium" ? "high" : r);

/**
 * Risk measures behaviour change. A non-observable change (refactor, logging, suspicious comment) is low,
 * except that touching auth, money or personal data still carries regression risk: medium.
 */
export function riskOfChange(c: Pick<Change, "observable">, factors: RiskFactor[]): RiskLevel {
  if (c.observable) return riskOf(factors);
  return factors.some((f) => RISK_RULES.critical.includes(f)) ? "medium" : "low";
}

export interface RiskContext {
  breakingEndpoints: Set<string>;
  crossService: boolean;
  /** Change types found in the changed files (no AI). They become the synthetic change c0. */
  changeKinds?: ChangeKindFinding[];
  /** Signals per endpoint from past defects, flaky runs and incidents (no AI). */
  history?: HistoryMap;
  /** Signals needed before history raises a change (risk.history.threshold). */
  historyThreshold?: number;
}

export interface RiskResult {
  changes: RiskedChange[];
  overall: RiskLevel;
  /** The change-type findings that made c0 (for the report and the regression selection). */
  changeKinds?: ChangeKindFinding[];
  /** Endpoints whose change was raised by history, with the evidence. */
  historyRaised?: { changeId: string; from: RiskLevel; to: RiskLevel; history: EndpointHistory }[];
}

/**
 * Risk of every change, computed here. Beyond what the plan names, two things are added from facts qa-sentinel finds
 * itself: a synthetic change c0 for the change types (db migration, config, toggle, dependency) and, per endpoint,
 * a one-level raise when past defects, flaky runs and incidents reach the threshold.
 */
export function applyRisk(plan: TestPlan, ctx: RiskContext): RiskResult {
  const threshold = ctx.historyThreshold ?? 2;
  const historyRaised: NonNullable<RiskResult["historyRaised"]> = [];
  const changes: RiskedChange[] = plan.changes.map((c) => {
    const factors = deriveFactors(c, ctx);
    let risk = riskOfChange(c, factors);
    const h = c.endpoint && c.observable ? ctx.history?.get(normaliseEndpoint(c.endpoint)) : undefined;
    if (h && h.count >= threshold) {
      factors.push("history");
      const to = raiseOne(risk);
      historyRaised.push({ changeId: c.id, from: risk, to, history: h });
      risk = to;
    }
    return { ...c, factors, risk };
  });
  const kinds = ctx.changeKinds ?? [];
  if (kinds.length) {
    const factors = factorsOfKinds(kinds);
    changes.push({
      id: "c0",
      type: "internal",
      summary: `Change types found in the code: ${[...new Set(kinds.map((k) => k.kind))].join(", ")}`,
      observable: true,
      requirementIds: [],
      oracleStatus: "missing",
      riskFactors: [],
      evidence: kinds.slice(0, 5).map((k) => ({ source: "source-code" as const, file: k.file, reference: `${k.kind} change` })),
      factors,
      risk: riskOf(factors),
      synthetic: true,
    });
  }
  return { changes, overall: maxRisk(changes.map((c) => c.risk)), ...(kinds.length ? { changeKinds: kinds } : {}), ...(historyRaised.length ? { historyRaised } : {}) };
}
