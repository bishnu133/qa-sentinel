import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../config.js";
import { findService, testEnv } from "../run.js";
import { specAt } from "../specs.js";
import { type ContractCheck, checkContract, contractCheckMarkdown, loadContract } from "../contracts.js";
import { log } from "../log.js";

export interface ContractCheckOptions {
  cwd: string;
  service?: string;
  servicePath?: string;
  story?: string;
  /** Git ref of the service to check (default HEAD). */
  ref?: string;
  out?: string;
  json?: boolean;
  /** Exit 1 when there is any mismatch (for a CI gate). */
  strict?: boolean;
}

/**
 * `qa-sentinel contract-check`: the whole implemented spec of each spec-first service against its agreed spec, every
 * endpoint (gap reports only show the endpoints an MR touches).
 */
export async function contractCheckCommand(o: ContractCheckOptions): Promise<number> {
  const cwd = path.resolve(o.cwd);
  const c = loadConfig(cwd);
  const services = c.workspace.services.filter((s) => s.contract && (!o.service || s.name === o.service)).map((s) => (o.servicePath && o.service ? findService(c, s.name, cwd, o.servicePath) : s));
  if (!services.length) {
    log.fail(o.service ? `service ${o.service} not found or has no \`contract\`` : "no service has a `contract` (the agreed API spec) in qa-sentinel.config.yaml");
    return 2;
  }
  const env = testEnv(c);
  const checks: ContractCheck[] = [];
  for (const s of services) {
    const repo = path.resolve(cwd, s.path);
    const { contract, reason } = await loadContract(c, s.contract!, { cwd, storyKey: o.story });
    const implemented = fs.existsSync(repo) ? await specAt(repo, o.ref ?? "HEAD", s, { env, timeoutMs: (s.openapiCommandTimeoutSeconds ?? 180) * 1000 }) : undefined;
    const k = checkContract(s.name, contract, implemented, reason);
    if (contract && implemented === undefined && s.openapi)
      k.note = fs.existsSync(repo) ? `${s.openapi} not found at ${o.ref ?? "HEAD"} in ${repo}${s.openapiCommand ? " (or openapiCommand failed)" : ""}` : `the service repo isn't at ${repo} (clone it there, or pass --service-path)`;
    checks.push(k);
    const m = k.deviations.filter((d) => d.severity === "mismatch").length;
    if (k.status === "checked") (m ? log.warn : log.ok)(`${s.name}: ${m} mismatch(es), ${k.deviations.length - m} extra`);
    else if (k.status === "conforms") log.ok(`${s.name}: matches the agreed spec`);
    else log.warn(`${s.name}: ${k.note ?? k.status}`);
  }
  const md = `# Agreed API contracts\n\n${contractCheckMarkdown(checks)}\n`;
  const out = path.resolve(cwd, o.out ?? "qa-contract-check.md");
  fs.writeFileSync(out, md);
  if (o.json) console.log(JSON.stringify(checks, null, 2));
  log.dim(`report: ${path.relative(cwd, out) || out}`);
  const failed = checks.some((k) => k.deviations.some((d) => d.severity === "mismatch")) || checks.some((k) => k.status === "no-contract" || k.status === "unparseable");
  return o.strict && failed ? 1 : 0;
}
