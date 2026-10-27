/**
 * Generation-level benchmark (B2): `npm run bench -- --generate`.
 *
 * The gap-report benchmark stops at the plan. This one runs `generate` itself (plan, author, guardrails, independent
 * verification, independent review) on a few scenarios and scores what comes out:
 *   - verification status (VERIFIED means the written tests passed against the running service),
 *   - expected values present (the guardrail that the tests assert the story's values, not the code's),
 *   - the independent review's verdicts (weak and wrong-oracle tests),
 *   - scenario-specific checks on the written tests (e.g. no fixed `reference` value that would collide).
 *
 * It costs real money (a rough estimate, not measured: $1-3 per scenario with Claude Sonnet-class models) and needs `npm install` to work
 * (it installs the sample service and the test repo, and starts the service on a free port). The scoring is plain code
 * over the run's files, so it is unit-tested with a fake engine and fixture runs (test/generateBench.test.ts).
 */
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SCENARIOS, type Scenario } from "./scenarios.js";
import { buildWorkspace, commitAll, git, type Workspace } from "./workspace.js";
import { quietly } from "./quiet.js";
import { loadConfig, writeConfig } from "../src/config.js";
import { generateCommand } from "../src/commands/generate.js";

const here = path.dirname(fileURLToPath(import.meta.url));

/** The scenarios the generation benchmark runs by default: a validation rule, and the test-data collision case. */
export const GENERATION_DEFAULT = ["new-validation", "test-data-collision"];

export interface GenerationResult {
  id: string;
  run: number;
  outcome: string;
  /** VERIFIED, FAILED, BLOCKED, WAITING_FOR_DEPLOYMENT, … or "none" when generation stopped before verification. */
  verification: string;
  testFiles: string[];
  expectedValues: { violations: number; findings: string[] };
  review: { status: string; strong: number; adequate: number; weak: number; wrongOracle: number } | null;
  checks: { name: string; pass: boolean; detail?: string }[];
  costUsd?: number;
  durationMs?: number;
  note?: string;
  error?: string;
}

/** A fixed string value for `reference:` in a test is a collision waiting to happen (the second run, or a parallel one, gets a 409). */
export function referenceChecks(files: Record<string, string>): { name: string; pass: boolean; detail?: string }[] {
  const fixed: string[] = [];
  let any = 0;
  for (const text of Object.values(files)) {
    for (const m of text.matchAll(/\breference\s*:\s*(["'`])((?:\\.|(?!\1).)*)\1/g)) {
      any++;
      if (!/\$\{|Date\.now|random|uuid|Math\./i.test(m[2])) fixed.push(m[2]);
    }
    for (const m of text.matchAll(/\breference\s*:\s*([A-Za-z_][\w.()]*)/g)) if (!["undefined", "null"].includes(m[1])) any++;
  }
  return [
    { name: "tests use a reference value", pass: any > 0, detail: any ? undefined : "no test sends a reference" },
    { name: "tests do not use a fixed reference value", pass: fixed.length === 0, detail: fixed.length ? `fixed: ${[...new Set(fixed)].join(", ")}` : undefined },
  ];
}

const readJson = <T>(file: string): T | undefined => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
};

/** Score one finished generate run from the files it left (manifest, guardrails.json, test-review.result.json) and the tests on its branch. */
export function scoreGeneration(s: Scenario, run: number, runDir: string, testFiles: Record<string, string>): GenerationResult {
  const manifest = readJson<{ outcome?: string; verification?: { status: string }; agent?: { costUsd?: number; durationMs?: number } }>(path.join(runDir, "manifest.json")) ?? {};
  const findings = readJson<{ level: string; rule: string; message: string }[]>(path.join(runDir, "guardrails.json")) ?? [];
  const missing = findings.filter((f) => f.rule === "expected-value-missing");
  const reviewFile = readJson<{ status: string; review?: { tests: { verdict: string }[] } }>(path.join(runDir, "test-review.result.json"));
  const verdicts = reviewFile?.review?.tests.map((t) => t.verdict) ?? [];
  const review = reviewFile
    ? { status: reviewFile.status, strong: verdicts.filter((v) => v === "strong").length, adequate: verdicts.filter((v) => v === "adequate").length, weak: verdicts.filter((v) => v === "weak").length, wrongOracle: verdicts.filter((v) => v === "wrong-oracle").length }
    : null;
  const r: GenerationResult = {
    id: s.id,
    run,
    outcome: manifest.outcome ?? "unknown",
    verification: manifest.verification?.status ?? "none",
    testFiles: Object.keys(testFiles),
    expectedValues: { violations: missing.length, findings: missing.map((f) => f.message.slice(0, 160)) },
    review,
    checks: [],
    costUsd: manifest.agent?.costUsd,
    durationMs: manifest.agent?.durationMs,
  };
  r.checks.push({ name: "tests were written and committed", pass: r.testFiles.length > 0, detail: r.outcome });
  r.checks.push({ name: "verification VERIFIED", pass: r.verification === "VERIFIED", detail: r.verification });
  r.checks.push({ name: "expected values present in the tests", pass: missing.length === 0, detail: missing.length ? `${missing.length} missing` : undefined });
  r.checks.push({ name: "review: no weak or wrong-oracle test", pass: review?.status === "reviewed" ? review.weak + review.wrongOracle === 0 : false, detail: review ? `${review.status}: ${review.weak} weak, ${review.wrongOracle} wrong-oracle` : "no review result" });
  if (s.checks?.uniqueData) r.checks.push(...referenceChecks(testFiles));
  return r;
}

export interface RuntimeHandle {
  /** Environment variables for the generate run (the base URL variable). */
  env: Record<string, string>;
  stop: () => void;
  note?: string;
}

const freePort = () =>
  new Promise<number>((ok, fail) => {
    const srv = net.createServer();
    srv.once("error", fail);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => ok(port));
    });
  });

/**
 * The real environment for a generation run: install the sample service and the test repo (network), start the service
 * on a free port. Failure to install or start is not an error: the run goes on and verification reports what it can.
 */
export async function startRuntime(w: Workspace, baseUrlEnv: string): Promise<RuntimeHandle> {
  const notes: string[] = [];
  for (const [dir, label] of [[w.svc, "service"], [w.tests, "test repo"]] as const) {
    const r = spawnSync("npm", ["install", "--silent", "--no-audit", "--no-fund"], { cwd: dir, encoding: "utf8", timeout: 300_000 });
    if (r.status !== 0) notes.push(`npm install in the ${label} failed`);
  }
  const port = await freePort();
  const child: ChildProcess = spawn("node", ["src/server.js"], { cwd: w.svc, env: { ...process.env, PORT: String(port) }, stdio: "ignore" });
  const url = `http://127.0.0.1:${port}`;
  let up = false;
  for (let i = 0; i < 30 && !up; i++) {
    await new Promise((r) => setTimeout(r, 500));
    up = await fetch(`${url}/health`).then((x) => x.ok, () => false);
  }
  if (!up) notes.push("the sample service did not start");
  return { env: { [baseUrlEnv]: url }, stop: () => child.kill(), note: notes.join("; ") || undefined };
}

export interface GenerationRunOptions {
  /** Start the service and install packages (the owner's real run). Tests pass a stub. */
  prepare?: (w: Workspace, baseUrlEnv: string) => Promise<RuntimeHandle>;
  /** Called after the workspace exists and before generate runs (tests point the test command at a stub runner here). */
  afterBuild?: (w: Workspace) => void | Promise<void>;
  /** Copy the run's evidence under bench/results/runs/. Off in tests. */
  keepEvidence?: boolean;
}

const GIT_IDENTITY = { GIT_AUTHOR_NAME: "bench", GIT_AUTHOR_EMAIL: "bench@x", GIT_COMMITTER_NAME: "bench", GIT_COMMITTER_EMAIL: "bench@x" };

/** Build the scenario's workspace, run `generate` on it and score the result. */
export async function runGenerationScenario(s: Scenario, run: number, o: GenerationRunOptions = {}): Promise<GenerationResult> {
  const w = await buildWorkspace(s, "qas-gen");
  // The bench workspace is made for analysis (level intelligence); generation needs maintenance.
  const cfg = loadConfig(w.tests);
  cfg.level = "maintenance";
  writeConfig(w.tests, cfg);
  commitAll(w.tests, "level: maintenance (generation benchmark)");
  await o.afterBuild?.(w);
  const c = loadConfig(w.tests);
  const runtime = await (o.prepare ?? startRuntime)(w, c.tests.api.baseUrlEnv);
  // generate reads the base URL and the git identity from the process environment; restore it afterwards.
  const touched: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries({ ...runtime.env, ...GIT_IDENTITY })) {
    touched[k] = process.env[k];
    process.env[k] = v;
  }
  let error: string | undefined;
  try {
    await quietly(() => generateCommand({ cwd: w.tests, service: "orders-service", base: "HEAD~1", head: "HEAD", storyFile: s.story ? path.join(w.tests, "story.md") : undefined }));
  } catch (e) {
    error = (e as Error).message;
  } finally {
    runtime.stop();
    for (const [k, v] of Object.entries(touched)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  const runsDir = path.join(w.tests, ".qa-sentinel/runs");
  const runDir = fs.existsSync(runsDir) ? fs.readdirSync(runsDir).map((d) => path.join(runsDir, d)).sort().at(-1) : undefined;
  // The tests the run committed: files that differ from main on the current branch.
  const files: Record<string, string> = {};
  try {
    for (const f of git(w.tests, "diff", "--name-only", "main", "HEAD").split("\n").filter((x) => /\.(spec|test)\.[tj]sx?$/.test(x))) files[f] = fs.readFileSync(path.join(w.tests, f), "utf8");
  } catch {
    /* no branch */
  }
  const result = runDir ? scoreGeneration(s, run, runDir, files) : ({ id: s.id, run, outcome: "no-run", verification: "none", testFiles: [], expectedValues: { violations: 0, findings: [] }, review: null, checks: [] } as GenerationResult);
  if (runtime.note) result.note = runtime.note;
  if (error) result.error = error;
  if (o.keepEvidence && runDir) fs.cpSync(runDir, path.join(here, "results", "runs", `gen-${s.id}-${run}`), { recursive: true });
  return result;
}

export function generationMarkdown(results: GenerationResult[]): string {
  const n = results.length;
  const count = (f: (r: GenerationResult) => boolean) => results.filter(f).length;
  const cost = results.reduce((a, r) => a + (r.costUsd ?? 0), 0);
  const rows = results.map(
    (r) =>
      `| ${r.id}${results.some((x) => x.id === r.id && x.run !== r.run) ? ` #${r.run}` : ""} | ${r.outcome} | ${r.verification} | ${r.testFiles.length} | ${r.expectedValues.violations} | ${r.review ? `${r.review.weak + r.review.wrongOracle} of ${r.review.strong + r.review.adequate + r.review.weak + r.review.wrongOracle}` : "–"} | ${r.checks.filter((c) => c.pass).length}/${r.checks.length} | ${r.costUsd?.toFixed(2) ?? "–"} |`,
  );
  const fails = results.flatMap((r) => r.checks.filter((c) => !c.pass).map((c) => `- **${r.id}**: ${c.name}${c.detail ? ` (${c.detail})` : ""}`));
  const notes = results.filter((r) => r.note || r.error).map((r) => `- **${r.id}**: ${[r.note, r.error].filter(Boolean).join("; ")}`);
  return [
    `# qa-sentinel generation benchmark – ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`,
    "",
    `**${n} run(s)** · verified ${count((r) => r.verification === "VERIFIED")}/${n} · runs with missing expected values ${count((r) => r.expectedValues.violations > 0)}/${n} · runs with a weak or wrong-oracle test ${count((r) => (r.review?.weak ?? 0) + (r.review?.wrongOracle ?? 0) > 0)}/${n} · total $${cost.toFixed(2)}`,
    "",
    "| Scenario | Outcome | Verification | Test files | Missing expected values | Weak or wrong-oracle tests | Checks | $ |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows,
    ...(fails.length ? ["", "## Failed checks", ...fails] : []),
    ...(notes.length ? ["", "## Notes", ...notes] : []),
  ].join("\n");
}

export async function generationMain(o: { only?: string[]; runs: number; args: string[] }): Promise<void> {
  const ids = o.only ?? GENERATION_DEFAULT;
  const selected = SCENARIOS.filter((s) => ids.includes(s.id));
  const results: GenerationResult[] = [];
  fs.mkdirSync(path.join(here, "results", "runs"), { recursive: true });
  for (const s of selected) {
    for (let run = 1; run <= o.runs; run++) {
      process.stderr.write(`▶ generate ${s.id} #${run}\n`);
      const r = await runGenerationScenario(s, run, { keepEvidence: true }).catch((e) => ({ id: s.id, run, outcome: "crash", verification: "none", testFiles: [], expectedValues: { violations: 0, findings: [] }, review: null, checks: [], error: String(e) }) as GenerationResult);
      process.stderr.write(`✔ ${s.id} #${run}: ${r.outcome} · ${r.verification} · $${r.costUsd?.toFixed(2) ?? "?"}\n`);
      results.push(r);
    }
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  fs.writeFileSync(path.join(here, "results", `generate-${stamp}.json`), JSON.stringify({ results }, null, 2));
  const md = generationMarkdown(results);
  fs.writeFileSync(path.join(here, "results", `generate-${stamp}.md`), md + "\n");
  fs.writeFileSync(path.join(here, "results", "latest-generate.md"), md + "\n");
  console.log(md);
}
