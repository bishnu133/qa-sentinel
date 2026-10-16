import path from "node:path";
import { loadConfig } from "../config.js";
import { atLeastRisk, rankGaps } from "../analysis/coverage.js";
import type { RiskLevel } from "../plan/schema.js";
import { computeCoverage } from "./coverage.js";
import { type BackfillTarget, generateCommand } from "./generate.js";
import { log } from "../log.js";

export interface BackfillOptions {
  cwd: string;
  service: string;
  servicePath?: string;
  /** Endpoints per run: one reviewed MR each. */
  batch?: number;
  minRisk?: RiskLevel;
  /** Also cover endpoints whose only tests assert just the status, or are all fixme/skip. */
  includeWeak?: boolean;
  /** Only these endpoints ("POST /orders"), in this order. */
  endpoints?: string[];
  checkout?: boolean;
  push?: boolean;
  env?: string;
  dryRun?: boolean;
}

/**
 * `qa-sentinel backfill`: tests for old code nobody is changing. Takes the riskiest gaps from `coverage` and runs
 * one generation for a small batch of them (plan → write → verify → review → MR), so a human reviews each batch.
 */
export async function backfillCommand(o: BackfillOptions): Promise<number> {
  const cwd = path.resolve(o.cwd);
  const c = loadConfig(cwd);
  const r = await computeCoverage(cwd, c, o.service);
  r.notes.forEach((n) => log.warn(n));
  let gaps = rankGaps(r.endpoints).filter((g) => (o.includeWeak || g.status === "untested") && atLeastRisk(g.risk, o.minRisk ?? "low"));
  if (o.endpoints?.length) {
    const want = o.endpoints.map((e) => e.trim().replace(/\s+/, " ").toUpperCase());
    gaps = want.map((w) => r.endpoints.find((e) => `${e.method} ${e.path}`.toUpperCase() === w || e.endpoint.toUpperCase() === w)).filter((e): e is NonNullable<typeof e> => Boolean(e));
    if (gaps.length < want.length) log.warn(`not in the spec: ${want.filter((w) => !gaps.some((g) => `${g.method} ${g.path}`.toUpperCase() === w || g.endpoint.toUpperCase() === w)).join(", ")}`);
  }
  const batch = gaps.slice(0, Math.max(1, o.batch ?? 5));
  if (!batch.length) {
    log.ok(`no ${o.includeWeak ? "" : "untested "}endpoints${o.minRisk ? ` at ${o.minRisk} risk or above` : ""} in ${o.service}`);
    return 0;
  }
  log.step(`backfill batch (${batch.length} of ${gaps.length} gap(s)):`);
  for (const g of batch) log.info(`  ${g.risk.padEnd(8)} ${g.method} ${g.path} (${g.status})`);
  if (o.dryRun) {
    log.info("dry run: nothing generated. Run without --dry-run to write tests for this batch.");
    return 0;
  }
  const targets: BackfillTarget[] = batch.map((g) => ({
    endpoint: g.endpoint,
    method: g.method,
    path: g.path,
    summary: g.summary,
    risk: g.risk,
    gap: g.status,
    existingTests: g.tests.map((t) => t.id),
  }));
  return generateCommand({ cwd, service: o.service, servicePath: o.servicePath, checkout: o.checkout, push: o.push, env: o.env, backfill: targets });
}
