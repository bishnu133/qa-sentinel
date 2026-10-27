import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { z } from "zod";
import { log } from "../log.js";
import { runProcess } from "../proc.js";
import { quoteWord, wrapTestCommand } from "../wrapper.js";
import type { Config } from "../config.js";
import type { AgentEngine, AgentResult, AgentStatus, AgentTask } from "./AgentEngine.js";

/**
 * A generic engine: any program that reads an AgentTask as JSON and prints an AgentResult as JSON. qa-sentinel ships no
 * vendor engine; this is the plug. What the program may do is decided by qa-sentinel AFTER the run (guardrails: write
 * paths, secrets, deleted tests, verification), exactly as for Claude Code, so the program's own permission system is
 * only a second layer. Contract and limits: docs/ENGINE-COMMAND.md.
 */

/** Version of the task and result JSON. A program may check `version` in the task it reads. */
export const ENGINE_CONTRACT_VERSION = 1;

/** The JSON a command engine reads (stdin, and the file named by {taskFile}). Env VALUES are never in it, only the names. */
export interface EngineTaskJson {
  version: number;
  kind: AgentTask["kind"];
  cwd: string;
  prompt: string;
  readOnlyDirs: string[];
  readDeny: string[];
  write: AgentTask["write"] | null;
  bash: string[];
  maxTurns: number;
  maxBudgetUsd: number;
  timeoutMs: number;
  model: string | null;
  envNames: string[];
}

export function taskJson(t: AgentTask): EngineTaskJson {
  return {
    version: ENGINE_CONTRACT_VERSION,
    kind: t.kind,
    cwd: t.cwd,
    prompt: t.prompt,
    readOnlyDirs: t.readOnlyDirs,
    readDeny: t.readDeny ?? [],
    write: t.write ?? null,
    bash: t.bash,
    maxTurns: t.maxTurns,
    maxBudgetUsd: t.maxBudgetUsd,
    timeoutMs: t.timeoutMs,
    model: t.model ?? null,
    envNames: Object.keys(t.env).sort(),
  };
}

const STATUSES = ["ok", "error", "timeout", "max-turns", "max-budget"] as const;
const ResultSchema = z.object({
  ok: z.boolean().optional(),
  status: z.enum(STATUSES).optional(),
  result: z.string().default(""),
  costUsd: z.number().nonnegative().optional(),
  turns: z.number().nonnegative().optional(),
  durationMs: z.number().nonnegative().optional(),
  denials: z.array(z.unknown()).optional(),
});

/** The last line of stdout that is a JSON object (a program may log before it), or the whole text when that parses. */
function jsonObject(stdout: string): unknown {
  const text = stdout.trim();
  const tries = [text, ...text.split("\n").reverse().map((l) => l.trim()).filter(Boolean)];
  for (const t of tries) {
    try {
      const v = JSON.parse(t);
      if (v && typeof v === "object" && !Array.isArray(v)) return v;
    } catch {
      /* next */
    }
  }
  return undefined;
}

/**
 * Turn what the program printed into an AgentResult. Missing `ok`/`status` are derived from each other; a non-zero exit
 * is never ok; cost or turns over the task's limits are reported as max-budget / max-turns (the program cannot be stopped
 * half way for them, so this is a check after the fact, and the program should stop itself).
 */
export function parseEngineOutput(stdout: string, exitCode: number | null, t: Pick<AgentTask, "maxTurns" | "maxBudgetUsd">): AgentResult {
  const raw = jsonObject(stdout);
  if (raw === undefined) return { ok: false, status: "error", result: `the engine command printed no JSON object on stdout (exit ${exitCode}): ${stdout.trim().slice(0, 200) || "nothing"}` };
  const p = ResultSchema.safeParse(raw);
  if (!p.success) return { ok: false, status: "error", result: `the engine command's JSON is not an AgentResult: ${p.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ").slice(0, 300)}` };
  const v = p.data;
  let status: AgentStatus = v.status ?? (v.ok === false ? "error" : "ok");
  if (v.ok === false && status === "ok") status = "error"; // contradictory: the worse word wins
  let result = v.result;
  if (exitCode !== 0 && status === "ok") {
    status = "error";
    result = `the engine command exited with code ${exitCode}${result ? `: ${result}` : ""}`;
  }
  if (status === "ok" && v.costUsd !== undefined && v.costUsd > t.maxBudgetUsd) {
    status = "max-budget";
    result = `the engine reported $${v.costUsd.toFixed(2)}, over the $${t.maxBudgetUsd} limit${result ? `: ${result}` : ""}`;
  }
  if (status === "ok" && v.turns !== undefined && v.turns > t.maxTurns) {
    status = "max-turns";
    result = `the engine reported ${v.turns} turns, over the limit of ${t.maxTurns}${result ? `: ${result}` : ""}`;
  }
  return { ok: status === "ok", status, result, costUsd: v.costUsd, turns: v.turns, durationMs: v.durationMs, denials: v.denials };
}

export interface CommandEngineOptions {
  command: string;
  /** verification.wrapCommand: the engine command runs inside it, like the test commands. */
  wrapCommand?: string;
  sandbox?: { enabled: boolean; failIfUnavailable: boolean };
  /** Variable names the program may receive that look like Claude credentials (ANTHROPIC_*, CLAUDE_*): only those in guardrails.passEnv. */
  passEnv?: string[];
}

export class CommandEngine implements AgentEngine {
  readonly name = "command";

  constructor(private readonly o: CommandEngineOptions) {}

  /** The first word of the command must be something the shell can find (a path or a program on PATH). */
  available(): { ok: boolean; version?: string } {
    const first = this.o.command.trim().split(/\s+/)[0] ?? "";
    if (!first) return { ok: false };
    if (!/^[\w./~@+-]+$/.test(first)) return { ok: true }; // quoted or composed: cannot tell without running it
    const r = spawnSync("sh", ["-c", `command -v ${first}`], { encoding: "utf8" });
    return { ok: r.status === 0 };
  }

  /** The command as the shell will get it, with {taskFile} filled in and the wrapper applied. */
  commandLine(taskFile: string): string {
    const filled = this.o.command.split("{taskFile}").join(quoteWord(taskFile));
    return wrapTestCommand({ verification: { wrapCommand: this.o.wrapCommand } } as Pick<Config, "verification">, filled);
  }

  async run(t: AgentTask): Promise<AgentResult> {
    // agent.sandbox is Claude Code's own sandbox and does not apply to a program we do not know. Asking for it without a
    // wrapper that isolates the program would look safe and not be, so stop.
    if (this.o.sandbox?.enabled && this.o.sandbox.failIfUnavailable && !this.o.wrapCommand)
      return { ok: false, status: "error", result: "agent.sandbox is on, but it only covers Claude Code. For agent.engine: command set verification.wrapCommand (a container or similar that isolates the program), or set agent.sandbox.failIfUnavailable: false to accept running it unsandboxed." };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qas-engine-"));
    const file = path.join(dir, "task.json");
    const body = JSON.stringify(taskJson(t));
    try {
      fs.writeFileSync(file, body, { mode: 0o600 });
      const line = this.commandLine(file);
      if (t.dryRun) {
        log.dim(`[dry-run] engine command: ${line}`);
        return { ok: true, status: "ok", result: "(dry run: the engine command was not run)" };
      }
      // The program gets the agent environment, minus Claude credentials unless the team listed them in guardrails.passEnv.
      const env: NodeJS.ProcessEnv = {};
      for (const [k, v] of Object.entries(t.env)) if (!/^(ANTHROPIC_|CLAUDE_)/.test(k) || (this.o.passEnv ?? []).includes(k)) env[k] = v;
      const r = await runProcess(line, [], { cwd: t.cwd, env, timeoutMs: t.timeoutMs, shell: true, echoStderr: true, input: body });
      if (r.error) return { ok: false, status: "error", result: `could not start the engine command: ${r.error}` };
      if (r.timedOut) return { ok: false, status: "timeout", result: `the engine command exceeded ${Math.round(t.timeoutMs / 60000)} min and was stopped.`, durationMs: r.durationMs };
      const out = parseEngineOutput(r.stdout, r.code, t);
      return { ...out, durationMs: out.durationMs ?? r.durationMs };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}
