import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";
import { ConfigSchema, loadConfig, writeConfig } from "../src/config.js";
import { assembleFeature, newFeatureCache } from "../src/feature/manifest.js";
import { suiteRunCommands } from "../src/layers.js";
import { indexSource } from "../src/analysis/testIndex.js";
import { hotfixCommand } from "../src/commands/hotfix.js";
import { initCommand, writeTestMap } from "../src/commands/init.js";
import { runChecks } from "../src/commands/doctor.js";
import { suiteCommand } from "../src/commands/suite.js";

// No global git identity needed: every git call carries its own.
const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const g = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8", env }).trim();
const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), `qas-${p}-`));
const bin = (n: string) => path.resolve("node_modules/.bin", n);
afterEach(() => vi.restoreAllMocks());

function cfg(extra: Record<string, unknown> = {}, runCommand = "npx playwright test") {
  return ConfigSchema.parse({ version: 1, mode: "scratch", project: { name: "p" }, tests: { api: { framework: "playwright", runCommand, dir: "tests/api" } }, ci: { platform: "gitlab" }, workspace: { services: [{ name: "orders", path: "orders", version: { path: "/orders/version", field: "commit" } }] }, ...extra });
}
const run = (cmd: string, cwd: string) => execFileSync("sh", ["-c", cmd], { cwd, env: { ...process.env, CI: "" }, stdio: "pipe", encoding: "utf8" });

describe("H1: comma-listed story tags are left out too", () => {
  const titles = [
    `kept one @story:SHOP-1`,
    `held list @story:SHOP-1,SHOP-7`,
    `held list first @story:SHOP-7,SHOP-1`,
    `held separate @story:SHOP-1 @story:SHOP-7`,
    `held alone @story:SHOP-7`,
    `kept ten @story:SHOP-70`,
    `kept dashed @story:SHOP-7-x`,
  ];
  const held = titles.filter((t) => t.startsWith("held"));
  const kept = titles.filter((t) => t.startsWith("kept"));

  it("real vitest runs only the kept ones", () => {
    const dir = tmp("h1v");
    const body = titles.map((t) => (t.startsWith("held") ? `test(${JSON.stringify(t)}, () => { throw new Error("must not run"); });` : `test(${JSON.stringify(t)}, () => {});`)).join("\n");
    fs.writeFileSync(path.join(dir, "x.test.ts"), `import { test } from "vitest";\n${body}\n`);
    const [v] = suiteRunCommands(cfg({}, bin("vitest") + " run"), [{ file: "x.test.ts", line: 2 }], ["SHOP-7"]);
    run(v.command, dir);
  });

  it("real mocha runs only the kept ones", () => {
    const dir = tmp("h1m");
    const body = titles.map((t) => (t.startsWith("held") ? `it(${JSON.stringify(t)}, () => { throw new Error("must not run"); });` : `it(${JSON.stringify(t)}, () => {});`)).join("\n");
    fs.writeFileSync(path.join(dir, "x.test.js"), body + "\n");
    const [m] = suiteRunCommands(cfg({}, bin("mocha")), [{ file: "x.test.js", line: 1 }], ["SHOP-7"]);
    const out = run(m.command, dir);
    expect(out).toContain(`${kept.length} passing`);
    expect(held.length).toBe(4);
  });
});

describe("M3: a story tag on a describe block counts for its tests", () => {
  it("the index carries it and a real vitest run leaves the group out", () => {
    const src = `import { describe, test } from "vitest";\ndescribe("Orders @story:SHOP-7", () => {\n  test("inside", () => { throw new Error("must not run"); });\n});\ntest("outside @story:SHOP-1", () => {});\n`;
    const idx = indexSource("x.test.ts", src);
    expect(idx.map((t) => t.stories)).toEqual([["SHOP-7"], ["SHOP-1"]]);
    const dir = tmp("m3");
    fs.writeFileSync(path.join(dir, "x.test.ts"), src);
    const [v] = suiteRunCommands(cfg({}, bin("vitest") + " run"), [{ file: "x.test.ts", line: 5 }], ["SHOP-7"]);
    run(v.command, dir);
  });
  it("tags on the test and on the group are joined", () => {
    const idx = indexSource("x.test.ts", `describe("G @story:SHOP-7", () => {\n  test("t @story:SHOP-1", () => {});\n});\n`);
    expect(idx[0].stories.sort()).toEqual(["SHOP-1", "SHOP-7"]);
  });
});

describe("pnpm and npm separators", () => {
  const tests = [{ file: "a.test.js", line: 1 }];
  it("npm gets ` --` for Mocha, pnpm and yarn do not, and an existing one is kept", () => {
    const one = (cmd: string) => suiteRunCommands(cfg({}, cmd), tests, ["SHOP-7"], { test: "mocha" })[0].command;
    expect(one("npm run test")).toMatch(/^npm run test -- --grep /);
    expect(one("pnpm run test")).toMatch(/^pnpm run test --grep /);
    expect(one("yarn test")).toMatch(/^yarn test --grep /);
    expect(one("npm run test --")).toMatch(/^npm run test -- --grep /);
    expect(one("npm run test --")).not.toMatch(/ -- -- /);
  });
});

describe("shared cache gives the same answer as no cache", () => {
  it("a reverted story is reverted either way", async () => {
    const work = tmp("rev");
    const o = path.join(work, "orders");
    fs.mkdirSync(o);
    g(o, "init", "-q", "-b", "main");
    g(o, "commit", "-q", "--allow-empty", "-m", "start");
    g(o, "commit", "-q", "--allow-empty", "-m", "SHOP-3: feature");
    g(o, "commit", "-q", "--allow-empty", "-m", "SHOP-4: other");
    const bad = g(o, "rev-parse", "HEAD~1");
    g(o, "commit", "-q", "--allow-empty", "-m", `Revert "SHOP-3: feature"\n\nThis reverts commit ${bad}.`);
    const c = cfg();
    const cache = newFeatureCache();
    const stories = ["SHOP-3", "SHOP-4", "SHOP-3"];
    for (const story of stories) {
      const a = await assembleFeature({ c, cwd: work, story, cache });
      const b = await assembleFeature({ c, cwd: work, story });
      expect(a.status).toBe(b.status);
      expect(a.parts.map((p) => p.reverted)).toEqual(b.parts.map((p) => p.reverted));
    }
    expect((await assembleFeature({ c, cwd: work, story: "SHOP-3", cache })).status).toBe("reverted");
    expect((await assembleFeature({ c, cwd: work, story: "SHOP-4", cache })).status).toBe("merged");
    expect(cache.asked.revertScans).toBe(1);
  });
});

describe("hotfix: M1 grace measured from when it reached main, L1 grace-days, L2 json", () => {
  function merged() {
    const work = tmp("hfm");
    const o = path.join(work, "orders");
    fs.mkdirSync(o);
    g(o, "init", "-q", "-b", "main");
    g(o, "commit", "-q", "--allow-empty", "-m", "start");
    g(o, "checkout", "-q", "-b", "hotfix/orders-1");
    fs.writeFileSync(path.join(o, "f.txt"), "fix");
    g(o, "add", "-A");
    // The fix was written 30 days ago.
    const old = new Date(Date.now() - 30 * 86_400_000).toISOString();
    execFileSync("git", ["commit", "-q", "-m", "SHOP-5: urgent fix"], { cwd: o, env: { ...env, GIT_AUTHOR_DATE: old, GIT_COMMITTER_DATE: old } });
    const fix = g(o, "rev-parse", "HEAD");
    g(o, "checkout", "-q", "main");
    g(o, "commit", "-q", "--allow-empty", "-m", "other main work");
    writeConfig(work, cfg({ workspace: { services: [{ name: "orders", path: "orders" }] } }));
    return { work, o, fix };
  }
  const call = async (work: string, fix: string, extra: object) => {
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      return await hotfixCommand({ cwd: work, service: "orders", commit: [fix], json: true, ...extra });
    } finally {
      out.mockRestore();
    }
  };
  it("a hotfix branch merged today is inside the grace days although its commit is 30 days old", async () => {
    const { work, o, fix } = merged();
    g(o, "merge", "-q", "--no-ff", "hotfix/orders-1", "-m", "Merge hotfix");
    expect(await call(work, fix, { strict: true })).toBe(0);
    const later = new Date(Date.now() + 5 * 86_400_000);
    expect(await call(work, fix, { strict: true, now: later })).toBe(1);
  });
  it("rejects a bad --grace-days, and --grace-days without --strict", async () => {
    const { work, fix } = merged();
    await expect(call(work, fix, { strict: true, graceDays: NaN })).rejects.toThrow(/--grace-days must be/);
    await expect(call(work, fix, { strict: true, graceDays: -1 })).rejects.toThrow(/--grace-days must be/);
    await expect(call(work, fix, { graceDays: 3 })).rejects.toThrow(/only works with --strict/);
  });
  it("--json lists the waiting and the late commits; waiting (75) wins over late (1)", async () => {
    const { work, o, fix } = merged();
    g(o, "merge", "-q", "--no-ff", "hotfix/orders-1", "-m", "Merge hotfix");
    g(o, "checkout", "-q", "-b", "hotfix/orders-2", "main~2");
    fs.writeFileSync(path.join(o, "g.txt"), "x");
    g(o, "add", "-A");
    g(o, "commit", "-q", "-m", "SHOP-6: second fix");
    const fix2 = g(o, "rev-parse", "HEAD");
    g(o, "checkout", "-q", "main");
    let json = "";
    const out = vi.spyOn(process.stdout, "write").mockImplementation((x: unknown) => ((json += String(x)), true));
    const later = new Date(Date.now() + 5 * 86_400_000);
    const code = await hotfixCommand({ cwd: work, service: "orders", commit: [fix, fix2], json: true, strict: true, now: later });
    out.mockRestore();
    expect(code).toBe(75);
    const j = JSON.parse(json);
    expect(j.waiting).toEqual([fix2]);
    expect(j.late).toEqual([fix]);
  });
});

describe("suite --run end to end with a real runner", () => {
  function workspace(runner: "vitest" | "mocha") {
    const work = tmp(`suite-${runner}`);
    const orders = path.join(work, "orders");
    fs.mkdirSync(orders);
    g(orders, "init", "-q", "-b", "main");
    g(orders, "commit", "-q", "--allow-empty", "-m", "start");
    g(orders, "tag", "v1");
    g(orders, "commit", "-q", "--allow-empty", "-m", "SHOP-7: after the release");
    const qa = path.join(work, "qa");
    fs.mkdirSync(path.join(qa, "tests/api"), { recursive: true });
    const ext = runner === "vitest" ? "ts" : "js";
    const head = runner === "vitest" ? `import { test as it } from "vitest";\n` : "";
    fs.writeFileSync(
      path.join(qa, `tests/api/a.test.${ext}`),
      `${head}it("kept @story:SHOP-1", () => {});\nit("held @story:SHOP-7", () => { throw new Error("must not run"); });\nit("held in a list @story:SHOP-1,SHOP-7", () => { throw new Error("must not run"); });\n`,
    );
    writeConfig(qa, cfg({ workspace: { services: [{ name: "orders", path: "../orders" }] } }, runner === "vitest" ? `${bin("vitest")} run` : bin("mocha")));
    return qa;
  }
  for (const runner of ["vitest", "mocha"] as const)
    it(`${runner}: the held-back tests do not run, the kept one does`, async () => {
      const qa = workspace(runner);
      const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      let code: number;
      try {
        code = await suiteCommand({ cwd: qa, tag: "v1", run: true });
      } finally {
        out.mockRestore();
        log.mockRestore();
      }
      expect(code).toBe(0);
      const md = fs.readFileSync(path.join(qa, "qa-suite.md"), "utf8");
      expect(md).toContain("SHOP-7 | ⏸️ held back");
    });
  it("--json carries the lookup counts", async () => {
    const qa = workspace("vitest");
    let json = "";
    const out = vi.spyOn(process.stdout, "write").mockImplementation((x: unknown) => ((json += String(x)), true));
    await suiteCommand({ cwd: qa, tag: "v1", json: true });
    out.mockRestore();
    expect(JSON.parse(json).asked).toEqual({ versionCalls: 0, revertScans: 1 });
  });
});

describe("init attribution and doctor", () => {
  function repo(files: Record<string, string>, services: { name: string; web?: boolean }[]) {
    const work = tmp("att");
    const qa = path.join(work, "qa-tests");
    fs.mkdirSync(path.join(qa, "tests/api"), { recursive: true });
    for (const s of services) {
      fs.mkdirSync(path.join(work, s.name));
      g(path.join(work, s.name), "init", "-q");
    }
    fs.writeFileSync(path.join(qa, "package.json"), JSON.stringify({ devDependencies: { "@playwright/test": "1.0.0" } }));
    for (const [f, body] of Object.entries(files)) fs.writeFileSync(path.join(qa, f), `import { test } from "@playwright/test";\n${body}\n`);
    g(qa, "init", "-q");
    return { work, qa };
  }
  const quiet = () => vi.spyOn(console, "log").mockImplementation(() => {});
  it("a test naming the second service goes under it; an unknown service name falls back to the first API service", async () => {
    const { work, qa } = repo(
      { "tests/api/a.spec.ts": `test("a @service:payments-service @endpoint:POST_/pay", async () => {});`, "tests/api/b.spec.ts": `test("b @service:ghost-service @endpoint:GET_/b", async () => {});` },
      [{ name: "orders-service" }, { name: "payments-service" }],
    );
    quiet();
    await initCommand({ cwd: qa, yes: true, mode: "existing", ci: "gitlab", workspace: work, name: "t", level: "maintenance" });
    const map = YAML.parse(fs.readFileSync(path.join(qa, "test-map.yaml"), "utf8"));
    expect(map.services["payments-service"].endpoints).toEqual({ "POST /pay": ["tests/api/a.spec.ts"] });
    expect(map.services["orders-service"].endpoints).toEqual({ "GET /b": ["tests/api/b.spec.ts"] });
  });
  it("a page test with no service goes under the web service; with no web service it stays in unmapped", async () => {
    const withWeb = repo({ "tests/api/p.spec.ts": `test("p @page:/orders", async () => {});` }, [{ name: "api-service" }, { name: "storefront" }]);
    quiet();
    await initCommand({ cwd: withWeb.qa, yes: true, mode: "existing", ci: "gitlab", workspace: withWeb.work, name: "t", level: "maintenance" });
    const cf = path.join(withWeb.qa, "qa-sentinel.config.yaml");
    const doc = YAML.parse(fs.readFileSync(cf, "utf8"));
    expect(doc.workspace.services.map((s: any) => s.name)).toEqual(["api-service", "storefront"]);
    // The kind comes from the config, which the person reviews; with the front end marked as web the page test goes there.
    doc.workspace.services[1].kind = "web";
    fs.writeFileSync(cf, YAML.stringify(doc));
    fs.rmSync(path.join(withWeb.qa, "test-map.yaml"));
    writeTestMap(withWeb.qa, loadConfig(withWeb.qa), { apiTestFiles: [] });
    const webMap = YAML.parse(fs.readFileSync(path.join(withWeb.qa, "test-map.yaml"), "utf8"));
    expect(webMap.services.storefront.screens).toEqual({ "/orders": ["tests/api/p.spec.ts"] });
    expect(webMap.services["api-service"].screens).toEqual({});
    const noWeb = repo({ "tests/api/p.spec.ts": `test("p @page:/orders", async () => {});` }, [{ name: "api-service" }]);
    await initCommand({ cwd: noWeb.qa, yes: true, mode: "existing", ci: "gitlab", workspace: noWeb.work, name: "t", level: "maintenance" });
    const map = YAML.parse(fs.readFileSync(path.join(noWeb.qa, "test-map.yaml"), "utf8"));
    expect(map.services["api-service"].screens).toEqual({});
    expect(map.unmapped).toContain("tests/api/p.spec.ts");
  });
  it("doctor: an empty map is one warning line, and 'not in config' is silent when the config has no services", async () => {
    const { work, qa } = repo({ "tests/api/a.spec.ts": `test("a @endpoint:POST_/x", async () => {});` }, [{ name: "orders-service" }]);
    quiet();
    await initCommand({ cwd: qa, yes: true, mode: "existing", ci: "gitlab", workspace: work, name: "t", level: "maintenance" });
    fs.writeFileSync(path.join(qa, "test-map.yaml"), YAML.stringify({ version: 1, services: { "orders-service": { endpoints: {}, screens: {} } } }));
    const lines = runChecks(qa, {}).filter((x) => x.level === "warn" && /test-map/.test(x.label));
    expect(lines).toHaveLength(1);
    expect(lines[0].hint).toMatch(/1 test\(s\) are tagged.*qa-sentinel learn/);
    const cf = path.join(qa, "qa-sentinel.config.yaml");
    const doc = YAML.parse(fs.readFileSync(cf, "utf8"));
    doc.workspace.services = [];
    fs.writeFileSync(cf, YAML.stringify(doc));
    expect(runChecks(qa, {}).some((x) => /lists only services of the config/.test(x.label))).toBe(false);
  });
});
