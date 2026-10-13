import { z } from "zod";

/**
 * The TestPlan is the single structured handoff between the AI analysis and everything after it
 * (report rendering, risk, authoring, MR summary). The agent writes it; qa-sentinel validates it,
 * computes risk from it and renders reports from it. Free-form agent prose is never parsed.
 */

/** Optional fields accept null too (models often write null for "not applicable"); normalised to undefined. */
const opt = <T extends z.ZodTypeAny>(t: T) => t.nullish().transform((v) => (v === null ? undefined : v)) as unknown as z.ZodOptional<T>;

export const EVIDENCE_SOURCES = ["requirement", "source-code", "openapi", "contract-diff", "domain-rule", "existing-test", "runtime"] as const;

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
  /** A front-end change the user can see or do: a new or changed page element, label, flow or navigation. */
  "ui-change",
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
  /** A core journey through the UI changed (sign-in, checkout, payment, submitting a form that writes data). */
  "user-journey",
  /** A visible UI change outside the core journeys (labels, layout, read-only pages). */
  "ui-visible",
] as const;

export const ChangeSchema = z
  .object({
    id: z.string().regex(/^c\d+$/, "change ids are c1, c2, …"),
    type: z.enum(CHANGE_TYPES),
    endpoint: opt(z.string()),
    /** Front-end route the change is on, e.g. /orders/new or /orders/:id. */
    page: opt(z.string()),
    /** Story mode (several services): which service the change is in. */
    service: opt(z.string()),
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

export const LAYERS = ["api", "web"] as const;
/** How a setup step creates its data. The policy: API or a test-data service first; UI only when no safe programmatic route exists. */
export const SETUP_VIA = ["api", "test-data-service", "db-helper", "ui"] as const;

/**
 * One precondition of a scenario, as a node in a small dependency graph (the workflow planner): e.g.
 * s1 "create an order" (api) → s2 "authorise its payment" (api, dependsOn s1) → the web test opens the order page.
 */
export const SetupStepSchema = z
  .object({
    id: z.string().regex(/^s\d+$/, "setup step ids are s1, s2, …"),
    via: z.enum(SETUP_VIA),
    action: z.string().min(1),
    /** Existing helper or builder to use (e.g. api.createOrder), or "new: <name>" when one must be added. */
    helper: opt(z.string()),
    dependsOn: z.array(z.string()).default([]),
    /** Required for ui and db-helper steps: why the API route is not possible. */
    why: opt(z.string()),
  })
  .strict();

export const ScenarioSchema = z
  .object({
    title: z.string().min(1),
    requirementIds: z.array(z.string()).default([]),
    /** Which layer proves this scenario. Default: the service's layer (web for front ends, api otherwise). */
    layer: opt(z.enum(LAYERS)),
    /** Web scenarios: the page the test opens. */
    page: opt(z.string()),
    /** Preconditions. Plain strings are accepted and read as API steps in order. */
    setup: z.array(z.union([z.string().min(1), SetupStepSchema])).default([]),
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

/**
 * Is each requirement item (AC, tech-scope or expected-result item) built by this change?
 *   implemented · partial · not-found (nothing in this change does it) · conflict (code does something else) ·
 *   elsewhere (belongs to another service/repo of the story) · not-applicable (no code needed, e.g. wording only)
 */
export const IMPLEMENTATION = ["implemented", "partial", "not-found", "conflict", "elsewhere", "not-applicable"] as const;

export const RequirementStatusSchema = z
  .object({
    id: z.string(),
    status: z.enum(IMPLEMENTATION),
    /** Where it is built (file:line) or which service should build it (elsewhere). */
    where: opt(z.string()),
    /** Scope items only: the ACs that already express this item. Empty = the story's ACs don't cover it. */
    coveredByAcs: z.array(z.string()).default([]),
    note: opt(z.string()),
    evidence: z.array(EvidenceSchema).default([]),
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
    requirementStatus: z.array(RequirementStatusSchema).default([]),
    suspicious: z.array(z.object({ file: z.string(), excerpt: z.string(), why: z.string() }).strict()).default([]),
    openQuestions: z.array(z.string()).default([]),
    skipReason: z.string().nullable().default(null),
  })
  .strict();

export type Evidence = z.infer<typeof EvidenceSchema>;
export type SetupStep = z.infer<typeof SetupStepSchema>;
export type Scenario = z.infer<typeof ScenarioSchema>;
export type Change = z.infer<typeof ChangeSchema>;
export type RequirementStatus = z.infer<typeof RequirementStatusSchema>;
export type Decision = z.infer<typeof DecisionSchema>;
export type TestPlan = z.infer<typeof TestPlanSchema>;
export type RiskFactor = (typeof RISK_FACTORS)[number];
export type RiskLevel = "low" | "medium" | "high" | "critical";
