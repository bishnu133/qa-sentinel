import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { Config } from "../config.js";
import { type IndexedTest, parseTags } from "./testIndex.js";
import { normaliseEndpoint } from "../plan/risk.js";

/**
 * Risk from history, no AI. Only data qa-sentinel or the team already keeps is read; no incident tool is called.
 *   1. known-defect tests (test.fail with an @endpoint tag): a confirmed product defect lives there,
 *   2. flaky tests: `flakyKeys` ("file::name") in .qa-sentinel/runs/<run>/verification.json inside the last
 *      `risk.history.days` days, matched to the test index by file and exact title (tags stripped), one signal per
 *      test per day however many runs saw it. Run folders are not kept in CI (they are git-ignored and only uploaded as
 *      job artifacts), so this source works where the runs folder is kept (a laptop, a persistent runner).
 *   3. the team's file `<knowledge.dir>/history.yaml`:
 *        endpoints:
 *          "POST /orders": { incidents: 2, service: orders, note: "double charge, March" }
 *      `service` is optional; without it the entry counts for every service. Do not put customer data in notes: they
 *      are shown in the merge request comment and written to the run's context.json.
 *
 * Every signal is kept per service and endpoint, so GET /health of one service does not count for another.
 */
export interface HistorySignal {
  kind: "known-defect" | "flaky" | "incident";
  count: number;
  detail: string;
}

export interface EndpointHistory {
  endpoint: string;
  /** The service the signals belong to; absent = every service (a history.yaml entry or a test without an @service tag). */
  service?: string;
  count: number;
  signals: HistorySignal[];
}

export type HistoryMap = Map<string, EndpointHistory>;

export const historyKey = (service: string | undefined, endpoint: string) => `${service ?? ""}|${normaliseEndpoint(endpoint)}`;

const add = (m: HistoryMap, service: string | undefined, endpoint: string, s: HistorySignal) => {
  if (s.count <= 0) return;
  const key = historyKey(service, endpoint);
  const e = m.get(key) ?? { endpoint: normaliseEndpoint(endpoint), ...(service ? { service } : {}), count: 0, signals: [] };
  e.count += s.count;
  e.signals.push(s);
  m.set(key, e);
};

/** The history of one endpoint of one service: its own signals plus the ones that count for every service. */
export function historyFor(map: HistoryMap | undefined, service: string | undefined, endpoint: string): EndpointHistory | undefined {
  const own = service ? map?.get(historyKey(service, endpoint)) : undefined;
  const shared = map?.get(historyKey(undefined, endpoint));
  if (own && shared) return { endpoint: own.endpoint, service, count: own.count + shared.count, signals: [...own.signals, ...shared.signals] };
  return own ?? shared;
}

/** Run folders are named "<ISO time with - for : and .>-<kind>", e.g. 2026-10-22T10-11-12-345Z-gap-orders. */
export function runTime(name: string, fallback: Date): Date {
  const m = name.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/);
  if (!m) return fallback;
  const d = new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`);
  return Number.isNaN(d.getTime()) ? fallback : d;
}

const stripTags = (n: string) => parseTags(n).title.trim();

/** A flaky test is an indexed test when the file is the same and the title is exactly the same (tags stripped; a describe prefix is allowed). */
const sameTest = (flaky: { file?: string; name: string }, t: IndexedTest) => {
  if (flaky.file && !(flaky.file === t.file || flaky.file.endsWith(`/${t.file}`) || t.file.endsWith(`/${flaky.file}`))) return false;
  const f = stripTags(flaky.name);
  const d = t.describe ? stripTags(t.describe) : "";
  return f === t.title || (d !== "" && (f === `${d} ${t.title}` || f === `${d} › ${t.title}` || f === `${d} > ${t.title}`));
};

export interface FlakyRun {
  run: string;
  when: Date;
  tests: { file?: string; name: string }[];
}

export function flakyRuns(cwd: string, o: { days: number; now: Date }): FlakyRun[] {
  const root = path.join(cwd, ".qa-sentinel", "runs");
  if (!fs.existsSync(root)) return [];
  const since = o.now.getTime() - o.days * 86_400_000;
  const out: FlakyRun[] = [];
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const file = path.join(root, e.name, "verification.json");
    if (!fs.existsSync(file)) continue;
    const when = runTime(e.name, fs.statSync(file).mtime);
    if (when.getTime() < since) continue;
    try {
      const j = JSON.parse(fs.readFileSync(file, "utf8")) as { flaky?: unknown; flakyKeys?: unknown };
      const strings = (x: unknown) => (Array.isArray(x) ? x.filter((v): v is string => typeof v === "string") : []);
      // flakyKeys are "file::name"; older reports only have the names (matched by title alone).
      const keys = strings(j.flakyKeys);
      const tests = keys.length
        ? keys.map((k) => {
            const i = k.indexOf("::");
            return i > 0 ? { file: k.slice(0, i), name: k.slice(i + 2) } : { name: k.replace(/^::/, "") };
          })
        : strings(j.flaky).map((name) => ({ name }));
      if (tests.length) out.push({ run: e.name, when, tests });
    } catch {
      // an unreadable report is no signal
    }
  }
  return out.sort((a, b) => a.run.localeCompare(b.run));
}

export interface HistoryFile {
  /** Entries as a list: the same endpoint may be listed for several services. */
  entries: { endpoint: string; service?: string; incidents: number; note?: string }[];
  problems: string[];
}

export function readHistoryFile(cwd: string, c: Pick<Config, "knowledge" | "risk">): HistoryFile {
  const rel = path.join(c.knowledge.dir, c.risk.history.file);
  const file = path.join(cwd, rel);
  const out: HistoryFile = { entries: [], problems: [] };
  if (!fs.existsSync(file)) return out;
  try {
    const y = YAML.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (y === null || y === undefined) return out;
    if (typeof y !== "object" || Array.isArray(y)) {
      out.problems.push(`${rel}: the top level must be a mapping with "endpoints:"; the file is ignored`);
      return out;
    }
    const eps = (y as { endpoints?: unknown }).endpoints;
    if (eps === undefined || eps === null) return out;
    if (typeof eps !== "object" || Array.isArray(eps)) {
      out.problems.push(`${rel}: "endpoints" must be a mapping of "METHOD /path" to { incidents, note }; it is ignored`);
      return out;
    }
    for (const [ep, v] of Object.entries(eps as Record<string, unknown>)) {
      const o = (v ?? {}) as { incidents?: unknown; note?: unknown; service?: unknown };
      const raw = o.incidents;
      const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
      if (!Number.isFinite(n) || n < 0) {
        out.problems.push(`${ep}: "incidents" must be a number (got ${JSON.stringify(raw) ?? "nothing"})`);
        continue;
      }
      out.entries.push({ endpoint: ep, incidents: Math.floor(n), ...(typeof o.service === "string" && o.service ? { service: o.service } : {}), ...(typeof o.note === "string" && o.note ? { note: o.note } : {}) });
    }
  } catch (e) {
    out.problems.push(`${rel} could not be read: ${(e as Error).message}`);
  }
  return out;
}

/** All history signals per service and endpoint (see historyKey), computed from the test index, the run folders and the team file. */
export function historySignals(i: { cwd: string; c: Pick<Config, "knowledge" | "risk">; index: IndexedTest[]; now?: Date }): { map: HistoryMap; problems: string[] } {
  const map: HistoryMap = new Map();
  for (const t of i.index) {
    if (t.status !== "known-defect") continue;
    for (const svc of t.services.length ? t.services : [undefined])
      for (const ep of t.endpoints) add(map, svc, ep, { kind: "known-defect", count: 1, detail: `known-defect test ${t.file}:${t.line}${t.bug ? ` (${t.bug})` : ""}` });
  }
  // One signal per test per day, however many runs (re-runs of one merge request) saw it flaky.
  const counted = new Set<string>();
  for (const r of flakyRuns(i.cwd, { days: i.c.risk.history.days, now: i.now ?? new Date() })) {
    const day = r.when.toISOString().slice(0, 10);
    for (const f of r.tests)
      for (const t of i.index) {
        if (!sameTest(f, t)) continue;
        const once = `${day}|${t.file}::${t.title}`;
        if (counted.has(once)) continue;
        counted.add(once);
        for (const svc of t.services.length ? t.services : [undefined])
          for (const ep of t.endpoints) add(map, svc, ep, { kind: "flaky", count: 1, detail: `flaky "${t.title.slice(0, 60)}" on ${day}` });
      }
  }
  const h = readHistoryFile(i.cwd, i.c);
  for (const v of h.entries) add(map, v.service, v.endpoint, { kind: "incident", count: v.incidents, detail: `${v.incidents} incident(s) in ${i.c.knowledge.dir}/${i.c.risk.history.file}${v.note ? `: ${v.note}` : ""}` });
  return { map, problems: h.problems };
}

/** One line for the report: what raised the endpoint's risk. */
export const historyLine = (h: EndpointHistory) => `${h.service ? `${h.service} ` : ""}${h.endpoint}: ${h.count} signal(s) – ${h.signals.map((s) => s.detail).join("; ")}`;
