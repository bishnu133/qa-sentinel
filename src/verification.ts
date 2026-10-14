import { constSubstituter } from "./analysis/testIndex.js";
import fs from "node:fs";
import path from "node:path";
import type { Config } from "./config.js";
import type { FileChange } from "./git.js";
import { TEST_FILE, addedLines } from "./guardrails.js";
import { runProcess } from "./proc.js";

export type VerificationStatus = "VERIFIED" | "FAILED" | "BLOCKED" | "NOT_RUN";
export type CheckStatus = "passed" | "failed" | "blocked" | "not-run" | "skipped";

export interface Check {
  name: "preflight" | "typecheck" | "lint" | "tests";
  status: CheckStatus;
  detail: string;
  durationMs?: number;
}

export interface TestCase {
  name: string;
  file?: string;
  status: "passed" | "failed" | "skipped";
  message?: string;
}

export interface VerificationReport {
  status: VerificationStatus;
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
      file: attr(attrs, "file") ?? attr(attrs, "classname"),
      status: failure ? "failed" : skipped ? "skipped" : "passed",
      message: failure ? decode((attr(failure[2], "message") ?? failure[3] ?? "").trim()).slice(0, 400) : undefined,
    });
  }
  return cases;
}

const ENV_ERROR = /(ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|socket hang up|getaddrinfo|certificate|connect EHOSTUNREACH)/i;

export function overallStatus(checks: Check[]): VerificationStatus {
  if (checks.some((c) => c.status === "failed")) return "FAILED";
  if (checks.some((c) => c.status === "blocked")) return "BLOCKED";
  const tests = checks.find((c) => c.name === "tests");
  if (!tests || tests.status === "not-run") return "NOT_RUN";
  return "VERIFIED";
}

export interface VerifyOptions {
  cwd: string;
  c: Config;
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

  // 1. Preflight: is the environment there at all? Unreachable = BLOCKED, never "passed".
  if (specs.length && c.verification.preflight) {
    const baseUrl = o.env[c.tests.api.baseUrlEnv];
    if (!baseUrl) checks.push({ name: "preflight", status: "blocked", detail: `${c.tests.api.baseUrlEnv} is not set` });
    else {
      const t0 = Date.now();
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 10_000);
        const res = await fetch(baseUrl, { method: "GET", signal: ctrl.signal, redirect: "manual" });
        clearTimeout(timer);
        checks.push({ name: "preflight", status: "passed", detail: `${new URL(baseUrl).host} answered ${res.status}`, durationMs: Date.now() - t0 });
      } catch (e) {
        checks.push({ name: "preflight", status: "blocked", detail: `${baseUrl} unreachable: ${(e as Error).message}`, durationMs: Date.now() - t0 });
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

  // 4. Tests: only the changed specs, with a machine-readable report.
  let cases: TestCase[] = [];
  const preflightBlocked = checks.some((x) => x.name === "preflight" && x.status === "blocked");
  if (!specs.length) {
    checks.push({ name: "tests", status: "not-run", detail: codeFiles.length ? "helpers changed but no spec files changed" : "no spec files changed" });
  } else if (preflightBlocked) {
    checks.push({ name: "tests", status: "not-run", detail: "skipped because the environment is unreachable" });
  } else {
    const isPlaywright = c.tests.api.framework === "playwright";
    const junit = isPlaywright ? path.join(o.runDir, "junit.xml") : c.verification.junitPath ? path.resolve(cwd, c.verification.junitPath) : undefined;
    if (junit && fs.existsSync(junit)) fs.rmSync(junit);
    const env = { ...o.env, ...(isPlaywright && junit ? { PLAYWRIGHT_JUNIT_OUTPUT_NAME: junit } : {}) };
    const cmd = `${c.tests.api.runCommand} ${specs.map(shq).join(" ")}${isPlaywright ? " --reporter=line,junit" : ""}`;
    const r = await runProcess(cmd, [], { cwd, env, timeoutMs, shell: true });
    cases = junit && fs.existsSync(junit) ? parseJUnit(fs.readFileSync(junit, "utf8")) : [];
    const failed = cases.filter((x) => x.status === "failed");
    const envFailures = failed.length > 0 && failed.every((x) => ENV_ERROR.test(x.message ?? ""));
    let status: CheckStatus;
    let detail: string;
    if (r.timedOut) [status, detail] = ["blocked", `test run exceeded ${c.verification.timeoutMinutes} min`];
    else if (junit && cases.length === 0) [status, detail] = [r.code === 0 ? "not-run" : "failed", `no test results produced (exit ${r.code})${r.code ? `: ${tail(r.stdout + r.stderr)}` : ""}`];
    else if (envFailures) [status, detail] = ["blocked", `environment errors: ${failed[0].message}`];
    else if (r.code !== 0 || failed.length) [status, detail] = ["failed", `${failed.length} failed${failed[0] ? `: ${failed[0].name}` : `, exit ${r.code}`}`];
    else [status, detail] = ["passed", cases.length ? `${cases.filter((x) => x.status === "passed").length} passed, ${cases.filter((x) => x.status === "skipped").length} skipped` : "exit 0 (no JUnit report configured)"];
    checks.push({ name: "tests", status, detail, durationMs: r.durationMs });
    fs.writeFileSync(path.join(o.runDir, "test-output.log"), r.stdout + "\n" + r.stderr);
  }

  const report: VerificationReport = {
    status: overallStatus(checks),
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
};

export function verificationMarkdown(r: VerificationReport): string {
  const rows = r.checks.map((c) => `| ${c.name} | ${c.status} | ${c.detail.replace(/\|/g, "\\|")} |`);
  const failed = r.cases.filter((x) => x.status === "failed").slice(0, 10);
  return [
    `**Verification: ${STATUS_BADGE[r.status]}** (run by qa-sentinel, not reported by the agent)`,
    "",
    "| Check | Result | Detail |",
    "| --- | --- | --- |",
    ...rows,
    ...(r.counts.total ? ["", `Tests: ${r.counts.passed} passed · ${r.counts.failed} failed · ${r.counts.skipped} skipped (of ${r.counts.total}).`] : []),
    ...(failed.length ? ["", "Failed:", ...failed.map((f) => `- \`${f.name}\` – ${f.message ?? ""}`)] : []),
  ].join("\n");
}
