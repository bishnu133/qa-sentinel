import type { Config } from "../config.js";
import { jiraContext } from "../scm/jira.js";
import { log } from "../log.js";
import { type JobHandle, beginJob, endJob, jobPolicy } from "./jobs.js";
import { type JobKind, type RecordStore, fileStore, jiraStore } from "./record.js";

/** The configured record store. A Jira store that can't be set up (no credentials, no URL) falls back to files, with a warning. */
export function openStore(cwd: string, c: Config, env: NodeJS.ProcessEnv = process.env): RecordStore {
  if (c.automation.record === "jira") {
    const ctx = jiraContext(c.requirements.jira.baseUrl, env);
    if (ctx) return jiraStore(cwd, ctx);
    log.warn("automation.record is jira, but there is no Jira URL or credentials here: the story record is kept in files only");
  }
  return fileStore(cwd);
}

/** Exit code for a job that was not started because of its limits (a budget, too many failures): not an error in the code, but it needs a person. */
export const EXIT_LIMIT = 4;

export type JobStart = { run: true; store: RecordStore; handle: JobHandle } | { run: false; exitCode: number };

export interface StartJobOptions {
  cwd: string;
  c: Config;
  story: string;
  kind: JobKind;
  key: string;
  force?: boolean;
  once?: boolean;
  env?: NodeJS.ProcessEnv;
}

/**
 * Claim an AI job before spending anything. Returns what to do: run (with the handle that counts its cost), or stop
 * with an exit code: 0 when the same work is done or running (nothing to do), EXIT_LIMIT when a limit stopped it.
 */
export async function startJob(o: StartJobOptions): Promise<JobStart> {
  const store = openStore(o.cwd, o.c, o.env);
  let r;
  try {
    r = await beginJob(store, { story: o.story, kind: o.kind, key: o.key, policy: jobPolicy(o.c, { force: o.force, once: o.once }, o.env), budgets: o.c.automation.budgets });
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
    return { run: false, exitCode: 0 };
  }
  log.fail(r.message);
  return { run: false, exitCode: EXIT_LIMIT };
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
