import path from "node:path";
import { loadConfig } from "../config.js";
import { formatUsage, runClaude } from "../claude.js";
import { READ_TOOLS } from "../run.js";
import { log } from "../log.js";

export interface LearnOptions {
  cwd: string;
  dryRun?: boolean;
}

/**
 * Agent pass that makes the project "agent-ready": learns test conventions into the
 * write-api-test skill and drafts test-map.yaml. Output is meant to be reviewed as a diff.
 */
export async function learnCommand(o: LearnOptions): Promise<void> {
  const cwd = path.resolve(o.cwd);
  const c = loadConfig(cwd);
  log.title("qa-sentinel learn");
  log.step(`mode: ${c.mode}; services: ${c.workspace.services.length}`);

  const res = await runClaude({
    cwd,
    prompt: [
      "Use the learn-conventions skill.",
      "Update only: .claude/skills/write-api-test/SKILL.md (the 'Project conventions' section),",
      "test-map.yaml, and .claude/qa-sentinel.md (the 'Readiness gaps' section).",
      "Finish with a short summary of what you learned and what a human should verify.",
    ].join("\n"),
    maxTurns: c.agent.maxTurns.learn,
    allowedTools: [...READ_TOOLS, "Edit", "Write"],
    addDirs: c.workspace.services.map((s) => path.resolve(cwd, s.path)),
    model: c.agent.model,
    dryRun: o.dryRun,
  });
  if (!res.ok) throw new Error(`learn failed: ${res.result.slice(0, 500)}`);
  log.info("\n" + res.result.trim());
  const usage = formatUsage(res);
  if (usage) log.dim(usage);
  log.title("Review the changes with `git diff` before committing.");
}
