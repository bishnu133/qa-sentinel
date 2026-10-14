import fs from "node:fs";
import path from "node:path";
import type { Config, ServiceConfig } from "../config.js";
import type { ChangeSet } from "../git.js";
import { showFile } from "../git.js";
import { type ContractDiff, breakingEndpoints, contractDiffMarkdown, diffSpecs } from "../analysis/contractDiff.js";
import type { AgentEngine, AgentResult } from "../engines/AgentEngine.js";
import type { RequirementSnapshot } from "../requirements.js";
import { type RunDir, agentEnv } from "../run.js";
import { writeKnowledge } from "../kb.js";
import { type PlanValidation, validatePlan } from "./validate.js";
import { type RiskedChange, applyRisk } from "./risk.js";
import type { RiskLevel, TestPlan } from "./schema.js";
import { log } from "../log.js";

export interface PlanOutcome {
  status: "valid" | "invalid" | "agent-failed" | "dry-run";
  plan?: TestPlan;
  risked?: { changes: RiskedChange[]; overall: RiskLevel };
  contract: ContractDiff;
  validation?: PlanValidation;
  runs: AgentResult[];
  message?: string;
}

export interface PlanInput {
  cwd: string;
  c: Config;
  service: ServiceConfig;
  repo: string;
  cs: ChangeSet;
  relevant: string[];
  req: RequirementSnapshot;
  run: RunDir;
  engine: AgentEngine;
  dryRun?: boolean;
  /** Extra context for the agents, written into context.json (e.g. kind, allowed write paths). */
  context?: Record<string, unknown>;
}

export const oracleOf = (req: RequirementSnapshot): "provided" | "ambiguous" | "missing" =>
  req.source === "none" ? "missing" : req.acceptanceCriteria.length ? "provided" : "ambiguous";

/** Deterministic contract diff for the service's OpenAPI spec, saved into the run dir. */
export function computeContractDiff(i: Pick<PlanInput, "service" | "repo" | "cs" | "run">): ContractDiff {
  const spec = i.service.openapi;
  const d = spec ? diffSpecs(showFile(i.repo, i.cs.base, spec), showFile(i.repo, i.cs.head, spec)) : diffSpecs(undefined, undefined);
  fs.writeFileSync(path.join(i.run.dir, "contract-diff.json"), JSON.stringify(d, null, 2));
  fs.writeFileSync(path.join(i.run.dir, "contract-diff.md"), contractDiffMarkdown(d, spec) + "\n");
  return d;
}

/**
 * Planning phase shared by gap-report and generate: contract diff (code) → plan (agent, writes only
 * test-plan.json) → schema + cross-field validation (code, one repair round) → risk (code).
 */
export async function planChange(i: PlanInput): Promise<PlanOutcome> {
  const { c, run } = i;
  const contract = computeContractDiff(i);
  const planRel = `${run.rel}/test-plan.json`;
  const planAbs = path.join(i.cwd, planRel);
  const oracle = oracleOf(i.req);
  const knowledge = writeKnowledge(i.cwd, c, run.dir, run.rel);
  fs.writeFileSync(
    path.join(run.dir, "context.json"),
    JSON.stringify(
      {
        service: i.service,
        serviceRepo: i.service.path,
        base: i.cs.base,
        head: i.cs.head,
        changedFiles: i.relevant,
        oracle,
        acceptanceCriteriaIds: i.req.acceptanceCriteria.map((a) => a.id),
        contractDiff: `${run.rel}/contract-diff.md`,
        ...(knowledge ? { knowledge } : {}),
        planPath: planRel,
        ...i.context,
      },
      null,
      2,
    ),
  );

  const base = {
    cwd: i.cwd,
    // Dependency services are readable when checked out alongside (locally); in CI they may not exist.
    readOnlyDirs: [i.repo, ...c.workspace.services.filter((s) => i.service.dependsOn.includes(s.name)).map((s) => path.resolve(i.cwd, s.path))].filter((d) => fs.existsSync(d)),
    write: { allowed: [planRel], blocked: [] },
    bash: [],
    env: agentEnv(c),
    model: c.agent.model,
    dryRun: i.dryRun,
    timeoutMs: c.agent.timeoutMinutes.gapReport * 60_000,
  };
  const runs: AgentResult[] = [];
  const first = await i.engine.run({
    ...base,
    kind: "plan",
    prompt: [
      "Use the qa-plan skill.",
      `Run context: ${run.rel}/context.json, diff: ${run.rel}/change.diff, story: ${run.rel}/story.md, computed contract diff: ${run.rel}/contract-diff.md.`,
      ...(knowledge ? [`Team domain rules: ${knowledge}. They rank after the story and the API contract as an oracle; cite them as evidence source "domain-rule".`] : []),
      `Write the plan as JSON to ${planRel}. That is the only file you may write. Then answer "done".`,
    ].join("\n"),
    maxTurns: c.agent.maxTurns.gapReport,
    maxBudgetUsd: c.agent.maxBudgetUsd.gapReport,
  });
  runs.push(first);
  if (i.dryRun) return { status: "dry-run", contract, runs };
  if (!first.ok) return { status: "agent-failed", contract, runs, message: `${first.status}: ${first.result.slice(0, 300)}` };

  const ctx = {
    acIds: i.req.acceptanceCriteria.map((a) => a.id),
    requirementsMissing: i.req.source === "none",
    testRepo: i.cwd,
    serviceRepo: i.repo,
  };
  const read = () => {
    try {
      return JSON.parse(fs.readFileSync(planAbs, "utf8"));
    } catch (e) {
      return { __error: fs.existsSync(planAbs) ? `test-plan.json is not valid JSON: ${(e as Error).message}` : "test-plan.json was not written" };
    }
  };
  const check = (raw: any): PlanValidation => (raw?.__error ? { ok: false, errors: [raw.__error], corrections: [], warnings: [], rules: {} } : validatePlan(raw, ctx));

  let validation = check(read());
  if (!validation.ok) {
    log.warn(`plan failed validation (${validation.errors.length} issue(s)); one repair round`);
    fs.writeFileSync(path.join(run.dir, "plan-errors-1.json"), JSON.stringify(validation.errors, null, 2));
    const repair = await i.engine.run({
      ...base,
      kind: "repair-plan",
      prompt: [
        "Use the qa-plan skill.",
        `The plan at ${planRel} failed qa-sentinel's validation. Re-read the schema and "Shapes of the list entries" in .claude/skills/qa-plan/SKILL.md, then fix the file so every check passes, keeping correct content unchanged:`,
        ...validation.errors.map((e) => `- ${e}`),
        "Then answer \"done\".",
      ].join("\n"),
      maxTurns: 15,
      maxBudgetUsd: c.agent.maxBudgetUsd.gapReport,
    });
    runs.push(repair);
    validation = check(read());
  }
  if (!validation.ok || !validation.plan) {
    fs.writeFileSync(path.join(run.dir, "plan-errors.json"), JSON.stringify(validation.errors, null, 2));
    return { status: "invalid", contract, validation, runs, message: validation.errors.slice(0, 8).join("; ") };
  }

  const crossService = c.workspace.services.some((s) => s.dependsOn.includes(i.service.name));
  const risked = applyRisk(validation.plan, { breakingEndpoints: breakingEndpoints(contract), crossService });
  fs.writeFileSync(path.join(run.dir, "test-plan.validated.json"), JSON.stringify({ ...validation.plan, risk: { overall: risked.overall, changes: risked.changes.map((x) => ({ id: x.id, risk: x.risk, factors: x.factors })) }, corrections: validation.corrections, warnings: validation.warnings }, null, 2));
  return { status: "valid", plan: validation.plan, risked, contract, validation, runs };
}
