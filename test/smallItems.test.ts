import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";
import { ConfigSchema, writeConfig } from "../src/config.js";
import { assembleFeature, newFeatureCache } from "../src/feature/manifest.js";
import { heldBackPattern, suiteRunCommands } from "../src/layers.js";
import { rangesLabel } from "../src/story.js";
import { hotfixCommand } from "../src/commands/hotfix.js";
import { initCommand } from "../src/commands/init.js";
import { runChecks } from "../src/commands/doctor.js";
import { suiteCommand } from "../src/commands/suite.js";

const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const g = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8", env }).trim();
const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), `qas-${p}-`));
const quiet = () => vi.spyOn(process.stdout, "write").mockImplementation(() => true);
afterEach(() => vi.restoreAllMocks());

function cfg(extra: Record<string, unknown> = {}, runCommand = "npx playwright test") {
  return ConfigSchema.parse({ version: 1, mode: "scratch", project: { name: "p" }, tests: { api: { framework: "playwright", runCommand } }, ci: { platform: "gitlab" }, workspace: { services: [{ name: "orders", path: "orders", version: { path: "/orders/version", field: "commit" } }] }, ...extra });
}

describe("suite: one lookup per service, however many stories", () => {
  it("asks the version endpoint once and reads the revert list once for 5 stories", async () => {
    const work = tmp("cache");
    const orders = path.join(work, "orders");
    fs.mkdirSync(orders);
    g(orders, "init", "-q", "-b", "main");
    for (let i = 1; i <= 5; i++) g(orders, "commit", "-q", "--allow-empty", "-m", `SHOP-10${i}: change ${i}`);
    let calls = 0;
    const head = g(orders, "rev-parse", "HEAD");
    const server = http.createServer((_q, res) => {
      calls++;
      res.end(JSON.stringify({ commit: head }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      const cache = newFeatureCache();
      const out = [];
      for (let i = 1; i <= 5; i++) out.push(await assembleFeature({ c: cfg(), cwd: work, story: `SHOP-10${i}`, environment: "sit", baseUrl: base, cache }));
      expect(out.map((m) => m.status)).toEqual(Array(5).fill("ready-for-feature-tests"));
      expect(calls).toBe(1);
      expect(cache.asked).toEqual({ versionCalls: 1, revertScans: 1 });
      // Without a cache every story asks again (the old behaviour is unchanged).
      await assembleFeature({ c: cfg(), cwd: work, story: "SHOP-101", environment: "sit", baseUrl: base });
      await assembleFeature({ c: cfg(), cwd: work, story: "SHOP-102", environment: "sit", baseUrl: base });
      expect(calls).toBe(3);
    } finally {
      server.close();
    }
  });
});

describe("suite --run: select by title where the runner takes no file:line", () => {
  const tests = [
    { file: "tests/api/a.test.ts", line: 3 },
    { file: "tests/api/a.test.ts", line: 9 },
    { file: "tests/api/b.test.ts", line: 4 },
  ];
  it("builds the leave-out pattern so SHOP-1 does not match SHOP-10", () => {
    const re = new RegExp(heldBackPattern(["SHOP-1", "SHOP-7"]));
    expect(re.test("works @story:SHOP-1 @ac:AC-1")).toBe(true);
    expect(re.test("works @story:SHOP-7")).toBe(true);
    expect(re.test("works @story:SHOP-10")).toBe(false);
    expect(re.test("works @story:SHOP-1-x")).toBe(false);
  });
  it("Playwright keeps exact file:line", () => {
    expect(suiteRunCommands(cfg(), tests, ["SHOP-7"]).map((x) => x.command)).toEqual(["npx playwright test tests/api/a.test.ts:3 tests/api/a.test.ts:9 tests/api/b.test.ts:4"]);
  });
  it("Mocha: files plus --grep --invert", () => {
    const [m] = suiteRunCommands(cfg({}, "npx mocha"), tests, ["SHOP-7"]);
    expect(m.command).toBe(`npx mocha --grep '@story:(?:[^\\s,]+,)*(?:SHOP-7)(?![\\w-])' --invert tests/api/a.test.ts tests/api/b.test.ts`);
  });
  it("Jest and Vitest: -t with a negative pattern; no filter when nothing is held back", () => {
    const [j] = suiteRunCommands(cfg({}, "npx jest"), tests, ["SHOP-7"]);
    expect(j.command).toBe(`npx jest --runTestsByPath -t '^(?!.*@story:(?:[^\\s,]+,)*(?:SHOP-7)(?![\\w-])).*$' tests/api/a.test.ts tests/api/b.test.ts`);
    expect(suiteRunCommands(cfg({}, "npx vitest run"), tests, [])[0].command).toBe("npx vitest run tests/api/a.test.ts tests/api/b.test.ts");
    expect(suiteRunCommands(cfg({}, "npm run test"), tests, ["SHOP-7"], { test: "jest" })[0].command).toContain("npm run test -- --runTestsByPath -t ");
  });
  it("WebdriverIO runs whole files and says so", () => {
    const [w] = suiteRunCommands(cfg({}, "npx wdio run wdio.conf.ts"), tests, ["SHOP-7"]);
    expect(w.note).toMatch(/whole files/);
  });
  it("a real vitest run leaves out the held-back test by title", () => {
    const dir = tmp("vt");
    fs.writeFileSync(path.join(dir, "x.test.ts"), `import { test } from "vitest";\ntest("kept @story:SHOP-1", () => {});\ntest("held @story:SHOP-7", () => { throw new Error("must not run"); });\ntest("ten @story:SHOP-70", () => {});\n`);
    const bin = path.resolve("node_modules/.bin/vitest");
    const [v] = suiteRunCommands(cfg({}, bin + " run"), [{ file: "x.test.ts", line: 2 }], ["SHOP-7"]);
    execFileSync("sh", ["-c", v.command], { cwd: dir, env: { ...process.env, CI: "" }, stdio: "pipe" });
  });
});

describe("suite --run end to end: Cucumber scenarios are reported separately", () => {
  it("lists them apart and does not run them", async () => {
    const work = tmp("suite");
    const qa = path.join(work, "qa");
    fs.mkdirSync(path.join(qa, "tests/api"), { recursive: true });
    fs.mkdirSync(path.join(qa, "tests/api/features"), { recursive: true });
    fs.writeFileSync(path.join(qa, "tests/api/a.spec.ts"), `test("plain @story:SHOP-1", async () => {});\n`);
    fs.writeFileSync(path.join(qa, "tests/api/features/x.feature"), `Feature: x\n  @story:SHOP-1\n  Scenario: a cucumber one\n    Given a thing\n`);
    const c = cfg({ tests: { api: { framework: "playwright", runCommand: "echo RAN", dir: "tests/api" } }, workspace: { services: [] } });
    writeConfig(qa, c);
    const out = quiet();
    const code = await suiteCommand({ cwd: qa, tag: "main", json: true });
    out.mockRestore();
    expect(code).toBe(0);
    const md = fs.readFileSync(path.join(qa, "qa-suite.md"), "utf8");
    const txt = fs.readFileSync(path.join(qa, "qa-suite.txt"), "utf8");
    expect(md).toContain("Cucumber scenarios (1;");
    expect(md).toContain("tests/api/features/x.feature");
    expect(txt.trim()).toBe("tests/api/a.spec.ts:1");
  });
});

describe("hotfix exit codes", () => {
  function setup() {
    const work = tmp("hotfix");
    const o = path.join(work, "orders");
    fs.mkdirSync(o);
    g(o, "init", "-q", "-b", "main");
    g(o, "commit", "-q", "--allow-empty", "-m", "start");
    g(o, "checkout", "-q", "-b", "hotfix/orders-1");
    fs.writeFileSync(path.join(o, "f.txt"), "fix");
    g(o, "add", "-A");
    g(o, "commit", "-q", "-m", "SHOP-5: urgent fix");
    const fix = g(o, "rev-parse", "HEAD");
    g(o, "checkout", "-q", "main");
    g(o, "commit", "-q", "--allow-empty", "-m", "other main work");
    writeConfig(work, cfg({ workspace: { services: [{ name: "orders", path: "orders" }] } }));
    return { work, o, fix };
  }
  const run = (work: string, fix: string, extra: object) => {
    const out = quiet();
    return hotfixCommand({ cwd: work, service: "orders", commit: [fix], json: true, ...extra }).finally(() => out.mockRestore());
  };
  it("is 0 by default, 75 with --fail-if-waiting and --strict while not on main", async () => {
    const { work, fix } = setup();
    expect(await run(work, fix, {})).toBe(0);
    expect(await run(work, fix, { failIfWaiting: true })).toBe(75);
    expect(await run(work, fix, { strict: true })).toBe(75);
  });
  it("after the cherry-pick: 0 inside the grace days, 1 after them without tests (only with --strict)", async () => {
    const { work, o, fix } = setup();
    g(o, "cherry-pick", "-x", fix);
    expect(await run(work, fix, { failIfWaiting: true })).toBe(0);
    expect(await run(work, fix, { strict: true })).toBe(0);
    const later = new Date(Date.now() + 5 * 86_400_000);
    expect(await run(work, fix, { strict: true, now: later })).toBe(1);
    expect(await run(work, fix, { strict: true, now: later, graceDays: 10 })).toBe(0);
    expect(await run(work, fix, { failIfWaiting: true, now: later })).toBe(0);
  });
});

describe("init then doctor: no mismatch flood", () => {
  async function tagged(extraSpec = "") {
    const work = tmp("init");
    const qa = path.join(work, "qa-tests");
    fs.mkdirSync(path.join(qa, "tests/api"), { recursive: true });
    fs.mkdirSync(path.join(work, "orders-service"));
    g(path.join(work, "orders-service"), "init", "-q");
    fs.writeFileSync(path.join(qa, "package.json"), JSON.stringify({ devDependencies: { "@playwright/test": "1.0.0" } }));
    fs.writeFileSync(path.join(qa, "tests/api/a.spec.ts"), `import { test } from "@playwright/test";\ntest("creates an order @service:orders-service @endpoint:POST_/orders @story:SHOP-1", async () => {});\n`);
    fs.writeFileSync(path.join(qa, "tests/api/b.spec.ts"), `import { test } from "@playwright/test";\ntest("reads an order @service:orders-service @endpoint:GET_/orders/{id}", async () => {});\n${extraSpec}`);
    g(qa, "init", "-q");
    return { work, qa };
  }
  it("init lists the tagged tests in test-map.yaml and doctor reports no mismatch", async () => {
    const { work, qa } = await tagged();
    quiet();
    await initCommand({ cwd: qa, yes: true, mode: "existing", ci: "gitlab", workspace: work, name: "t", level: "maintenance" });
    const map = YAML.parse(fs.readFileSync(path.join(qa, "test-map.yaml"), "utf8"));
    expect(map.services["orders-service"].endpoints).toEqual({ "POST /orders": ["tests/api/a.spec.ts"], "GET /orders/{id}": ["tests/api/b.spec.ts"] });
    const checks = runChecks(qa, {});
    expect(checks.filter((x) => /agrees with test tags/.test(x.label))).toEqual([]);
  });
  it("an empty map gives one actionable line, not N mismatches; a service missing from the map is flagged", async () => {
    const { work, qa } = await tagged();
    quiet();
    await initCommand({ cwd: qa, yes: true, mode: "existing", ci: "gitlab", workspace: work, name: "t", level: "maintenance" });
    const mapFile = path.join(qa, "test-map.yaml");
    fs.writeFileSync(mapFile, YAML.stringify({ version: 1, services: { "orders-service": { path: "../orders-service", endpoints: {}, screens: {} }, "old-service": { endpoints: {} } } }));
    const checks = runChecks(qa, {});
    const agree = checks.filter((x) => /agrees with test tags/.test(x.label));
    expect(agree).toHaveLength(1);
    expect(agree[0].hint).toMatch(/empty.*qa-sentinel learn/);
    expect(checks.some((x) => /lists only services of the config/.test(x.label) && /old-service/.test(x.hint ?? ""))).toBe(true);
    const doc = YAML.parse(fs.readFileSync(path.join(qa, "qa-sentinel.config.yaml"), "utf8"));
    doc.workspace.services.push({ name: "billing", path: "../billing" });
    fs.writeFileSync(path.join(qa, "qa-sentinel.config.yaml"), YAML.stringify(doc));
    expect(runChecks(qa, {}).some((x) => /lists every service of the config/.test(x.label) && /billing/.test(x.hint ?? ""))).toBe(true);
  });
});

describe("story change label", () => {
  it("says a repeated label once", () => {
    const l = "orders feature/SHOP-106-shipping-notice merged";
    expect(rangesLabel("orders", [l, l, l])).toBe("orders feature/SHOP-106-shipping-notice merged (3 changes)");
    expect(rangesLabel("orders", ["orders !12 merged", "orders !14 open"])).toBe("orders !12 merged, !14 open");
    expect(rangesLabel("orders", [l])).toBe(l);
  });
});

describe("jest fixture", () => {
  it("is well-formed XML", () => {
    const x = fs.readFileSync(path.join(__dirname, "fixtures/jest-fails/results.xml"), "utf8");
    expect((x.match(/<failure/g) ?? []).length).toBe((x.match(/<\/failure>/g) ?? []).length);
  });
});
