import fs from "node:fs";
import path from "node:path";
import { type TestPlan, TestPlanSchema } from "./schema.js";
import { ruleFor } from "./decide.js";
import { checkWorkflow, normaliseSetup } from "./workflow.js";
import type { ExpectedFile } from "../expected/format.js";

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
  layers?: ("api" | "web" | "mobile")[];
  defaultLayer?: "api" | "web" | "mobile";
  /** The story's expected behaviour (code-blind, reviewed by QA): scenarios cite its ids; only ready ones are tested. */
  expected?: ExpectedFile;
  /** AC-first: every AC needs a scenario, existing coverage, or a stated reason for having none. */
  requireAcCoverage?: boolean;
  /**
   * Story mode (all of the story's changes in one run): every AC is held to that. One service's change: only the ACs it
   * builds or touches are; the rest get a warning (another change may build them).
   */
  storyMode?: boolean;
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
      if (s.layer === "web" || s.layer === "mobile") {
        s.page ??= c.page;
        if (!s.page) errors.push(`${at}: a ${s.layer} scenario needs the ${s.layer === "web" ? 'page it opens ("page": "/orders/new")' : 'screen it opens ("page": "orders/new")'}`);
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
  // Automatability triage: manual or hook requirements say why; manual ones get a manual test card.
  for (const r of plan.requirementStatus) {
    const a = r.automation;
    if (!a) continue;
    if (a.how !== "automated" && !a.reason) errors.push(`requirementStatus ${r.id}: automation "${a.how}" needs a reason`);
    if (a.how === "hook" && !a.hook) errors.push(`requirementStatus ${r.id}: automation "hook" must name the hook the system needs ("hook")`);
    if (a.how === "manual" && !(plan.manualTests ?? []).some((m) => m.requirementIds.includes(r.id))) warnings.push(`requirementStatus ${r.id}: manual, but no manualTests card covers it`);
  }
  for (const m of plan.manualTests ?? []) checkReqIds("manualTests", m.requirementIds);

  if (!ctx.requirementsMissing) {
    for (const id of items) {
      const n = seen.get(id) ?? 0;
      if (n === 0) errors.push(`requirementStatus: ${id} has no implementation status (implemented, partial, not-found, conflict, elsewhere or not-applicable)`);
      if (n > 1) errors.push(`requirementStatus: ${id} appears ${n} times; give exactly one`);
    }
  }

  checkAcCoverage(plan, ctx, errors, warnings);
  return { ok: errors.length === 0, plan, errors, corrections, warnings, rules };
}

/**
 * AC-first: each scenario cites the expected behaviours it proves (ready ones only, of the ACs it names), and every
 * AC gets at least one scenario, existing tests that cover it, or a stated reason for having none.
 */
function checkAcCoverage(plan: TestPlan, ctx: PlanContext, errors: string[], warnings: string[]): void {
  const exp = ctx.expected;
  const live = (exp?.acs ?? []).filter((a) => !a.removed);
  const owner = new Map(live.flatMap((a) => a.behaviours.map((b) => [b.id, { ac: a, b }] as const)));
  const scenarios = plan.decisions.flatMap((d) => d.proposedScenarios.map((s, k) => ({ d, s, at: `decision ${d.changeId} scenario ${k + 1}` })));
  // Only scenarios that get written count as coverage (a scenario under skip or reuse is never implemented).
  const written = scenarios.filter(({ d }) => ["create", "update", "review"].includes(d.decision));
  const cited = new Set<string>();
  for (const { s, at } of scenarios) {
    for (const id of s.behaviourIds) {
      const o = owner.get(id);
      if (!exp) errors.push(`${at}: cites behaviour ${id}, but this story has no expected-behaviour file; leave behaviourIds empty`);
      else if (!o) errors.push(`${at}: behaviour ${id} isn't in expected/${exp.story}.md (known: ${[...owner.keys()].join(", ") || "none"})`);
      else if (!s.requirementIds.includes(o.ac.id)) errors.push(`${at}: behaviour ${id} belongs to ${o.ac.id}; add ${o.ac.id} to the scenario's requirementIds`);
      else if (o.b.state !== "ready") errors.push(`${at}: behaviour ${id} is ${o.b.state}: it isn't tested until QA marks it ready; leave it out`);
      else cited.add(id);
    }
  }
  if (!ctx.requireAcCoverage || ctx.requirementsMissing) return;
  const status = new Map(plan.requirementStatus.map((r) => [r.id, r]));
  // Existing tests count only when one of them is tagged with the AC.
  const taggedWith = (file: string, ac: string) => {
    try {
      return new RegExp(`@ac:[^\\s'"\`]*\\b${ac}\\b`, "i").test(fs.readFileSync(path.resolve(ctx.testRepo, file), "utf8"));
    } catch {
      return false;
    }
  };
  const reused = (ac: string) =>
    plan.decisions.some((d) => ["reuse", "review"].includes(d.decision) && d.coverage === "covered" && plan.changes.find((c) => c.id === d.changeId)?.requirementIds.includes(ac) && d.existingTests.some((f) => taggedWith(f, ac)));
  const touched = new Set([...plan.changes.flatMap((c) => c.requirementIds), ...plan.requirementStatus.filter((r) => ["implemented", "partial", "conflict"].includes(r.status)).map((r) => r.id)]);
  const exempt: string[] = [];
  for (const ac of ctx.acIds) {
    const e = live.find((a) => a.id === ac);
    const ready = (e?.behaviours ?? []).filter((b) => b.state === "ready");
    const r = status.get(ac);
    const mine = written.filter(({ s }) => s.requirementIds.includes(ac));
    if (mine.length) {
      const missed = ready.filter((b) => !cited.has(b.id)).map((b) => b.id);
      if (missed.length) warnings.push(`${ac}: expected behaviour ${missed.join(", ")} has no scenario citing it`);
      continue;
    }
    if (reused(ac)) continue;
    if (r?.automation && r.automation.how !== "automated") continue;
    if (r && ["elsewhere", "not-applicable"].includes(r.status)) continue;
    if (r?.noScenario) continue;
    if (e && (e.untestable || !ready.length)) {
      exempt.push(`${ac} (${e.untestable ? `untestable: ${e.untestable}` : "waiting for the PO's answers"})`);
      continue;
    }
    if (!ctx.storyMode && !touched.has(ac)) {
      warnings.push(`${ac} has no scenario, and this change doesn't build it (another change of the story may): tested once the change that builds it is planned`);
      continue;
    }
    errors.push(
      `${ac} has no scenario${ready.length ? ` for its expected behaviour (${ready.map((b) => b.id).join(", ")})` : ""}: plan one (cite it in requirementIds${ready.length ? " and behaviourIds" : ""}), or give requirementStatus ${ac} a "noScenario" reason (e.g. existing tests that already prove it)`,
    );
  }
  if (exempt.length) warnings.push(`No tests yet for ${exempt.join("; ")}`);
}

/** Decisions that require writing tests. */
export const actionable = (plan: TestPlan) => plan.decisions.filter((d) => ["update", "create", "review"].includes(d.decision));
