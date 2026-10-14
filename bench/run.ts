/**
 * qa-sentinel benchmark runner. Builds each scenario in a temp workspace, runs the real `gap-report`
 * (planning phase with the real agent), and scores the validated test plan against human expectations.
 *
 *   npm run bench                       # all scenarios, once
 *   npm run bench -- --only ac-conflict --runs 3
 *
 * Metrics (per the review): gap recall, gap precision, decision accuracy, plus scenario checks,
 * plan validity, cost and duration. Results: bench/results/<timestamp>.json and .md
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { BASE_SERVICE, BASE_TESTS, SCENARIOS, type Scenario } from "./scenarios.js";
import { initCommand } from "../src/commands/init.js";
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

const write = (root: string, files: Record<string, string | null>) => {
  for (const [rel, content] of Object.entries(files)) {
    const f = path.join(root, rel);
    if (content === null) fs.rmSync(f, { force: true });
    else {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, content);
    }
  }
};
const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const commitAll = (cwd: string, msg: string) => {
  git(cwd, "add", "-A");
  git(cwd, "-c", "user.email=bench@x", "-c", "user.name=bench", "commit", "-qm", msg);
};

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
  error?: string;
}

async function runScenario(s: Scenario, run: number): Promise<ScenarioResult> {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), `qas-bench-${s.id}-`));
  const svc = path.join(ws, "orders-service");
  const tests = path.join(ws, "qa-tests");
  fs.mkdirSync(svc);
  fs.mkdirSync(tests);
  write(svc, BASE_SERVICE);
  git(svc, "init", "-q", "-b", "main");
  commitAll(svc, "base");
  write(svc, s.change);
  for (const [f, c] of Object.entries(s.change)) {
    if (c !== null && BASE_SERVICE[f] === c) throw new Error(`${s.id}: change to ${f} is identical to the base (a replace did not match)`);
  }
  commitAll(svc, `${s.id}: developer change`);

  await quietly(() => initCommand({ cwd: tests, yes: true, mode: "scratch", ci: "gitlab", workspace: ws, name: "bench" }));
  write(tests, { ...BASE_TESTS, ...(s.tests ?? {}) });
  if (s.story) write(tests, { "story.md": s.story });
  git(tests, "init", "-q", "-b", "main");
  commitAll(tests, "tests");

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
  const ck = s.checks ?? {};
  if (ck.suspicious !== undefined) r.checks.push({ name: "suspicious content flagged", pass: (plan.suspicious?.length ?? 0) > 0 === ck.suspicious });
  if (ck.acMismatch) r.checks.push({ name: `requirement conflict ${ck.acMismatch} reported`, pass: plan.acMismatches.some((m: any) => m.requirementId === ck.acMismatch) });
  if (ck.minRisk) r.checks.push({ name: `risk ≥ ${ck.minRisk}`, pass: RISK.indexOf(plan.risk.overall) >= RISK.indexOf(ck.minRisk), detail: plan.risk.overall });
  if (ck.maxRisk) r.checks.push({ name: `risk ≤ ${ck.maxRisk}`, pass: RISK.indexOf(plan.risk.overall) <= RISK.indexOf(ck.maxRisk), detail: plan.risk.overall });
  if (ck.noApprovedOracle) r.checks.push({ name: "no change claimed approved without requirements", pass: plan.changes.every((c: any) => c.oracleStatus !== "approved") });
  if (ck.invalidTest) r.checks.push({ name: `flags ${path.basename(ck.invalidTest)} as no longer valid`, pass: plan.impactedTests.some((t: any) => t.file === ck.invalidTest && t.stillValid === false) });
  return r;
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
  ].join("\n");
}

async function main() {
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
