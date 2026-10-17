import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../config.js";
import { pendingRecords, sweep, sweepMarkdown } from "../testData.js";
import { log } from "../log.js";

export interface DataOptions {
  cwd: string;
  dryRun?: boolean;
  olderThan?: number;
  out?: string;
  env?: NodeJS.ProcessEnv;
}

/** `qa-sentinel data status`: test data runs created and haven't deleted yet. */
export function dataStatusCommand(o: DataOptions): number {
  const cwd = path.resolve(o.cwd);
  const c = loadConfig(cwd);
  const dir = path.resolve(cwd, c.testData.ledgerDir);
  const pending = pendingRecords(dir, { olderThanMinutes: o.olderThan });
  if (!pending.length) {
    log.ok(`no test data left behind (${c.testData.ledgerDir})`);
    return 0;
  }
  log.warn(`${pending.length} record(s) not deleted yet`);
  for (const p of pending) console.log(`  ${p.kind ?? "?"} ${p.id ?? "?"}  ${p.remove ? `${p.remove.method ?? "DELETE"} ${p.remove.path}` : "(no delete request)"}  ← ${p.test ?? "?"}`);
  return 1;
}

/** `qa-sentinel data sweep`: delete what killed runs left behind, newest first, on the test environment only. */
export const DEFAULT_SWEEP_AGE_MINUTES = 30;

export async function dataSweepCommand(o: DataOptions): Promise<number> {
  // By default, leave runs active in the last half hour alone: another run on this machine may still use that data.
  o = { ...o, olderThan: o.olderThan ?? DEFAULT_SWEEP_AGE_MINUTES };
  const cwd = path.resolve(o.cwd);
  const c = loadConfig(cwd);
  const env = o.env ?? process.env;
  const dir = path.resolve(cwd, c.testData.ledgerDir);
  const baseUrl = env[c.tests.api.baseUrlEnv];
  const authHeader = env[c.testData.sweepAuthEnv];
  if (!baseUrl && !o.dryRun && pendingRecords(dir, { olderThanMinutes: o.olderThan }).length) {
    log.fail(`${c.tests.api.baseUrlEnv} is not set: the sweeper only deletes on the test environment`);
    return 2;
  }
  const r = await sweep({ dir, baseUrl, authHeader, dryRun: o.dryRun, olderThanMinutes: o.olderThan });
  const md = sweepMarkdown(r, o.dryRun);
  if (o.out) fs.writeFileSync(path.resolve(cwd, o.out), `# Test data sweep\n\n${md}\n`);
  if (r.failed.length || r.manual.length) log.warn(md.split("\n")[0]);
  else log.ok(md.split("\n")[0]);
  for (const f of r.failed) log.dim(`  ${f.kind} ${f.id}: ${f.error}`);
  return r.failed.length || r.manual.length ? 1 : 0;
}
