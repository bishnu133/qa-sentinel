import { spawn, spawnSync } from "node:child_process";
import { log } from "./log.js";

export interface ClaudeRunOptions {
  cwd: string;
  prompt: string;
  maxTurns: number;
  allowedTools: string[];
  addDirs?: string[];
  model?: string;
  dryRun?: boolean;
}

export interface ClaudeRunResult {
  ok: boolean;
  result: string;
  costUsd?: number;
  turns?: number;
  durationMs?: number;
  raw?: unknown;
}

export function claudeAvailable(): { ok: boolean; version?: string } {
  const r = spawnSync("claude", ["--version"], { encoding: "utf8" });
  if (r.error || r.status !== 0) return { ok: false };
  return { ok: true, version: r.stdout.trim() };
}

export function buildClaudeArgs(o: ClaudeRunOptions): string[] {
  const args = ["-p", o.prompt, "--output-format", "json", "--max-turns", String(o.maxTurns)];
  if (o.allowedTools.length) args.push("--allowedTools", o.allowedTools.join(","));
  for (const d of o.addDirs ?? []) args.push("--add-dir", d);
  if (o.model) args.push("--model", o.model);
  return args;
}

/** Run Claude Code headless and parse its JSON result. */
export async function runClaude(o: ClaudeRunOptions): Promise<ClaudeRunResult> {
  const args = buildClaudeArgs(o);
  if (o.dryRun) {
    log.dim("[dry-run] claude " + args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" "));
    return { ok: true, result: "(dry run: Claude was not invoked)" };
  }
  return new Promise((resolve) => {
    const child = spawn("claude", args, { cwd: o.cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => {
      stderr += d;
      process.stderr.write(d);
    });
    child.on("error", (err) => resolve({ ok: false, result: `Could not start claude: ${err.message}` }));
    child.on("close", (code) => {
      try {
        const json = JSON.parse(stdout.trim().split("\n").pop() ?? "{}");
        resolve({
          ok: code === 0 && !json.is_error,
          result: String(json.result ?? ""),
          costUsd: json.total_cost_usd ?? json.cost_usd,
          turns: json.num_turns,
          durationMs: json.duration_ms,
          raw: json,
        });
      } catch {
        resolve({ ok: false, result: stdout || stderr || `claude exited with code ${code}` });
      }
    });
  });
}

export function formatUsage(r: ClaudeRunResult): string {
  const parts: string[] = [];
  if (r.turns !== undefined) parts.push(`${r.turns} turns`);
  if (r.durationMs !== undefined) parts.push(`${Math.round(r.durationMs / 1000)}s`);
  if (r.costUsd !== undefined) parts.push(`$${r.costUsd.toFixed(2)}`);
  return parts.join(" · ");
}
