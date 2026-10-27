import crypto from "node:crypto";
import fs from "node:fs";
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
  result: z.string().optional(),
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
  const v = { ...p.data, result: p.data.result ?? "" };
  // Any JSON object would otherwise count as success (a stray log line such as {"level":"info"} printed last).
  if (p.data.result === undefined && p.data.ok === undefined && p.data.status === undefined)
    return { ok: false, status: "error", result: 'the engine command\'s JSON has none of "result", "ok" or "status", so it is not an AgentResult' };
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
  /**
   * The environment a non-agent process would get (no Claude, Bedrock or Vertex credentials; only guardrails.passEnv and the
   * test variables). The engine passes on only the task's variables that are also in it.
   */
  cleanEnv?: () => NodeJS.ProcessEnv;
}

const seconds = (ms: number) => (ms >= 120_000 ? `${Math.round(ms / 60_000)} min` : `${Math.max(1, Math.round(ms / 1000))} s`);

/** Ignored paths that a test run makes on its own; changes there are not a sign of anything. */
const NOISY = [/^\.qa-sentinel\//, /^test-results\//, /^playwright-report\//, /^blob-report\//, /^coverage\//, /^node_modules\/\.cache\//, /^node_modules\/\.vite/];

/**
 * What the path guardrail cannot see: git ignores some files (node_modules, .env) and does not list .git itself. Before and
 * after the run we note size and time of every ignored file, and the content of .git/config and the hooks, and report
 * what differs. Not covered: anything outside the repository, and processes the program leaves running.
 */
export function guardSnapshot(cwd: string): Map<string, string> | undefined {
  const git = (args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  const top = git(["rev-parse", "--git-dir"]);
  if (top.status !== 0) return undefined;
  const snap = new Map<string, string>();
  const ign = git(["ls-files", "--others", "--ignored", "--exclude-standard", "-z"]);
  if (ign.status === 0)
    for (const f of ign.stdout.split("\0").filter(Boolean)) {
      if (NOISY.some((r) => r.test(f))) continue;
      try {
        const st = fs.lstatSync(path.join(cwd, f));
        snap.set(f, `${st.size}:${Math.round(st.mtimeMs)}`);
      } catch {
        /* gone */
      }
    }
  const hash = (file: string) => (fs.existsSync(file) && fs.statSync(file).isFile() ? crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") : "-");
  const gp = (name: string) => path.resolve(cwd, git(["rev-parse", "--git-path", name]).stdout.trim());
  snap.set(".git/config", hash(gp("config")));
  const hooks = gp("hooks");
  if (fs.existsSync(hooks)) for (const h of fs.readdirSync(hooks)) if (!h.endsWith(".sample")) snap.set(`.git/hooks/${h}`, hash(path.join(hooks, h)));
  return snap;
}

export function snapshotDiff(before: Map<string, string>, after: Map<string, string>): string[] {
  const out: string[] = [];
  for (const [k, v] of after) if (before.get(k) !== v) out.push(before.has(k) ? `changed ${k}` : `new ${k}`);
  for (const k of before.keys()) if (!after.has(k)) out.push(`removed ${k}`);
  return out;
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
    // The task file lives in the repo's own scratch folder (git-ignored), so a wrapper that mounts the repo can read it too.
    const scratch = path.join(t.cwd, ".qa-sentinel");
    fs.mkdirSync(scratch, { recursive: true });
    const dir = fs.mkdtempSync(path.join(scratch, "engine-"));
    const file = path.join(dir, "task.json");
    const body = JSON.stringify(taskJson(t));
    try {
      fs.writeFileSync(file, body, { mode: 0o600 });
      const line = this.commandLine(file);
      if (t.dryRun) {
        log.dim(`[dry-run] engine command: ${line}`);
        return { ok: true, status: "ok", result: "(dry run: the engine command was not run)" };
      }
      // The program gets only what a plain process would: no Claude, Bedrock or Vertex credentials unless the team listed them
      // in guardrails.passEnv. The task's own variables are kept when they are in that clean set.
      const clean = this.o.cleanEnv?.();
      const env: NodeJS.ProcessEnv = {};
      for (const [k, v] of Object.entries(t.env)) {
        const allowed = clean ? k in clean : !/^(ANTHROPIC_|CLAUDE_)/.test(k) || (this.o.passEnv ?? []).includes(k);
        if (allowed) env[k] = v;
      }
      const before = guardSnapshot(t.cwd);
      const r = await runProcess(line, [], { cwd: t.cwd, env, timeoutMs: t.timeoutMs, shell: true, echoStderr: true, input: body });
      const after = before ? guardSnapshot(t.cwd) : undefined;
      const moved = before && after ? snapshotDiff(before, after) : [];
      if (r.error) return { ok: false, status: "error", result: `could not start the engine command: ${r.error}` };
      if (r.timedOut) return { ok: false, status: "timeout", result: `the engine command exceeded ${seconds(t.timeoutMs)} and was stopped.`, durationMs: r.durationMs };
      if (moved.length) return { ok: false, status: "error", result: `the engine command changed files that git ignores or that control git (${moved.slice(0, 8).join(", ")}${moved.length > 8 ? `, and ${moved.length - 8} more` : ""}); the run is not trusted. Look at them before anything else runs.`, durationMs: r.durationMs };
      const out = parseEngineOutput(r.stdout, r.code, t);
      return { ...out, durationMs: out.durationMs ?? r.durationMs };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}
