import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { Config } from "../config.js";
import { type IndexedTest } from "./testIndex.js";
import { normaliseEndpoint } from "../plan/risk.js";

/**
 * Risk from history, no AI. Only data qa-sentinel or the team already keeps is read; no incident tool is called.
 *   1. known-defect tests (test.fail with an @endpoint tag): a confirmed product defect lives there,
 *   2. flaky tests: `flaky` in .qa-sentinel/runs/<run>/verification.json inside the last `risk.history.days` days,
 *      mapped to endpoints through the test index (one signal per test per run),
 *   3. the team's file `<knowledge.dir>/history.yaml`:
 *        endpoints:
 *          "POST /orders": { incidents: 2, note: "double charge, March" }
 */
export interface HistorySignal {
  kind: "known-defect" | "flaky" | "incident";
  count: number;
  detail: string;
}

export interface EndpointHistory {
  endpoint: string;
  count: number;
  signals: HistorySignal[];
}

export type HistoryMap = Map<string, EndpointHistory>;

const add = (m: HistoryMap, endpoint: string, s: HistorySignal) => {
  if (s.count <= 0) return;
  const key = normaliseEndpoint(endpoint);
  const e = m.get(key) ?? { endpoint: key, count: 0, signals: [] };
  e.count += s.count;
  e.signals.push(s);
  m.set(key, e);
};

/** Run folders are named "<ISO time with - for : and .>-<kind>", e.g. 2026-10-22T10-11-12-345Z-gap-orders. */
export function runTime(name: string, fallback: Date): Date {
  const m = name.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/);
  if (!m) return fallback;
  const d = new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`);
  return Number.isNaN(d.getTime()) ? fallback : d;
}

/** Tests a flaky name could be: JUnit names often carry a describe prefix or the tags, so a name that contains the title counts. */
const sameTest = (flaky: string, t: IndexedTest) => {
  const f = flaky.trim();
  return f === t.title || (t.title.length >= 8 && f.includes(t.title));
};

export function flakyRuns(cwd: string, o: { days: number; now: Date }): { run: string; names: string[] }[] {
  const root = path.join(cwd, ".qa-sentinel", "runs");
  if (!fs.existsSync(root)) return [];
  const since = o.now.getTime() - o.days * 86_400_000;
  const out: { run: string; names: string[] }[] = [];
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const file = path.join(root, e.name, "verification.json");
    if (!fs.existsSync(file)) continue;
    const when = runTime(e.name, fs.statSync(file).mtime);
    if (when.getTime() < since) continue;
    try {
      const j = JSON.parse(fs.readFileSync(file, "utf8")) as { flaky?: unknown };
      const names = Array.isArray(j.flaky) ? j.flaky.filter((x): x is string => typeof x === "string") : [];
      if (names.length) out.push({ run: e.name, names });
    } catch {
      // an unreadable report is no signal
    }
  }
  return out;
}

export interface HistoryFile {
  endpoints: Record<string, { incidents: number; note?: string }>;
  problems: string[];
}

export function readHistoryFile(cwd: string, c: Pick<Config, "knowledge" | "risk">): HistoryFile {
  const file = path.join(cwd, c.knowledge.dir, c.risk.history.file);
  const out: HistoryFile = { endpoints: {}, problems: [] };
  if (!fs.existsSync(file)) return out;
  try {
    const y = YAML.parse(fs.readFileSync(file, "utf8")) as { endpoints?: Record<string, unknown> } | null;
    for (const [ep, v] of Object.entries(y?.endpoints ?? {})) {
      const o = (v ?? {}) as { incidents?: unknown; note?: unknown };
      const n = typeof o.incidents === "number" ? o.incidents : Number(o.incidents);
      if (!Number.isFinite(n) || n < 0) {
        out.problems.push(`${ep}: "incidents" must be a number`);
        continue;
      }
      out.endpoints[ep] = { incidents: Math.floor(n), ...(typeof o.note === "string" && o.note ? { note: o.note } : {}) };
    }
  } catch (e) {
    out.problems.push(`${path.join(c.knowledge.dir, c.risk.history.file)} could not be read: ${(e as Error).message}`);
  }
  return out;
}

/** All history signals per endpoint (normalised key), computed from the test index, the run folders and the team file. */
export function historySignals(i: { cwd: string; c: Pick<Config, "knowledge" | "risk">; index: IndexedTest[]; now?: Date }): { map: HistoryMap; problems: string[] } {
  const map: HistoryMap = new Map();
  for (const t of i.index) {
    if (t.status !== "known-defect") continue;
    for (const ep of t.endpoints) add(map, ep, { kind: "known-defect", count: 1, detail: `known-defect test ${t.file}:${t.line}${t.bug ? ` (${t.bug})` : ""}` });
  }
  for (const r of flakyRuns(i.cwd, { days: i.c.risk.history.days, now: i.now ?? new Date() })) {
    const seen = new Set<string>();
    for (const name of r.names)
      for (const t of i.index) {
        if (!sameTest(name, t) || seen.has(t.id)) continue;
        seen.add(t.id);
        for (const ep of t.endpoints) add(map, ep, { kind: "flaky", count: 1, detail: `flaky "${t.title.slice(0, 60)}" in run ${r.run}` });
      }
  }
  const h = readHistoryFile(i.cwd, i.c);
  for (const [ep, v] of Object.entries(h.endpoints)) add(map, ep, { kind: "incident", count: v.incidents, detail: `${v.incidents} incident(s) in ${i.c.knowledge.dir}/${i.c.risk.history.file}${v.note ? `: ${v.note}` : ""}` });
  return { map, problems: h.problems };
}

/** One line for the report: what raised the endpoint's risk. */
export const historyLine = (h: EndpointHistory) => `${h.endpoint}: ${h.count} signal(s) – ${h.signals.map((s) => s.detail).join("; ")}`;
