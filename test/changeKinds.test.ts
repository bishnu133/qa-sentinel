import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { changeKinds, changeKindsMarkdown, factorsOfKinds, majorOf, packageJsonDependencyChanges } from "../src/analysis/changeKinds.js";
import { changeSet } from "../src/git.js";
import { applyRisk, riskOf } from "../src/plan/risk.js";
import { renderGapReport } from "../src/plan/render.js";
import { selectRegression } from "../src/analysis/regression.js";
import { indexSource } from "../src/analysis/testIndex.js";
import { validatePlan } from "../src/plan/validate.js";

const g = (cwd: string, ...a: string[]) =>
  execFileSync("git", a, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
const c = ConfigSchema.parse({ version: 1, mode: "scratch", project: { name: "p" }, tests: { api: { framework: "playwright", runCommand: "x" } }, ci: { platform: "gitlab" } });
const put = (root: string, rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};

describe("A5 change types from the changed files", () => {
  it("knows the major version of a range", () => {
    expect(majorOf("^4.21.2")).toBe(4);
    expect(majorOf(">=2 <3")).toBe(2);
    expect(majorOf("workspace:*")).toBeUndefined();
  });

  it("counts only dependency sections of package.json, and flags a major jump", () => {
    const before = JSON.stringify({ name: "a", version: "1.0.0", scripts: { t: "x" }, dependencies: { express: "^4.21.2", zod: "^3.0.0" }, devDependencies: { tsx: "^4.0.0" } });
    const scriptOnly = JSON.stringify({ name: "a", version: "1.0.1", scripts: { t: "y" }, dependencies: { express: "^4.21.2", zod: "^3.0.0" }, devDependencies: { tsx: "^4.0.0" } });
    expect(packageJsonDependencyChanges(before, scriptOnly)).toEqual([]);
    const bumped = JSON.stringify({ name: "a", dependencies: { express: "^5.0.0", zod: "^3.1.0" }, devDependencies: { tsx: "^4.0.0", vitest: "^2.0.0" } });
    const withNew = JSON.stringify({ name: "a", dependencies: { express: "^5.0.0", zod: "^3.1.0", pino: "^9.0.0" }, devDependencies: { tsx: "^4.0.0", vitest: "^2.0.0" } });
    const d = packageJsonDependencyChanges(before, withNew);
    expect(d.find((x) => x.name === "express")).toMatchObject({ from: "^4.21.2", to: "^5.0.0", major: true });
    expect(d.find((x) => x.name === "zod")?.major).toBe(false);
    expect(d.find((x) => x.name === "pino")).toMatchObject({ from: undefined, major: false });
    // devDependencies are not dependency changes (a lint or test tool changes no behaviour)
    expect(d.find((x) => x.name === "vitest")).toBeUndefined();
    expect(packageJsonDependencyChanges(before, bumped).some((x) => x.name === "vitest")).toBe(false);
    expect(packageJsonDependencyChanges("not json", undefined)).toEqual([]);
  });

  // The path globs, one row each: [file, expected kinds].
  const table: [string, string[]][] = [
    ["db/migrations/002_add_slot.sql", ["migration"]],
    ["src/main/resources/db/changelog/001.xml", ["migration"]],
    ["scripts/fix.sql", ["migration"]],
    ["src/main/resources/application-prod.yml", ["config"]],
    ["application.properties", ["config"]],
    ["config/limits.json", ["config"]],
    ["deploy/helm/orders/values-prod.yaml", ["config"]],
    ["sample.env.example", ["config"]],
    ["src/feature-flags/orders.json", ["toggle"]],
    ["pom.xml", ["dependency"]],
    ["services/api/build.gradle.kts", ["dependency"]],
    ["go.mod", ["dependency"]],
    ["requirements-dev.txt", ["dependency"]],
    ["src/orders/handler.js", []],
    ["README.md", []],
  ];
  it.each(table)("%s is %j", (file, kinds) => {
    // package.json is covered below (it needs git history); the others are decided by name alone.
    const found = changeKinds(c, { repo: os.tmpdir(), base: "x", head: "y", files: [file] });
    expect(found.map((f) => f.kind)).toEqual(kinds);
  });

  it("reads package.json from git, counting lock files out and dependency sections in", () => {
    const r = fs.mkdtempSync(path.join(os.tmpdir(), "qas-kinds-"));
    g(r, "init", "-q", "-b", "main");
    put(r, "package.json", JSON.stringify({ name: "orders", scripts: { start: "node ." }, dependencies: { express: "^4.21.2" } }));
    put(r, "package-lock.json", "{}");
    put(r, "src/a.js", "1");
    g(r, "add", "-A");
    g(r, "commit", "-q", "-m", "init");
    g(r, "checkout", "-q", "-b", "feature/x");
    // 1. a script change only
    put(r, "package.json", JSON.stringify({ name: "orders", scripts: { start: "node src/a.js" }, dependencies: { express: "^4.21.2" } }));
    g(r, "commit", "-qam", "script");
    let cs = changeSet(r, "main", "HEAD");
    expect(changeKinds(c, { repo: r, base: cs.base, head: cs.head, files: cs.files })).toEqual([]);
    // 2. a major bump, a lock file and a migration
    put(r, "package.json", JSON.stringify({ name: "orders", scripts: { start: "node src/a.js" }, dependencies: { express: "^5.0.0" } }));
    put(r, "package-lock.json", '{"changed":true}');
    put(r, "db/migrations/002.sql", "alter table orders add column slot text;");
    g(r, "add", "-A");
    g(r, "commit", "-q", "-m", "bump");
    cs = changeSet(r, "main", "HEAD");
    const found = changeKinds(c, { repo: r, base: cs.base, head: cs.head, files: cs.files });
    expect(found.map((f) => `${f.kind}:${f.file}${f.major ? ":major" : ""}`)).toEqual(["migration:db/migrations/002.sql", "dependency:package.json:major"]);
    expect(found[1].detail).toBe("express ^4.21.2 to ^5.0.0 (major)");
    expect(factorsOfKinds(found).sort()).toEqual(["db-migration", "dependency-bump", "dependency-major"]);
    expect(changeKindsMarkdown(found)).toContain("Change types found in the code (no AI)");
  });

  it("works for a service that is a folder of a monorepo (paths from its folder)", () => {
    const r = fs.mkdtempSync(path.join(os.tmpdir(), "qas-kinds-mono-"));
    g(r, "init", "-q", "-b", "main");
    put(r, "svc/package.json", JSON.stringify({ dependencies: { a: "^1.0.0" } }));
    g(r, "add", "-A");
    g(r, "commit", "-q", "-m", "init");
    put(r, "svc/package.json", JSON.stringify({ dependencies: { a: "^2.0.0" } }));
    g(r, "commit", "-qam", "bump");
    const svc = path.join(r, "svc");
    const cs = changeSet(svc, "HEAD~1", "HEAD");
    expect(changeKinds(c, { repo: svc, base: cs.base, head: cs.head, files: cs.files, service: "orders" })).toMatchObject([{ kind: "dependency", file: "package.json", service: "orders", major: true }]);
  });

  it("can be changed in the config", () => {
    const c2 = ConfigSchema.parse({ ...c, risk: { changeTypes: { migration: ["sql/**"] } } });
    expect(changeKinds(c2, { repo: os.tmpdir(), base: "x", head: "y", files: ["sql/a.txt", "db/migrations/x.sql"] }).map((f) => f.file)).toEqual(["sql/a.txt"]);
  });
});

const ev = [{ source: "source-code" as const, file: "src/server.js", line: 1, reference: "x" }];
const plan = (): any => ({
  schemaVersion: 1,
  verdict: "v",
  recommendedAction: "a",
  changes: [{ id: "c1", type: "validation-change", endpoint: "POST /orders", summary: "slot required", observable: true, requirementIds: [], oracleStatus: "missing", riskFactors: ["read-only"], evidence: ev }],
  decisions: [{ changeId: "c1", coverage: "missing", decision: "review", existingTests: [], proposedScenarios: [{ title: "s", setup: [], assertions: ["a"] }], evidence: ev, reason: "r" }],
  impactedTests: [],
  acMismatches: [],
  specDrift: [],
  requirementStatus: [],
  suspicious: [],
  openQuestions: [],
  skipReason: null,
});

describe("A5 risk", () => {
  it("has the levels the plan asks for", () => {
    expect(riskOf(["db-migration"])).toBe("high");
    expect(riskOf(["config-change"])).toBe("medium");
    expect(riskOf(["toggle-change"])).toBe("medium");
    expect(riskOf(["dependency-bump"])).toBe("medium");
    expect(riskOf(["dependency-bump", "dependency-major"])).toBe("high");
  });

  it("adds the synthetic change c0, so overall risk includes it, and the agent cannot pick these factors", () => {
    const p = validatePlan(plan(), { acIds: [], requirementsMissing: true, testRepo: os.tmpdir(), serviceRepo: os.tmpdir() }).plan!;
    const none = applyRisk(p, { breakingEndpoints: new Set(), crossService: false });
    expect(none.overall).toBe("low");
    expect(none.changes.map((x) => x.id)).toEqual(["c1"]);
    const kinds = changeKinds(c, { repo: os.tmpdir(), base: "x", head: "y", files: ["db/migrations/002.sql"] });
    const r = applyRisk(p, { breakingEndpoints: new Set(), crossService: false, changeKinds: kinds });
    expect(r.overall).toBe("high");
    expect(r.changes.map((x) => x.id)).toEqual(["c1", "c0"]);
    expect(r.changes[1]).toMatchObject({ synthetic: true, risk: "high", factors: ["db-migration"] });
    const bad = plan();
    bad.changes[0].riskFactors = ["db-migration"];
    expect(validatePlan(bad, { acIds: [], requirementsMissing: true, testRepo: os.tmpdir(), serviceRepo: os.tmpdir() }).errors.join("\n")).toContain("riskFactors");
  });

  it("shows the section in the report and leaves c0 out of the decision table", () => {
    const p = validatePlan(plan(), { acIds: [], requirementsMissing: true, testRepo: os.tmpdir(), serviceRepo: os.tmpdir() }).plan!;
    const kinds = changeKinds(c, { repo: os.tmpdir(), base: "x", head: "y", files: ["db/migrations/002.sql", "src/main/resources/application.yml"] });
    const risked = applyRisk(p, { breakingEndpoints: new Set(), crossService: false, changeKinds: kinds });
    const md = renderGapReport({ service: "orders", plan: p, risked, contract: { status: "no-spec", changes: [] }, requirementsLine: "", corrections: [], warnings: [], oracle: "missing" });
    expect(md).toContain("**Change types found in the code (no AI)**");
    expect(md).toContain("Database migration: `db/migrations/002.sql`");
    expect(md).toContain("Configuration change: `src/main/resources/application.yml`");
    expect(md).toContain("🟠 High risk");
    const table = md.split("\n").filter((l) => l.startsWith("| ")).join("\n");
    expect(table).not.toContain("Change types found");
    expect(md).toContain("risk high from: db-migration, config-change (added by qa-sentinel)");
  });
});

describe("A5 regression", () => {
  const index = indexSource("tests/api/orders/o.spec.ts", `test("creates @service:orders @endpoint:POST_/orders", async () => {});\ntest("lists @service:orders @endpoint:GET_/orders", async () => {});`);
  const cfg: any = { workspace: { services: [{ name: "orders", dependsOn: [] }] } };
  const base = { c: cfg, service: "orders", plan: { changes: [{ id: "c1", type: "validation-change", endpoint: "POST /orders", summary: "s", observable: true }], decisions: [], impactedTests: [] } as any, index, map: undefined };
  it("selects only the endpoint's tests without a migration", () => {
    const sel = selectRegression(base);
    expect(sel.args).toEqual(["tests/api/orders/o.spec.ts:1"]);
    expect(sel.serviceWide).toBe(false);
  });
  it("falls back to the service-wide suite for a migration or a dependency change, not for config", () => {
    const k = (kind: string, service?: string) => [{ kind, file: "f", ...(service ? { service } : {}) }] as any;
    const mig = selectRegression({ ...base, changeKinds: k("migration") });
    expect(mig.serviceWide).toBe(true);
    expect(mig.args).toHaveLength(2);
    expect(mig.notes.join(" ")).toContain("database migration");
    expect(selectRegression({ ...base, changeKinds: k("dependency") }).serviceWide).toBe(true);
    expect(selectRegression({ ...base, changeKinds: k("config") }).serviceWide).toBe(false);
    // Story mode: a migration in another service does not widen this one.
    expect(selectRegression({ ...base, changeKinds: k("migration", "payments") }).serviceWide).toBe(false);
  });
});
