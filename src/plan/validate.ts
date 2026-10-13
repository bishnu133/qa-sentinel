import fs from "node:fs";
import path from "node:path";
import { type TestPlan, TestPlanSchema } from "./schema.js";
import { ruleFor } from "./decide.js";
import { checkWorkflow, normaliseSetup } from "./workflow.js";

export interface PlanContext {
  /** AC ids from the requirement snapshot (AC-1, AC-2, …). Empty when none were parsed. */
  acIds: string[];
  /** Scope item ids (TS-1, ER-1, …): citable like ACs, and checked for implementation status. */
  scopeIds?: string[];
  /** True when no requirements were found at all. */
  requirementsMissing: boolean;
  testRepo: string;
  serviceRepo: string;
  /** Story mode: every service repo, by service name (evidence may be "service/path" or a path in any of them). */
  serviceRepos?: Record<string, string>;
  /** Enabled test layers (default: api only) and the layer scenarios default to (the service's layer). */
  layers?: ("api" | "web")[];
  defaultLayer?: "api" | "web";
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
  /** The decision-engine rule that applied to each change's decision (changeId → rule). */
  rules: Record<string, string>;
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
  const rules: Record<string, string> = {};

  const parsed = TestPlanSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
      corrections,
      warnings,
      rules,
    };
  }
  const plan: TestPlan = structuredClone(parsed.data);

  const ids = new Set<string>();
  for (const c of plan.changes) {
    if (ids.has(c.id)) errors.push(`changes: duplicate id ${c.id}`);
    ids.add(c.id);
  }
  const byId = new Map(plan.changes.map((c) => [c.id, c]));
  const acSet = new Set([...ctx.acIds, ...(ctx.scopeIds ?? [])]);
  const checkReqIds = (where: string, reqIds: string[]) => {
    if (!reqIds.length) return;
    if (ctx.requirementsMissing) errors.push(`${where}: cites ${reqIds.join(", ")} but no requirements were provided; leave requirementIds empty`);
    else if (acSet.size) for (const r of reqIds) if (!acSet.has(r)) errors.push(`${where}: unknown requirement id ${r} (known: ${[...acSet].join(", ")})`);
  };

  for (const c of plan.changes) {
    checkReqIds(`change ${c.id}`, c.requirementIds);
    if (c.type === "suspicious-instruction" && c.observable) errors.push(`change ${c.id}: a suspicious instruction is not an observable behaviour change`);
    if (c.type === "internal" && c.observable) {
      // An internal change has no observable behaviour by definition; don't let it raise risk or demand new tests.
      corrections.push(`change ${c.id}: typed "internal" so marked non-observable`);
      c.observable = false;
    }
    if (c.observable && !c.riskFactors.length) errors.push(`change ${c.id}: an observable change needs at least one risk factor`);
    if (ctx.requirementsMissing && c.oracleStatus === "approved") errors.push(`change ${c.id}: oracle cannot be "approved" when no requirements were provided`);
    for (const e of c.evidence) {
      const inAnyRepo = (f: string) =>
        exists(ctx.serviceRepo, f) ||
        Object.entries(ctx.serviceRepos ?? {}).some(([name, root]) => exists(root, f) || (f.startsWith(`${name}/`) && exists(root, f.slice(name.length + 1))));
      if ((e.source === "source-code" || e.source === "openapi") && e.file && !inAnyRepo(e.file)) {
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

    // The decision engine (decide.ts): safety rules are corrected in code, the rest are errors to repair.
    const rule = ruleFor(c, d);
    rules[d.changeId] = rule.rule;
    if (!rule.allowed.includes(d.decision)) {
      if (rule.safety) {
        const because = c.type === "suspicious-instruction" ? "the change is a suspicious instruction" : `the oracle is ${c.oracleStatus}`;
        corrections.push(`${where}: decision "${d.decision}" changed to "${rule.fallback}" because ${because}`);
        if (rule.fallback === "skip" && !d.evidence.length) d.evidence = c.evidence.slice(0, 3);
        d.decision = rule.fallback;
      } else if (c.observable && c.type !== "internal") {
        errors.push(`${where}: decision "${d.decision}" does not fit the rule "${rule.rule}"; use ${rule.allowed.map((a) => `"${a}"`).join(" or ")}`);
      }
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
        if (c.type === "internal") errors.push(`${where}: an internal change needs no new tests; use "reuse" (existing tests) or "skip"`);
        if (!d.existingTests.length) errors.push(`${where}: "update" must name the spec(s) to change`);
        if (!d.proposedScenarios.length) errors.push(`${where}: "update" needs at least one proposed scenario`);
        break;
      case "create":
        if (c.type === "internal") errors.push(`${where}: an internal change needs no new tests; use "reuse" (existing tests) or "skip"`);
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
    d.proposedScenarios.forEach((s, i) => {
      const at = `${where} scenario ${i + 1}`;
      checkReqIds(at, s.requirementIds);
      // Workflow planner: the layer that proves it, its page, and its setup graph checked against the data policy.
      s.layer ??= ctx.defaultLayer ?? "api";
      if (!(ctx.layers ?? ["api"]).includes(s.layer)) errors.push(`${at}: layer "${s.layer}" is not enabled in this project (enabled: ${(ctx.layers ?? ["api"]).join(", ")})`);
      if (s.layer === "web") {
        s.page ??= c.page;
        if (!s.page) errors.push(`${at}: a web scenario needs the page it opens ("page": "/orders/new")`);
      }
      const steps = normaliseSetup(s.setup);
      const wf = checkWorkflow(steps, s.layer, at);
      errors.push(...wf.errors);
      warnings.push(...wf.warnings);
      s.setup = steps;
    });
  }

  for (const c of plan.changes) {
    const n = decided.get(c.id) ?? 0;
    if (c.observable && n === 0) errors.push(`change ${c.id}: observable change has no decision`);
    if (n > 1) errors.push(`change ${c.id}: has ${n} decisions; give exactly one`);
  }
  for (const t of plan.impactedTests) if (!exists(ctx.testRepo, t.file)) errors.push(`impactedTests: not found: ${t.file}`);
  if (plan.skipReason && plan.changes.some((c) => c.observable)) errors.push("skipReason is set but there are observable changes");
  for (const m of plan.acMismatches) if (m.requirementId) checkReqIds("acMismatches", [m.requirementId]);

  // Is the story built? Every AC and scope item gets exactly one implementation status, backed by evidence.
  const items = [...ctx.acIds, ...(ctx.scopeIds ?? [])];
  const seen = new Map<string, number>();
  for (const r of plan.requirementStatus) {
    const where = `requirementStatus ${r.id}`;
    if (!acSet.has(r.id)) errors.push(`${where}: unknown requirement id (known: ${items.join(", ") || "none"})`);
    seen.set(r.id, (seen.get(r.id) ?? 0) + 1);
    if (["implemented", "partial", "conflict"].includes(r.status) && !r.evidence.length) errors.push(`${where}: "${r.status}" needs evidence (the code that does it)`);
    if (r.status === "elsewhere" && !r.where) errors.push(`${where}: "elsewhere" must say which service or repo should build it ("where")`);
    for (const a of r.coveredByAcs) if (!ctx.acIds.includes(a)) errors.push(`${where}: coveredByAcs cites ${a}, which is not an AC`);
    if (r.status === "conflict" && !plan.acMismatches.some((m) => m.requirementId === r.id) && !plan.changes.some((ch) => ch.oracleStatus === "conflicting" && ch.requirementIds.includes(r.id)))
      warnings.push(`${where}: marked "conflict" but no acMismatch or conflicting change cites it`);
  }
  if (!ctx.requirementsMissing) {
    for (const id of items) {
      const n = seen.get(id) ?? 0;
      if (n === 0) errors.push(`requirementStatus: ${id} has no implementation status (implemented, partial, not-found, conflict, elsewhere or not-applicable)`);
      if (n > 1) errors.push(`requirementStatus: ${id} appears ${n} times; give exactly one`);
    }
  }

  return { ok: errors.length === 0, plan, errors, corrections, warnings, rules };
}

/** Decisions that require writing tests. */
export const actionable = (plan: TestPlan) => plan.decisions.filter((d) => ["update", "create", "review"].includes(d.decision));
