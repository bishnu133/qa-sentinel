import path from "node:path";
import { loadConfig } from "../config.js";
import { formatUsage, runClaude } from "../claude.js";
import { matchesAny } from "../fsutil.js";
import { ARTIFACT_GLOBS, agentEnv } from "../run.js";
import { checkPaths, claudePermissions, diffSnapshots, findingsMarkdown, learnPolicy, snapshotTree } from "../guardrails.js";
import { log } from "../log.js";

export interface LearnOptions {
  cwd: string;
  dryRun?: boolean;
}

/**
 * Agent pass that makes the project "agent-ready": learns test conventions into the
 * write-api-test skill and drafts test-map.yaml. Only three files may change; the result is reviewed as a diff.
 */
export async function learnCommand(o: LearnOptions): Promise<number> {
  const cwd = path.resolve(o.cwd);
  const c = loadConfig(cwd);
  log.title("qa-sentinel learn");
  log.step(`mode: ${c.mode}; services: ${c.workspace.services.length}`);

  const before = snapshotTree(cwd);
  const policy = learnPolicy();
  const serviceDirs = c.workspace.services.map((s) => path.resolve(cwd, s.path));
  const perms = claudePermissions({ write: policy, bash: [], readOnlyDirs: serviceDirs });
  const res = await runClaude({
    cwd,
    prompt: [
      "Use the learn-conventions skill.",
      `Update only these files: ${policy.allowed.join(", ")}. Any other change is rejected.`,
      "Finish with a short summary of what you learned and what a human should verify.",
    ].join("\n"),
    maxTurns: c.agent.maxTurns.learn,
    tools: ["Read", "Grep", "Glob", "Agent", "Edit", "Write"],
    allow: perms.allow,
    deny: perms.deny,
    addDirs: serviceDirs,
    model: c.agent.model,
    maxBudgetUsd: c.agent.maxBudgetUsd.learn,
    timeoutMs: c.agent.timeoutMinutes.learn * 60_000,
    env: agentEnv(c),
    dryRun: o.dryRun,
  });
  if (!res.ok) throw new Error(`learn ${res.status}: ${res.result.slice(0, 500)}`);

  const touched = diffSnapshots(before, snapshotTree(cwd)).filter((p) => !matchesAny(p, ARTIFACT_GLOBS));
  const bad = checkPaths(touched.map((p) => ({ path: p, status: "M" })), policy);
  if (bad.length) {
    log.fail("learn changed files it is not allowed to change. Review and revert them:");
    log.info(findingsMarkdown(bad));
    return 1;
  }
  log.info("\n" + res.result.trim());
  const usage = formatUsage(res);
  if (usage) log.dim(usage);
  log.title("Review the changes with `git diff` before committing.");
  return 0;
}
