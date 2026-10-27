import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { breakingKey, changeKinds, dependencyLines, majorOf, matchesKind, packageJsonDependencyChanges } from "../src/analysis/changeKinds.js";
import { flakyRuns, historyFor, historyKey, historySignals, readHistoryFile } from "../src/analysis/history.js";
import { indexSource } from "../src/analysis/testIndex.js";
import { selectRegression } from "../src/analysis/regression.js";
import { changedEndpointHistory } from "../src/plan/planner.js";
import { applyRisk } from "../src/plan/risk.js";
import { validatePlan } from "../src/plan/validate.js";
import { renderGapReport } from "../src/plan/render.js";
import { riskInputs } from "../src/commands/gapReport.js";
import { changeSet } from "../src/git.js";

const g = (cwd: string, ...a: string[]) =>
  execFileSync("git", a, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", HOME: os.tmpdir() } }).trim();
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "qas-rr-"));
const put = (root: string, rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};
const cfg = (extra: any = {}) =>
  ConfigSchema.parse({ version: 1, mode: "scratch", project: { name: "p" }, tests: { api: { framework: "playwright", runCommand: "x" } }, ci: { platform: "gitlab" }, workspace: { services: [{ name: "orders", path: "../orders" }] }, ...extra });
const c = cfg();

describe("M5 majorOf and breakingKey", () => {
  it.each([
    ["^4.21.2", "4"],
    ["~2.0.0-beta.1", "2"],
    ["v3.1.0", "3"],
    [">=2 <3", "2"],
    ["workspace:^1.2.0", "1"],
    ["npm:left-pad2@^3.0.0", "3"],
    ["^0.3.1", "0.3"],
    ["latest", "*"],
    ["*", "*"],
    ["github:org/lib2#v3.0", "3"],
    ["github:org/lib2", undefined],
    ["git+https://host/org/lib2.git", undefined],
    ["file:../lib2", undefined],
    ["link:../lib2", undefined],
    ["workspace:*", undefined],
  ])("%s gives %s", (range, key) => {
    expect(breakingKey(range)).toBe(key);
  });

  it("majorOf keeps the number", () => {
    expect(majorOf("^4.21.2")).toBe(4);
    expect(majorOf("^0.3.1")).toBe(0);
    expect(majorOf("latest")).toBeUndefined();
  });

  const major = (from: string, to: string) => packageJsonDependencyChanges(JSON.stringify({ dependencies: { x: from } }), JSON.stringify({ dependencies: { x: to } }))[0].major;
  it("flags real major changes only", () => {
    expect(major("file:../lib1", "file:../lib2")).toBe(false);
    expect(major("github:org/lib2#v1.0", "github:org/lib2#v3.0")).toBe(true);
    expect(major("npm:a2@^1.0.0", "npm:a2@^1.5.0")).toBe(false);
    expect(major("^0.3.0", "^0.4.0")).toBe(true);
    expect(major("^0.3.0", "^0.3.9")).toBe(false);
    expect(major("^2.0.0", "^1.0.0")).toBe(true); // a downgrade breaks callers too
    expect(major("latest", "^3.0.0")).toBe(true);
    expect(major("*", "^3.0.0")).toBe(true);
    expect(major("workspace:^1", "workspace:^2")).toBe(true);
    expect(major("^4.1.0", "^4.9.0")).toBe(false);
  });
});

describe("M3 dependency files: only dependency declarations count", () => {
  it("devDependencies in package.json are no dependency change", () => {
    const a = JSON.stringify({ dependencies: { express: "^4.0.0" }, devDependencies: { eslint: "^8.0.0", "@types/node": "^20.0.0" } });
    const b = JSON.stringify({ dependencies: { express: "^4.0.0" }, devDependencies: { eslint: "^9.0.0", "@types/node": "^22.0.0" } });
    expect(packageJsonDependencyChanges(a, b)).toEqual([]);
  });

  it("pom.xml: a release version bump is not, a dependency change is, a test dependency is not", () => {
    const pom = (ver: string, dep: string, extra = "") => `<project><version>${ver}</version><dependencies><dependency><groupId>g</groupId><artifactId>a</artifactId><version>${dep}</version></dependency>${extra}</dependencies></project>`;
    const x = dependencyLines("pom.xml", pom("1.0.0", "2.0.0"))!;
    expect(dependencyLines("pom.xml", pom("1.0.1", "2.0.0"))).toEqual(x);
    expect(dependencyLines("pom.xml", pom("1.0.0", "3.0.0"))).not.toEqual(x);
    const testDep = "<dependency><groupId>j</groupId><artifactId>junit</artifactId><version>5</version><scope>test</scope></dependency>";
    expect(dependencyLines("pom.xml", pom("1.0.0", "2.0.0", testDep))).toEqual(x);
  });

  it("gradle, go.mod, requirements, Cargo, Gemfile, composer, csproj", () => {
    const set = (f: string, t: string) => [...dependencyLines(f, t)!].sort();
    expect(set("build.gradle", "version = '1.0'\ndependencies {\n  implementation 'a:b:1'\n  testImplementation 'j:u:5'\n}")).toEqual(["implementation 'a:b:1'"]);
    expect(set("go.mod", "module x\ngo 1.21\nrequire github.com/a/b v1.2.3\n")).toEqual(["require github.com/a/b v1.2.3"]);
    expect(set("requirements.txt", "# c\nflask==2.0\n-r base.txt\n")).toEqual(["flask==2.0"]);
    expect(set("requirements-dev.txt", "pytest==8\n")).toEqual([]);
    expect(set("Cargo.toml", '[package]\nversion = "0.1.0"\n[dependencies]\nserde = "1"\n[dev-dependencies]\ntokio = "1"\n')).toEqual(['dependencies: serde = "1"']);
    expect(set("Pipfile", "[packages]\nflask = '*'\n[dev-packages]\npytest = '*'\n")).toEqual(["packages: flask = '*'"]);
    expect(set("pyproject.toml", '[project]\nversion = "1"\ndependencies = [\n  "flask>=2",\n]\n[tool.poetry.group.dev.dependencies]\npytest = "8"\n')).toEqual(['"flask>=2",', "]", "dependencies = ["]);
    expect(set("Gemfile", "gem 'rails'\ngroup :test do\n  gem 'rspec'\nend\n")).toEqual(["gem 'rails'"]);
    expect(set("composer.json", JSON.stringify({ require: { "a/b": "^1" }, "require-dev": { "p/u": "^9" } }))).toEqual(["a/b@^1"]);
    expect(set("app.csproj", '<Project><PackageReference Include="X" Version="1"/><PropertyGroup><Version>2</Version></PropertyGroup></Project>')).toEqual(['<PackageReference Include="X" Version="1"/>']);
    expect(dependencyLines("custom.deps", "x")).toBeUndefined();
  });

  it("reads a real repo: a pom.xml release bump gives no finding, a new dependency does", () => {
    const r = tmp();
    g(r, "init", "-q", "-b", "main");
    const pom = (ver: string, deps: string) => `<project><version>${ver}</version><dependencies>${deps}</dependencies></project>`;
    const d1 = "<dependency><groupId>g</groupId><artifactId>a</artifactId><version>1</version></dependency>";
    const d2 = "<dependency><groupId>g</groupId><artifactId>b</artifactId><version>1</version></dependency>";
    put(r, "pom.xml", pom("1.0.0", d1));
    g(r, "add", "-A");
    g(r, "commit", "-q", "-m", "init");
    put(r, "pom.xml", pom("1.0.1", d1));
    g(r, "commit", "-qam", "release");
    let cs = changeSet(r, "HEAD~1", "HEAD");
    expect(changeKinds(c, { repo: r, base: cs.base, head: cs.head, files: cs.files })).toEqual([]);
    put(r, "pom.xml", pom("1.0.1", d1 + d2));
    g(r, "commit", "-qam", "dep");
    cs = changeSet(r, "HEAD~1", "HEAD");
    const f = changeKinds(c, { repo: r, base: cs.base, head: cs.head, files: cs.files });
    expect(f).toMatchObject([{ kind: "dependency", file: "pom.xml" }]);
    expect(f[0].detail).toContain("1 dependency line(s) changed");
  });

  it("story mode: the whole-suite run is limited to the service with the migration or dependency change", () => {
    const index = [...indexSource("tests/api/orders/o.spec.ts", `test("creates @service:orders @endpoint:POST_/orders", async () => {});\ntest("lists @service:orders @endpoint:GET_/orders", async () => {});`), ...indexSource("tests/api/pay/p.spec.ts", `test("pays @service:payments @endpoint:POST_/pay", async () => {});\ntest("refunds @service:payments @endpoint:POST_/refund", async () => {});`)];
    const conf: any = { workspace: { services: [{ name: "orders", dependsOn: [] }, { name: "payments", dependsOn: [] }] } };
    const kinds: any = [{ kind: "migration", file: "db/migrations/1.sql", service: "payments" }];
    const plan = (ep: string) => ({ changes: [{ id: "c1", type: "validation-change", endpoint: ep, summary: "s", observable: true }], decisions: [], impactedTests: [] }) as any;
    const orders = selectRegression({ c: conf, service: "orders", plan: plan("POST /orders"), index, map: undefined, changeKinds: kinds });
    const pay = selectRegression({ c: conf, service: "payments", plan: plan("POST /pay"), index, map: undefined, changeKinds: kinds });
    expect(orders.serviceWide).toBe(false);
    expect(orders.args).toEqual(["tests/api/orders/o.spec.ts:1"]);
    expect(pay.serviceWide).toBe(true);
    expect(pay.args).toHaveLength(2);
  });
});

describe("M4 default globs", () => {
  const kinds = (file: string) => changeKinds(c, { repo: os.tmpdir(), base: "x", head: "y", files: [file] }).map((f) => f.kind);
  it.each([
    ["db/migrations/002.sql", ["migration"]],
    ["test/fixtures/seed.sql", []],
    ["src/queries/find.sql", []],
    ["test/migrations/x.test.ts", []],
    ["db/migration/V3__add_slot.java", ["migration"]],
    ["alembic/versions/ab12_add.py", ["migration"]],
    ["src/migration/1700-AddSlot.ts", ["migration"]],
    ["Data/Migrations/20240101_Init.cs", ["migration"]],
    ["prisma/schema.prisma", ["migration"]],
    ["src/main/resources/Application.yml", ["config"]],
    ["src/main/resources/bootstrap.yml", ["config"]],
    ["src/config/db.ts", ["config"]],
    ["config/eslint.js", []],
    ["src/flags/cli.ts", []],
    ["src/feature-flags/orders.json", ["toggle"]],
    ["gradle/libs.versions.toml", ["dependency"]],
    ["requirements/base.txt", ["dependency"]],
    ["Pipfile", ["dependency"]],
    ["Cargo.toml", ["dependency"]],
    ["composer.json", ["dependency"]],
    ["src/App/App.csproj", ["dependency"]],
  ])("%s is %j", (file, expected) => {
    expect(kinds(file)).toEqual(expected);
  });
  it("matches without regard to case, and an exclusion wins", () => {
    expect(matchesKind("DB/MIGRATIONS/A.SQL", ["**/migrations/**"])).toBe(true);
    expect(matchesKind("a/test/x.sql", ["**/*.sql", "!**/test/**"])).toBe(false);
  });
});

const NOW = new Date("2026-10-23T12:00:00Z");
const stamp = (n: number, hourShift = 0) => new Date(NOW.getTime() - n * 86_400_000 + hourShift * 3_600_000).toISOString().replace(/[:.]/g, "-");
const run = (root: string, when: string, kind: string, body: object) => put(root, `.qa-sentinel/runs/${when}-${kind}/verification.json`, JSON.stringify(body));
const specs = [
  ...indexSource("tests/api/orders/orders.spec.ts", `test("creates an order @service:orders @endpoint:POST_/orders", async () => {});\ntest("creates an order with discount @service:orders @endpoint:POST_/discounts", async () => {});\n// QA-BUG: https://j/1\ntest.fail("health is down @service:orders @endpoint:GET_/health", async () => {});`),
  ...indexSource("tests/api/pay/pay.spec.ts", `test("creates an order @service:payments @endpoint:POST_/payments", async () => {});\n// QA-BUG: https://j/2\ntest.fail("health is down @service:payments @endpoint:GET_/health", async () => {});`),
];

describe("M1 flaky history", () => {
  it("matches on file and exact title, never on a substring", () => {
    const root = tmp();
    run(root, stamp(3), "gap-orders", { flaky: ["creates an order with discount"], flakyKeys: ["tests/api/orders/orders.spec.ts::creates an order with discount"] });
    const { map } = historySignals({ cwd: root, c, index: specs, now: NOW });
    expect(historyFor(map, "orders", "POST /discounts")?.count).toBe(1);
    expect(historyFor(map, "orders", "POST /orders")).toBeUndefined();
  });

  it("uses the file: the same title in another spec file is another test", () => {
    const root = tmp();
    run(root, stamp(3), "gap-pay", { flakyKeys: ["tests/api/pay/pay.spec.ts::creates an order"] });
    const { map } = historySignals({ cwd: root, c, index: specs, now: NOW });
    expect(historyFor(map, "payments", "POST /payments")?.count).toBe(1);
    expect(historyFor(map, "orders", "POST /orders")).toBeUndefined();
  });

  it("counts a flaky test once per day, however many runs saw it", () => {
    const root = tmp();
    const key = "tests/api/orders/orders.spec.ts::creates an order";
    run(root, stamp(3, 0), "gap-orders", { flakyKeys: [key] });
    run(root, stamp(3, -1), "generate-orders", { flakyKeys: [key] });
    run(root, stamp(3, -2), "gap-orders", { flakyKeys: [key] });
    expect(historyFor(historySignals({ cwd: root, c, index: specs, now: NOW }).map, "orders", "POST /orders")?.count).toBe(1);
    run(root, stamp(5), "gap-orders", { flakyKeys: [key] }); // another day is another signal
    expect(historyFor(historySignals({ cwd: root, c, index: specs, now: NOW }).map, "orders", "POST /orders")?.count).toBe(2);
  });

  it("flakyRuns reads the new keys", () => {
    const root = tmp();
    run(root, stamp(1), "x", { flakyKeys: ["a.spec.ts::t one"] });
    expect(flakyRuns(root, { days: 90, now: NOW })[0].tests).toEqual([{ file: "a.spec.ts", name: "t one" }]);
  });
});

describe("M6 history by service", () => {
  it("a known-defect test in another service does not count here", () => {
    const { map } = historySignals({ cwd: tmp(), c, index: specs, now: NOW });
    expect(historyFor(map, "orders", "GET /health")?.signals).toHaveLength(1);
    expect(historyFor(map, "orders", "GET /health")?.signals[0].detail).toContain("tests/api/orders/orders.spec.ts");
    expect(historyFor(map, "payments", "GET /health")?.signals[0].detail).toContain("tests/api/pay/pay.spec.ts");
    expect(historyFor(map, "billing", "GET /health")).toBeUndefined();
  });

  it("history.yaml takes a service; without one it counts for every service", () => {
    const root = tmp();
    put(root, "kb/history.yaml", 'endpoints:\n  "GET /health": { incidents: 3, service: payments, note: "outage" }\n  "POST /login": { incidents: 2 }\n');
    const { map } = historySignals({ cwd: root, c, index: [], now: NOW });
    expect(historyFor(map, "payments", "GET /health")?.count).toBe(3);
    expect(historyFor(map, "orders", "GET /health")).toBeUndefined();
    expect(historyFor(map, "orders", "POST /login")?.count).toBe(2);
    expect(historyFor(map, "payments", "POST /login")?.count).toBe(2);
    expect(historyFor(map, "payments", "GET /health")?.service).toBe("payments");
  });

  it("applyRisk looks up the change's service, then the run's service", () => {
    const { map } = historySignals({ cwd: tmp(), c, index: specs, now: NOW });
    const ev = [{ source: "source-code" as const, file: "src/server.js", line: 1, reference: "x" }];
    const mk = (service?: string): any => ({ schemaVersion: 1, verdict: "v", recommendedAction: "a", changes: [{ id: "c1", type: "validation-change", endpoint: "GET /health", ...(service ? { service } : {}), summary: "s", observable: true, requirementIds: [], oracleStatus: "missing", riskFactors: ["read-only"], evidence: ev }], decisions: [], impactedTests: [], acMismatches: [], specDrift: [], requirementStatus: [], suspicious: [], openQuestions: [], skipReason: null });
    const base = { breakingEndpoints: new Set<string>(), crossService: false, history: map, historyThreshold: 1 };
    expect(applyRisk(mk(), { ...base, service: "orders" }).changes[0].risk).toBe("medium");
    expect(applyRisk(mk(), { ...base, service: "billing" }).changes[0].risk).toBe("low");
    expect(applyRisk(mk("payments"), { ...base, service: "billing" }).changes[0].risk).toBe("medium");
    expect(historyKey("orders", "get /health/")).toBe("orders|GET /health");
  });
});

describe("L2 a malformed history.yaml is reported", () => {
  const read = (text: string) => {
    const root = tmp();
    put(root, "kb/history.yaml", text);
    return readHistoryFile(root, c);
  };
  it("warns about a top-level list, a bad endpoints block, true, an empty string, and a missing number", () => {
    expect(read("- a\n- b\n").problems.join()).toContain("top level must be a mapping");
    expect(read("endpoints: [a]\n").problems.join()).toContain('"endpoints" must be a mapping');
    const bad = read('endpoints:\n  "A /a": { incidents: true }\n  "B /b": { incidents: "" }\n  "C /c": {}\n  "D /d": { incidents: 2 }\n');
    expect(bad.problems).toHaveLength(3);
    expect(bad.entries).toMatchObject([{ endpoint: "D /d", incidents: 2 }]);
  });
  it("an empty file is fine", () => {
    expect(read("").problems).toEqual([]);
  });
});

describe("M7 access control", () => {
  const root = tmp();
  put(root, "src/server.js", "x");
  const base = { acIds: [], requirementsMissing: true, testRepo: root, serviceRepo: root, roles: ["admin", "clerk"], accessControl: "require" as const };
  const ev = [{ source: "source-code", file: "src/server.js", line: 1, reference: "x" }];
  const plan = (o: { endpoint?: string; noScenario?: string; reqNo?: string } = {}): any => ({
    schemaVersion: 1,
    verdict: "v",
    recommendedAction: "a",
    changes: [{ id: "c1", type: "new-endpoint", endpoint: o.endpoint ?? "POST /login", summary: "login", observable: true, requirementIds: o.reqNo ? ["AC-1"] : [], oracleStatus: "missing", riskFactors: ["new-endpoint"], evidence: ev }],
    decisions: [{ changeId: "c1", coverage: "missing", decision: "create", existingTests: [], proposedScenarios: [{ title: "logs in", setup: [], assertions: ["200"] }], evidence: ev, reason: "r", ...(o.noScenario ? { noScenario: o.noScenario } : {}) }],
    impactedTests: [],
    acMismatches: [],
    specDrift: [],
    requirementStatus: o.reqNo ? [{ id: "AC-1", status: "implemented", noScenario: o.reqNo, evidence: ev }] : [],
    suspicious: [],
    openQuestions: [],
    skipReason: null,
  });
  const v = (p: any, extra: any = {}) => validatePlan(p, { ...base, ...(p.requirementStatus.length ? { acIds: ["AC-1"], requirementsMissing: false } : {}), ...extra });

  it("a new public endpoint is asked for scenarios unless it is listed as public", () => {
    expect(v(plan()).errors.join("\n")).toContain('"no-token"');
    expect(v(plan(), { publicEndpoints: ["post /login/"] }).errors).toEqual([]);
  });

  it("an existing @role:none test counts as the no-token scenario", () => {
    const r = v(plan({ endpoint: "POST /orders" }), { existingRoles: { "POST /orders": ["none"] } });
    expect(r.errors.join("\n")).not.toContain('"no-token"');
    expect(r.errors.join("\n")).toContain('"forbidden"');
    expect(v(plan({ endpoint: "POST /orders" }), { existingRoles: { "POST /orders": ["admin"] } }).errors.join("\n")).toContain('"no-token"');
  });

  it("a noScenario reason on the requirement is accepted too", () => {
    expect(v(plan({ reqNo: "public endpoint" })).errors).toEqual([]);
  });

  it("the decision's noScenario reason is shown in the report", () => {
    const p = v(plan({ noScenario: "login is public by design" }));
    expect(p.errors).toEqual([]);
    const md = renderGapReport({ service: "o", plan: p.plan!, risked: applyRisk(p.plan!, { breakingEndpoints: new Set(), crossService: false }), contract: { status: "no-spec", changes: [] }, requirementsLine: "", corrections: [], warnings: [], oracle: "missing" });
    expect(md).toContain("No access-control scenarios, with the reason given");
    expect(md).toContain("- c1: login is public by design");
  });

  it("config has a list of public endpoints", () => {
    expect(cfg({ risk: { publicEndpoints: ["POST /login"] } }).risk.publicEndpoints).toEqual(["POST /login"]);
  });
});

describe("M8 context.json stays small", () => {
  it("keeps this service's touched endpoints, at most 15, with short details", () => {
    const { map } = historySignals({ cwd: tmp(), c, index: specs, now: NOW });
    const many = new Map(map);
    for (let i = 0; i < 40; i++) many.set(historyKey("orders", `GET /r${i}`), { endpoint: `GET /r${i}`, service: "orders", count: 2, signals: [{ kind: "incident", count: 2, detail: "x".repeat(500) }] });
    const diff = Array.from({ length: 40 }, (_, i) => `+ app.get("/r${i}")`).join("\n");
    const out = changedEndpointHistory(many, ["orders"], [diff]);
    expect(out).toHaveLength(15);
    expect(out.every((x) => x.why.length <= 170)).toBe(true);
    // the other service's endpoint and an endpoint the diff does not touch are left out
    expect(changedEndpointHistory(map, ["orders"], ["+ app.get('/health')"]).map((x) => x.service)).toEqual(["orders"]);
    expect(changedEndpointHistory(map, ["orders"], ["+ nothing here"])).toEqual([]);
    expect(changedEndpointHistory(map, ["orders"], ["+ nothing here"], ["GET /health"])).toHaveLength(1);
  });
});

describe("L1 c0 is reserved", () => {
  it("rejects a change named c0, accepts c1 and c10", () => {
    const ev = [{ source: "source-code", file: "src/server.js", line: 1, reference: "x" }];
    const p = (id: string): any => ({ schemaVersion: 1, verdict: "v", recommendedAction: "a", changes: [{ id, type: "internal", summary: "s", observable: false, requirementIds: [], oracleStatus: "missing", riskFactors: ["internal"], evidence: ev }], decisions: [], impactedTests: [], acMismatches: [], specDrift: [], requirementStatus: [], suspicious: [], openQuestions: [], skipReason: "internal" });
    const base = { acIds: [], requirementsMissing: true, testRepo: os.tmpdir(), serviceRepo: os.tmpdir() };
    expect(validatePlan(p("c0"), base).errors.join("\n")).toContain("c0 is added by qa-sentinel");
    expect(validatePlan(p("c1"), base).errors).toEqual([]);
    expect(validatePlan(p("c10"), base).errors).toEqual([]);
  });
});

describe("L3 the unchanged check sees risk settings and the history file", () => {
  it("changes with kb/history.yaml and with risk.changeTypes", () => {
    const root = tmp();
    const a = riskInputs(c, root);
    put(root, "kb/history.yaml", "endpoints: {}\n");
    const b = riskInputs(c, root);
    expect(b).not.toBe(a);
    expect(riskInputs(cfg({ risk: { changeTypes: { migration: ["sql/**"] } } }), root)).not.toBe(b);
    expect(riskInputs(c, root)).toBe(b);
  });
});

describe("L6 @role on a describe applies to its tests", () => {
  it("is inherited", () => {
    const t = indexSource("tests/api/a.spec.ts", `test.describe("anonymous @role:none", () => {\n  test("refuses @endpoint:POST_/orders", async () => {});\n});\ntest("other @role:admin @endpoint:POST_/x", async () => {});`);
    expect(t[0].roles).toEqual(["none"]);
    expect(t[1].roles).toEqual(["admin"]);
  });
});
