import crypto from "node:crypto";
import { authHint, modelRoute, type ModelRoute } from "./modelRoute.js";
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
  /**
   * Seconds to wait for a one-line test call before the real run (default 60; 0 = skip the check). A wrong or
   * stale credential makes Claude Code retry for minutes before it gives up; this finds out in seconds.
   */
  accessCheckSeconds?: number;
  /** Claude Code's built-in Bash sandbox (agent.sandbox). Undefined or not enabled: Claude Code's own default (off). */
  sandbox?: { enabled: boolean; allowedDomains: string[]; failIfUnavailable: boolean };
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
  // One --settings value: the deny rules and, when agent.sandbox is on, the sandbox keys (names as in Claude Code's sandboxing docs).
  const settings: Record<string, unknown> = {
    ...(o.deny.length ? { permissions: { deny: o.deny } } : {}),
    ...(o.sandbox?.enabled ? { sandbox: { enabled: true, failIfUnavailable: o.sandbox.failIfUnavailable, allowUnsandboxedCommands: false, network: { allowedDomains: o.sandbox.allowedDomains } } } : {}),
  };
  if (Object.keys(settings).length) args.push("--settings", JSON.stringify(settings));
  for (const d of o.addDirs ?? []) args.push("--add-dir", d);
  if (o.model) args.push("--model", o.model);
  if (o.maxBudgetUsd !== undefined) args.push("--max-budget-usd", String(o.maxBudgetUsd));
  return args;
}

/** Raised when Claude can't be used at all (no key, rate limit, API down): stop, don't write a fallback report. */
export class ClaudeAccessError extends Error {}

/** Account or API problems that no retry or repair round can fix. Returns a short, actionable message. */
export function accessProblem(json: any, route?: ModelRoute): string | undefined {
  const text = String(json?.result ?? "");
  const status = json?.api_error_status;
  if (/not logged in|please run \/login|invalid x-api-key|authentication_error/i.test(text) || status === 401)
    return authHint(route);
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

// ---------------------------------------------------------------------------------------------
// Access check: find out in seconds, before a long run, whether Claude can be used at all.

export interface AccessCheck {
  ok: boolean;
  /** What is wrong and what to do (set when ok is false). */
  message?: string;
  /** Why no live call was made (already checked in this process, or switched off). */
  skipped?: string;
  /** Not blocking, but worth saying (e.g. the API answered with a temporary error). */
  warning?: string;
  /** Cost of the test call, in USD. */
  costUsd?: number;
  durationMs?: number;
}

/** Problems visible without calling anything: a key with spaces or quotes, a missing region. Undefined = nothing found. */
export function staticAccessProblem(env: NodeJS.ProcessEnv = process.env, route: ModelRoute = modelRoute(env)): string | undefined {
  if (route.missing.length) return authHint(route);
  const key = env.ANTHROPIC_API_KEY;
  if (key !== undefined && key.trim() === "" && (route.kind === "login" || route.kind === "api-key"))
    return "ANTHROPIC_API_KEY is set but empty. Unset it to use your Claude login (unset ANTHROPIC_API_KEY), or set it to your key.";
  if (route.kind === "api-key" && key !== undefined) {
    if (key.trim() === "") return "ANTHROPIC_API_KEY is set but empty. Unset it to use your Claude login (unset ANTHROPIC_API_KEY), or set it to your key.";
    if (key !== key.trim() || /["'\r\n]/.test(key))
      return "ANTHROPIC_API_KEY has a space, a quote or a line break around the key. Set it again without them (the key itself starts with sk-ant-).";
    if (!env.ANTHROPIC_AUTH_TOKEN && !key.startsWith("sk-ant-"))
      return "ANTHROPIC_API_KEY does not start with sk-ant-, so it is not an Anthropic API key. If you meant to use your Claude login, run: unset ANTHROPIC_API_KEY";
  }
  return undefined;
}

const verifiedAccess = new Set<string>();
/** For tests. */
export function resetAccessMemo(): void {
  verifiedAccess.clear();
}
const accessKey = (env: NodeJS.ProcessEnv, model?: string) =>
  crypto.createHash("sha256").update([model ?? "", env.ANTHROPIC_API_KEY ?? "", env.ANTHROPIC_AUTH_TOKEN ?? "", env.ANTHROPIC_BASE_URL ?? "", env.CLAUDE_CODE_USE_BEDROCK ?? "", env.CLAUDE_CODE_USE_VERTEX ?? ""].join("\u0000")).digest("hex");

/**
 * One cheap test call ("reply OK", no tools, one turn) before the first real run of a command. It stops a wrong key,
 * an expired login or an unreachable gateway in under a minute instead of after minutes of retries. The result is
 * remembered for the rest of the process, so a command that runs the agent several times checks once.
 */
export async function checkClaudeAccess(o: { cwd: string; env: NodeJS.ProcessEnv; model?: string; seconds?: number; run?: typeof runProcess }): Promise<AccessCheck> {
  const seconds = o.seconds ?? 60;
  if (seconds <= 0 || /^(1|true|yes)$/i.test(process.env.QA_SENTINEL_SKIP_ACCESS_CHECK ?? "")) return { ok: true, skipped: "switched off" };
  const route = modelRoute(o.env);
  const fixed = staticAccessProblem(o.env, route);
  if (fixed) return { ok: false, message: fixed };
  const key = accessKey(o.env, o.model);
  if (verifiedAccess.has(key)) return { ok: true, skipped: "already checked in this run" };
  const args = ["-p", "Reply with the single word OK.", "--output-format", "json", "--max-turns", "1", "--permission-mode", "dontAsk", "--tools", ""];
  if (o.model) args.push("--model", o.model);
  const r = await (o.run ?? runProcess)("claude", args, { cwd: o.cwd, env: o.env, timeoutMs: seconds * 1000 });
  if (r.error) return { ok: false, message: `Could not start claude: ${r.error}. Install Claude Code and check that \`claude --version\` works.` };
  if (r.timedOut)
    return {
      ok: false,
      durationMs: r.durationMs,
      message:
        `Claude gave no answer within ${seconds}s to a one-word test. That is what a wrong or expired credential, a blocked network or a gateway that is down looks like (Claude Code keeps retrying for minutes).\n  ` +
        authHint(route) +
        `\n  A slow but working setup can raise the wait: agent.accessCheckSeconds in qa-sentinel.config.yaml (0 skips this check).`,
    };
  let json: any;
  try {
    json = JSON.parse(r.stdout.trim().split("\n").pop() ?? "{}");
  } catch {
    const text = (r.stdout || r.stderr || "").trim().slice(0, 300);
    return { ok: false, durationMs: r.durationMs, message: `Claude answered the test call with something unexpected (exit code ${r.code}): ${text || "no output"}\n  ${authHint(route)}` };
  }
  const problem = accessProblem(json, route);
  if (problem) return { ok: false, durationMs: r.durationMs, message: problem };
  const costUsd = json.total_cost_usd ?? json.cost_usd;
  if (json.is_error) return { ok: true, durationMs: r.durationMs, costUsd, warning: `the test call returned an error that is not about access (${String(json.result ?? json.subtype ?? "").slice(0, 200)}); continuing` };
  verifiedAccess.add(key);
  return { ok: true, durationMs: r.durationMs, costUsd };
}

/** Run Claude Code headless with a hard timeout, a budget cap and a scrubbed environment. */
export async function runClaude(o: ClaudeRunOptions): Promise<ClaudeRunResult> {
  const args = buildClaudeArgs(o);
  if (o.dryRun) {
    log.dim("[dry-run] claude " + args.map((a) => (/[\s"{]/.test(a) ? JSON.stringify(a) : a)).join(" "));
    return { ok: true, status: "ok", result: "(dry run: Claude was not invoked)" };
  }
  const access = await checkClaudeAccess({ cwd: o.cwd, env: o.env, model: o.model, seconds: o.accessCheckSeconds });
  if (!access.ok) throw new ClaudeAccessError(access.message ?? "Claude can't be used");
  if (access.warning) log.warn(access.warning);
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
