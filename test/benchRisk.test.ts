import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BASE_SERVICE, SCENARIOS } from "../bench/scenarios.js";
import { score } from "../bench/run.js";
import { ConfigSchema } from "../src/config.js";
import { changeKinds } from "../src/analysis/changeKinds.js";
import { changeSet } from "../src/git.js";
import { applyRisk } from "../src/plan/risk.js";
import { validatePlan } from "../src/plan/validate.js";

// No AI: the new benchmark scenarios are applied to a real temporary repo, qa-sentinel's own code finds the change
// types and sets the risk, and bench's scorer is run on a hand-written plan.
const g = (cwd: string, ...a: string[]) =>
  execFileSync("git", a, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
const c = ConfigSchema.parse({ version: 1, mode: "scratch", project: { name: "p" }, tests: { api: { framework: "playwright", runCommand: "x" } }, ci: { platform: "gitlab" } });
const put = (root: string, files: Record<string, string | null>) => {
  for (const [f, text] of Object.entries(files)) {
    if (text === null) continue;
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), text);
  }
};
const emptyPlan = (): any => ({ schemaVersion: 1, verdict: "v", recommendedAction: "a", changes: [], decisions: [], impactedTests: [], acMismatches: [], specDrift: [], requirementStatus: [], suspicious: [], openQuestions: [], skipReason: "no behaviour change" });
const result = (id: string): any => ({ id, run: 1, planValid: true, status: "valid", expectedGaps: 0, foundGaps: 0, reportedGaps: 0, truePositiveGaps: 0, decisionsCorrect: 0, decisionsExpected: 0, checks: [], corrections: 0, repairRounds: 0 });

function risked(id: string) {
  const s = SCENARIOS.find((x) => x.id === id)!;
  const r = fs.mkdtempSync(path.join(os.tmpdir(), `qas-benchrisk-${id}-`));
  put(r, BASE_SERVICE);
  g(r, "init", "-q", "-b", "main");
  g(r, "add", "-A");
  g(r, "commit", "-q", "-m", "base");
  put(r, s.change);
  g(r, "add", "-A");
  g(r, "commit", "-q", "-m", "change");
  const cs = changeSet(r, "HEAD~1", "HEAD");
  const kinds = changeKinds(c, { repo: r, base: cs.base, head: cs.head, files: cs.files });
  const base = { acIds: [], requirementsMissing: true, testRepo: r, serviceRepo: r };
  const plan = validatePlan(emptyPlan(), base).plan!;
  const out = applyRisk(plan, { breakingEndpoints: new Set(), crossService: false, changeKinds: kinds });
  return { s, plan: { ...plan, risk: { overall: out.overall, changeKinds: out.changeKinds } } };
}

describe("benchmark scenarios for the new risk types need no AI for their checks", () => {
  for (const id of ["db-migration", "dependency-major"]) {
    it(`${id}: found in code, high risk, and the benchmark check passes`, () => {
      const { s, plan } = risked(id);
      expect(plan.risk.overall).toBe("high");
      const r = score(s, plan, result(id));
      expect(r.checks.filter((x) => !x.pass)).toEqual([]);
      expect(r.checks.map((x) => x.name)).toContain(`change type ${s.checks!.changeKind} found in code`);
    });
  }

  it("a plan without the structured drift fails the spec-drift check; with it passes", () => {
    const s = SCENARIOS.find((x) => x.id === "spec-drift")!;
    const drift = { endpoint: "POST /orders", spec: "no slot", code: "slot required", evidence: [{ source: "source-code", file: "src/server.js", line: 9, reference: "x" }] };
    const base: any = { ...emptyPlan(), risk: { overall: "medium" }, changes: [{ id: "c1", type: "validation-change", endpoint: "POST /orders", summary: "deliverySlot is required in code", observable: true, oracleStatus: "missing" }], decisions: [{ changeId: "c1", decision: "review" }] };
    const bad = score(s, { ...base, specDrift: ["slot required but not in spec"] }, result("spec-drift"));
    expect(bad.checks.find((x) => x.name.startsWith("spec drift"))!.pass).toBe(false);
    const good = score(s, { ...base, specDrift: [drift] }, result("spec-drift"));
    expect(good.checks.filter((x) => !x.pass)).toEqual([]);
  });
});
