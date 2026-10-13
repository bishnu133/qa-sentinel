import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../config.js";
import { HEALED_JSON, HEALED_MD, groupBySite, healedFromResults, healedMarkdown, isHealed } from "../web/healed.js";
import { log } from "../log.js";

export interface HealedOptions {
  cwd: string;
  results?: string;
  out?: string;
  failOnHeal?: boolean;
}

/**
 * After a run with QA_HEALING=bubblegum: list the steps Bubblegum healed as page-object fixes (qa-healed.md) and
 * keep them for the next generation run (qa-healed.json). Exit 1 with tests.web.bubblegum.failOnHeal (or
 * --fail-on-heal) when anything was healed, so a pipeline can treat "passed by healing" as not clean.
 */
export function healedCommand(o: HealedOptions): number {
  const cwd = path.resolve(o.cwd);
  const c = loadConfig(cwd);
  const file = path.resolve(cwd, o.results ?? "test-results/results.json");
  if (!fs.existsSync(file)) throw new Error(`No test results at ${file}. Run the tests with the Playwright JSON reporter first.`);
  const steps = healedFromResults(file);
  const md = healedMarkdown(steps);
  fs.writeFileSync(path.join(cwd, HEALED_JSON), JSON.stringify(steps, null, 2) + "\n");
  fs.writeFileSync(path.resolve(cwd, o.out ?? HEALED_MD), md + "\n");
  const groups = groupBySite(steps);
  const healed = groups.filter((g) => g.healed);
  if (!steps.length) {
    log.ok("no healed steps");
    return 0;
  }
  log.warn(`${healed.length} page-object locator(s) healed at runtime, ${groups.length - healed.length} not healed; see ${o.out ?? HEALED_MD}`);
  for (const g of groups) log.info(`  ${g.healed ? "healed" : "failed"}  ${g.site}  ${g.intent}  (${g.failedLocator}${g.healedTo ? ` → ${g.healedTo}` : ""})`);
  const failOnHeal = o.failOnHeal ?? c.tests.web.bubblegum.failOnHeal;
  return failOnHeal && steps.some(isHealed) ? 1 : 0;
}
