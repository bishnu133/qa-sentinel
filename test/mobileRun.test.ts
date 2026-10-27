import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { describe, expect, it, vi } from "vitest";
import { mobileChecks } from "../src/commands/doctor.js";
import { initCommand } from "../src/commands/init.js";
import { mobileRunCommand, planMobileRun } from "../src/commands/mobileRun.js";
import { loadConfig } from "../src/config.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "qas-mrun-"));

async function project(targets: Record<string, unknown> = {}, runCommand?: string) {
  const repo = path.join(tmp(), "qa");
  fs.mkdirSync(repo);
  await initCommand({ cwd: repo, yes: true, mode: "scratch", mobile: true, ci: "gitlab", level: "maintenance", name: "x" });
  const file = path.join(repo, "qa-sentinel.config.yaml");
  const d = YAML.parseDocument(fs.readFileSync(file, "utf8"));
  d.setIn(["tests", "mobile", "targets"], targets);
  if (runCommand) d.setIn(["tests", "mobile", "runCommand"], runCommand);
  fs.writeFileSync(file, d.toString());
  return repo;
}

describe("mobile targets (iOS, device farm)", () => {
  it("builds the user's command with --spec per file, plain env, secret env by name", async () => {
    const repo = await project({ "ios-farm": { platform: "ios", runCommand: "npx wdio run farm.conf.ts", env: { QA_BUNDLE_ID: "com.shop" }, passEnv: ["FARM_KEY"] } });
    const c = loadConfig(repo);
    const p = planMobileRun(c, "ios-farm", ["tests/mobile/a.spec.ts", "tests/mobile/b c.spec.ts:12"], { PATH: "/bin", FARM_KEY: "k-123", QA_APPIUM_URL: "https://u:p@farm.example/wd/hub" });
    expect(p.problems).toEqual([]);
    expect(p.command).toBe("npx wdio run farm.conf.ts --spec 'tests/mobile/a.spec.ts' --spec 'tests/mobile/b c.spec.ts'");
    expect(p.platform).toBe("ios");
    expect(p.env).toMatchObject({ QA_MOBILE_PLATFORM: "ios", QA_BUNDLE_ID: "com.shop", FARM_KEY: "k-123", QA_APPIUM_URL: "https://u:p@farm.example/wd/hub" });
    expect(p.notes.join()).toContain("iOS runs are not proven yet");
    expect(p.shownEnv).toEqual(["QA_BUNDLE_ID=com.shop", "QA_MOBILE_PLATFORM=ios", "FARM_KEY=*** (from your environment)"]);
    expect(JSON.stringify(p.shownEnv) + p.command).not.toMatch(/k-123|u:p/);
  });

  it("puts the command inside verification.wrapCommand", async () => {
    const repo = await project({ t: { platform: "android", env: { QA_APP: "/a.apk" } } });
    const c = loadConfig(repo);
    c.verification.wrapCommand = "docker run --rm img sh -c {cmd}";
    expect(planMobileRun(c, "t", ["tests/mobile/a.spec.ts"], { PATH: "/bin" }).command).toBe(`docker run --rm img sh -c 'npx wdio run wdio.conf.ts --spec '\\''tests/mobile/a.spec.ts'\\'''`);
  });

  it("names every setup problem without printing values", async () => {
    const repo = await project({ ios: { platform: "ios", passEnv: ["FARM_KEY"] } });
    const c = loadConfig(repo);
    const p = planMobileRun(c, "ios", [], { PATH: "/bin", QA_APPIUM_CAPS: "{broken-secret" });
    expect(p.problems.join("\n")).toContain("not set in your environment: FARM_KEY");
    expect(p.problems.join("\n")).toContain("QA_APPIUM_CAPS is not valid JSON");
    expect(p.problems.join("\n")).not.toContain("broken-secret");
    expect(planMobileRun(c, "ios", [], { FARM_KEY: "x" }).problems.join()).toContain("iOS needs QA_BUNDLE_ID");
    expect(planMobileRun(c, "nope", [], {}).problems[0]).toContain('no target "nope" in tests.mobile.targets (there: ios)');
    // the app may be named in the farm's own block
    expect(planMobileRun(c, "ios", [], { FARM_KEY: "x", QA_APPIUM_CAPS: '{"bstack:options":{"app":"bs://abc"}}' }).problems).toEqual([]);
  });

  it("the command: --dry-run prints and runs nothing; a real run returns the command's exit code", async () => {
    const repo = await project({ t: { platform: "android", runCommand: `node -e "require('fs').writeFileSync('ran.txt', process.argv.slice(1).join(' ') + process.env.QA_MOBILE_PLATFORM); process.exit(4)" --`, env: { QA_APP: "/a.apk" } } });
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...a) => void logs.push(a.join(" ")));
    try {
      expect(await mobileRunCommand(repo, { target: "t", specs: ["tests/mobile/a.spec.ts"], dryRun: true, env: { PATH: process.env.PATH } })).toBe(0);
      expect(fs.existsSync(path.join(repo, "ran.txt"))).toBe(false);
      expect(logs.join("\n")).toContain("command: node -e");
      expect(await mobileRunCommand(repo, { target: "t", specs: ["tests/mobile/a.spec.ts"], env: { PATH: process.env.PATH } })).toBe(4);
      expect(fs.readFileSync(path.join(repo, "ran.txt"), "utf8")).toBe("--spec tests/mobile/a.spec.tsandroid");
      expect(await mobileRunCommand(repo, { target: "missing", env: {} })).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("config: target names and env names are validated", async () => {
    await expect(project({ "bad name": {} }).then(loadConfig)).rejects.toThrow(/tests\.mobile\.targets/);
    await expect(project({ ok: { env: { "BAD-NAME": "x" } } }).then(loadConfig)).rejects.toThrow(/BAD-NAME|invalid/i);
    expect(loadConfig(await project({ ok: { platform: "ios" } })).tests.mobile.targets.ok).toEqual({ platform: "ios", env: {}, passEnv: [] });
  });
});

describe("doctor: iOS and farm checks", () => {
  it("iOS: says it is not proven, needs an app, and a Mac or a farm", async () => {
    const repo = await project({ farm: { platform: "ios", passEnv: ["FARM_KEY"] } });
    const c = loadConfig(repo);
    c.tests.mobile.platform = "ios";
    const checks = mobileChecks(repo, c, {});
    expect(checks.find((x) => x.label === "iOS runs are not proven yet")?.level).toBe("warn");
    expect(checks.find((x) => x.label.startsWith("iOS app under test"))?.level).toBe("fail");
    expect(checks.find((x) => x.label === "mobile target farm (ios)")).toMatchObject({ level: "warn", hint: expect.stringContaining("FARM_KEY") });
    if (process.platform !== "darwin") expect(checks.find((x) => x.label === "iOS needs a Mac or a farm")?.level).toBe("warn");
    const ok = mobileChecks(repo, c, { QA_BUNDLE_ID: "com.shop", QA_APPIUM_URL: "https://u:secret@farm.example/wd/hub", FARM_KEY: "k" });
    expect(ok.find((x) => x.label.startsWith("iOS app under test"))?.level).toBe("ok");
    expect(ok.find((x) => x.label === "mobile target farm (ios)")?.level).toBe("ok");
    expect(JSON.stringify(ok)).not.toContain("secret");
  });

  it("android is not told about iOS; QA_APPIUM_CAPS is checked and never printed", async () => {
    const repo = await project();
    const c = loadConfig(repo);
    expect(mobileChecks(repo, c, {}).some((x) => x.label.includes("iOS"))).toBe(false);
    const good = mobileChecks(repo, c, { QA_APPIUM_CAPS: '{"bstack:options":{"accessKey":"top-secret"}}' });
    expect(good.find((x) => x.label.startsWith("QA_APPIUM_CAPS"))).toMatchObject({ level: "ok", label: "QA_APPIUM_CAPS: a JSON object with 1 key(s)" });
    const bad = mobileChecks(repo, c, { QA_APPIUM_CAPS: "{top-secret" });
    expect(bad.find((x) => x.label.startsWith("QA_APPIUM_CAPS"))?.level).toBe("fail");
    expect(JSON.stringify([good, bad])).not.toContain("top-secret");
  });

  it("explore: snapshot without an app is a warning; an older wdio.conf.ts that ignores QA_APPIUM_CAPS is a warning", async () => {
    const repo = await project();
    const c = loadConfig(repo);
    c.tests.mobile.explore = "snapshot";
    expect(mobileChecks(repo, c, {}).find((x) => x.label === "tests.mobile.explore: snapshot needs an app")?.level).toBe("warn");
    expect(mobileChecks(repo, c, { QA_APP: "/a.apk" }).some((x) => x.label.startsWith("tests.mobile.explore"))).toBe(false);
    fs.writeFileSync(path.join(repo, "wdio.conf.ts"), "export const config = {};\n");
    expect(mobileChecks(repo, c, { QA_APPIUM_CAPS: "{}" }).find((x) => x.label === "wdio.conf.ts reads QA_APPIUM_CAPS")?.level).toBe("warn");
  });
});
