import crypto from "node:crypto";
import os from "node:os";
import type { AgentEngine, AgentResult } from "../engines/AgentEngine.js";
import { log } from "../log.js";
import { type Job, type JobKind, type RecordStore, type StoryRecord, emptyRecord, trimRecord } from "./record.js";

/**
 * AI jobs and their limits.
 *
 * A job is one unit of AI work with a key built from its inputs (the story's ACs, the service commit). The same inputs
 * give the same key, so a pipeline that is retried, started twice or triggered again by the same event can see that
 * the work was already done (or is running) instead of paying for it again. Budgets stop spending per story, per day
 * and per month. Both live in the story record (a cache): with no record, work simply runs, as before.
 */

export interface Budgets {
  perStoryUsd: number;
  perDayUsd: number;
  perMonthUsd: number;
}

export interface JobPolicy {
  /** A job that already finished with the same key is skipped. */
  skipDone: boolean;
  /** A job marked running for longer than this is taken to be dead. */
  lockMinutes: number;
  /** Failed runs of one key before it stops being retried. */
  maxAttempts: number;
  /** Run again even if the same key finished, failed too often, or looks to be running. Never overrides budgets. */
  force: boolean;
}

export const digest = (parts: string[]) => crypto.createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 10);

/** The spec job: the requirements pass for these ACs (hash of each AC's normalised text). */
export const specJobKey = (story: string, acHashes: string[]) => `spec:${story}:${digest([...acHashes].sort())}`;
/** The generate job: tests for this story/service change, at this commit, for these ACs. */
export const generateJobKey = (story: string | undefined, scope: string, head: string, acHashes: string[]) =>
  `generate:${story ?? "-"}:${scope}:${/^[0-9a-f]{7,40}$/i.test(head) ? head.slice(0, 12) : digest([head])}:${digest([...acHashes].sort())}`;

/** What a run must have left in the budget to be worth starting: a run cut short by the cap wastes what it spent. */
export const MIN_USEFUL_USD: Record<JobKind, number> = { spec: 0.1, generate: 1, other: 0.25 };

const day = (d: Date) => d.toISOString().slice(0, 10);
const month = (d: Date) => d.toISOString().slice(0, 7);

export interface BudgetStatus {
  /** The most that may still be spent (Infinity = no limit). */
  remainingUsd: number;
  /** Which limit is the tightest. */
  limit?: "story" | "day" | "month";
  spent: { story: number; day: number; month: number };
  /** Human-readable, set when remainingUsd is below `need`. */
  message?: string;
}

/** Days and months are UTC. The records passed in are what this machine has seen: the day and month totals are only as wide as that. */
export function budgetStatus(b: Budgets, records: StoryRecord[], story: StoryRecord | undefined, need = 0, now = new Date()): BudgetStatus {
  const all = story ? [...records.filter((r) => r.key !== story.key), story] : records;
  const sum = (match: (at: string) => boolean) => all.reduce((a, r) => a + r.ledger.filter((e) => match(e.at)).reduce((x, e) => x + e.costUsd, 0), 0);
  const spent = { story: story?.totalCostUsd ?? 0, day: sum((at) => at.slice(0, 10) === day(now)), month: sum((at) => at.slice(0, 7) === month(now)) };
  const room: [BudgetStatus["limit"], number, string][] = [
    ["story", b.perStoryUsd, `this story has used $${spent.story.toFixed(2)} of its $${b.perStoryUsd} (automation.budgets.perStoryUsd)`],
    ["day", b.perDayUsd, `today (UTC) $${spent.day.toFixed(2)} of $${b.perDayUsd} is used (automation.budgets.perDayUsd)`],
    ["month", b.perMonthUsd, `this month (UTC) $${spent.month.toFixed(2)} of $${b.perMonthUsd} is used (automation.budgets.perMonthUsd)`],
  ];
  let remainingUsd = Infinity;
  let limit: BudgetStatus["limit"];
  let why = "";
  for (const [name, cap, text] of room) {
    if (cap <= 0) continue; // 0 = no limit
    const left = cap - spent[name!];
    if (left < remainingUsd) {
      remainingUsd = Math.max(0, left);
      limit = name;
      why = text;
    }
  }
  const fix = limit === "story" ? "Raise automation.budgets.perStoryUsd in qa-sentinel.config.yaml (a story's total never resets)." : limit === "day" ? "Raise automation.budgets.perDayUsd, or run again after midnight UTC." : "Raise automation.budgets.perMonthUsd, or run again next month (UTC).";
  const message = remainingUsd < need ? `AI budget: ${why}; $${remainingUsd.toFixed(2)} is left, this job needs at least $${need.toFixed(2)}. ${fix}` : undefined;
  return { remainingUsd, limit, spent, message };
}

export interface JobHandle {
  story: string;
  key: string;
  kind: JobKind;
  /** USD this job may still spend: the budget left when it started, less what it has spent. */
  remainingUsd(): number;
  addCost(usd: number): void;
  readonly spentUsd: number;
  note?: string;
}

export type BeginResult =
  | { run: true; handle: JobHandle; notes: string[] }
  | { run: false; reason: "done" | "running" | "attempts" | "budget"; message: string };

/** Is the process that holds a job still there? Only known for this machine; anything else counts as alive until the lock expires. */
export function ownerAlive(owner: string | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  const m = /^(.*):(\d+)$/.exec(owner ?? "");
  if (!m || m[1] !== os.hostname()) return true;
  // CI containers often share a host name (and reuse low PIDs), so a missing PID there proves nothing: wait for the lock to expire.
  if (truthy(env.CI)) return true;
  try {
    process.kill(Number(m[2]), 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

const ago = (iso: string, now: Date) => {
  const m = Math.max(0, Math.round((now.getTime() - Date.parse(iso)) / 60000));
  return m < 60 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
};

export interface BeginOptions {
  story: string;
  kind: JobKind;
  key: string;
  policy: JobPolicy;
  budgets: Budgets;
  now?: Date;
}

export type Gate = { ok: true; notes: string[]; expire?: boolean } | { ok: false; reason: "done" | "running" | "attempts"; message: string };

/** Can a job with this key start, given what the record says about its earlier runs? Pure: nothing is changed. */
export function jobGate(key: string, prev: Job | undefined, policy: JobPolicy, now: Date): Gate {
  const notes: string[] = [];
  let expire = false;
  if (prev?.state === "running") {
    // A run on this machine whose process is gone (Ctrl-C, crash) is dead at once; others are dead after the lock time.
    const alive = now.getTime() - Date.parse(prev.startedAt) < policy.lockMinutes * 60_000 && ownerAlive(prev.owner);
    if (alive && !policy.force)
      return { ok: false, reason: "running", message: `${key} is already running (started ${ago(prev.startedAt, now)}${prev.owner ? ` by ${prev.owner}` : ""}). If that run died, wait ${policy.lockMinutes} min or use --force.` };
    notes.push(alive ? `--force: starting although ${key} was marked running ${ago(prev.startedAt, now)}` : `${key} was marked running ${ago(prev.startedAt, now)}; that run never finished, so it is started again`);
    expire = true;
  }
  const last = expire ? undefined : prev;
  if (last?.state === "done" && policy.skipDone && !policy.force)
    return { ok: false, reason: "done", message: `${key} was already done ${last.finishedAt ? ago(last.finishedAt, now) : ""}${last.outcome ? ` (${last.outcome})` : ""}, $${last.costUsd.toFixed(2)}. Nothing has changed since; use --force to run it again.` };
  if (last?.state === "failed" && last.attempts >= policy.maxAttempts && !policy.force)
    return { ok: false, reason: "attempts", message: `${key} failed ${last.attempts} times with these exact inputs (last: ${last.outcome ?? last.error ?? "unknown"}). Fix the cause (the story, the config), or use --force.` };
  return { ok: true, notes, ...(expire ? { expire } : {}) };
}

/** Claim a job: refuse when the same work is done, running or has failed too often, or when the budget is used up. */
export async function beginJob(store: RecordStore, o: BeginOptions): Promise<BeginResult> {
  const now = o.now ?? new Date();
  return store.locked(o.story, async () => {
    const rec = (await store.load(o.story)) ?? emptyRecord(o.story, now);
    const prev = rec.jobs[o.key];
    const gate = jobGate(o.key, prev, o.policy, now);
    if (!gate.ok) return { run: false as const, reason: gate.reason, message: gate.message };
    if (gate.expire && prev) rec.jobs[o.key] = { ...prev, state: "aborted", finishedAt: now.toISOString(), error: "the run never finished (lock expired)" };
    const last = rec.jobs[o.key];
    const need = MIN_USEFUL_USD[o.kind];
    const status = budgetStatus(o.budgets, await store.list(), rec, need, now);
    if (status.message) return { run: false as const, reason: "budget" as const, message: status.message };
    const job: Job = {
      key: o.key,
      kind: o.kind,
      state: "running",
      startedAt: now.toISOString(),
      attempts: last?.attempts ?? 0,
      costUsd: last?.costUsd ?? 0,
      owner: `${os.hostname()}:${process.pid}`,
    };
    rec.jobs[o.key] = job;
    rec.updatedAt = now.toISOString();
    await store.save(rec);
    let spent = 0;
    const handle: JobHandle = {
      story: o.story,
      key: o.key,
      kind: o.kind,
      remainingUsd: () => status.remainingUsd - spent,
      addCost: (usd) => {
        if (Number.isFinite(usd) && usd > 0) spent += usd;
      },
      get spentUsd() {
        return spent;
      },
    };
    return { run: true as const, handle, notes: gate.notes };
  });
}

export interface EndOptions {
  /** done: the run reached an end the story can live with; failed: it did not (counts as an attempt); aborted: stopped by something outside the story (no credentials, Ctrl-C): not counted. */
  state: "done" | "failed" | "aborted";
  outcome?: string;
  error?: string;
  runId?: string;
  now?: Date;
}

/** Record how a job ended and what it cost. Never throws: bookkeeping must not change the result of the work. */
export async function endJob(store: RecordStore, h: JobHandle, o: EndOptions): Promise<void> {
  const now = o.now ?? new Date();
  try {
    await store.locked(h.story, async () => {
      const rec = (await store.load(h.story)) ?? emptyRecord(h.story, now);
      const j = rec.jobs[h.key] ?? { key: h.key, kind: h.kind, state: "running" as const, startedAt: now.toISOString(), attempts: 0, costUsd: 0 };
      rec.jobs[h.key] = {
        ...j,
        state: o.state,
        finishedAt: now.toISOString(),
        // Failed runs in a row with these inputs: a run that ends done starts the count again.
        attempts: o.state === "done" ? 0 : o.state === "failed" ? j.attempts + 1 : j.attempts,
        costUsd: Math.round((j.costUsd + h.spentUsd) * 1e6) / 1e6,
        ...(o.runId ? { runId: o.runId } : {}),
        ...(o.outcome ? { outcome: o.outcome } : {}),
        ...(o.error ? { error: o.error.slice(0, 400) } : {}),
      };
      if (h.spentUsd > 0) {
        rec.ledger.push({ at: now.toISOString(), job: h.key, kind: h.kind, costUsd: Math.round(h.spentUsd * 1e6) / 1e6 });
        rec.totalCostUsd = Math.round((rec.totalCostUsd + h.spentUsd) * 1e6) / 1e6;
      }
      rec.updatedAt = now.toISOString();
      await store.save(trimRecord(rec, now));
    });
  } catch (e) {
    log.warn(`could not update the story record for ${h.key}: ${(e as Error).message}`);
  }
}

/**
 * The agent engine with the job's budget applied: each call may spend only what is left (`--max-budget-usd` is
 * lowered to it), a call after the budget is gone is refused, and every call's cost is counted.
 */
export function budgetedEngine(inner: AgentEngine, h: JobHandle): AgentEngine {
  return {
    name: inner.name,
    available: () => inner.available(),
    async run(t) {
      const left = h.remainingUsd();
      if (left < 0.01 && !t.dryRun) {
        const r: AgentResult = { ok: false, status: "max-budget", result: "The AI budget for this job is used up; no further agent calls are made." };
        return r;
      }
      const r = await inner.run({ ...t, maxBudgetUsd: Number.isFinite(left) ? Math.min(t.maxBudgetUsd, left) : t.maxBudgetUsd });
      h.addCost(r.costUsd ?? 0);
      return r;
    },
  };
}

const truthy = (v?: string) => Boolean(v) && !/^(0|false|no)$/i.test(v!);

export function jobPolicy(c: { automation: { jobs: { skipDone: "ci" | "always" | "never"; lockMinutes: number; maxAttempts: number } } }, o: { force?: boolean; once?: boolean }, env: NodeJS.ProcessEnv = process.env): JobPolicy {
  const j = c.automation.jobs;
  return { skipDone: o.once || j.skipDone === "always" || (j.skipDone === "ci" && truthy(env.CI)), lockMinutes: j.lockMinutes, maxAttempts: j.maxAttempts, force: Boolean(o.force) };
}

/**
 * How a job ended, from a command's exit code and outcome word. Tests committed (and pushed) are done even when
 * verification was not VERIFIED (waiting for deployment, a failing check): the MR carries them, and generating the
 * same tests again would cost the same and change nothing.
 */
export function endStateOf(code: number, outcome: string): "done" | "failed" {
  return code === 0 || outcome === "dry-run" || outcome.startsWith("committed-") ? "done" : "failed";
}
