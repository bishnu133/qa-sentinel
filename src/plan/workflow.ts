import type { Scenario, SetupStep } from "./schema.js";

/**
 * The cross-platform workflow planner, kept small: each scenario's preconditions are a dependency graph of setup
 * steps, checked in code against the test-data policy:
 *   - API or a test-data service first;
 *   - UI only for a web test, and only with a reason (no safe programmatic route);
 *   - DB helpers only with a reason, and only on isolated environments.
 * A web test then does exactly one thing through the browser: the behaviour under test.
 */

/** Plain-string steps (older plans, API scenarios) become API steps in the order given. */
export function normaliseSetup(setup: Scenario["setup"]): SetupStep[] {
  return setup.map((s, i) => (typeof s === "string" ? { id: `s${i + 1}`, via: "api", action: s, dependsOn: i ? [`s${i}`] : [] } : s));
}

export interface WorkflowCheck {
  errors: string[];
  warnings: string[];
  /** Steps in an order that respects dependsOn (empty when there is a cycle). */
  order: SetupStep[];
}

export function checkWorkflow(steps: SetupStep[], layer: "api" | "web", where: string): WorkflowCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  const ids = new Set<string>();
  for (const s of steps) {
    if (ids.has(s.id)) errors.push(`${where}: duplicate setup step id ${s.id}`);
    ids.add(s.id);
  }
  for (const s of steps) {
    for (const d of s.dependsOn) if (!ids.has(d)) errors.push(`${where}: setup step ${s.id} depends on unknown step ${d}`);
    if (s.dependsOn.includes(s.id)) errors.push(`${where}: setup step ${s.id} depends on itself`);
    if (s.via === "ui") {
      if (layer !== "web") errors.push(`${where}: setup step ${s.id} goes through the UI, but this is an ${layer} test; create the data through the API`);
      else if (!s.why) errors.push(`${where}: setup step ${s.id} goes through the UI; test data is created through the API unless there is no safe programmatic route (say why in "why", or use an API helper)`);
      else warnings.push(`${where}: setup step ${s.id} uses the UI (${s.why})`);
    }
    if (s.via === "db-helper") {
      if (!s.why) errors.push(`${where}: setup step ${s.id} writes to the database; only documented helpers on isolated environments may do that (say why in "why")`);
      else warnings.push(`${where}: setup step ${s.id} uses a DB helper: isolated environments only`);
    }
  }
  const order = topoOrder(steps);
  if (steps.length && !order.length) errors.push(`${where}: setup steps have a dependency cycle`);
  return { errors, warnings, order };
}

/** Kahn's algorithm, keeping the given order among independent steps. Empty on a cycle or unknown deps. */
export function topoOrder(steps: SetupStep[]): SetupStep[] {
  const byId = new Map(steps.map((s) => [s.id, s]));
  if (steps.some((s) => s.dependsOn.some((d) => !byId.has(d)))) return [];
  const done = new Set<string>();
  const out: SetupStep[] = [];
  while (out.length < steps.length) {
    const next = steps.find((s) => !done.has(s.id) && s.dependsOn.every((d) => done.has(d)));
    if (!next) return [];
    done.add(next.id);
    out.push(next);
  }
  return out;
}

/** One line per scenario for reports: "s1 create an order (api) → s2 authorise it (api) → web: /orders/:id". */
export function workflowLine(sc: Pick<Scenario, "setup" | "layer" | "page">): string {
  const steps = topoOrder(normaliseSetup(sc.setup));
  const parts = steps.map((s) => `${s.action} _(${s.via}${s.helper ? `: ${s.helper}` : ""})_`);
  if (sc.layer === "web") parts.push(`**web**${sc.page ? ` \`${sc.page}\`` : ""}`);
  return parts.join(" → ");
}
