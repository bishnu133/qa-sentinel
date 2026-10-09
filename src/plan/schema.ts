import { z } from "zod";

/**
 * The TestPlan is the single structured handoff between the AI analysis and everything after it
 * (report rendering, risk, authoring, MR summary). The agent writes it; qa-sentinel validates it,
 * computes risk from it and renders reports from it. Free-form agent prose is never parsed.
 */

/** Optional fields accept null too (models often write null for "not applicable"); normalised to undefined. */
const opt = <T extends z.ZodTypeAny>(t: T) => t.nullish().transform((v) => (v === null ? undefined : v)) as unknown as z.ZodOptional<T>;

export const EVIDENCE_SOURCES = ["requirement", "source-code", "openapi", "contract-diff", "existing-test", "runtime"] as const;

export const EvidenceSchema = z
  .object({
    source: z.enum(EVIDENCE_SOURCES),
    /** Path relative to the repo the source lives in (service repo for code/openapi, test repo for tests). */
    file: opt(z.string()),
    line: opt(z.number().int().positive()),
    /** What exactly supports the claim: a quote, an AC id, a constant, an assertion. */
    reference: z.string().min(1),
  })
  .strict();

export const CHANGE_TYPES = [
  "new-endpoint",
  "contract-change",
  "validation-change",
  "business-rule",
  "error-handling",
  "removed",
  "internal",
  "suspicious-instruction",
] as const;

export const ORACLE_STATUSES = ["approved", "conflicting", "ambiguous", "missing"] as const;

/** Observable risk factors. The agent picks them (with evidence); qa-sentinel turns them into a risk level. */
export const RISK_FACTORS = [
  "auth",
  "money",
  "personal-data",
  "business-rule",
  "breaking-contract",
  "write-path-error-handling",
  "cross-service",
  "conflicting-oracle",
  "new-endpoint",
  "validation",
  "non-breaking-contract",
  "read-only",
  "internal",
] as const;

export const ChangeSchema = z
  .object({
    id: z.string().regex(/^c\d+$/, "change ids are c1, c2, …"),
    type: z.enum(CHANGE_TYPES),
    endpoint: opt(z.string()),
    summary: z.string().min(1),
    observable: z.boolean(),
    requirementIds: z.array(z.string()).default([]),
    oracleStatus: z.enum(ORACLE_STATUSES),
    /** Required (≥1) for observable changes; checked in validate.ts. */
    riskFactors: z.array(z.enum(RISK_FACTORS)).default([]),
    evidence: z.array(EvidenceSchema).min(1),
  })
  .strict();

export const COVERAGE = ["covered", "partial", "missing", "outdated", "unknown"] as const;
export const DECISIONS = ["reuse", "update", "create", "review", "skip"] as const;

export const ScenarioSchema = z
  .object({
    title: z.string().min(1),
    requirementIds: z.array(z.string()).default([]),
    setup: z.array(z.string()).default([]),
    assertions: z.array(z.string()).min(1, "a scenario must name at least one assertion"),
  })
  .strict();

export const DecisionSchema = z
  .object({
    changeId: z.string(),
    coverage: z.enum(COVERAGE),
    decision: z.enum(DECISIONS),
    existingTests: z.array(z.string()).default([]),
    proposedScenarios: z.array(ScenarioSchema).default([]),
    evidence: z.array(EvidenceSchema).default([]),
    reason: z.string().min(1),
  })
  .strict();

export const TestPlanSchema = z
  .object({
    schemaVersion: z.literal(1),
    verdict: z.string().min(1),
    recommendedAction: z.string().min(1),
    changes: z.array(ChangeSchema),
    decisions: z.array(DecisionSchema),
    impactedTests: z
      .array(z.object({ file: z.string(), reason: z.string(), stillValid: z.boolean() }).strict())
      .default([]),
    acMismatches: z
      .array(
        z
          .object({
            requirementId: opt(z.string()),
            requirement: z.string(),
            observed: z.string(),
            evidence: z.array(EvidenceSchema).min(1),
          })
          .strict(),
      )
      .default([]),
    specDrift: z.array(z.string()).default([]),
    suspicious: z.array(z.object({ file: z.string(), excerpt: z.string(), why: z.string() }).strict()).default([]),
    openQuestions: z.array(z.string()).default([]),
    skipReason: z.string().nullable().default(null),
  })
  .strict();

export type Evidence = z.infer<typeof EvidenceSchema>;
export type Change = z.infer<typeof ChangeSchema>;
export type Decision = z.infer<typeof DecisionSchema>;
export type TestPlan = z.infer<typeof TestPlanSchema>;
export type RiskFactor = (typeof RISK_FACTORS)[number];
export type RiskLevel = "low" | "medium" | "high" | "critical";
