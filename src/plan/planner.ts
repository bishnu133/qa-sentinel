import { isFeature } from "../requirements.js";
import type { ExpectedFile } from "../expected/format.js";
import fs from "node:fs";
import path from "node:path";
import type { Config, ServiceConfig } from "../config.js";
import type { ChangeSet } from "../git.js";
import { specAt } from "../specs.js";
import { type ContractDiff, breakingEndpoints, contractDiffMarkdown, diffSpecs } from "../analysis/contractDiff.js";
import type { AgentEngine, AgentResult } from "../engines/AgentEngine.js";
import type { RequirementSnapshot } from "../requirements.js";
import { type RunDir, agentEnv, testEnv } from "../run.js";
import { writeKnowledge } from "../kb.js";
import { type PlanValidation, validatePlan } from "./validate.js";
import { type RiskedChange, applyRisk } from "./risk.js";
import type { RiskLevel, TestPlan } from "./schema.js";
import { log } from "../log.js";
import { type ContractCheck, checkContract, contractCheckMarkdown, loadContract, warnContract } from "../contracts.js";
import type { StoryPart } from "../story.js";
import { layers, primaryLayer } from "../layers.js";

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
  /** The story's expected behaviour (expected/<STORY>.md), when it has one. */
  expected?: ExpectedFile;
  /** Story mode: every service part of the story (service/repo/cs above are the combined view). */
  parts?: StoryPart[];
  /** Story-scoped generation: the ACs to plan now, and the ones that wait (with what they wait for). */
  acScope?: string[];
  heldAcs?: Map<string, string>;
  /** Spec files that open QA agent merge requests add (path → "!12"). */
  addedByOpenMrs?: Map<string, string>;
}

export const oracleOf = (req: RequirementSnapshot): "provided" | "ambiguous" | "missing" =>
  req.source === "none" ? "missing" : req.acceptanceCriteria.length ? "provided" : "ambiguous";

/**
 * Deterministic contract diff for the service's OpenAPI spec, saved into the run dir. Spec-first services (`contract`)
 * also get their implemented spec at head checked against the agreed one; the agreed spec is saved for the agents.
 */
export async function computeContractDiff(i: Pick<PlanInput, "c" | "service" | "repo" | "cs" | "run" | "parts"> & { cwd?: string; req?: Pick<RequirementSnapshot, "storyKey"> }): Promise<ContractDiff> {
  const env = testEnv(i.c);
  /** The spec at base and head; a generated head spec is saved in the run dir so the agent can read it. */
  const specs = async (repo: string, cs: ChangeSet, s: ServiceConfig) => {
    const o = { env, timeoutMs: (s.openapiCommandTimeoutSeconds ?? 180) * 1000 };
    const base = await specAt(repo, cs.base, s, o);
    const head = await specAt(repo, cs.head, s, o);
    if (s.openapiCommand && head && s.openapi) fs.writeFileSync(path.join(i.run.dir, `spec-${s.name}${path.extname(s.openapi) || ".yaml"}`), head);
    return { d: diffSpecs(base, head), head };
  };
  const agreedFor = async (s: ServiceConfig, head: string | undefined): Promise<ContractCheck | undefined> => {
    if (!s.contract) return undefined;
    const { contract, reason } = await loadContract(i.c, s.contract, { cwd: i.cwd ?? process.cwd(), storyKey: i.req?.storyKey, env: process.env });
    warnContract(s.name, reason);
    if (contract) fs.writeFileSync(path.join(i.run.dir, `agreed-spec-${s.name}${/^\s*[{[]/.test(contract.text) ? ".json" : ".yaml"}`), contract.text);
    return checkContract(s.name, contract, head, reason);
  };
  const finish = (d: ContractDiff, md: string): ContractDiff => {
    let out = md;
    if (d.agreed?.length) {
      const touched = new Set(d.changes.map((x) => x.endpoint));
      fs.writeFileSync(path.join(i.run.dir, "contract-check.json"), JSON.stringify(d.agreed, null, 2));
      fs.writeFileSync(path.join(i.run.dir, "contract-check.md"), contractCheckMarkdown(d.agreed) + "\n");
      out += "\n\n" + contractCheckMarkdown(d.agreed, touched);
    }
    fs.writeFileSync(path.join(i.run.dir, "contract-diff.json"), JSON.stringify(d, null, 2));
    fs.writeFileSync(path.join(i.run.dir, "contract-diff.md"), out + "\n");
    return d;
  };
  if (i.parts?.length) {
    // Story mode: one contract diff per service with a spec, merged; the markdown keeps a section per service.
    const each = await Promise.all(
      i.parts.map(async (p) => {
        const r = p.service.openapi ? await specs(p.repo, p.cs, p.service) : { d: diffSpecs(undefined, undefined), head: undefined };
        return { p, d: r.d, agreed: await agreedFor(p.service, r.head) };
      }),
    );
    const compared = each.filter((x) => x.d.status !== "no-spec");
    const agreed = each.flatMap((x) => (x.agreed ? [x.agreed] : []));
    const d: ContractDiff = {
      status: compared.find((x) => x.d.status === "compared")?.d.status ?? compared[0]?.d.status ?? "no-spec",
      changes: compared.flatMap((x) => x.d.changes),
      note: compared.length ? undefined : "no service in this story has an OpenAPI spec",
      ...(agreed.length ? { agreed } : {}),
    };
    return finish(d, compared.length ? compared.map((x) => `#### ${x.p.service.name}\n${contractDiffMarkdown(x.d, x.p.service.openapi)}`).join("\n\n") : contractDiffMarkdown(d));
  }
  const spec = i.service.openapi;
  const r = spec ? await specs(i.repo, i.cs, i.service) : { d: diffSpecs(undefined, undefined), head: undefined };
  const agreed = await agreedFor(i.service, r.head);
  const d: ContractDiff = agreed ? { ...r.d, agreed: [agreed] } : r.d;
  return finish(d, contractDiffMarkdown(d, spec));
}

/**
 * Planning phase shared by gap-report and generate: contract diff (code) → plan (agent, writes only
 * test-plan.json) → schema + cross-field validation (code, one repair round) → risk (code).
 */
export async function planChange(i: PlanInput): Promise<PlanOutcome> {
  const { c, run } = i;
  const contract = await computeContractDiff(i);
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
        ...(i.parts?.length
          ? {
              story: i.req.storyKey,
              // Story mode: the change spans these services; change.diff has a section per service and changedFiles are "service/path".
              services: i.parts.map((p) => ({ name: p.service.name, path: p.service.path, kind: p.service.kind, openapi: p.service.openapi, base: p.cs.base, head: p.cs.head, merged: p.merged, changedFiles: p.relevant })),
            }
          : {}),
        // Test layers in this repo and the one this service is tested on first (web for front ends).
        testLayers: layers(c).map((l) => ({ layer: l.layer, dir: l.dir, helpersDir: l.helpersDir, runCommand: l.runCommand })),
        serviceLayer: primaryLayer(c, i.service),
        ...(i.service.routes.length ? { serviceRoutes: i.service.routes } : {}),
        testData: c.testData,
        ...(c.tests.hooks.length ? { testHooks: c.tests.hooks } : {}),
        acceptanceCriteriaIds: i.req.acceptanceCriteria.map((a) => a.id),
        ...(i.acScope ? { acScope: i.acScope } : {}),
        ...(i.heldAcs?.size ? { heldAcs: Object.fromEntries(i.heldAcs) } : {}),
        scopeItemIds: (i.req.scopeItems ?? []).map((x) => x.id),
        contractDiff: `${run.rel}/contract-diff.md`,
        // Spec-first: the agreed spec is the source of truth for the API; contract-check.md lists where the code differs.
        ...(contract.agreed?.length
          ? {
              agreedSpecs: fs.readdirSync(run.dir).filter((f) => f.startsWith("agreed-spec-")).map((f) => `${run.rel}/${f}`),
              contractCheck: `${run.rel}/contract-check.md`,
            }
          : {}),
        // Specs generated at build time aren't in the service repo: the head version is in the run dir.
        ...(() => {
          const files = fs.readdirSync(run.dir).filter((f) => f.startsWith("spec-"));
          return files.length ? { generatedSpecs: files.map((f) => `${run.rel}/${f}`) } : {};
        })(),
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
    readOnlyDirs: [...new Set([i.repo, ...(i.parts ?? []).map((p) => p.repo), ...c.workspace.services.filter((s) => i.service.dependsOn.includes(s.name)).map((s) => path.resolve(i.cwd, s.path))])].filter((d) => fs.existsSync(d)),
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
      ...(i.expected && typeof i.context?.expectedBehaviour === "string" ? [`Expected behaviour (written from the story alone, before the code was read; QA reviews it in the merge request; the oracle for values): ${i.context.expectedBehaviour}. Plan scenarios for its ready behaviours and cite them in behaviourIds.`] : []),
      ...(i.acScope ? [`Plan only for the ACs in acScope (context.json). ACs in heldAcs wait for other services or for their status: give them no scenario and no requirementStatus, and do not cite them anywhere.`] : []),
      ...(typeof i.context?.openAgentMrs === "string" ? [`Other open QA agent merge requests already add tests: ${i.context.openAgentMrs}. Do not plan the same tests again; for a "create" decision name the new spec file in targetFile.`] : []),
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
    scopeIds: (i.req.scopeItems ?? []).map((x) => x.id),
    requirementsMissing: i.req.source === "none",
    testRepo: i.cwd,
    serviceRepo: i.repo,
    serviceRepos: i.parts?.length ? Object.fromEntries(i.parts.map((p) => [p.service.name, p.repo])) : undefined,
    layers: layers(c).map((l) => l.layer),
    defaultLayer: primaryLayer(c, i.service),
    expected: i.expected,
    requireAcCoverage: i.context?.kind !== "backfill" && i.req.acceptanceCriteria.length > 0 && isFeature(c, i.req),
    storyMode: (i.parts?.length ?? 0) > 0,
    ...(i.acScope ? { acScope: i.acScope } : {}),
    ...(i.heldAcs ? { heldAcs: i.heldAcs } : {}),
    ...(i.addedByOpenMrs ? { addedByOpenMrs: i.addedByOpenMrs } : {}),
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

  const crossService = (i.parts?.length ?? 0) > 1 || c.workspace.services.some((s) => s.dependsOn.includes(i.service.name));
  const risked = applyRisk(validation.plan, { breakingEndpoints: breakingEndpoints(contract), crossService });
  fs.writeFileSync(path.join(run.dir, "test-plan.validated.json"), JSON.stringify({ ...validation.plan, risk: { overall: risked.overall, changes: risked.changes.map((x) => ({ id: x.id, risk: x.risk, factors: x.factors })) }, corrections: validation.corrections, warnings: validation.warnings }, null, 2));
  return { status: "valid", plan: validation.plan, risked, contract, validation, runs };
}
