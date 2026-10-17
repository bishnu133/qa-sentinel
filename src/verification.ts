import { hasPackage } from "./fsutil.js";
import { constSubstituter, indexSource } from "./analysis/testIndex.js";
import { groupByToggles, withToggles } from "./toggles.js";
import fs from "node:fs";
import path from "node:path";
import type { Config } from "./config.js";
import type { FileChange } from "./git.js";
import { TEST_FILE, addedLines } from "./guardrails.js";
import { runProcess } from "./proc.js";
import { type Layer, type LayerConfig, junitReporter, layerOfFile, layers, runnerOf, specArgs } from "./layers.js";

/** WAITING_FOR_DEPLOYMENT: only test runs failed, and the change they test isn't deployed in that environment yet. */
export type VerificationStatus = "VERIFIED" | "FAILED" | "BLOCKED" | "NOT_RUN" | "WAITING_FOR_DEPLOYMENT";
export type CheckStatus = "passed" | "failed" | "blocked" | "not-run" | "skipped";

export interface Check {
  name: "preflight" | "typecheck" | "lint" | "tests" | "deployment";
  /** Which test layer a preflight or tests check belongs to (api, web). */
  layer?: Layer;
  status: CheckStatus;
  detail: string;
  durationMs?: number;
}

export interface TestCase {
  name: string;
  file?: string;
  layer?: Layer;
  status: "passed" | "failed" | "skipped";
  message?: string;
}

export interface VerificationReport {
  status: VerificationStatus;
  /** Tests that failed once and passed on the automatic retry: not a product bug, but not stable either. */
  flaky?: string[];
  checks: Check[];
  specs: string[];
  cases: TestCase[];
  counts: { total: number; passed: number; failed: number; skipped: number };
}

const decode = (s: string) =>
  s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const attr = (attrs: string, name: string) => {
  const m = attrs.match(new RegExp(`\\b${name}="([^"]*)"`));
  return m ? decode(m[1]) : undefined;
};

/** Reporters put a file path or a suite title in classname (mocha xunit, jest-junit): only a path is a file. */
export const fileLike = (s: string | undefined) => (s && /\.([cm]?[jt]sx?|py|java|kt|cs|rb|go|php|feature)$/.test(s.trim()) ? s : undefined);

/** The package.json scripts of the test repo (to see which runner `npm run test` calls). */
export function packageScripts(cwd: string): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8")).scripts ?? {};
  } catch {
    return {};
  }
}

/** Minimal JUnit XML reader (Playwright, jest-junit, mocha-junit-reporter all emit this shape). */
export function parseJUnit(xml: string): TestCase[] {
  const cases: TestCase[] = [];
  const re = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g;
  for (const m of xml.matchAll(re)) {
    const attrs = m[1];
    const body = m[2] ?? "";
    const failure = body.match(/<(failure|error)\b([^>]*)(?:\/>|>([\s\S]*?)<\/\1>)/);
    const skipped = /<skipped\b/.test(body);
    cases.push({
      name: attr(attrs, "name") ?? "(unnamed)",
      file: attr(attrs, "file") ?? fileLike(attr(attrs, "classname")),
      status: failure ? "failed" : skipped ? "skipped" : "passed",
      message: failure ? decode((attr(failure[2], "message") ?? failure[3] ?? "").trim()).slice(0, 400) : undefined,
    });
  }
  return cases;
}

const ENV_ERROR = /(ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|socket hang up|getaddrinfo|certificate|connect EHOSTUNREACH|Unable to connect to|Could not find a connected|no (?:connected )?devices? (?:found|connected)|Could not start a new session|session not created)/i;

/** A JUnit file, or a folder of them (WebdriverIO writes one per worker). */
function readJUnitAt(p: string | undefined): TestCase[] {
  if (!p || !fs.existsSync(p)) return [];
  if (!fs.statSync(p).isDirectory()) return parseJUnit(fs.readFileSync(p, "utf8"));
  return fs
    .readdirSync(p)
    .filter((f) => f.endsWith(".xml"))
    .sort()
    .flatMap((f) => parseJUnit(fs.readFileSync(path.join(p, f), "utf8")));
}

export function overallStatus(checks: Check[]): VerificationStatus {
  if (checks.some((c) => c.status === "failed")) return "FAILED";
  if (checks.some((c) => c.status === "blocked")) return "BLOCKED";
  const tests = checks.filter((c) => c.name === "tests");
  if (!tests.length || tests.every((t) => t.status === "not-run")) return "NOT_RUN";
  if (tests.some((t) => t.status === "not-run")) return "NOT_RUN";
  return "VERIFIED";
}

export interface VerifyOptions {
  cwd: string;
  c: Config;
  /** Named environment the tests run against (for toggle commands). */
  environment?: string;
  changes: FileChange[];
  runDir: string;
  env: NodeJS.ProcessEnv;
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Deterministic verification, run by the CLI itself after the agent has finished. */
export async function verifyChanges(o: VerifyOptions): Promise<VerificationReport> {
  const { c, cwd } = o;
  const timeoutMs = c.verification.timeoutMinutes * 60_000;
  const live = o.changes.filter((x) => x.status !== "D");
  const specs = live.map((x) => x.path).filter((p) => TEST_FILE.test(p) && fs.existsSync(path.join(cwd, p)));
  const codeFiles = live.map((x) => x.path).filter((p) => /\.(ts|tsx|js|mjs|cjs)$/.test(p));
  const checks: Check[] = [];

  // 1. Preflight: is each environment there at all? Unreachable = BLOCKED, never "passed".
  const specsByLayer = new Map<LayerConfig, string[]>();
  for (const l of layers(c)) {
    const mine = specs.filter((p) => (layerOfFile(c, p) ?? "api") === l.layer);
    if (mine.length) specsByLayer.set(l, mine);
  }
  if (c.verification.preflight) {
    for (const l of specsByLayer.keys()) {
      const base = o.env[l.baseUrlEnv] || l.defaultBaseUrl;
      const baseUrl = base && l.preflightPath ? `${base.replace(/\/+$/, "")}${l.preflightPath}` : base;
      if (!baseUrl) {
        checks.push({ name: "preflight", layer: l.layer, status: "blocked", detail: `${l.baseUrlEnv} is not set` });
        continue;
      }
      const t0 = Date.now();
      // Device farms put credentials in the URL (https://user:key@hub…): send them as a header, never print them.
      let target: URL;
      try {
        target = new URL(baseUrl);
      } catch {
        checks.push({ name: "preflight", layer: l.layer, status: "blocked", detail: `${l.baseUrlEnv} is not a valid URL` });
        continue;
      }
      const auth = target.username || target.password ? `Basic ${Buffer.from(`${decodeURIComponent(target.username)}:${decodeURIComponent(target.password)}`).toString("base64")}` : undefined;
      target.username = "";
      target.password = "";
      const shown = `${target.origin}${target.pathname}`;
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 10_000);
        const res = await fetch(target, { method: "GET", signal: ctrl.signal, redirect: "manual", headers: auth ? { Authorization: auth } : {} });
        clearTimeout(timer);
        checks.push({ name: "preflight", layer: l.layer, status: "passed", detail: `${target.host} answered ${res.status}`, durationMs: Date.now() - t0 });
      } catch (e) {
        checks.push({ name: "preflight", layer: l.layer, status: "blocked", detail: `${shown} unreachable: ${(e as Error).message}`, durationMs: Date.now() - t0 });
      }
    }
  }

  // 2. Type-check (whole project: a helper change can break specs the agent did not touch).
  const tsconfig = fs.existsSync(path.join(cwd, "tsconfig.json"));
  const wantTsc = c.verification.typecheck === "always" || (c.verification.typecheck === "auto" && tsconfig && c.tests.language === "typescript");
  if (wantTsc && codeFiles.length) {
    const r = await runProcess("npx", ["--no-install", "tsc", "--noEmit"], { cwd, env: o.env, timeoutMs });
    checks.push({
      name: "typecheck",
      status: r.timedOut ? "blocked" : r.code === 0 ? "passed" : "failed",
      detail: r.timedOut ? "timed out" : r.code === 0 ? "tsc --noEmit clean" : tail(r.stdout + r.stderr),
      durationMs: r.durationMs,
    });
  }

  // 3. Lint (optional).
  if (c.verification.lintCommand && codeFiles.length) {
    const r = await runProcess(`${c.verification.lintCommand} ${codeFiles.map(shq).join(" ")}`, [], { cwd, env: o.env, timeoutMs, shell: true });
    checks.push({ name: "lint", status: r.timedOut ? "blocked" : r.code === 0 ? "passed" : "failed", detail: r.code === 0 ? "clean" : tail(r.stdout + r.stderr), durationMs: r.durationMs });
  }

  // 4. Tests: only the changed specs, per layer (each with its own command and base URL), with a machine-readable report.
  let cases: TestCase[] = [];
  const outputs: string[] = [];
  const flaky: string[] = [];
  if (!specs.length) {
    checks.push({ name: "tests", status: "not-run", detail: codeFiles.length ? "helpers changed but no spec files changed" : "no spec files changed" });
  }
  // Tests behind feature toggles (@toggle:name=value) run in groups, each with its toggles set and then put back.
  const specIndex = specs.flatMap((f) => {
    try {
      return indexSource(f, fs.readFileSync(path.join(cwd, f), "utf8"));
    } catch {
      return [];
    }
  });
  const runLayer = async (l: LayerConfig, layerSpecs: string[], sfx: string, label: string) => {
    if (checks.some((x) => x.name === "preflight" && x.layer === l.layer && x.status === "blocked")) {
        checks.push({ name: "tests", layer: l.layer, status: "not-run", detail: "skipped because the environment is unreachable" });
        return;
      }
      // API keeps junit.xml (what pipelines built for v0.4 collect); other layers get junit-<layer>.xml (or a folder).
      // Other runners: JUnit through their own reporter when qa-sentinel can switch it on (mocha, vitest, jest-junit).
      const auto =
        !l.isPlaywright && !l.junitDirEnv && !c.verification.junitPath
          ? junitReporter(runnerOf(l.runCommand, packageScripts(cwd)), l.runCommand, path.join(o.runDir, l.layer === "api" ? `junit${sfx}.xml` : `junit-${l.layer}${sfx}.xml`), (pkg) => hasPackage(cwd, pkg), shq)
          : undefined;
      const junit = l.isPlaywright
        ? path.join(o.runDir, l.layer === "api" ? `junit${sfx}.xml` : `junit-${l.layer}${sfx}.xml`)
        : l.junitDirEnv
          ? path.join(o.runDir, `junit-${l.layer}${sfx}`)
          : c.verification.junitPath
            ? path.resolve(cwd, c.verification.junitPath)
            : auto
              ? path.join(o.runDir, l.layer === "api" ? `junit${sfx}.xml` : `junit-${l.layer}${sfx}.xml`)
              : undefined;
      if (junit && fs.existsSync(junit)) fs.rmSync(junit, { recursive: true, force: true });
      const env = {
        ...o.env,
        ...(l.isPlaywright && junit ? { PLAYWRIGHT_JUNIT_OUTPUT_NAME: junit } : {}),
        ...(auto?.env ?? {}),
        ...(l.junitDirEnv && junit ? { [l.junitDirEnv]: junit } : {}),
        ...(l.resultsDirEnv ? { [l.resultsDirEnv]: path.join(o.runDir, `results-${l.layer}${sfx}`) } : {}),
        ...(!o.env[l.baseUrlEnv] && l.defaultBaseUrl ? { [l.baseUrlEnv]: l.defaultBaseUrl } : {}),
      };
      const runArgs = (files: string[]) => `${l.runCommand} ${specArgs(l, files, shq)}${l.isPlaywright ? " --reporter=line,junit" : (auto?.args ?? "")}`;
      const cmd = runArgs(layerSpecs);
      let r = await runProcess(cmd, [], { cwd, env, timeoutMs, shell: true });
      let mine = readJUnitAt(junit).map((x) => ({ ...x, layer: l.layer }));
      // One retry of the failed specs before calling it a failure: a test that passes on retry is flaky, not a bug.
      const firstFailed = mine.filter((x) => x.status === "failed" && !ENV_ERROR.test(x.message ?? ""));
      if (c.verification.retryFailed && firstFailed.length && !r.timedOut && junit) {
        const retrySpecs = layerSpecs.filter((sp) => firstFailed.some((f) => f.file && (sp.endsWith(f.file) || f.file.endsWith(sp))));
        if (retrySpecs.length) {
          fs.rmSync(junit, { recursive: true, force: true });
          const r2 = await runProcess(runArgs(retrySpecs), [], { cwd, env, timeoutMs, shell: true });
          const again = readJUnitAt(junit);
          // Same test = same file and name: two specs may hold tests with the same title.
          const key = (x: TestCase) => `${x.file ?? ""}::${x.name}`;
          const passedAgain = new Set(again.filter((a) => a.status === "passed").map(key));
          const healed = firstFailed.filter((f) => passedAgain.has(key(f)));
          if (healed.length) {
            flaky.push(...healed.map((f) => f.name));
            const healedKeys = new Set(healed.map(key));
            mine = mine.map((x) => (x.status === "failed" && healedKeys.has(key(x)) ? { ...x, status: "passed" as const, message: "passed on retry (flaky)" } : x));
            if (mine.every((x) => x.status !== "failed")) r = { ...r2, code: 0 };
          }
        }
      }
      cases = cases.concat(mine);
      const failed = mine.filter((x) => x.status === "failed");
      const envFailures = failed.length > 0 && failed.every((x) => ENV_ERROR.test(x.message ?? ""));
      let status: CheckStatus;
      let detail: string;
      if (r.timedOut) [status, detail] = ["blocked", `test run exceeded ${c.verification.timeoutMinutes} min`];
      else if (junit && mine.length === 0) [status, detail] = [r.code === 0 ? "not-run" : "failed", `no test results produced (exit ${r.code})${r.code ? `: ${tail(r.stdout + r.stderr)}` : ""}`];
      else if (envFailures) [status, detail] = ["blocked", `environment errors: ${failed[0].message}`];
      else if (r.code !== 0 || failed.length) [status, detail] = ["failed", `${failed.length} failed${failed[0] ? `: ${failed[0].name}` : `, exit ${r.code}`}`];
      else [status, detail] = ["passed", mine.length ? `${mine.filter((x) => x.status === "passed").length} passed, ${mine.filter((x) => x.status === "skipped").length} skipped${flaky.length ? `, ${flaky.length} only on retry (flaky)` : ""}` : "exit 0 (no JUnit report configured)"];
      checks.push({ name: "tests", ...(specsByLayer.size > 1 || l.layer !== "api" ? { layer: l.layer } : {}), status, detail: label ? `${detail} (${label})` : detail, durationMs: r.durationMs });
      outputs.push(`### ${l.layer}: ${cmd}\n${r.stdout}\n${r.stderr}`);
  
  };
  for (const [l, layerSpecs] of specsByLayer) {
    const { groups, conflicts } = groupByToggles(layerSpecs, specIndex);
    for (const x of conflicts) checks.push({ name: "tests", layer: l.layer, status: "blocked", detail: `${x.file} needs toggle ${x.toggle} both on and off: split it into two files` });
    const plain = groups.length === 1 && !Object.keys(groups[0].toggles).length;
    for (const [i, g] of groups.entries()) {
      const label = Object.entries(g.toggles).map(([k, v]) => `${k}=${v}`).join(", ");
      const sfx = plain || i === 0 ? "" : `-${i}`;
      try {
        await withToggles(c, o.environment, g.toggles, o.env, () => runLayer(l, g.files, sfx, label ? `toggles ${label}` : ""));
      } catch (e) {
        checks.push({ name: "tests", layer: l.layer, status: "blocked", detail: `toggles ${label} could not be set: ${(e as Error).message}` });
      }
    }
  }
  if (outputs.length) fs.writeFileSync(path.join(o.runDir, "test-output.log"), outputs.join("\n\n"));

  const report: VerificationReport = {
    status: overallStatus(checks),
    ...(flaky.length ? { flaky } : {}),
    checks,
    specs,
    cases,
    counts: {
      total: cases.length,
      passed: cases.filter((x) => x.status === "passed").length,
      failed: cases.filter((x) => x.status === "failed").length,
      skipped: cases.filter((x) => x.status === "skipped").length,
    },
  };
  fs.writeFileSync(path.join(o.runDir, "verification.json"), JSON.stringify(report, null, 2));
  return report;
}

function tail(s: string, lines = 12): string {
  return s.trim().split("\n").slice(-lines).join(" ⏎ ").slice(0, 600);
}

export interface Discrepancy {
  file: string;
  test: string;
  note?: string;
}

/**
 * Tests the agent deliberately did not run as passing (fixme/skip) because the product disagrees with the
 * requirements. These must be visible in the MR, never hidden behind "all tests passed".
 */
export function findDiscrepancies(cwd: string, ref: string, changes: FileChange[]): Discrepancy[] {
  const out: Discrepancy[] = [];
  for (const ch of changes) {
    if (ch.status === "D" || !TEST_FILE.test(ch.path)) continue;
    const added = new Set(addedLines(cwd, ref, ch.path));
    const src = fs.readFileSync(path.join(cwd, ch.path), "utf8");
    const subst = constSubstituter(src);
    const lines = src.split("\n");
    lines.forEach((line, i) => {
      if (!added.has(line)) return;
      const m = line.match(/\b(?:test|it|describe)\.(?:fixme|skip)\s*\(\s*(["'`])(.*?)\1|\bx(?:it|describe)\s*\(\s*(["'`])(.*?)\3/);
      if (!m) return;
      let note: string | undefined;
      for (let j = i - 1; j >= Math.max(0, i - 4); j--) {
        const n = lines[j].match(/\/\/\s*QA-AGENT:\s*(.*)$/);
        if (n) {
          // A note may continue on following comment lines, up to the test itself.
          const more = lines
            .slice(j + 1, i)
            .map((l) => l.match(/^\s*\/\/\s?(.*)$/)?.[1]?.trim())
            .filter((l): l is string => Boolean(l));
          note = [n[1].trim(), ...more].join(" ").replace(/\|/g, "\\|");
          break;
        }
      }
      out.push({ file: ch.path, test: subst(m[2] ?? m[4] ?? "").replace(/\s*@\S+/g, "").trim(), note });
    });
  }
  return out;
}

export const STATUS_BADGE: Record<VerificationStatus, string> = {
  VERIFIED: "✅ VERIFIED",
  FAILED: "❌ FAILED",
  BLOCKED: "⛔ BLOCKED",
  NOT_RUN: "⚪ NOT_RUN",
  WAITING_FOR_DEPLOYMENT: "⏳ WAITING FOR DEPLOYMENT",
};

export function verificationMarkdown(r: VerificationReport): string {
  const rows = r.checks.map((c) => `| ${c.name}${c.layer ? ` (${c.layer})` : ""} | ${c.status} | ${c.detail.replace(/\|/g, "\\|")} |`);
  const failed = r.cases.filter((x) => x.status === "failed").slice(0, 10);
  return [
    `**Verification: ${STATUS_BADGE[r.status]}** (run by qa-sentinel, not reported by the agent)`,
    "",
    "| Check | Result | Detail |",
    "| --- | --- | --- |",
    ...rows,
    ...(r.counts.total ? ["", `Tests: ${r.counts.passed} passed · ${r.counts.failed} failed · ${r.counts.skipped} skipped (of ${r.counts.total}).`] : []),
    ...(failed.length ? ["", "Failed:", ...failed.map((f) => `- \`${f.name}\` – ${f.message ?? ""}`)] : []),
    ...(r.flaky?.length ? ["", `⚠️ Flaky (failed once, passed on the automatic retry; make them deterministic before merging): ${r.flaky.map((f) => `\`${f}\``).join(", ")}`] : []),
  ].join("\n");
}
