import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { getIssueProperty, setIssueProperty, type JiraContext } from "../scm/jira.js";
import { log } from "../log.js";

/**
 * The story record: one small file per story with what qa-sentinel last saw and did (acceptance-criteria hashes,
 * the last background check, AI jobs and what they cost). It is a CACHE. The truth is always recomputed from Jira,
 * the expected/ file and the tests; deleting a record loses job history and spend counts, never a decision.
 */

export const RECORD_VERSION = 1;
/** Ledger entries older than this are dropped (the month budget needs the current month; a margin covers a long month). */
export const LEDGER_DAYS = 62;
const MAX_JOBS = 60;
/** Jira issue properties hold 32 KB; stay well under it. */
const JIRA_MAX_BYTES = 28_000;

export const JobKind = z.enum(["spec", "generate", "other"]);
export type JobKind = z.infer<typeof JobKind>;

export const JobSchema = z.object({
  key: z.string(),
  kind: JobKind,
  /** running: started and not finished (a crashed run stays here until the lock expires); aborted: stopped by something outside the story (no credentials, Ctrl-C). */
  state: z.enum(["running", "done", "failed", "aborted"]),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  /** Failed runs in a row with this key (a done run resets it; aborted runs and expired locks are not counted). */
  attempts: z.number().int().min(0).default(0),
  /** Cost of all runs with this key, USD. */
  costUsd: z.number().min(0).default(0),
  runId: z.string().optional(),
  outcome: z.string().optional(),
  error: z.string().optional(),
  /** host:pid of the run holding the job, to tell a live run from a dead one. */
  owner: z.string().optional(),
});
export type Job = z.infer<typeof JobSchema>;

export const LedgerEntrySchema = z.object({ at: z.string(), job: z.string(), kind: JobKind, costUsd: z.number().min(0) });
export type LedgerEntry = z.infer<typeof LedgerEntrySchema>;

export const StoryRecordSchema = z.object({
  version: z.literal(RECORD_VERSION),
  key: z.string(),
  updatedAt: z.string(),
  /** What Jira said at the last check. */
  jira: z
    .object({ status: z.string().optional(), issueType: z.string().optional(), updated: z.string().optional(), url: z.string().optional(), labels: z.array(z.string()).default([]) })
    .optional(),
  /** The ACs as the last check saw them: id and hash of the normalised text. */
  acs: z.array(z.object({ id: z.string(), hash: z.string() })).default([]),
  /** The last background check's verdict (see stories/assess.ts). */
  lastCheck: z.object({ at: z.string(), state: z.string(), next: z.string(), reasons: z.array(z.string()).default([]) }).optional(),
  jobs: z.record(JobSchema).default({}),
  /** Spend by time, for the day and month budgets. */
  ledger: z.array(LedgerEntrySchema).default([]),
  /** All AI spend on this story, USD (the ledger is trimmed; this is not). */
  totalCostUsd: z.number().min(0).default(0),
});
export type StoryRecord = z.infer<typeof StoryRecordSchema>;

export const emptyRecord = (key: string, now = new Date()): StoryRecord => ({ version: RECORD_VERSION, key, updatedAt: now.toISOString(), acs: [], jobs: {}, ledger: [], totalCostUsd: 0 });

/** A story key becomes a file name: keep it to plain characters, so no key can point outside the records folder. */
export const SAFE_KEY = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;
export function assertSafeKey(key: string): string {
  if (!SAFE_KEY.test(key) || key.includes("..")) throw new Error(`"${key}" can't be used as a story key for the record (letters, digits, - _ . only)`);
  return key;
}

/** Key for work that belongs to no story (a service change without one, repo-wide commands). */
export const NO_STORY = "_no-story";

export interface RecordStore {
  readonly kind: "file" | "jira";
  load(key: string): Promise<StoryRecord | undefined>;
  save(rec: StoryRecord): Promise<void>;
  /** Run `fn` while no other process on this machine changes this story's record. */
  locked<T>(key: string, fn: () => Promise<T>): Promise<T>;
  /** Every record this machine has (for budgets and the overview). Jira-held records of other runners are not included. */
  list(): Promise<StoryRecord[]>;
  /** Where records are kept, for messages. */
  where: string;
}

export const recordsDir = (cwd: string) => path.join(cwd, ".qa-sentinel", "stories");

const owner = () => `${os.hostname()}:${process.pid}`;

// ---------------------------------------------------------------------------------------------
// Files

/** Parse a record file; a damaged one is moved aside (never silently overwritten) and treated as missing. */
function readRecordFile(file: string, key: string): StoryRecord | undefined {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed = StoryRecordSchema.safeParse(JSON.parse(text));
    if (parsed.success && parsed.data.key === key) return parsed.data;
    throw new Error(parsed.success ? `it belongs to ${parsed.data.key}` : parsed.error.issues[0]?.message ?? "invalid");
  } catch (e) {
    const aside = `${file}.damaged-${Date.now()}`;
    try {
      fs.renameSync(file, aside);
      log.warn(`story record ${path.basename(file)} could not be read (${(e as Error).message}); moved to ${path.basename(aside)}, starting a new one. It only held job history and spend counts.`);
    } catch {
      log.warn(`story record ${path.basename(file)} could not be read (${(e as Error).message})`);
    }
    return undefined;
  }
}

function writeAtomic(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

const LOCK_STALE_MS = 30_000;

async function withFileLock<T>(lockFile: string, fn: () => Promise<T>): Promise<T> {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      const fd = fs.openSync(lockFile, "wx");
      fs.writeSync(fd, `${owner()} ${new Date().toISOString()}`);
      fs.closeSync(fd);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      try {
        if (Date.now() - fs.statSync(lockFile).mtimeMs > LOCK_STALE_MS) fs.unlinkSync(lockFile);
      } catch {
        /* released meanwhile */
      }
      if (Date.now() > deadline) throw new Error(`the story record is locked by another qa-sentinel process (${lockFile}); if none is running, delete that file`);
      await new Promise((r) => setTimeout(r, 40));
    }
  }
  try {
    return await fn();
  } finally {
    try {
      fs.unlinkSync(lockFile);
    } catch {
      /* already gone */
    }
  }
}

export function fileStore(cwd: string): RecordStore {
  const dir = recordsDir(cwd);
  const fileOf = (key: string) => path.join(dir, `${assertSafeKey(key)}.json`);
  return {
    kind: "file",
    where: path.relative(cwd, dir) || dir,
    async load(key) {
      return readRecordFile(fileOf(key), key);
    },
    async save(rec) {
      writeAtomic(fileOf(rec.key), JSON.stringify(trimRecord(rec), null, 2) + "\n");
    },
    locked: (key, fn) => withFileLock(`${fileOf(key)}.lock`, fn),
    async list() {
      let names: string[] = [];
      try {
        names = fs.readdirSync(dir);
      } catch {
        return [];
      }
      return names
        .filter((n) => n.endsWith(".json"))
        .map((n) => readRecordFile(path.join(dir, n), n.slice(0, -".json".length)))
        .filter((r): r is StoryRecord => Boolean(r));
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Jira (a copy on the story itself, so a CI runner without a cache still knows what was done)

export const JIRA_PROPERTY = "qa-sentinel.record";

/**
 * Records kept in a Jira issue property AND the local file. Jira is read first (it is shared by every runner), the
 * file is the fallback and is always written. When Jira can't be reached the run goes on with the file and says so:
 * the record is a cache, so a Jira outage must not stop test work. Jira has no compare-and-set: two runners starting
 * the same job at the same moment can both win (the files only protect one machine).
 */
export function jiraStore(cwd: string, ctx: JiraContext): RecordStore {
  const local = fileStore(cwd);
  let warned = false;
  const warn = (what: string, e: unknown) => {
    if (warned) return;
    warned = true;
    log.warn(`story record: Jira ${what} failed (${(e as Error).message.slice(0, 160)}); using the local copy only`);
  };
  return {
    kind: "jira",
    where: `Jira issue property ${JIRA_PROPERTY} (and ${local.where})`,
    async load(key) {
      const mine = await local.load(key);
      if (key === NO_STORY) return mine;
      try {
        const raw = await getIssueProperty<unknown>(ctx, key, JIRA_PROPERTY);
        const parsed = raw === undefined ? undefined : StoryRecordSchema.safeParse(raw);
        if (!parsed?.success) return mine;
        // Whichever copy was saved last wins; both only ever grow forward.
        return !mine || parsed.data.updatedAt >= mine.updatedAt ? parsed.data : mine;
      } catch (e) {
        warn("read", e);
        return mine;
      }
    },
    async save(rec) {
      await local.save(rec);
      if (rec.key === NO_STORY) return;
      try {
        await setIssueProperty(ctx, rec.key, JIRA_PROPERTY, fitForJira(trimRecord(rec)));
      } catch (e) {
        warn("write", e);
      }
    },
    locked: (key, fn) => local.locked(key, fn),
    list: () => local.list(),
  };
}

/** Drop what the record doesn't need to keep: old ledger entries and the oldest finished jobs. */
/** Which jobs to drop first: finished "other" jobs (never looked up by key), then the oldest; running jobs last. */
const dropOrder = (a: Job, b: Job) => {
  const rank = (j: Job) => (j.state === "running" ? 2 : j.kind === "other" ? 0 : 1);
  return rank(a) - rank(b) || (a.finishedAt ?? a.startedAt).localeCompare(b.finishedAt ?? b.startedAt);
};

export function trimRecord(rec: StoryRecord, now = new Date()): StoryRecord {
  const cutoff = new Date(now.getTime() - LEDGER_DAYS * 86_400_000).toISOString();
  const ledger = rec.ledger.filter((e) => e.at >= cutoff);
  const jobs = Object.values(rec.jobs);
  if (jobs.length <= MAX_JOBS) return { ...rec, ledger };
  const keep = [...jobs].sort(dropOrder).slice(jobs.length - MAX_JOBS);
  return { ...rec, ledger, jobs: Object.fromEntries(keep.map((j) => [j.key, j])) };
}

/** Shrink a record until it fits a Jira issue property. */
export function fitForJira(rec: StoryRecord): StoryRecord {
  let r = rec;
  const size = (x: StoryRecord) => Buffer.byteLength(JSON.stringify(x));
  while (size(r) > JIRA_MAX_BYTES && (r.ledger.length > 10 || Object.keys(r.jobs).length > 5)) {
    const jobs = Object.values(r.jobs).sort(dropOrder);
    const dropJob = Object.keys(r.jobs).length > 5 && r.ledger.length <= Object.keys(r.jobs).length;
    r = dropJob ? { ...r, jobs: Object.fromEntries(Object.entries(r.jobs).filter(([k]) => k !== jobs[0].key)) } : { ...r, ledger: r.ledger.slice(Math.ceil(r.ledger.length * 0.2)) };
  }
  return r;
}
