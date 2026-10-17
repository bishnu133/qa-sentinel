import fs from "node:fs";
import path from "node:path";
import { netFetch } from "./net.js";
import type { Config } from "./config.js";
import type { Finding } from "./guardrails.js";

/**
 * The test-data ledger. Tests that create data (a program, then a company in it, an event, a session…) record each
 * record as they create it, in a JSON-lines file per run (`.qa-data/<run>.jsonl`), together with the request that
 * deletes it. The test fixture deletes them in reverse order when the test ends, pass or fail. When a run is killed
 * before that, the records stay in the file and `qa-sentinel data sweep` deletes the leftovers later.
 *
 * Only relative paths are recorded, and the sweeper sends them to the test environment's base URL: a ledger can't
 * make qa-sentinel call another host.
 */
export interface LedgerLine {
  op: "create" | "delete" | "failed";
  /** Order of creation within the file. */
  seq: number;
  kind?: string;
  id?: string;
  /** How to delete it later, e.g. { method: "DELETE", path: "/events/42" }. Absent: only the test's own cleanup knows how. */
  remove?: { method?: string; path: string };
  test?: string;
  at?: string;
  error?: string;
}

export interface PendingRecord extends LedgerLine {
  file: string;
}

export function readLedger(file: string): LedgerLine[] {
  const out: LedgerLine[] = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // a half-written last line from a killed run
    }
  }
  return out;
}

/** Records created and not deleted yet, newest first (the order to delete them in). */
/**
 * olderThanMinutes: skip ledgers written to in the last N minutes (another run may still be using that data).
 * startedAfter: only ledgers whose first record is from this time on (this run's own tests).
 */
export function pendingRecords(dir: string, o: { olderThanMinutes?: number; startedAfter?: number; now?: number } = {}): PendingRecord[] {
  if (!fs.existsSync(dir)) return [];
  const cutoff = (o.now ?? Date.now()) - (o.olderThanMinutes ?? 0) * 60_000;
  const out: PendingRecord[] = [];
  for (const name of fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"))) {
    const file = path.join(dir, name);
    if (o.olderThanMinutes && fs.statSync(file).mtimeMs > cutoff) continue; // a run that may still be going
    const lines = readLedger(file);
    if (o.startedAfter !== undefined) {
      const first = lines.find((l) => l.op === "create" && l.at)?.at;
      if (!first || Date.parse(first) < o.startedAfter) continue;
    }
    const deleted = new Set(lines.filter((l) => l.op === "delete").map((l) => l.seq));
    for (const l of lines) if (l.op === "create" && !deleted.has(l.seq)) out.push({ ...l, file });
  }
  // Newest first: a session is deleted before its event, the event before its company.
  return out.sort((a, b) => (b.at ?? "").localeCompare(a.at ?? "") || b.seq - a.seq);
}

export interface SweepResult {
  deleted: PendingRecord[];
  failed: (PendingRecord & { error: string })[];
  /** No delete request recorded: someone has to remove these by hand (or the project's own sweeper). */
  manual: PendingRecord[];
}

export interface SweepOptions {
  dir: string;
  baseUrl?: string;
  /** Authorization header value for the deletes, e.g. "Bearer …". */
  authHeader?: string;
  dryRun?: boolean;
  olderThanMinutes?: number;
  startedAfter?: number;
  fetchImpl?: typeof fetch;
}

/** Append a line; a killed run may have left a half-written last line, which must not swallow this one. */
function appendLine(file: string, line: object): void {
  const size = fs.statSync(file).size;
  let lead = "";
  if (size) {
    const fd = fs.openSync(file, "r");
    const b = Buffer.alloc(1);
    fs.readSync(fd, b, 0, 1, size - 1);
    fs.closeSync(fd);
    if (b[0] !== 0x0a) lead = "\n";
  }
  fs.appendFileSync(file, lead + JSON.stringify(line) + "\n");
}

/** A path on the test environment: one leading slash, no backslashes, scheme, encoded slashes or control characters. */
const safePath = (p: string) => /^\/(?!\/)/.test(p) && !/[\\\s]|%5c|%2f%2f|^\/[^/?#]*:/i.test(p);

/** The test environment's URL for a recorded path; undefined when it would land on another origin. */
export function sweepUrl(baseUrl: string, p: string): string | undefined {
  if (!safePath(p)) return undefined;
  const base = new URL(baseUrl);
  const url = new URL(base.pathname.replace(/\/?$/, "/") + p.slice(1), base.origin);
  return url.origin === base.origin ? url.toString() : undefined;
}

export async function sweep(o: SweepOptions): Promise<SweepResult> {
  const r: SweepResult = { deleted: [], failed: [], manual: [] };
  const pending = pendingRecords(o.dir, { olderThanMinutes: o.olderThanMinutes, startedAfter: o.startedAfter });
  const doFetch = o.fetchImpl ?? netFetch;
  for (const rec of pending) {
    if (!rec.remove?.path) {
      r.manual.push(rec);
      continue;
    }
    if (!safePath(rec.remove.path) || (o.baseUrl && !sweepUrl(o.baseUrl, rec.remove.path))) {
      r.failed.push({ ...rec, error: `not a path on the test environment: ${rec.remove.path.slice(0, 80)}` });
      continue;
    }
    if (o.dryRun) {
      r.deleted.push(rec);
      continue;
    }
    if (!o.baseUrl) {
      r.failed.push({ ...rec, error: "no base URL for the test environment" });
      continue;
    }
    try {
      const url = sweepUrl(o.baseUrl, rec.remove.path)!;
      const res = await doFetch(url, { method: (rec.remove.method ?? "DELETE").toUpperCase(), headers: o.authHeader ? { Authorization: o.authHeader } : {} });
      // Gone already (the test's own cleanup got there, or someone deleted it) counts as deleted.
      if (res.ok || res.status === 404 || res.status === 410) {
        appendLine(rec.file, { op: "delete", seq: rec.seq, at: new Date().toISOString() });
        r.deleted.push(rec);
      } else r.failed.push({ ...rec, error: `${res.status}` });
    } catch (e) {
      r.failed.push({ ...rec, error: (e as Error).message.split("\n")[0] });
    }
  }
  if (!o.dryRun) {
    // Fully cleaned files are removed; files with leftovers stay for the next sweep.
    for (const file of new Set(pending.map((p) => p.file))) {
      const lines = readLedger(file);
      const deleted = new Set(lines.filter((l) => l.op === "delete").map((l) => l.seq));
      if (lines.filter((l) => l.op === "create").every((l) => deleted.has(l.seq))) fs.rmSync(file, { force: true });
    }
  }
  return r;
}

export function sweepMarkdown(r: SweepResult, dryRun = false): string {
  const row = (p: PendingRecord, note: string) => `| ${p.kind ?? "–"} | ${p.id ?? "–"} | ${p.test ?? "–"} | ${note} |`;
  const rows = [
    ...r.deleted.map((p) => row(p, dryRun ? `would delete (${p.remove?.method ?? "DELETE"} ${p.remove?.path})` : "deleted")),
    ...r.failed.map((p) => row(p, `❌ ${p.error}`)),
    ...r.manual.map((p) => row(p, "⚠️ no delete request recorded: remove by hand")),
  ];
  if (!rows.length) return "No test data left behind.";
  return [
    `${dryRun ? "Would delete" : "Deleted"} ${r.deleted.length}, failed ${r.failed.length}, by hand ${r.manual.length}.`,
    "",
    "| Kind | Id | Created by test | Result |",
    "| --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
}

/**
 * After qa-sentinel's own test runs (verify, generate): sweep the leftovers of tests started since `startedAt` (not
 * those of another run on the same machine); what can't be deleted becomes a finding.
 */
export async function sweepAfterRun(cwd: string, c: Config, startedAt: number, env: NodeJS.ProcessEnv = process.env): Promise<Finding[]> {
  const dir = path.resolve(cwd, c.testData.ledgerDir);
  if (!pendingRecords(dir, { startedAfter: startedAt }).length) return [];
  const r = await sweep({ dir, baseUrl: env[c.tests.api.baseUrlEnv], authHeader: env[c.testData.sweepAuthEnv], startedAfter: startedAt });
  return [...r.failed, ...r.manual].map((p) => ({
    level: "warning" as const,
    rule: "test-data" as const,
    file: c.testData.ledgerDir,
    message: `${p.kind ?? "record"} ${p.id ?? "?"} created by "${p.test ?? "?"}" was not deleted${"error" in p && p.error ? ` (${p.error})` : " (no delete request recorded)"}`,
  }));
}
