import { spawnSync } from "node:child_process";
import { log } from "./log.js";
import { runProcess } from "./proc.js";

export interface ClaudeRunOptions {
  cwd: string;
  prompt: string;
  maxTurns: number;
  /** Tools that exist in the session at all (`--tools`). */
  tools: string[];
  /** Pre-approved rules (`--allowedTools`); everything else is denied because the mode is dontAsk. */
  allow: string[];
  /** Deny rules, passed through `--settings`. */
  deny: string[];
  addDirs?: string[];
  model?: string;
  maxBudgetUsd?: number;
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
  dryRun?: boolean;
}

export type ClaudeStatus = "ok" | "error" | "timeout" | "max-turns" | "max-budget";

export interface ClaudeRunResult {
  ok: boolean;
  status: ClaudeStatus;
  result: string;
  costUsd?: number;
  turns?: number;
  durationMs?: number;
  /** Tool calls Claude Code refused (from the result JSON), for diagnosing over-tight permissions. */
  denials?: unknown[];
  raw?: unknown;
}

export function claudeAvailable(): { ok: boolean; version?: string } {
  const r = spawnSync("claude", ["--version"], { encoding: "utf8" });
  if (r.error || r.status !== 0) return { ok: false };
  return { ok: true, version: r.stdout.trim() };
}

export function buildClaudeArgs(o: ClaudeRunOptions): string[] {
  const args = [
    "-p",
    o.prompt,
    "--output-format",
    "json",
    "--max-turns",
    String(o.maxTurns),
    "--permission-mode",
    "dontAsk",
    "--tools",
    o.tools.join(","),
  ];
  if (o.allow.length) args.push("--allowedTools", o.allow.join(","));
  if (o.deny.length) args.push("--settings", JSON.stringify({ permissions: { deny: o.deny } }));
  for (const d of o.addDirs ?? []) args.push("--add-dir", d);
  if (o.model) args.push("--model", o.model);
  if (o.maxBudgetUsd !== undefined) args.push("--max-budget-usd", String(o.maxBudgetUsd));
  return args;
}

/** Raised when Claude can't be used at all (no key, rate limit, API down): stop, don't write a fallback report. */
export class ClaudeAccessError extends Error {}

/** Account or API problems that no retry or repair round can fix. Returns a short, actionable message. */
export function accessProblem(json: any): string | undefined {
  const text = String(json?.result ?? "");
  const status = json?.api_error_status;
  if (/not logged in|please run \/login|invalid x-api-key|authentication_error/i.test(text) || status === 401)
    return "Claude Code has no valid credentials. Set ANTHROPIC_API_KEY (check with: echo ${#ANTHROPIC_API_KEY}) and test with: claude -p \"reply with OK\"";
  if (status === 429 || /rate limit|\(429\)/i.test(text))
    return `The Anthropic API refused the request (rate limit). Check the key's workspace limits and credits in the Anthropic Console.\n  ${text.slice(0, 300)}`;
  if (status === 403 || /credit balance|billing/i.test(text))
    return `The Anthropic account can't be used (billing or permissions).\n  ${text.slice(0, 300)}`;
  if (json?.terminal_reason === "api_error" && (json?.num_turns ?? 0) <= 1 && !json?.total_cost_usd)
    return `The Anthropic API could not be used: ${text.slice(0, 300)}`;
  return undefined;
}

export function statusFromJson(json: any, code: number | null): ClaudeStatus {
  const sub = String(json?.subtype ?? "");
  if (sub.includes("max_turns")) return "max-turns";
  if (sub.includes("budget")) return "max-budget";
  if (code === 0 && !json?.is_error && (sub === "" || sub === "success")) return "ok";
  return "error";
}

/** Run Claude Code headless with a hard timeout, a budget cap and a scrubbed environment. */
export async function runClaude(o: ClaudeRunOptions): Promise<ClaudeRunResult> {
  const args = buildClaudeArgs(o);
  if (o.dryRun) {
    log.dim("[dry-run] claude " + args.map((a) => (/[\s"{]/.test(a) ? JSON.stringify(a) : a)).join(" "));
    return { ok: true, status: "ok", result: "(dry run: Claude was not invoked)" };
  }
  const started = Date.now();
  const heartbeat = setInterval(() => {
    const s = Math.round((Date.now() - started) / 1000);
    log.dim(`  … agent working (${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s)`);
  }, 30_000);
  heartbeat.unref();
  const r = await runProcess("claude", args, { cwd: o.cwd, env: o.env, timeoutMs: o.timeoutMs, echoStderr: true }).finally(() =>
    clearInterval(heartbeat),
  );
  if (r.error) return { ok: false, status: "error", result: `Could not start claude: ${r.error}` };
  if (r.timedOut) {
    return { ok: false, status: "timeout", result: `Agent run exceeded ${Math.round(o.timeoutMs / 60000)} min and was stopped.`, durationMs: r.durationMs };
  }
  let json: any;
  try {
    json = JSON.parse(r.stdout.trim().split("\n").pop() ?? "{}");
  } catch {
    return { ok: false, status: "error", result: r.stdout || r.stderr || `claude exited with code ${r.code}` };
  }
  const problem = accessProblem(json);
  if (problem) throw new ClaudeAccessError(problem);
  {
    const status = statusFromJson(json, r.code);
    return {
      ok: status === "ok",
      status,
      result: String(json.result ?? json.subtype ?? ""),
      costUsd: json.total_cost_usd ?? json.cost_usd,
      turns: json.num_turns,
      durationMs: json.duration_ms ?? r.durationMs,
      denials: Array.isArray(json.permission_denials) ? json.permission_denials : [],
      raw: json,
    };
  }
}

export function formatUsage(r: Pick<ClaudeRunResult, "turns" | "durationMs" | "costUsd">): string {
  const parts: string[] = [];
  if (r.turns !== undefined) parts.push(`${r.turns} turns`);
  if (r.durationMs !== undefined) parts.push(`${Math.round(r.durationMs / 1000)}s`);
  if (r.costUsd !== undefined) parts.push(`$${r.costUsd.toFixed(2)}`);
  return parts.join(" · ");
}
