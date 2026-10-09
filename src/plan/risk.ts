import type { Change, RiskFactor, RiskLevel, TestPlan } from "./schema.js";

/**
 * Transparent, rule-based risk. The model only names factors (with evidence); the level is computed here,
 * so the same factors always give the same risk and the rule can be read and changed by the team.
 */
export const RISK_RULES: Record<Exclude<RiskLevel, "low">, RiskFactor[]> = {
  critical: ["auth", "money", "personal-data"],
  high: ["business-rule", "breaking-contract", "write-path-error-handling", "cross-service", "conflicting-oracle"],
  medium: ["new-endpoint", "validation", "non-breaking-contract"],
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
  // Consumers exist and the change alters what they receive or send.
  if (ctx.crossService && change.observable && ["contract-change", "removed", "error-handling"].includes(change.type)) f.add("cross-service");
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
}

/**
 * Risk measures behaviour change. A non-observable change (refactor, logging, suspicious comment) is low,
 * except that touching auth, money or personal data still carries regression risk: medium.
 */
export function riskOfChange(c: Pick<Change, "observable">, factors: RiskFactor[]): RiskLevel {
  if (c.observable) return riskOf(factors);
  return factors.some((f) => RISK_RULES.critical.includes(f)) ? "medium" : "low";
}

export function applyRisk(plan: TestPlan, ctx: { breakingEndpoints: Set<string>; crossService: boolean }): { changes: RiskedChange[]; overall: RiskLevel } {
  const changes = plan.changes.map((c) => {
    const factors = deriveFactors(c, ctx);
    return { ...c, factors, risk: riskOfChange(c, factors) };
  });
  return { changes, overall: maxRisk(changes.map((c) => c.risk)) };
}
