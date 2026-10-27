/**
 * B1, mutation checks (benchmark only, no AI).
 *
 * "Do the tests catch a bug?" answered the plain way: plant a known defect in a copy of the sample service, run the
 * tests, and see whether any of them fails. The defects are HAND-WRITTEN patches in bench/mutations/<scenario>/*.patch,
 * not generated. The result is reported as "N planted defects, M caught", never as a general mutation score: N is small
 * and chosen by a person, and a defect that survives may be a gap in the tests or a defect no test could see.
 *
 *   node sandbox/shoplite/local.mjs setup
 *   npm run bench:mutate -- --scenario SHOP-101            # the reference tests that ship with the scenario
 *   npm run bench:mutate -- --scenario SHOP-101 --tests-ref qa-sentinel/orders-service-ab12cd34   # tests an agent wrote
 *
 * A patch file starts with header lines, then a unified diff that `git apply` accepts:
 *   # mutation: cap-3-to-5
 *   # service: orders-service
 *   # describes: the delivery slot takes 5 orders instead of 3
 *   # expect-killed-by: slot is full, AC-3          (words of a failing test's name; "none" = nobody should notice)
 * `reference.patch` is not a defect: it is the correct implementation of the scenario, applied first, so every mutant
 * is "the correct code plus one defect". The tests must pass on it (the baseline) or nothing is scored.
 *
 * Not built: generic mutation operators or a tool such as Stryker against arbitrary services (they need per-language
 * tooling and their results on unknown code can't be checked here).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { parseFlags } from "./args.js";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export interface Mutation {
  id: string;
  /** Header text, shown in the report. */
  description: string;
  /** Words of a failing test's name that show the right test noticed. Empty: the defect is expected to survive. */
  expectKilledBy: string[];
  /** The unified diff, without the header lines. */
  patch: string;
  service?: string;
}

export interface TestOutcome {
  total: number;
  /** Names of the tests that failed. */
  failed: string[];
  /** The test run itself did not work (service did not start, results unreadable): this is not a catch. */
  error?: string;
}

/** Runs the tests against a folder (a copy of the service with the patches applied) and says which failed. */
export type Runner = (dir: string) => Promise<TestOutcome>;

export type MutantStatus = "killed" | "survived" | "error";

export interface MutationRow {
  id: string;
  description: string;
  status: MutantStatus;
  /** Failing tests (first 5). */
  killedBy: string[];
  expectKilledBy: string[];
  /** Did the result match what the patch's header expected? null for an error. */
  expectationMet: boolean | null;
  note?: string;
}

export interface MutationReport {
  scenario: string;
  baseline: TestOutcome;
  /** False when the tests fail (or can't run) on the correct code: nothing is scored then. */
  baselineOk: boolean;
  rows: MutationRow[];
  planted: number;
  caught: number;
  survived: number;
  errors: number;
}

/** Split a .patch file into its header values and the diff. */
export function parseMutationPatch(file: string, text: string): Mutation & { reference: boolean } {
  const header = new Map<string, string>();
  const lines = text.split("\n");
  let i = 0;
  for (; i < lines.length && !/^(diff --git|--- )/.test(lines[i]); i++) {
    const m = /^#\s*([a-z-]+):\s*(.*)$/.exec(lines[i]);
    if (m) header.set(m[1], m[2].trim());
  }
  const patch = lines.slice(i).join("\n");
  if (!patch.trim()) throw new Error(`${file}: no diff in the patch`);
  const id = header.get("mutation") ?? path.basename(file, ".patch");
  const expect = (header.get("expect-killed-by") ?? "").split(",").map((x) => x.trim()).filter((x) => x && x.toLowerCase() !== "none");
  if (path.basename(file) !== "reference.patch" && !header.has("expect-killed-by")) throw new Error(`${file}: add a "# expect-killed-by: <words>" header ("none" if no test should notice)`);
  return { id, description: header.get("describes") ?? id, expectKilledBy: expect, patch, service: header.get("service"), reference: path.basename(file) === "reference.patch" };
}

/** The patches of a scenario: its reference (if any) and its mutations, in file-name order. */
export function loadMutations(scenario: string, root = path.join(here, "mutations")): { reference?: Mutation; mutations: Mutation[]; testsDir?: string } {
  const dir = path.join(root, scenario);
  if (!fs.existsSync(dir)) throw new Error(`no mutations for ${scenario}: ${path.relative(process.cwd(), dir)} does not exist`);
  const all = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".patch"))
    .sort()
    .map((f) => parseMutationPatch(path.join(dir, f), fs.readFileSync(path.join(dir, f), "utf8")));
  const testsDir = fs.existsSync(path.join(dir, "tests")) ? path.join(dir, "tests") : undefined;
  return { reference: all.find((m) => m.reference), mutations: all.filter((m) => !m.reference), testsDir };
}

/** Apply a unified diff to a folder with `git apply` (works outside a repository). */
export function applyPatch(dir: string, patch: string): void {
  const r = spawnSync("git", ["apply", "--whitespace=nowarn", "-"], { cwd: dir, input: patch.endsWith("\n") ? patch : patch + "\n", encoding: "utf8" });
  if (r.status !== 0) throw new Error(`patch does not apply: ${(r.stderr || r.stdout).trim().split("\n")[0]}`);
}

const copyTree = (from: string, to: string) => fs.cpSync(from, to, { recursive: true, filter: (src) => !/(^|[\\/])(\.git|node_modules)$/.test(src) });

const classify = (m: Mutation, out: TestOutcome, baselineTotal: number): MutationRow => {
  const base = { id: m.id, description: m.description, expectKilledBy: m.expectKilledBy };
  if (out.error) return { ...base, status: "error", killedBy: [], expectationMet: null, note: out.error };
  // Fewer or more tests than on the correct code means the run was not the same run: no verdict either way.
  if (out.total !== baselineTotal) return { ...base, status: "error", killedBy: [], expectationMet: null, note: `${out.total} tests ran, ${baselineTotal} on the correct code` };
  const killed = out.failed.length > 0;
  const named = m.expectKilledBy.length ? out.failed.some((f) => m.expectKilledBy.some((w) => f.toLowerCase().includes(w.toLowerCase()))) : !killed;
  return {
    ...base,
    status: killed ? "killed" : "survived",
    killedBy: out.failed.slice(0, 5),
    expectationMet: named,
    note: killed && m.expectKilledBy.length && !named ? "caught, but not by the test the patch names" : !killed && m.expectKilledBy.length ? `no test noticed (expected: ${m.expectKilledBy.join(", ")})` : killed && !m.expectKilledBy.length ? "expected to survive but a test failed" : undefined,
  };
};

/**
 * Plant each defect in its own copy of `sourceDir`, run the tests and count the catches. The baseline (the correct code,
 * i.e. the source plus the reference patch) runs first and must pass.
 */
export async function runMutations(o: { scenario: string; sourceDir: string; reference?: Mutation; mutations: Mutation[]; run: Runner }): Promise<MutationReport> {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "qas-mutate-"));
  const prepare = (label: string, ...patches: Mutation[]) => {
    const dir = path.join(scratch, label);
    copyTree(o.sourceDir, dir);
    for (const p of patches) applyPatch(dir, p.patch);
    return dir;
  };
  try {
    const refs = o.reference ? [o.reference] : [];
    const baseline = await o.run(prepare("baseline", ...refs));
    const baselineOk = !baseline.error && baseline.total > 0 && baseline.failed.length === 0;
    const rows: MutationRow[] = [];
    if (baselineOk) {
      for (const [i, m] of o.mutations.entries()) {
        let row: MutationRow;
        try {
          row = classify(m, await o.run(prepare(`m${i}`, ...refs, m)), baseline.total);
        } catch (e) {
          row = { id: m.id, description: m.description, status: "error", killedBy: [], expectKilledBy: m.expectKilledBy, expectationMet: null, note: (e as Error).message };
        }
        rows.push(row);
      }
    }
    return {
      scenario: o.scenario,
      baseline,
      baselineOk,
      rows,
      planted: rows.length,
      caught: rows.filter((r) => r.status === "killed").length,
      survived: rows.filter((r) => r.status === "survived").length,
      errors: rows.filter((r) => r.status === "error").length,
    };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/** Failing tests from a run's output: Playwright's JSON reporter, or TAP-style lines ("ok 1 - name" / "not ok 2 - name"). */
export function parseOutcome(stdout: string, status: number | null): TestOutcome {
  const start = stdout.indexOf("{");
  if (start >= 0) {
    try {
      const j = JSON.parse(stdout.slice(start)) as { suites?: any[]; errors?: unknown[] };
      // Playwright lists run-level errors (a worker crash, a failing global setup) here: the run is not a result.
      if (Array.isArray(j.errors) && j.errors.length) return { total: 0, failed: [], error: `the test run reported ${j.errors.length} error(s) of its own (worker or setup failure)` };
      let total = 0;
      const failed: string[] = [];
      const walk = (s: any, file: string) => {
        const f = s.file ?? file;
        for (const spec of s.specs ?? []) {
          total++;
          if (spec.ok === false) failed.push(`${spec.file ?? f} › ${spec.title}`);
        }
        for (const child of s.suites ?? []) walk(child, f);
      };
      for (const s of j.suites ?? []) walk(s, s.file ?? "");
      if (total && !failed.length && status) return { total, failed: [], error: `the test command exited ${status} although no test failed` };
      if (total || !status) return { total, failed };
    } catch {
      /* not JSON: try the line format */
    }
  }
  const tap = [...stdout.matchAll(/^(not ok|ok)\s+\d+\s*-?\s*(.*)$/gm)];
  if (tap.length) return { total: tap.length, failed: tap.filter((m) => m[1] === "not ok").map((m) => m[2].trim()) };
  return { total: 0, failed: [], error: status === 0 ? "the test command printed no results" : `the test command could not run the tests (exit ${status ?? "?"})` };
}

/** A runner that runs a shell command with MUTANT_DIR set to the folder under test. */
export function commandRunner(cmd: string, o: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): Runner {
  return async (dir) => {
    const r = spawnSync("sh", ["-c", cmd], { cwd: o.cwd ?? dir, env: { ...process.env, ...o.env, MUTANT_DIR: dir }, encoding: "utf8", timeout: o.timeoutMs ?? 300_000, maxBuffer: 64 * 1024 * 1024 });
    if (r.error) return { total: 0, failed: [], error: r.error.message };
    return parseOutcome(r.stdout ?? "", r.status);
  };
}

/** A test name without its tags and folders: "orders.spec.ts › returns 402 when payment is declined". */
const shortName = (n: string) => n.replace(/\s@\S+/g, "").replace(/^.*\/([^/]+\.[tj]s) › /, "$1 › ");

export function mutationMarkdown(r: MutationReport, extra: { tests?: string } = {}): string {
  const head = [`# qa-sentinel mutation check – ${r.scenario} – ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`, ""];
  if (extra.tests) head.push(`Tests: ${extra.tests}`, "");
  if (!r.baselineOk) {
    return [
      ...head,
      "**Nothing was scored: the tests do not pass on the correct code.**",
      "",
      r.baseline.error ? `The baseline run failed to run: ${r.baseline.error}` : r.baseline.total === 0 ? "The baseline run found no tests." : `Failing on the correct code (${r.baseline.failed.length} of ${r.baseline.total}): ${r.baseline.failed.slice(0, 8).map((f) => `\`${f}\``).join(", ")}`,
      "",
      "A mutation result only means something when the tests pass before the defect is planted. Fix the tests (or the reference patch) and run again.",
    ].join("\n");
  }
  const rows = r.rows.map((x) => `| ${x.id} | ${x.description} | ${x.status === "killed" ? "caught" : x.status === "survived" ? "**survived**" : "error"} | ${x.killedBy.map((k) => `\`${shortName(k)}\``).join(", ") || "–"} | ${x.expectKilledBy.join(", ") || "none"} | ${x.expectationMet === null ? "–" : x.expectationMet ? "yes" : "**no**"} |`);
  const notes = r.rows.filter((x) => x.note).map((x) => `- **${x.id}**: ${x.note}`);
  return [
    ...head,
    `**${r.planted} planted defect${r.planted === 1 ? "" : "s"}, ${r.caught} caught**${r.survived ? `, ${r.survived} survived` : ""}${r.errors ? `, ${r.errors} could not be judged (the test run failed)` : ""}. Baseline: ${r.baseline.total} tests passed on the correct code.`,
    "",
    "| Defect | What it changes | Result | Failing tests | Patch expects | As expected |",
    "| --- | --- | --- | --- | --- | --- |",
    ...rows,
    ...(notes.length ? ["", ...notes] : []),
    "",
    "_The defects are hand-written and few. \"M of N caught\" says how these tests do against these defects; it is not a general mutation score. A survivor is either a gap in the tests or a defect no test could see; read the description._",
  ].join("\n");
}

/* ---------- the ShopLite sandbox harness ---------- */

const GIT_IDENTITY = { GIT_AUTHOR_NAME: "bench", GIT_AUTHOR_EMAIL: "bench@x", GIT_COMMITTER_NAME: "bench", GIT_COMMITTER_EMAIL: "bench@x" };

/**
 * `qa-env/start.sh` runs a service from /tmp/services/<name> BEFORE it looks at the local folder we give it (CI puts the
 * service under test there). A leftover folder would make the environment run that code and every defect would
 * "survive". The sandbox's own services are the ones to check.
 */
export function leftoverServiceFolders(root = "/tmp/services"): string[] {
  return ["orders-service", "payments-service", "notifications-service", "storefront"].map((s) => path.join(root, s)).filter((d) => fs.existsSync(d));
}

/** A ref that git would read as an option is refused; everything else goes to git as one argument, never through a shell. */
function checkRef(ref: string): void {
  if (!ref.trim() || ref.startsWith("-") || /[\0\n]/.test(ref)) throw new Error(`not a usable git ref: ${JSON.stringify(ref)}`);
}

/** Extract `ref` of a repository into `dest`: `git archive -o <tar>` and `tar`, with no shell. */
export function extractRef(repo: string, ref: string, dest: string): void {
  checkRef(ref);
  const tarFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "qas-archive-")), "tree.tar");
  try {
    execFileSync("git", ["-C", repo, "archive", "--format=tar", "-o", tarFile, ref, "--"], { stdio: ["ignore", "pipe", "pipe"] });
    execFileSync("tar", ["-x", "-f", tarFile, "-C", dest], { stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    throw new Error(`cannot read ${ref} from ${repo}: ${String((e as { stderr?: Buffer }).stderr ?? (e as Error).message).trim().split("\n")[0]}`);
  } finally {
    fs.rmSync(path.dirname(tarFile), { recursive: true, force: true });
  }
}

export interface ShopliteOptions {
  work: string;
  testsDir: string;
  /** The scripts and commands, replaceable in tests. Defaults: the sandbox's qa-env scripts and Playwright's API project. */
  startScript?: string;
  stopScript?: string;
  testCommand?: string;
  /** Run after the environment is up: exit 0 only when the orders service answers with the commit in $EXPECT_SHA. */
  verifyCommand?: string;
  /** Where start.sh looks first for a service (default /tmp/services). */
  servicesRoot?: string;
}

const VERIFY_SERVES_MUTANT = `node -e 'fetch(process.env.QA_BASE_URL + "/orders/version").then(r=>r.json()).then(j=>process.exit(j.commit===process.env.EXPECT_SHA?0:1),()=>process.exit(1))'`;

/**
 * Tests against the local ShopLite environment: a mutant folder replaces orders-service, the other services are the
 * ones from the work folder, the environment is started with qa-env/start.sh, the API tests run, the environment is
 * stopped. The mutant folder is given a git commit and, after the start, the orders service must report that commit
 * (/orders/version): if it does not, something else is serving and the run is an error, not a result.
 * Every path reaches bash as an environment variable, never inside the script text. Needs `local.mjs setup` first.
 */
export function shopliteRunner(o: ShopliteOptions): Runner {
  const services = ["payments-service", "notifications-service", "storefront"].filter((s) => fs.existsSync(path.join(o.work, s)));
  const stop = o.stopScript ?? path.resolve(here, "../sandbox/shoplite/tests-extra/qa-env/stop.sh");
  const start = o.startScript ?? path.join(o.testsDir, "qa-env/start.sh");
  const script = [
    'bash "$QAS_STOP" >/dev/null 2>&1',
    'export QA_ENV_LOCAL_SERVICES="$QAS_ROOT" QA_ENV_DIR="$QAS_ROOT/.qa-env"',
    'source "$QAS_START" >&2 || { bash "$QAS_STOP" >/dev/null 2>&1; echo "SERVICE_DID_NOT_START" >&2; exit 97; }',
    'if ! bash -c "$QAS_VERIFY" >&2; then bash "$QAS_STOP" >/dev/null 2>&1; echo "NOT_SERVING_THE_MUTANT" >&2; exit 96; fi',
    'cd "$QAS_TESTS" && bash -c "$QAS_TEST_CMD"',
    'code=$?; bash "$QAS_STOP" >/dev/null 2>&1; exit $code',
  ].join("\n");
  return async (mutant) => {
    const leftovers = leftoverServiceFolders(o.servicesRoot);
    if (leftovers.length) return { total: 0, failed: [], error: `${leftovers.join(", ")} exist(s); start.sh would run that code instead of the mutant. Remove them and run again` };
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "qas-mutenv-"));
    try {
      for (const s of services) fs.symlinkSync(path.join(o.work, s), path.join(root, s));
      const orders = path.join(root, "orders-service");
      fs.cpSync(mutant, orders, { recursive: true });
      const gitEnv = { ...process.env, ...GIT_IDENTITY, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
      fs.writeFileSync(path.join(orders, ".gitignore"), "node_modules\n");
      execFileSync("git", ["init", "-q", "-b", "main"], { cwd: orders, env: gitEnv, stdio: "ignore" });
      execFileSync("git", ["add", "-A"], { cwd: orders, env: gitEnv, stdio: "ignore" });
      execFileSync("git", ["commit", "-q", "-m", "mutant"], { cwd: orders, env: gitEnv, stdio: "ignore" });
      const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: orders, env: gitEnv, encoding: "utf8" }).trim();
      if (fs.existsSync(path.join(o.work, "orders-service/node_modules"))) fs.symlinkSync(path.join(o.work, "orders-service/node_modules"), path.join(orders, "node_modules"));
      const r = spawnSync("bash", ["-c", script], {
        encoding: "utf8",
        timeout: 300_000,
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, QAS_STOP: stop, QAS_START: start, QAS_ROOT: root, QAS_TESTS: o.testsDir, EXPECT_SHA: sha, QAS_VERIFY: o.verifyCommand ?? VERIFY_SERVES_MUTANT, QAS_TEST_CMD: o.testCommand ?? "npx playwright test --project=api --reporter=json" },
      });
      if (r.status === 97) return { total: 0, failed: [], error: "the service did not start with this patch" };
      if (r.status === 96) return { total: 0, failed: [], error: "the environment started, but the orders service is not the mutant copy (another process or folder is serving)" };
      return parseOutcome(r.stdout ?? "", r.status);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}

/** The tests to run: a copy of qa-tests (at a ref when given) with the scenario's reference tests laid over it. The caller removes the folder. */
export function prepareTests(work: string, o: { ref?: string; overlay?: string }): string {
  const src = path.join(work, "qa-tests");
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), "qas-mutate-tests-"));
  try {
    if (o.ref) extractRef(src, o.ref, dest);
    else copyTree(src, dest);
    if (o.overlay) fs.cpSync(o.overlay, dest, { recursive: true });
    if (fs.existsSync(path.join(src, "node_modules"))) fs.symlinkSync(path.join(src, "node_modules"), path.join(dest, "node_modules"));
  } catch (e) {
    fs.rmSync(dest, { recursive: true, force: true });
    throw e;
  }
  return dest;
}

export const MUTATE_USAGE = "usage: npm run bench:mutate -- --scenario SHOP-101 [--work ./shoplite-local] [--tests-ref <branch in qa-tests>]";

export async function mutateMain(argv: string[]): Promise<number> {
  const parsed = parseFlags(argv, { values: { scenario: "string", work: "string", "tests-ref": "string" }, switches: [] });
  if (!parsed.ok || !parsed.values.scenario) {
    console.error(`${parsed.ok ? "--scenario is required" : parsed.error}\n${MUTATE_USAGE}`);
    return 2;
  }
  const scenario = parsed.values.scenario;
  const work = path.resolve(parsed.values.work ?? "shoplite-local");
  if (!fs.existsSync(path.join(work, "qa-tests")) || !fs.existsSync(path.join(work, "orders-service"))) {
    console.error(`No ShopLite sandbox in ${work}. Run: node sandbox/shoplite/local.mjs setup`);
    return 2;
  }
  const left = leftoverServiceFolders();
  if (left.length) {
    console.error(`${left.join(", ")} exist(s). The ShopLite environment would run that code instead of the mutant copies, so every defect would seem to survive. Remove them and run again.`);
    return 2;
  }
  const ref = parsed.values["tests-ref"];
  const { reference, mutations, testsDir } = loadMutations(scenario);
  let tests: string | undefined;
  let source: string | undefined;
  try {
    // With --tests-ref the tests are the ones an agent wrote; the reference tests are only laid over the default tests.
    tests = prepareTests(work, { ref, overlay: ref ? undefined : testsDir });
    source = fs.mkdtempSync(path.join(os.tmpdir(), "qas-mutate-src-"));
    extractRef(path.join(work, "orders-service"), "main", source);
    const report = await runMutations({ scenario, sourceDir: source, reference, mutations, run: shopliteRunner({ work, testsDir: tests }) });
    const md = mutationMarkdown(report, { tests: ref ? `qa-tests at ${ref}` : "the reference tests shipped with the scenario (bench/mutations)" });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    fs.mkdirSync(path.join(here, "results"), { recursive: true });
    fs.writeFileSync(path.join(here, "results", `mutations-${stamp}.md`), md + "\n");
    console.log(md);
    return report.baselineOk ? 0 : 1;
  } finally {
    spawnSync("bash", [path.resolve(here, "../sandbox/shoplite/tests-extra/qa-env/stop.sh")], { stdio: "ignore" });
    if (tests) fs.rmSync(tests, { recursive: true, force: true });
    if (source) fs.rmSync(source, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) mutateMain(process.argv.slice(2)).then((c) => process.exit(c), (e) => (console.error(String(e?.message ?? e)), process.exit(1)));
