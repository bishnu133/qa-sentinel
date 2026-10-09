import fs from "node:fs";
import path from "node:path";
import { type TestPlan, TestPlanSchema } from "./schema.js";

export interface PlanContext {
  /** AC ids from the requirement snapshot (AC-1, AC-2, …). Empty when none were parsed. */
  acIds: string[];
  /** True when no requirements were found at all. */
  requirementsMissing: boolean;
  testRepo: string;
  serviceRepo: string;
}

export interface PlanValidation {
  ok: boolean;
  plan?: TestPlan;
  /** Must be fixed by the agent; the plan is rejected. */
  errors: string[];
  /** Safety rewrites qa-sentinel applied itself (e.g. a conflicting oracle forced to `review`). */
  corrections: string[];
  /** Non-blocking oddities worth showing a reviewer. */
  warnings: string[];
}

const exists = (root: string, f: string) => fs.existsSync(path.resolve(root, f));

/**
 * Schema + cross-field validation. Logical contradictions are errors (the agent gets one repair round);
 * the one safety rule (conflicting oracle ⇒ human review) is corrected, never trusted to the model.
 */
export function validatePlan(raw: unknown, ctx: PlanContext): PlanValidation {
  const errors: string[] = [];
  const corrections: string[] = [];
  const warnings: string[] = [];

  const parsed = TestPlanSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
      corrections,
      warnings,
    };
  }
  const plan: TestPlan = structuredClone(parsed.data);

  const ids = new Set<string>();
  for (const c of plan.changes) {
    if (ids.has(c.id)) errors.push(`changes: duplicate id ${c.id}`);
    ids.add(c.id);
  }
  const byId = new Map(plan.changes.map((c) => [c.id, c]));
  const acSet = new Set(ctx.acIds);
  const checkReqIds = (where: string, reqIds: string[]) => {
    if (!reqIds.length) return;
    if (ctx.requirementsMissing) errors.push(`${where}: cites ${reqIds.join(", ")} but no requirements were provided; leave requirementIds empty`);
    else if (acSet.size) for (const r of reqIds) if (!acSet.has(r)) errors.push(`${where}: unknown requirement id ${r} (known: ${[...acSet].join(", ")})`);
  };

  for (const c of plan.changes) {
    checkReqIds(`change ${c.id}`, c.requirementIds);
    if (c.type === "suspicious-instruction" && c.observable) errors.push(`change ${c.id}: a suspicious instruction is not an observable behaviour change`);
    if (c.type === "internal" && c.observable) warnings.push(`change ${c.id} is typed internal but marked observable`);
    if (c.observable && !c.riskFactors.length) errors.push(`change ${c.id}: an observable change needs at least one risk factor`);
    if (ctx.requirementsMissing && c.oracleStatus === "approved") errors.push(`change ${c.id}: oracle cannot be "approved" when no requirements were provided`);
    for (const e of c.evidence) {
      if ((e.source === "source-code" || e.source === "openapi") && e.file && !exists(ctx.serviceRepo, e.file)) {
        warnings.push(`change ${c.id}: evidence file not found in service repo: ${e.file}`);
      }
    }
  }

  const decided = new Map<string, number>();
  for (const d of plan.decisions) {
    const c = byId.get(d.changeId);
    const where = `decision for ${d.changeId}`;
    if (!c) {
      errors.push(`${where}: no change with that id`);
      continue;
    }
    decided.set(d.changeId, (decided.get(d.changeId) ?? 0) + 1);

    // Safety rule, enforced in code: a requirement conflict always goes to a human.
    if (c.oracleStatus === "conflicting" && d.decision !== "review") {
      corrections.push(`${where}: decision "${d.decision}" changed to "review" because the oracle is conflicting`);
      d.decision = "review";
    }

    switch (d.decision) {
      case "skip":
        if (c.observable && c.type !== "internal") errors.push(`${where}: "skip" is only for non-observable or internal changes`);
        if (!d.evidence.length) errors.push(`${where}: "skip" needs evidence that no verification is needed`);
        break;
      case "reuse":
        if (!d.existingTests.length) errors.push(`${where}: "reuse" must name the existing tests to run`);
        if (d.coverage !== "covered") errors.push(`${where}: "reuse" requires coverage "covered" (got "${d.coverage}")`);
        break;
      case "update":
        if (!d.existingTests.length) errors.push(`${where}: "update" must name the spec(s) to change`);
        if (!d.proposedScenarios.length) errors.push(`${where}: "update" needs at least one proposed scenario`);
        break;
      case "create":
        if (!d.proposedScenarios.length) errors.push(`${where}: "create" needs at least one proposed scenario`);
        break;
      case "review":
        if (!d.proposedScenarios.length && c.oracleStatus === "conflicting") {
          warnings.push(`${where}: review without a proposed scenario; the requirement-side test will not be written`);
        }
        break;
    }
    const skipOk = d.decision === "skip" && (!c.observable || c.type === "internal");
    if (d.coverage === "covered" && !["reuse", "review"].includes(d.decision) && !skipOk) {
      errors.push(`${where}: coverage is "covered" so the decision should be "reuse" (got "${d.decision}")`);
    }
    if (d.coverage === "unknown" && d.decision === "reuse") errors.push(`${where}: coverage "unknown" cannot be reused; prove coverage or update/create`);
    for (const t of d.existingTests) if (!exists(ctx.testRepo, t)) errors.push(`${where}: existing test not found: ${t}`);
    d.proposedScenarios.forEach((s, i) => checkReqIds(`${where} scenario ${i + 1}`, s.requirementIds));
  }

  for (const c of plan.changes) {
    const n = decided.get(c.id) ?? 0;
    if (c.observable && n === 0) errors.push(`change ${c.id}: observable change has no decision`);
    if (n > 1) errors.push(`change ${c.id}: has ${n} decisions; give exactly one`);
  }
  for (const t of plan.impactedTests) if (!exists(ctx.testRepo, t.file)) errors.push(`impactedTests: not found: ${t.file}`);
  if (plan.skipReason && plan.changes.some((c) => c.observable)) errors.push("skipReason is set but there are observable changes");
  for (const m of plan.acMismatches) if (m.requirementId) checkReqIds("acMismatches", [m.requirementId]);

  return { ok: errors.length === 0, plan, errors, corrections, warnings };
}

/** Decisions that require writing tests. */
export const actionable = (plan: TestPlan) => plan.decisions.filter((d) => ["update", "create", "review"].includes(d.decision));
