import type { Config } from "../config.js";
import { jiraContext } from "../scm/jira.js";
import { log } from "../log.js";
import { notifyStory } from "../reporting/notify.js";
import { ClaudeAccessError } from "../claude.js";
import type { AgentEngine } from "../engines/AgentEngine.js";
import { type JobHandle, beginJob, budgetedEngine, endJob, jobPolicy } from "./jobs.js";
import { type JobKind, NO_STORY, type RecordStore, fileStore, jiraStore } from "./record.js";

/** The configured record store. A Jira store that can't be set up (no credentials, no URL) falls back to files, with a warning. */
export function openStore(cwd: string, c: Config, env: NodeJS.ProcessEnv = process.env): RecordStore {
  if (c.automation.record === "jira") {
    const ctx = jiraContext(c.requirements.jira, env);
    if (ctx) return jiraStore(cwd, ctx);
    log.warn("automation.record is jira, but there is no Jira URL or credentials here: the story record is kept in files only");
  }
  return fileStore(cwd);
}

/** Exit code for a job that was not started because of its limits (a budget, too many failures): not an error in the code, but it needs a person. */
export const EXIT_LIMIT = 4;

export type JobStart = { run: true; store: RecordStore; handle: JobHandle } | { run: false; exitCode: number; /** Why it did not start (shown by callers that run several jobs). */ message?: string };

export interface StartJobOptions {
  cwd: string;
  c: Config;
  story: string;
  kind: JobKind;
  key: string;
  force?: boolean;
  once?: boolean;
  env?: NodeJS.ProcessEnv;
  /** See BeginOptions.exclusive. */
  exclusive?: boolean;
}

/**
 * Claim an AI job before spending anything. Returns what to do: run (with the handle that counts its cost), or stop
 * with an exit code: 0 when the same work is done or running (nothing to do), EXIT_LIMIT when a limit stopped it.
 */
export async function startJob(o: StartJobOptions): Promise<JobStart> {
  const store = openStore(o.cwd, o.c, o.env);
  let r;
  try {
    r = await beginJob(store, { story: o.story, kind: o.kind, key: o.key, policy: jobPolicy(o.c, { force: o.force, once: o.once }, o.env), budgets: o.c.automation.budgets, ...(o.exclusive ? { exclusive: true } : {}) });
  } catch (e) {
    // The record is a cache: if it can't be read or written, the work still runs, without job history and limits.
    log.warn(`story record unavailable (${(e as Error).message}); running without job keys and budgets`);
    return { run: true, store, handle: noRecordHandle(o) };
  }
  if (r.run) {
    r.notes.forEach((n) => log.warn(n));
    return { run: true, store, handle: r.handle };
  }
  if (r.reason === "done" || r.reason === "running") {
    log.ok(`skipped: ${r.message}`);
    return { run: false, exitCode: 0, message: r.message };
  }
  log.fail(r.message);
  if (r.reason === "budget" && o.story !== NO_STORY) await notifyStory(o.cwd, o.c, o.story, "stopped-by-budget", `qa-sentinel stopped before starting AI work on this story: ${r.message}`, o.key, o.env, store);
  return { run: false, exitCode: EXIT_LIMIT, message: r.message };
}

/** A handle for a run that has no usable record: counts cost, limits nothing. */
function noRecordHandle(o: StartJobOptions): JobHandle {
  let spent = 0;
  return {
    story: o.story,
    key: o.key,
    kind: o.kind,
    remainingUsd: () => Infinity,
    addCost: (usd) => {
      if (Number.isFinite(usd) && usd > 0) spent += usd;
    },
    get spentUsd() {
      return spent;
    },
  };
}

export { endJob };

/**
 * AI spend that is not a spec or generate job (gap report, story review, tag, lessons, learn): no job key, but the
 * day and month budgets apply and the cost lands in the ledger. `run` gets a function that puts the budget on its
 * engine; `refused` builds the command's result when a limit stops it.
 */
export async function withSpend<T>(
  o: { cwd: string; c: Config; story?: string; label: string; skip?: boolean; env?: NodeJS.ProcessEnv },
  refused: (exitCode: number, message?: string) => T,
  run: (wrap: (e: AgentEngine) => AgentEngine, handle?: JobHandle) => Promise<T>,
  exitCodeOf: (t: T) => number,
): Promise<T> {
  if (o.skip) return run((e) => e);
  const story = (o.story ?? "").toUpperCase() || NO_STORY;
  const start = await startJob({ cwd: o.cwd, c: o.c, story, kind: "other", key: `other:${o.label}:${Date.now().toString(36)}-${process.pid}`, env: o.env });
  if (!start.run) return refused(start.exitCode, start.message);
  try {
    const result = await run((e) => budgetedEngine(e, start.handle), start.handle);
    await endJob(start.store, start.handle, { state: exitCodeOf(result) === 0 ? "done" : "failed", outcome: `${o.label} exit ${exitCodeOf(result)}` });
    return result;
  } catch (e) {
    await endJob(start.store, start.handle, { state: e instanceof ClaudeAccessError ? "aborted" : "failed", outcome: `${o.label} error`, error: (e as Error).message });
    throw e;
  }
}
