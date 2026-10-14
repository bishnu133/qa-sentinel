import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { describe, expect, it } from "vitest";
import { addMobileCommand, initCommand } from "../src/commands/init.js";
import { loadConfig } from "../src/config.js";
import { layerEnvNames, layerOfFile, primaryLayer, runCommandsFor, specArgs, suiteRunCommand } from "../src/layers.js";
import { verifyChanges } from "../src/verification.js";
import { checkPaths, generatePolicy } from "../src/guardrails.js";
import { parseTags } from "../src/analysis/testIndex.js";
import { validatePlan } from "../src/plan/validate.js";
import { readRunResults } from "../src/showcase/results.js";
import { pickShowcaseTests } from "../src/showcase/pack.js";
import { mobileChecks } from "../src/commands/doctor.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "qas-mobile-"));
const repoDir = () => {
  const r = path.join(tmp(), "qa-tests");
  fs.mkdirSync(r);
  return r;
};

describe("mobile layer", () => {
  it("init --mobile writes the WebdriverIO scaffold, the skill, packages and a CI job; layers know about it", async () => {
    const repo = repoDir();
    await initCommand({ cwd: repo, yes: true, mode: "scratch", web: true, mobile: true, ci: "gitlab", level: "maintenance", name: "m" });
    for (const f of ["wdio.conf.ts", "src/mobile/ui.ts", "src/mobile/evidence.ts", "src/mobile/globals.d.ts", "src/screens/base-screen.ts", "src/screens/home-screen.ts", "src/fixtures/mobile.ts", "tests/mobile/example/home.spec.ts", ".claude/skills/write-mobile-test/SKILL.md"])
      expect(fs.existsSync(path.join(repo, f)), f).toBe(true);
    const pkg = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8"));
    expect(pkg.devDependencies["@wdio/cli"]).toBeTruthy();
    expect(pkg.devDependencies["@wdio/junit-reporter"]).toBeTruthy();
    expect(fs.readFileSync(path.join(repo, "tsconfig.json"), "utf8")).toContain('"wdio.conf.ts"');
    expect(fs.readFileSync(path.join(repo, "src/fixtures/mobile.ts"), "utf8")).toContain("process.env.QA_BASE_URL");
    expect(fs.readFileSync(path.join(repo, ".claude/qa-sentinel.md"), "utf8")).toContain("Mobile tests: WebdriverIO + Appium in `tests/mobile`");
    const ci = fs.readFileSync(path.join(repo, "ci/qa-sentinel/tests.gitlab-ci.yml"), "utf8");
    const doc = YAML.parse(ci, { customTags: [{ tag: "!reference", collection: "seq", resolve: (v: unknown) => v }] as any, logLevel: "error" });
    expect(doc["mobile-tests"].script.at(-1)).toBe("npx wdio run wdio.conf.ts ${QA_MOBILE_TEST_ARGS}");
    expect(doc["qa-showcase"].needs).toEqual(["api-tests", { job: "mobile-tests", optional: true }]);
    expect(doc["api-tests"].script.at(-1)).toBe("npx playwright test --project=api --project=web ${QA_TEST_ARGS}");

    const c = loadConfig(repo);
    expect(layerOfFile(c, "tests/mobile/orders/new.spec.ts")).toBe("mobile");
    expect(primaryLayer(c, { name: "app", path: "../app", dependsOn: [], kind: "mobile", routes: [] })).toBe("mobile");
    expect(suiteRunCommand(c)).toBe("npx playwright test --project=api --project=web");
    expect(runCommandsFor(c, ["tests/api/a.spec.ts:3", "tests/web/b.spec.ts", "tests/mobile/c.spec.ts:12", "tests/mobile/c.spec.ts:20", "tests/mobile/d.spec.ts"])).toEqual([
      "npx playwright test --project=api --project=web tests/api/a.spec.ts:3 tests/web/b.spec.ts",
      "npx wdio run wdio.conf.ts --spec tests/mobile/c.spec.ts --spec tests/mobile/d.spec.ts",
    ]);
    expect(specArgs({ specArg: "--spec" }, ["a b.ts"], (s) => `'${s}'`)).toBe("--spec 'a b.ts'");
    expect(layerEnvNames(c)).toEqual(expect.arrayContaining(["QA_APPIUM_URL", "QA_APP", "QA_MOBILE_PLATFORM", "QA_WEB_URL"]));

    // The agent may write specs and screen objects, never the evidence hooks or the device config.
    const findings = checkPaths(
      [
        { status: "M", path: "wdio.conf.ts" },
        { status: "M", path: "src/mobile/evidence.ts" },
        { status: "A", path: "src/screens/order-screen.ts" },
        { status: "A", path: "tests/mobile/orders/new.spec.ts" },
      ],
      generatePolicy(c),
    );
    expect(findings.map((f) => [f.file, f.rule])).toEqual([
      ["wdio.conf.ts", "blocked-path"],
      ["src/mobile/evidence.ts", "blocked-path"],
    ]);
  });

  it("add-mobile turns the layer on in an existing project and keeps the config", async () => {
    const repo = repoDir();
    await initCommand({ cwd: repo, yes: true, mode: "scratch", ci: "jenkins", level: "maintenance", name: "a" });
    expect(fs.existsSync(path.join(repo, ".claude/skills/write-mobile-test"))).toBe(false);
    const c = addMobileCommand({ cwd: repo, platform: "ios" });
    expect(c.tests.mobile.enabled).toBe(true);
    expect(c.tests.mobile.platform).toBe("ios");
    expect(fs.readFileSync(path.join(repo, "wdio.conf.ts"), "utf8")).toContain('?? "ios"');
    expect(fs.existsSync(path.join(repo, ".claude/skills/write-mobile-test/SKILL.md"))).toBe(true);
    expect(fs.readFileSync(path.join(repo, "ci/qa-sentinel/Jenkinsfile.tests"), "utf8")).toContain("stage('Mobile tests')");
    expect(JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8")).devDependencies.webdriverio).toBeTruthy();
    expect(JSON.parse(fs.readFileSync(path.join(repo, "tsconfig.json"), "utf8")).include).toContain("wdio.conf.ts");
    const checks = mobileChecks(repo, c, {});
    expect(checks.find((x) => x.label.startsWith("app under test"))?.level).toBe("warn");
    expect(checks.find((x) => x.label === "wdio.conf.ts present")?.level).toBe("ok");
  });

  it("verifies mobile specs: Appium /status preflight, --spec per file, JUnit folder; blocked when Appium is down", async () => {
    const repo = repoDir();
    await initCommand({ cwd: repo, yes: true, mode: "scratch", mobile: true, ci: "gitlab", level: "maintenance", name: "v" });
    // A fake WebdriverIO: records its arguments and writes one JUnit file per "worker" into $QA_JUNIT_DIR.
    const runner = `node -e "const fs=require('fs');const d=process.env.QA_JUNIT_DIR;fs.mkdirSync(d,{recursive:true});fs.appendFileSync('${repo}/seen.log',process.argv.slice(1).join(' ')+' results='+(process.env.QA_RESULTS_DIR?'set':'unset')+'\\\\n');fs.writeFileSync(d+'/results-0-0.xml','<testsuite><testcase name=\\"opens @screen home\\" file=\\"file://./tests/mobile/a.spec.ts\\"/></testsuite>');fs.writeFileSync(d+'/results-0-1.xml','<testsuite><testcase name=\\"orders\\" file=\\"file://./tests/mobile/b.spec.ts\\"/></testsuite>')"`;
    const cfg = path.join(repo, "qa-sentinel.config.yaml");
    const doc = YAML.parseDocument(fs.readFileSync(cfg, "utf8"));
    doc.setIn(["tests", "mobile", "runCommand"], `${runner} --`);
    fs.writeFileSync(cfg, doc.toString());
    fs.writeFileSync(path.join(repo, "tests/mobile/a.spec.ts"), "x");
    fs.writeFileSync(path.join(repo, "tests/mobile/b.spec.ts"), "x");
    const c = loadConfig(repo);

    const seenPaths: string[] = [];
    const server = http.createServer((req, res) => {
      seenPaths.push(req.url ?? "");
      res.end('{"value":{"ready":true}}');
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    const changes = [
      { status: "A" as const, path: "tests/mobile/a.spec.ts" },
      { status: "A" as const, path: "tests/mobile/b.spec.ts" },
    ];
    const cc = { ...c, verification: { ...c.verification, typecheck: "never" as const } };
    try {
      const r = await verifyChanges({ cwd: repo, c: cc, changes, runDir: tmp(), env: { PATH: process.env.PATH, QA_APPIUM_URL: `http://127.0.0.1:${port}/` } });
      expect(r.status).toBe("VERIFIED");
      expect(seenPaths).toEqual(["/status"]);
      expect(r.cases.map((x) => x.layer)).toEqual(["mobile", "mobile"]);
      expect(r.checks.find((x) => x.name === "tests")).toMatchObject({ layer: "mobile", status: "passed", detail: "2 passed, 0 skipped" });
      expect(fs.readFileSync(path.join(repo, "seen.log"), "utf8").trim()).toBe("--spec tests/mobile/a.spec.ts --spec tests/mobile/b.spec.ts results=set");
    } finally {
      server.close();
    }
    const down = await verifyChanges({ cwd: repo, c: cc, changes, runDir: tmp(), env: { PATH: process.env.PATH, QA_APPIUM_URL: `http://127.0.0.1:${port}` } });
    expect(down.status).toBe("BLOCKED");
    expect(down.checks.find((x) => x.name === "preflight")?.detail).toContain(`127.0.0.1:${port}/status unreachable`);
    // A device-farm URL with credentials: they go in a header and never into the report.
    const auths: (string | undefined)[] = [];
    const farm = http.createServer((req, res) => {
      auths.push(req.headers.authorization);
      res.end("{}");
    });
    await new Promise<void>((r) => farm.listen(0, "127.0.0.1", () => r()));
    const fport = (farm.address() as { port: number }).port;
    try {
      const withKey = await verifyChanges({ cwd: repo, c: cc, changes, runDir: tmp(), env: { PATH: process.env.PATH, QA_APPIUM_URL: `http://alice:s3cr%2Ft@127.0.0.1:${fport}/wd/hub` } });
      expect(auths).toEqual([`Basic ${Buffer.from("alice:s3cr/t").toString("base64")}`]);
      expect(JSON.stringify(withKey.checks)).not.toContain("s3cr");
    } finally {
      farm.close();
    }
    const unreachable = await verifyChanges({ cwd: repo, c: cc, changes, runDir: tmp(), env: { PATH: process.env.PATH, QA_APPIUM_URL: `http://alice:s3cr3t@127.0.0.1:${fport}/wd/hub` } });
    expect(unreachable.status).toBe("BLOCKED");
    expect(JSON.stringify(unreachable.checks)).not.toContain("s3cr3t");
  });

  it("indexes @screen tags, plans mobile scenarios with a screen, and allows ui setup steps for them", () => {
    expect(parseTags("opens the cart @service:app @screen:cart/:cartId @ac:AC-1").pages).toEqual(["/cart/:id"]);
    const plan: any = {
      schemaVersion: 1,
      verdict: "v",
      recommendedAction: "a",
      changes: [{ id: "c1", type: "ui-change", summary: "new cart badge", observable: true, requirementIds: ["AC-1"], oracleStatus: "approved", riskFactors: [], evidence: [{ source: "source-code", reference: "x" }] }],
      decisions: [
        {
          changeId: "c1",
          coverage: "missing",
          decision: "create",
          existingTests: [],
          proposedScenarios: [
            { title: "badge", requirementIds: ["AC-1"], layer: "mobile", setup: [{ id: "s1", via: "ui", action: "log in with biometrics", why: "no API for device enrolment", dependsOn: [] }], assertions: ["badge shows 2"] },
          ],
          evidence: [],
          reason: "r",
        },
      ],
      impactedTests: [],
      acMismatches: [],
      specDrift: [],
      suspicious: [],
      openQuestions: [],
      skipReason: null,
      requirementStatus: [{ id: "AC-1", status: "implemented", coveredByAcs: [], evidence: [{ source: "source-code", reference: "x" }] }],
    };
    const v = validatePlan(plan, { acIds: ["AC-1"], requirementsMissing: false, testRepo: tmp(), serviceRepo: tmp(), layers: ["api", "mobile"], defaultLayer: "mobile" } as any);
    expect(v.errors.join("\n")).toContain("a mobile scenario needs the screen it opens");
    expect(v.errors.join("\n")).not.toContain("goes through the UI");
  });

  it("reads mobile result files for the showcase and picks UI tests (web first, then mobile) per AC", () => {
    const dir = tmp();
    const mk = (n: string, title: string, status: string, at: number) =>
      fs.writeFileSync(path.join(dir, `${n}.result.json`), JSON.stringify({ file: "tests/mobile/cart.spec.ts", title, status, evidence: [{ kind: "video", name: "video", path: `${n}.mp4`, contentType: "video/mp4" }], at }));
    mk("a-1", "shows the badge @screen:cart @ac:AC-1", "failed", 1);
    mk("a-2", "shows the badge @screen:cart @ac:AC-1", "passed", 2);
    fs.writeFileSync(path.join(dir, "junk.result.json"), "{");
    const results = readRunResults(dir);
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("passed");
    expect(results[0].evidence[0].path).toBe(path.join(dir, "a-2.mp4"));

    const c: any = { tests: { api: { dir: "tests/api", helpersDir: "src/api", runCommand: "x", baseUrlEnv: "B", extraWritePaths: [], framework: "playwright" }, web: { enabled: true, dir: "tests/web", pagesDir: "src/pages", runCommand: "y", baseUrlEnv: "W", extraWritePaths: [] }, mobile: { enabled: true, dir: "tests/mobile", screensDir: "src/screens", runCommand: "z", appiumUrlEnv: "A", appiumUrl: "u", extraWritePaths: [] } } };
    const t = (file: string, title: string) => ({ test: { id: `${file}:1`, file, line: 1, title, tags: [] }, result: { title, status: "passed", evidence: [] } });
    const picks = pickShowcaseTests(c, {
      story: "S-1",
      acs: [
        { id: "AC-1", text: "badge", tests: [t("tests/api/a.spec.ts", "api"), t("tests/mobile/b.spec.ts", "app")] },
        { id: "AC-2", text: "list", tests: [t("tests/mobile/c.spec.ts", "app"), t("tests/web/d.spec.ts", "web")] },
        { id: "AC-3", text: "rule", tests: [t("tests/api/e.spec.ts", "api")] },
      ],
    } as any);
    expect(picks.map((p) => [p.ac, p.layer, p.ui])).toEqual([
      ["AC-1", "mobile", true],
      ["AC-2", "web", true],
      ["AC-3", "api", false],
    ]);
  });
});

import { rebaseImports } from "../src/commands/init.js";
describe("scaffold imports", () => {
  it("follow the configured folders", () => {
    const move = (f: string) => f.replace(/^src\/screens\//, "app/screens/").replace(/^tests\/mobile\//, "e2e/");
    const spec = 'import { useMobile } from "../../../src/fixtures/mobile";\nimport { HomeScreen } from "../../../src/screens/home-screen";';
    expect(rebaseImports(spec, "tests/mobile/example/home.spec.ts", "e2e/example/home.spec.ts", move)).toBe('import { useMobile } from "../../src/fixtures/mobile";\nimport { HomeScreen } from "../../app/screens/home-screen";');
    expect(rebaseImports('import type { El, Ui } from "../mobile/ui";', "src/screens/base-screen.ts", "app/screens/base-screen.ts", move)).toBe('import type { El, Ui } from "../../src/mobile/ui";');
    expect(rebaseImports('import { BaseScreen } from "./base-screen";', "src/screens/home-screen.ts", "app/screens/home-screen.ts", move)).toBe('import { BaseScreen } from "./base-screen";');
  });
});
