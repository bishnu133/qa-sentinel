import { exposures } from "../analysis/gateway.js";
import fs from "node:fs";
import path from "node:path";
import { loadConfig, type Config, type ServiceConfig } from "../config.js";
import { findService, testEnv } from "../run.js";
import { specAt } from "../specs.js";
import { loadContract } from "../contracts.js";
import { indexTests, readTestMap } from "../analysis/testIndex.js";
import { type EndpointCoverage, type PageCoverage, coverageMarkdown, endpointCoverage, pageCoverage, specOperations } from "../analysis/coverage.js";
import { log } from "../log.js";

export interface CoverageOptions {
  cwd: string;
  service?: string;
  servicePath?: string;
  out?: string;
  json?: boolean;
}

export interface CoverageResult {
  endpoints: EndpointCoverage[];
  pages: PageCoverage[];
  notes: string[];
}

/** The spec an API service's coverage is measured against: what the code implements, else the agreed contract. */
async function specFor(c: Config, cwd: string, s: ServiceConfig, ref = "HEAD"): Promise<{ text?: string; from?: string; missingRepo?: string }> {
  const repo = path.resolve(cwd, s.path);
  let missingRepo: string | undefined;
  if (s.openapi && fs.existsSync(repo)) {
    const text = await specAt(repo, ref, s, { env: testEnv(c), timeoutMs: (s.openapiCommandTimeoutSeconds ?? 180) * 1000 });
    if (text) return { text, from: s.openapi };
  } else if (s.openapi) missingRepo = repo;
  if (s.contract) {
    const { contract } = await loadContract(c, s.contract, { cwd });
    if (contract) return { text: contract.text, from: contract.from };
  }
  return { missingRepo };
}

/** `servicePath` (CI): where `only` is checked out, as for gap-report and generate (`subdir` joined on). */
export async function computeCoverage(cwd: string, c: Config, only?: string, servicePath?: string, ref = "HEAD"): Promise<CoverageResult> {
  const services = c.workspace.services.filter((s) => !only || s.name === only).map((s) => (servicePath && only ? findService(c, s.name, cwd, servicePath) : s));
  if (only && !services.length) throw new Error(`service ${only} is not in qa-sentinel.config.yaml`);
  const index = indexTests(cwd, c);
  const map = readTestMap(cwd);
  const r: CoverageResult = { endpoints: [], pages: [], notes: [] };
  for (const s of services) {
    if (s.kind === "web" || s.kind === "mobile") {
      r.pages.push(...pageCoverage(s, index, map));
      continue;
    }
    const spec = await specFor(c, cwd, s, ref);
    if (!spec.text) {
      r.notes.push(
        spec.missingRepo
          ? `${s.name}: the service repo isn't at ${spec.missingRepo} (clone it there, or pass --service-path), so its endpoints can't be listed`
          : `${s.name}: no OpenAPI spec (set openapi, openapiCommand or contract), so its endpoints can't be listed`,
      );
      continue;
    }
    try {
      r.endpoints.push(...endpointCoverage(s, specOperations(spec.text), index, map, (op) => exposures(c, s.name, op.endpoint, map as never)));
    } catch (e) {
      r.notes.push(`${s.name}: ${spec.from} could not be read (${(e as Error).message.split("\n")[0]})`);
    }
  }
  return r;
}

/** `qa-sentinel coverage`: every endpoint (and page) with its tests; untested ones ranked by risk. No agent, no cost. */
export async function coverageCommand(o: CoverageOptions): Promise<number> {
  const cwd = path.resolve(o.cwd);
  const c = loadConfig(cwd);
  const r = await computeCoverage(cwd, c, o.service, o.servicePath);
  const md = coverageMarkdown(r);
  const out = path.resolve(cwd, o.out ?? "qa-coverage.md");
  fs.writeFileSync(out, md);
  fs.writeFileSync(out.replace(/\.md$/, "") + ".json", JSON.stringify(r, null, 2));
  if (o.json) console.log(JSON.stringify(r, null, 2));
  const tested = r.endpoints.filter((e) => e.status === "tested").length;
  log.ok(`${r.endpoints.length} endpoint(s), ${tested} tested; ${r.endpoints.length - tested} gap(s)${r.pages.length ? `; pages ${r.pages.filter((p) => p.status === "tested").length}/${r.pages.length} tested` : ""}`);
  r.notes.forEach((n) => log.warn(n));
  log.dim(`report: ${path.relative(cwd, out) || out}`);
  return 0;
}
