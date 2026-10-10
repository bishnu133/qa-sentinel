import type { WritePolicy } from "../guardrails.js";

/**
 * What qa-sentinel asks of an agent runtime. Everything around it (git, requirements, contract diff,
 * plan validation, guardrails, verification, publishing) is engine-independent, so another runtime
 * (Agent SDK, another model provider) only has to implement this interface.
 */
export interface AgentTask {
  kind: "plan" | "repair-plan" | "author" | "learn" | "review";
  cwd: string;
  prompt: string;
  /** Directories the agent may read but never change (service repos). */
  readOnlyDirs: string[];
  /** Paths the agent may change; undefined = read-only task. */
  write?: WritePolicy;
  /** Exact shell command patterns the agent may run (e.g. "npx playwright test --project=api *"). */
  bash: string[];
  maxTurns: number;
  maxBudgetUsd: number;
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
  model?: string;
  dryRun?: boolean;
}

export type AgentStatus = "ok" | "error" | "timeout" | "max-turns" | "max-budget";

export interface AgentResult {
  ok: boolean;
  status: AgentStatus;
  /** The agent's final message (free text; never parsed for decisions). */
  result: string;
  costUsd?: number;
  turns?: number;
  durationMs?: number;
  /** Tool calls the runtime refused. */
  denials?: unknown[];
}

export interface AgentEngine {
  readonly name: string;
  available(): { ok: boolean; version?: string };
  run(task: AgentTask): Promise<AgentResult>;
}

/** Sum usage across several runs of one command (plan + repair + author). */
export function addUsage(...rs: (AgentResult | undefined)[]): Pick<AgentResult, "turns" | "durationMs" | "costUsd"> {
  const xs = rs.filter(Boolean) as AgentResult[];
  const sum = (k: "turns" | "durationMs" | "costUsd") => (xs.some((r) => r[k] !== undefined) ? xs.reduce((a, r) => a + (r[k] ?? 0), 0) : undefined);
  return { turns: sum("turns"), durationMs: sum("durationMs"), costUsd: sum("costUsd") };
}
