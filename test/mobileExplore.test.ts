import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import { initCommand } from "../src/commands/init.js";
import { loadConfig } from "../src/config.js";
import { buildCaps, extraCaps } from "../src/mobile/caps.js";
import { deepLinkFor, exploreMobile, screensToExplore, snapshotScreens, summariseSource } from "../src/mobile/explore.js";
import { testOnlyEnvNames } from "../src/layers.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "qas-mexp-"));

const ANDROID_XML = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy index="0" class="hierarchy" rotation="0" width="1080" height="2400">
  <android.widget.FrameLayout index="0" package="com.shop" class="android.widget.FrameLayout" text="" resource-id="" content-desc="" clickable="false">
    <android.widget.EditText index="0" package="com.shop" class="android.widget.EditText" text="2" resource-id="com.shop:id/qty" content-desc="quantity" clickable="true" />
    <android.widget.Button index="1" package="com.shop" class="android.widget.Button" text="Place &amp; pay" resource-id="com.shop:id/place" content-desc="place-order" clickable="true" />
    <android.view.View index="2" class="android.view.View" text="" resource-id="" content-desc="" />
  </android.widget.FrameLayout>
</hierarchy>`;
const IOS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<AppiumAUT><XCUIElementTypeApplication type="XCUIElementTypeApplication" name="Shop" label="Shop"><XCUIElementTypeButton type="XCUIElementTypeButton" name="place-order" label="Place order" value="" accessible="true"/></XCUIElementTypeApplication></AppiumAUT>`;
const PNG = Buffer.from("89504e470d0a1a0a", "hex");

interface Seen {
  method: string;
  url: string;
  auth?: string;
  body?: any;
}

/** A mock Appium server with the five routes the snapshot code uses. */
async function mockAppium(o: { failSession?: boolean; failDeepLinkFor?: string; xml?: string; noShot?: boolean } = {}) {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : undefined;
      seen.push({ method: req.method!, url: req.url!, auth: req.headers.authorization, body });
      const send = (code: number, v: unknown) => {
        res.statusCode = code;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(v));
      };
      if (req.method === "POST" && req.url === "/session") return o.failSession ? send(500, { value: { error: "session not created", message: "no device\nstack" } }) : send(200, { value: { sessionId: "S1", capabilities: {} } });
      if (req.method === "POST" && req.url === "/session/S1/execute/sync") {
        if (o.failDeepLinkFor && body.args[0].url === o.failDeepLinkFor) return send(500, { value: { error: "unknown error", message: "no activity handles it" } });
        return send(200, { value: null });
      }
      if (req.method === "GET" && req.url === "/session/S1/source") return send(200, { value: o.xml ?? ANDROID_XML });
      if (req.method === "GET" && req.url === "/session/S1/screenshot") return o.noShot ? send(500, { value: { error: "x", message: "no shot" } }) : send(200, { value: PNG.toString("base64") });
      if (req.method === "DELETE" && req.url === "/session/S1") return send(200, { value: null });
      send(404, { value: { error: "unknown command", message: "nope" } });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  return { seen, port, close: () => new Promise<void>((r) => server.close(() => r())) };
}

let closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.map((f) => f()));
  closers = [];
});
const start = async (o?: Parameters<typeof mockAppium>[0]) => {
  const m = await mockAppium(o);
  closers.push(m.close);
  return m;
};

describe("app screen snapshots (D5)", () => {
  it("reads an Android tree into a short list of ids and texts", () => {
    const els = summariseSource(ANDROID_XML);
    expect(els).toEqual([
      { type: "EditText", id: "quantity", text: "2", clickable: true },
      { type: "Button", id: "place-order", text: "Place & pay", clickable: true },
    ]);
  });

  it("reads an iOS tree (name is the accessibility id)", () => {
    expect(summariseSource(IOS_XML)).toEqual([
      { type: "XCUIElementTypeApplication", id: "Shop", text: undefined, clickable: undefined },
      { type: "XCUIElementTypeButton", id: "place-order", text: "Place order", clickable: true },
    ]);
  });

  it("opens a session, a deep link per screen on Android, saves XML, summary and PNG, and deletes the session", async () => {
    const m = await start();
    const runDir = tmp();
    const caps = { platformName: "Android", "appium:appPackage": "com.shop" };
    const snaps = await snapshotScreens({ appiumUrl: `http://127.0.0.1:${m.port}`, caps, platform: "android", runDir, screens: [{ name: "orders/new", deepLink: "shop://orders/new" }, { name: "cart", deepLink: "shop://cart" }] });
    expect(snaps.map((s) => s.error)).toEqual([undefined, undefined]);
    expect(m.seen.map((s) => `${s.method} ${s.url}`)).toEqual([
      "POST /session",
      "POST /session/S1/execute/sync",
      "GET /session/S1/source",
      "GET /session/S1/screenshot",
      "POST /session/S1/execute/sync",
      "GET /session/S1/source",
      "GET /session/S1/screenshot",
      "DELETE /session/S1",
    ]);
    expect(m.seen[0].body).toEqual({ capabilities: { alwaysMatch: caps, firstMatch: [{}] } });
    expect(m.seen[1].body).toEqual({ script: "mobile: deepLink", args: [{ url: "shop://orders/new", package: "com.shop" }] });
    const dir = path.join(runDir, "screen-snapshots");
    expect(fs.readdirSync(dir).sort()).toEqual(["README.md", "cart.png", "cart.summary.txt", "cart.xml", "orders_new.png", "orders_new.summary.txt", "orders_new.xml"]);
    expect(fs.readFileSync(path.join(dir, "orders_new.summary.txt"), "utf8")).toContain('Button id="place-order" text="Place & pay" (tappable)');
    expect(fs.readFileSync(path.join(dir, "orders_new.png")).equals(PNG)).toBe(true);
    expect(fs.readFileSync(path.join(dir, "README.md"), "utf8")).toContain("`orders/new` (shop://orders/new): `orders_new.xml`");
  });

  it("without a deep link it takes the screen as it is (no execute call)", async () => {
    const m = await start();
    const snaps = await snapshotScreens({ appiumUrl: `http://127.0.0.1:${m.port}`, caps: {}, platform: "android", runDir: tmp(), screens: [{ name: "launch" }] });
    expect(snaps[0].error).toBeUndefined();
    expect(m.seen.some((s) => s.url.includes("execute"))).toBe(false);
  });

  it("iOS: a deep link is refused with a clear message (not supported yet); the launch screen works", async () => {
    const m = await start({ xml: IOS_XML });
    const snaps = await snapshotScreens({ appiumUrl: `http://127.0.0.1:${m.port}`, caps: { platformName: "iOS" }, platform: "ios", runDir: tmp(), screens: [{ name: "orders/new", deepLink: "shop://orders/new" }, { name: "launch" }] });
    expect(snaps[0].error).toContain("not supported yet");
    expect(snaps[1].error).toBeUndefined();
    expect(snaps[1].summary).toContain("place-order");
    expect(m.seen.some((s) => s.url.includes("execute"))).toBe(false);
    expect(m.seen.at(-1)).toMatchObject({ method: "DELETE" });
  });

  it("one failing deep link does not stop the other screens; a missing screenshot keeps the tree", async () => {
    const m = await start({ failDeepLinkFor: "shop://bad", noShot: true });
    const snaps = await snapshotScreens({ appiumUrl: `http://127.0.0.1:${m.port}`, caps: {}, platform: "android", runDir: tmp(), screens: [{ name: "bad", deepLink: "shop://bad" }, { name: "good", deepLink: "shop://good" }] });
    expect(snaps[0].error).toContain("answered 500: no activity handles it");
    expect(snaps[1].error).toBeUndefined();
    expect(snaps[1].xml).toBeTruthy();
    expect(snaps[1].screenshot).toBeUndefined();
  });

  it("a session that cannot start marks every screen and never throws", async () => {
    const m = await start({ failSession: true });
    const snaps = await snapshotScreens({ appiumUrl: `http://127.0.0.1:${m.port}`, caps: {}, platform: "android", runDir: tmp(), screens: [{ name: "a" }, { name: "b" }] });
    expect(snaps.map((s) => s.error)).toEqual(['no Appium session: POST /session answered 500: no device', 'no Appium session: POST /session answered 500: no device']);
    const down = await snapshotScreens({ appiumUrl: "http://127.0.0.1:1", caps: {}, platform: "android", runDir: tmp(), screens: [{ name: "a" }] });
    expect(down[0].error).toContain("no Appium session");
    const bad = await snapshotScreens({ appiumUrl: "not a url", caps: {}, platform: "android", runDir: tmp(), screens: [{ name: "a" }] });
    expect(bad[0].error).toContain("not a valid URL");
  });

  it("credentials in the Appium URL go in a header, and appear in no file or message", async () => {
    const m = await start();
    const runDir = tmp();
    const snaps = await snapshotScreens({ appiumUrl: `http://alice:s3cr%2Ft@127.0.0.1:${m.port}/`, caps: {}, platform: "android", runDir, screens: [{ name: "launch" }] });
    expect(new Set(m.seen.map((s) => s.auth))).toEqual(new Set([`Basic ${Buffer.from("alice:s3cr/t").toString("base64")}`]));
    const all = JSON.stringify(snaps) + fs.readdirSync(path.join(runDir, "screen-snapshots")).map((f) => (f.endsWith(".png") ? "" : fs.readFileSync(path.join(runDir, "screen-snapshots", f), "utf8"))).join("");
    expect(all).not.toMatch(/s3cr|alice/);
    const failed = await snapshotScreens({ appiumUrl: "http://alice:s3cr3t@127.0.0.1:1/", caps: {}, platform: "android", runDir: tmp(), screens: [{ name: "a" }] });
    expect(JSON.stringify(failed)).not.toMatch(/s3cr3t|alice/);
  });

  it("keeps the base path of a farm URL (/wd/hub)", async () => {
    const m = await start();
    // The mock only knows root paths, so a /wd/hub prefix gives 404 for the session: the message names the route without credentials or the prefix host.
    const snaps = await snapshotScreens({ appiumUrl: `http://k:v@127.0.0.1:${m.port}/wd/hub`, caps: {}, platform: "android", runDir: tmp(), screens: [{ name: "a" }] });
    expect(m.seen[0].url).toBe("/wd/hub/session");
    expect(snaps[0].error).toContain("404");
  });

  it("works out screens from the plan: mobile scenarios only, reuse/skip left out", () => {
    const plan: any = {
      changes: [{ id: "c1", page: "orders/new" }, { id: "c2", page: "/cart/" }, { id: "c3", page: "/web-only" }],
      decisions: [
        { changeId: "c1", decision: "create", proposedScenarios: [{ layer: "mobile", page: "orders/new" }, { layer: "mobile", page: "/orders/:id" }] },
        { changeId: "c2", decision: "reuse", proposedScenarios: [] },
        { changeId: "c3", decision: "create", proposedScenarios: [{ layer: "web", page: "/web-only" }] },
      ],
    };
    expect(screensToExplore(plan)).toEqual(["orders/new", "orders/:id"]);
    expect(screensToExplore(plan, 1)).toEqual(["orders/new"]);
  });

  it("builds a deep link from the base, or keeps a full URL", () => {
    expect(deepLinkFor("shop://", "orders/new")).toBe("shop://orders/new");
    expect(deepLinkFor("https://shop.example/app", "/orders/new")).toBe("https://shop.example/app/orders/new");
    expect(deepLinkFor("shop://", "other://x/y")).toBe("other://x/y");
    expect(deepLinkFor("", "orders/new")).toBeUndefined();
  });

  it("exploreMobile: config and env to snapshots; explore defaults to none; parameter screens are listed, not opened", async () => {
    const m = await start();
    const repo = path.join(tmp(), "qa");
    fs.mkdirSync(repo);
    await initCommand({ cwd: repo, yes: true, mode: "scratch", mobile: true, ci: "gitlab", level: "maintenance", name: "x" });
    const c = loadConfig(repo);
    expect(c.tests.mobile.explore).toBe("none");
    c.tests.mobile.explore = "snapshot";
    c.tests.mobile.deepLinkBase = "shop://";
    const runDir = tmp();
    const env = { QA_APPIUM_URL: `http://127.0.0.1:${m.port}`, QA_APP_PACKAGE: "com.shop" };
    const snaps = await exploreMobile({ c, runDir, screens: ["orders/new", "orders/:id"], env });
    expect(snaps.map((s) => [s.screen, Boolean(s.error)])).toEqual([["orders/new", false], ["orders/:id", true]]);
    expect(m.seen[0].body.capabilities.alwaysMatch).toMatchObject({ platformName: "Android", "appium:automationName": "UiAutomator2", "appium:appPackage": "com.shop" });
    expect(fs.readFileSync(path.join(runDir, "screen-snapshots", "README.md"), "utf8")).toContain("`orders/:id`: has a parameter");
    // No deep-link base: one snapshot of the launch screen. No app given: every screen is an error, no call is made.
    c.tests.mobile.deepLinkBase = "";
    const before = m.seen.length;
    const launch = await exploreMobile({ c, runDir: tmp(), screens: ["orders/new"], env });
    expect(launch.map((s) => s.screen)).toEqual(["launch"]);
    expect(m.seen.length).toBeGreaterThan(before);
    const noApp = await exploreMobile({ c, runDir: tmp(), screens: ["x"], env: { QA_APPIUM_URL: env.QA_APPIUM_URL } });
    expect(noApp[0].error).toContain("no app to open");
    const badCaps = await exploreMobile({ c, runDir: tmp(), screens: ["x"], env: { ...env, QA_APPIUM_CAPS: '{"k":"top-secret-value"' } });
    expect(badCaps[0].error).toContain("not valid JSON");
    expect(badCaps[0].error).not.toContain("top-secret-value");
  });
});

describe("device-farm capabilities (D6)", () => {
  it("QA_APPIUM_CAPS is merged over the defaults; bad values are refused without echoing them", () => {
    const env = { QA_MOBILE_PLATFORM: "ios", QA_BUNDLE_ID: "com.shop", QA_APPIUM_CAPS: '{"bstack:options":{"userName":"u","accessKey":"k"},"appium:deviceName":"iPhone 14"}' };
    const caps = buildCaps(env, "android");
    expect(caps).toMatchObject({ platformName: "iOS", "appium:automationName": "XCUITest", "appium:bundleId": "com.shop", "appium:deviceName": "iPhone 14", "bstack:options": { userName: "u", accessKey: "k" } });
    expect(caps).not.toHaveProperty("appium:udid");
    expect(extraCaps({})).toEqual({});
    expect(() => extraCaps({ QA_APPIUM_CAPS: "[1]" })).toThrow("one JSON object");
    expect(() => extraCaps({ QA_APPIUM_CAPS: "{secret-key" })).toThrow(/not valid JSON/);
    try {
      extraCaps({ QA_APPIUM_CAPS: "{secret-key" });
    } catch (e) {
      expect((e as Error).message).not.toContain("secret-key");
    }
  });

  it("the scaffolded wdio.conf.ts builds the same capabilities as qa-sentinel does (iOS and Android, with and without QA_APPIUM_CAPS)", async () => {
    const repo = path.join(tmp(), "qa");
    fs.mkdirSync(repo);
    await initCommand({ cwd: repo, yes: true, mode: "scratch", mobile: true, ci: "gitlab", level: "maintenance", name: "x" });
    const conf = fs.readFileSync(path.join(repo, "wdio.conf.ts"), "utf8");
    expect(conf).toContain("QA_APPIUM_CAPS");
    const snippet = conf.slice(conf.indexOf("const appium = "), conf.indexOf("export const config"));
    const js = ts.transpileModule(`${snippet}\nreturn capabilities;`.replace(/^/, ""), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
    const fromTemplate = (env: NodeJS.ProcessEnv) => new Function("process", js)({ env });
    const cases: NodeJS.ProcessEnv[] = [
      {},
      { QA_MOBILE_PLATFORM: "ios", QA_BUNDLE_ID: "com.shop", QA_DEVICE_NAME: "iPhone 15 Pro", QA_PLATFORM_VERSION: "17.4" },
      { QA_APP: "/a.apk", QA_APPIUM_CAPS: '{"sauce:options":{"build":"b1"},"appium:newCommandTimeout":60}' },
      { QA_MOBILE_PLATFORM: "IOS", QA_APPIUM_CAPS: '  ' },
    ];
    for (const env of cases) expect(fromTemplate(env), JSON.stringify(env)).toEqual(buildCaps(env, "android"));
    expect(() => fromTemplate({ QA_APPIUM_CAPS: "{nope" })).toThrow(/not valid JSON/);
    expect(() => fromTemplate({ QA_APPIUM_CAPS: "3" })).toThrow(/one JSON object/);
  });

  it("iOS deep links in the screen-object base class give a clear 'not supported yet' error", async () => {
    const repo = path.join(tmp(), "qa");
    fs.mkdirSync(repo);
    await initCommand({ cwd: repo, yes: true, mode: "scratch", mobile: true, ci: "gitlab", level: "maintenance", name: "x" });
    const base = fs.readFileSync(path.join(repo, "src/screens/base-screen.ts"), "utf8");
    expect(base).toContain("openDeepLink is not supported on iOS yet");
    expect(base).not.toContain("driver.url(url)");
  });

  it("QA_APPIUM_CAPS goes to qa-sentinel's own runs, not to the agent", async () => {
    const repo = path.join(tmp(), "qa");
    fs.mkdirSync(repo);
    await initCommand({ cwd: repo, yes: true, mode: "scratch", mobile: true, ci: "gitlab", level: "maintenance", name: "x" });
    expect(testOnlyEnvNames(loadConfig(repo))).toContain("QA_APPIUM_CAPS");
  });
});
