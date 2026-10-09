import { claudeAvailable, runClaude } from "../claude.js";
import { claudePermissions } from "../guardrails.js";
import type { Config } from "../config.js";
import type { AgentEngine, AgentResult, AgentTask } from "./AgentEngine.js";

/** Claude Code in headless mode, with dontAsk permissions derived from the task's policy. */
export class ClaudeCodeEngine implements AgentEngine {
  readonly name = "claude-code";

  available() {
    return claudeAvailable();
  }

  async run(t: AgentTask): Promise<AgentResult> {
    const perms = claudePermissions({ write: t.write, bash: t.bash, readOnlyDirs: t.readOnlyDirs });
    const tools = ["Read", "Grep", "Glob", "Agent", ...(t.write ? ["Edit", "Write"] : []), ...(t.bash.length ? ["Bash"] : [])];
    const r = await runClaude({
      cwd: t.cwd,
      prompt: t.prompt,
      maxTurns: t.maxTurns,
      tools,
      allow: perms.allow,
      deny: perms.deny,
      addDirs: t.readOnlyDirs,
      model: t.model,
      maxBudgetUsd: t.maxBudgetUsd,
      timeoutMs: t.timeoutMs,
      env: t.env,
      dryRun: t.dryRun,
    });
    return { ok: r.ok, status: r.status, result: r.result, costUsd: r.costUsd, turns: r.turns, durationMs: r.durationMs, denials: r.denials };
  }
}

export function engineFor(c: Config): AgentEngine {
  switch (c.agent.engine) {
    case "claude-code":
      return new ClaudeCodeEngine();
  }
}
