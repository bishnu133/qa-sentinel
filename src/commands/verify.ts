import { useEnvironment } from "../run.js";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../config.js";
import { changesSince, git, resolveSha } from "../git.js";
import { matchesAny } from "../fsutil.js";
import { ARTIFACT_GLOBS, createRunDir, testEnv } from "../run.js";
import { checkContent, checkPaths, findingsMarkdown, generatePolicy, violations } from "../guardrails.js";
import { findDiscrepancies, verificationMarkdown, verifyChanges } from "../verification.js";
import { log } from "../log.js";

export interface VerifyOptions {
  cwd: string;
  base?: string;
  /** Apply the agent write policy (use on qa-sentinel/* branches). */
  policy?: boolean;
  out?: string;
  /** Named environment from `environments:`. */
  env?: string;
}

/**
 * The same independent checks `generate` runs, usable as a CI gate on any branch:
 * policy (optional) → type-check → lint → changed specs with JUnit. Exit 0 only when VERIFIED.
 */
export async function verifyCommand(o: VerifyOptions): Promise<number> {
  const cwd = path.resolve(o.cwd);
  const c = loadConfig(cwd);
  useEnvironment(c, o.env);
  const baseRef = o.base ?? process.env.CI_MERGE_REQUEST_DIFF_BASE_SHA ?? `origin/${c.ci.targetBranch}`;
  const base = git(cwd, ["merge-base", resolveSha(cwd, baseRef), "HEAD"]);
  const changes = changesSince(cwd, base).filter((x) => !matchesAny(x.path, ARTIFACT_GLOBS));
  log.title(`qa-sentinel verify (${changes.length} file(s) changed since ${base.slice(0, 8)})`);

  let exit = 0;
  const findings = o.policy
    ? [
        ...checkPaths(changes, generatePolicy(c)),
        ...checkContent(changes, {
          repo: cwd,
          ref: base,
          allowedHosts: c.guardrails.allowedHosts,
          baseUrl: process.env[c.tests.api.baseUrlEnv],
          assertionRemoval: c.guardrails.assertionRemoval,
        }),
      ]
    : [];
  if (findings.length) log.info(findingsMarkdown(findings));
  if (violations(findings).length) {
    log.fail(`${violations(findings).length} guardrail violation(s)`);
    exit = 1;
  }

  const run = createRunDir(cwd, "verify");
  const report = await verifyChanges({ cwd, c, changes, runDir: run.dir, env: testEnv(c) });
  const discrepancies = findDiscrepancies(cwd, base, changes);
  const md = [
    verificationMarkdown(report),
    ...(discrepancies.length ? ["", "Unresolved discrepancies (fixme/skip):", ...discrepancies.map((d) => `- ${d.test} (\`${d.file}\`)${d.note ? ` – ${d.note}` : ""}`)] : []),
  ].join("\n");
  log.info(md);
  if (o.out) fs.writeFileSync(path.resolve(cwd, o.out), md + "\n");
  if (report.status !== "VERIFIED") exit = 1;
  return exit;
}
