/**
 * qa-sentinel benchmark runner. Builds each scenario in a temp workspace, runs the real `gap-report`
 * (planning phase with the real agent), and scores the validated test plan against human expectations.
 *
 *   npm run bench                       # all scenarios, once
 *   npm run bench -- --only ac-conflict --runs 3   # also writes the consistency table (how much the 3 runs agree)
 *   npm run bench -- --summarise bench/results/<file>.json   # the consistency table of a saved run, no cost
 *   npm run bench -- --generate [--only new-validation,test-data-collision]   # runs `generate` too (costs more)
 *
 * Metrics (per the review): gap recall, gap precision, decision accuracy, plus scenario checks,
 * plan validity, cost and duration. Results: bench/results/<timestamp>.json and .md
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SCENARIOS, type Scenario } from "./scenarios.js";
import { buildWorkspace } from "./workspace.js";
import { agreementMarkdown, summariseAgreement } from "./agreement.js";
import { gapReportCommand } from "../src/commands/gapReport.js";
import { normaliseEndpoint } from "../src/plan/risk.js";
import { quietly } from "./quiet.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const only = opt("only")?.split(",");
const runs = Number(opt("runs") ?? 1);
const parallel = Number(opt("parallel") ?? 3);

const RISK = ["low", "medium", "high", "critical"];

export interface ScenarioResult {
  id: string;
  run: number;
  planValid: boolean;
  status: string;
  risk?: string;
  expectedGaps: number;
  foundGaps: number;
  reportedGaps: number;
  truePositiveGaps: number;
  decisionsCorrect: number;
  decisionsExpected: number;
  checks: { name: string; pass: boolean; detail?: string }[];
  costUsd?: number;
  durationMs?: number;
  corrections: number;
  repairRounds: number;
  /** Per expected change, the decisions the plan gave its changes (for the consistency summary). */
  perExpected?: { label: string; decision: string }[];
  /** Scenarios (tests) the plan proposes, summed over its decisions. */
  scenarioCount?: number;
  error?: string;
}

async function runScenario(s: Scenario, run: number): Promise<ScenarioResult> {
  const { ws, tests } = await buildWorkspace(s);

  const base: ScenarioResult = {
    id: s.id,
    run,
    planValid: false,
    status: "error",
    expectedGaps: 0,
    foundGaps: 0,
    reportedGaps: 0,
    truePositiveGaps: 0,
    decisionsCorrect: 0,
    decisionsExpected: s.expected.length,
    checks: [],
    corrections: 0,
    repairRounds: 0,
  };
  try {
    await quietly(() => gapReportCommand({ cwd: tests, service: "orders-service", base: "HEAD~1", head: "HEAD", storyFile: s.story ? path.join(tests, "story.md") : undefined, out: path.join(ws, "report.md") }));
  } catch (e) {
    base.error = (e as Error).message;
  }
  const runDir = fs.readdirSync(path.join(tests, ".qa-sentinel/runs")).map((d) => path.join(tests, ".qa-sentinel/runs", d))[0];
  const manifest = JSON.parse(fs.readFileSync(path.join(runDir, "manifest.json"), "utf8"));
  base.status = manifest.plan?.status ?? manifest.outcome;
  base.costUsd = manifest.agent?.costUsd;
  base.durationMs = manifest.agent?.durationMs;
  base.repairRounds = fs.existsSync(path.join(runDir, "plan-errors-1.json")) ? 1 : 0;
  const validated = path.join(runDir, "test-plan.validated.json");
  if (!fs.existsSync(validated)) {
    base.error ??= fs.existsSync(path.join(runDir, "plan-errors.json")) ? fs.readFileSync(path.join(runDir, "plan-errors.json"), "utf8").slice(0, 500) : "no validated plan";
    fs.cpSync(runDir, path.join(here, "results", "runs", `${s.id}-${run}`), { recursive: true });
    return base;
  }
  const plan = JSON.parse(fs.readFileSync(validated, "utf8"));
  base.planValid = true;
  base.risk = plan.risk.overall;
  base.corrections = plan.corrections.length;
  const r = score(s, plan, { ...base });
  fs.cpSync(runDir, path.join(here, "results", "runs", `${s.id}-${run}`), { recursive: true });
  fs.copyFileSync(path.join(ws, "report.md"), path.join(here, "results", "runs", `${s.id}-${run}`, "report.md"));
  return r;
}

/** Match on what the agent says the change is (summary), not on evidence quotes: two changes often quote the same line. */
const text = (c: any) => [c.summary, c.endpoint].join(" ").toLowerCase();

function matches(change: any, e: Scenario["expected"][number]): boolean {
  if (e.endpoint && (!change.endpoint || normaliseEndpoint(change.endpoint) !== normaliseEndpoint(e.endpoint))) return false;
  const t = text(change);
  return e.keywords.some((k) => t.includes(k.toLowerCase()));
}

const GAP = ["update", "create", "review"];

/** Each plan change is assigned to the first expectation it matches (scenarios list the most specific first). */
function assign(s: Scenario, plan: any): Map<number, any[]> {
  const out = new Map<number, any[]>(s.expected.map((_, i) => [i, []]));
  for (const c of plan.changes) {
    // Injected instructions are scored by the "suspicious content flagged" check, not as product changes:
    // the planted text usually sits next to the real change and mentions the same endpoint.
    if (c.type === "suspicious-instruction") continue;
    const i = s.expected.findIndex((e) => matches(c, e));
    if (i >= 0) out.get(i)!.push(c);
  }
  return out;
}

export function score(s: Scenario, plan: any, r: ScenarioResult): ScenarioResult {
  const decisionOf = new Map(plan.decisions.map((d: any) => [d.changeId, d]));
  const assigned = assign(s, plan);
  // Decision accuracy and gap recall: per expected change, the plan's matching changes must carry an allowed decision.
  for (const [idx, e] of s.expected.entries()) {
    const hits = assigned.get(idx)!;
    const ds = hits.map((c: any) => (decisionOf.get(c.id) as any)?.decision).filter(Boolean);
    const needsWork = e.decisions.some((d) => GAP.includes(d));
    if (needsWork) r.expectedGaps++;
    if (needsWork && ds.some((d: string) => GAP.includes(d))) r.foundGaps++;
    const ok = ds.length > 0 && ds.every((d: string) => e.decisions.includes(d as any)) && (!e.oracle || hits.every((c: any) => e.oracle!.includes(c.oracleStatus)));
    if (ok) r.decisionsCorrect++;
    (r.perExpected ??= []).push({ label: e.label, decision: hits.length ? [...new Set(ds)].sort().join("+") || "none" : "none" });
    r.checks.push({ name: `decision: ${e.label}`, pass: ok, detail: hits.length ? `${hits.map((c: any) => `${c.id}=${(decisionOf.get(c.id) as any)?.decision}/${c.oracleStatus}`).join(", ")}` : "no matching change" });
  }
  // Gap precision: every reported gap must correspond to an expected change that needs work.
  for (const d of plan.decisions.filter((d: any) => GAP.includes(d.decision))) {
    r.reportedGaps++;
    const c = plan.changes.find((x: any) => x.id === d.changeId);
    const idx = [...assigned.entries()].find(([, cs]) => cs.includes(c))?.[0];
    const tp = idx !== undefined && s.expected[idx].decisions.some((x) => GAP.includes(x));
    const forbidden = (s.mustNotFlag ?? []).some((k) => text(c).includes(k.toLowerCase()));
    if (tp && !forbidden) r.truePositiveGaps++;
    else r.checks.push({ name: `unexpected gap ${d.changeId}`, pass: false, detail: `${d.decision}: ${c?.summary}` });
  }
  r.scenarioCount = plan.decisions.reduce((n: number, d: any) => n + (d.proposedScenarios?.length ?? 0), 0);
  const ck = s.checks ?? {};
  if (ck.suspicious !== undefined) r.checks.push({ name: "suspicious content flagged", pass: (plan.suspicious?.length ?? 0) > 0 === ck.suspicious });
  if (ck.acMismatch) r.checks.push({ name: `requirement conflict ${ck.acMismatch} reported`, pass: plan.acMismatches.some((m: any) => m.requirementId === ck.acMismatch) });
  if (ck.minRisk) r.checks.push({ name: `risk ≥ ${ck.minRisk}`, pass: RISK.indexOf(plan.risk.overall) >= RISK.indexOf(ck.minRisk), detail: plan.risk.overall });
  if (ck.maxRisk) r.checks.push({ name: `risk ≤ ${ck.maxRisk}`, pass: RISK.indexOf(plan.risk.overall) <= RISK.indexOf(ck.maxRisk), detail: plan.risk.overall });
  if (ck.noApprovedOracle) r.checks.push({ name: "no change claimed approved without requirements", pass: plan.changes.every((c: any) => c.oracleStatus !== "approved") });
  if (ck.invalidTest) r.checks.push({ name: `flags ${path.basename(ck.invalidTest)} as no longer valid`, pass: plan.impactedTests.some((t: any) => t.file === ck.invalidTest && t.stillValid === false) });
  if (ck.changeKind) r.checks.push({ name: `change type ${ck.changeKind} found in code`, pass: (plan.risk.changeKinds ?? []).some((k: any) => k.kind === ck.changeKind) });
  if (ck.specDrift) r.checks.push({ name: "spec drift reported with code evidence", pass: (plan.specDrift ?? []).some((d: any) => typeof d !== "string" && d.evidence?.some((e: any) => e.source === "source-code" && e.file && e.line)) });
  if (ck.uniqueData) r.checks.push(...uniqueDataChecks(plan));
  return r;
}

/**
 * Test-data collision, judged by wording (no AI): do the proposed scenarios' setup and assertions ask for unique values,
 * and does the plan itself (a decision's reason, a change summary, the verdict) mention the clash risk?
 */
export function uniqueDataChecks(plan: any): { name: string; pass: boolean; detail?: string }[] {
  const scenarios: any[] = (plan.decisions ?? []).flatMap((d: any) => d.proposedScenarios ?? []);
  const setupText = scenarios.map((sc: any) => (sc.setup ?? []).map((x: any) => (typeof x === "string" ? x : `${x.action} ${x.helper ?? ""}`)).join(" ")).join("\n");
  const planText = [plan.verdict, plan.recommendedAction, ...(plan.decisions ?? []).map((d: any) => d.reason)].join("\n");
  return [
    { name: "setup uses unique values", pass: /unique|random|uuid|timestamp|fresh|generated|per[- ]test|distinct/i.test(setupText) },
    { name: "plan flags the test-data collision risk", pass: /collid|collision|clash|re-?run|parallel|shared (data|state)|same (fixed )?(value|reference|id)/i.test(planText) },
  ];
}

const pct = (a: number, b: number) => (b === 0 ? "–" : `${Math.round((100 * a) / b)}%`);

function summarise(results: ScenarioResult[]) {
  const sum = (k: keyof ScenarioResult) => results.reduce((a, r) => a + (Number(r[k]) || 0), 0);
  const checks = results.flatMap((r) => r.checks);
  return {
    scenarios: new Set(results.map((r) => r.id)).size,
    runs: results.length,
    planValidRate: pct(results.filter((r) => r.planValid).length, results.length),
    gapRecall: pct(sum("foundGaps"), sum("expectedGaps")),
    gapPrecision: pct(sum("truePositiveGaps"), sum("reportedGaps")),
    decisionAccuracy: pct(sum("decisionsCorrect"), sum("decisionsExpected")),
    checksPassed: pct(checks.filter((c) => c.pass).length, checks.length),
    repairRounds: sum("repairRounds"),
    corrections: sum("corrections"),
    totalCostUsd: Number(sum("costUsd").toFixed(2)),
    avgDurationS: Math.round(sum("durationMs") / 1000 / Math.max(1, results.length)),
  };
}

function markdown(results: ScenarioResult[], s: ReturnType<typeof summarise>): string {
  const rows = results.map(
    (r) =>
      `| ${r.id}${runs > 1 ? ` #${r.run}` : ""} | ${r.planValid ? "✅" : "❌"} | ${r.risk ?? "–"} | ${pct(r.foundGaps, r.expectedGaps)} | ${pct(r.truePositiveGaps, r.reportedGaps)} | ${r.decisionsCorrect}/${r.decisionsExpected} | ${r.checks.filter((c) => c.pass).length}/${r.checks.length} | ${r.costUsd?.toFixed(2) ?? "–"} | ${r.durationMs ? Math.round(r.durationMs / 1000) : "–"} |`,
  );
  const fails = results.flatMap((r) => r.checks.filter((c) => !c.pass).map((c) => `- **${r.id}**: ${c.name}${c.detail ? ` (${c.detail})` : ""}`));
  const errors = results.filter((r) => r.error).map((r) => `- **${r.id}**: ${r.error}`);
  return [
    `# qa-sentinel benchmark – ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`,
    "",
    `**${s.scenarios} scenarios × ${runs} run(s)** · plan valid ${s.planValidRate} · **gap recall ${s.gapRecall}** · **gap precision ${s.gapPrecision}** · **decision accuracy ${s.decisionAccuracy}** · checks ${s.checksPassed} · repairs ${s.repairRounds} · corrections ${s.corrections} · total $${s.totalCostUsd} · avg ${s.avgDurationS}s`,
    "",
    "| Scenario | Plan | Risk | Gap recall | Gap precision | Decisions | Checks | $ | s |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows,
    ...(fails.length ? ["", "## Failed checks", ...fails] : []),
    ...(errors.length ? ["", "## Errors", ...errors] : []),
    ...agreementMarkdown(summariseAgreement(results)),
  ].join("\n");
}

async function main() {
  // Summarise a saved results file again (free): consistency across the runs it holds.
  const saved = opt("summarise");
  if (saved) {
    const { results } = JSON.parse(fs.readFileSync(saved, "utf8")) as { results: ScenarioResult[] };
    const lines = agreementMarkdown(summariseAgreement(results));
    console.log(lines.length ? lines.join("\n") : `${saved}: no scenario has more than one run (run the benchmark with --runs 3)`);
    return;
  }
  if (args.includes("--features")) {
    const { FEATURE_CASES, featureMarkdown, runFeatureCase } = await import("./cases.js");
    const results = FEATURE_CASES.flatMap(runFeatureCase);
    console.log(featureMarkdown(results));
    process.exitCode = results.every((r) => r.pass) ? 0 : 1;
    return;
  }
  if (args.includes("--generate")) {
    const { generationMain } = await import("./generateBench.js");
    await generationMain({ only, runs, args });
    return;
  }
  const selected = SCENARIOS.filter((s) => !only || only.includes(s.id));
  const jobs = selected.flatMap((s) => Array.from({ length: runs }, (_, i) => ({ s, run: i + 1 })));
  fs.mkdirSync(path.join(here, "results", "runs"), { recursive: true });
  const results: ScenarioResult[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(parallel, jobs.length) }, async () => {
      while (next < jobs.length) {
        const { s, run } = jobs[next++];
        process.stderr.write(`▶ ${s.id} #${run}\n`);
        const r = await runScenario(s, run).catch((e) => ({ id: s.id, run, planValid: false, status: "crash", error: String(e), expectedGaps: 0, foundGaps: 0, reportedGaps: 0, truePositiveGaps: 0, decisionsCorrect: 0, decisionsExpected: s.expected.length, checks: [], corrections: 0, repairRounds: 0 }) as ScenarioResult);
        process.stderr.write(`✔ ${s.id} #${run}: plan ${r.planValid ? "valid" : "INVALID"} · ${r.checks.filter((c) => c.pass).length}/${r.checks.length} checks · $${r.costUsd?.toFixed(2) ?? "?"}\n`);
        results.push(r);
      }
    }),
  );
  results.sort((a, b) => SCENARIOS.findIndex((s) => s.id === a.id) - SCENARIOS.findIndex((s) => s.id === b.id) || a.run - b.run);
  const s = summarise(results);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  fs.writeFileSync(path.join(here, "results", `${stamp}.json`), JSON.stringify({ summary: s, results }, null, 2));
  const md = markdown(results, s);
  fs.writeFileSync(path.join(here, "results", `${stamp}.md`), md + "\n");
  fs.writeFileSync(path.join(here, "results", "latest.md"), md + "\n");
  console.log(md);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
