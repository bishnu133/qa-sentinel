import fs from "node:fs";
import path from "node:path";
import type { Config } from "../config.js";
import type { TestPlan } from "../plan/schema.js";
import { slug } from "../web/explore.js";
import { buildCaps, platformOf } from "./caps.js";

/**
 * Before the agent writes mobile tests, qa-sentinel opens the affected app screens on a device itself and saves what is on
 * them: the accessibility tree (XML: ids, text, types: what good selectors are built from) and a screenshot. It talks plain
 * W3C WebDriver / Appium HTTP to the Appium server (no WebdriverIO), so it works the same on an emulator, a Mac with
 * simulators or a device farm that exposes an Appium URL. The agent reads files instead of driving a device.
 *
 * Calls used, and nothing else: POST /session, GET /session/:id/source, GET /session/:id/screenshot,
 * POST /session/:id/execute/sync (Android deep link only), DELETE /session/:id.
 * Credentials in the Appium URL go in an Authorization header and are never printed or saved.
 *
 * Unverified: the HTTP calls are tested against a mock server only; no real emulator, device or farm was used for this code.
 */

export interface ScreenSnapshot {
  screen: string;
  deepLink?: string;
  xml?: string;
  screenshot?: string;
  summary?: string;
  error?: string;
}

export interface ScreenRequest {
  name: string;
  deepLink?: string;
}

/** Screens a plan's mobile scenarios and UI changes touch (names or deep-link routes), at most `max`. */
export function screensToExplore(plan: TestPlan, max = 6): string[] {
  const out = new Set<string>();
  for (const d of plan.decisions) {
    if (!["create", "update", "review"].includes(d.decision)) continue;
    const mobile = d.proposedScenarios.filter((s) => s.layer === "mobile");
    for (const s of mobile) if (s.page) out.add(s.page.trim().replace(/^\/+|\/+$/g, ""));
    const ch = plan.changes.find((c) => c.id === d.changeId);
    if (ch?.page && mobile.length) out.add(ch.page.trim().replace(/^\/+|\/+$/g, ""));
  }
  out.delete("");
  return [...out].slice(0, max);
}

/** The deep link for a screen name, or undefined when the config has no base. A name that is already a URL is used as it is. */
export function deepLinkFor(base: string, screen: string): string | undefined {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(screen)) return screen;
  return base ? (base.endsWith("/") ? base : `${base}/`) + screen.replace(/^\/+/, "") : undefined;
}

// ---- tiny XML reader: enough for Appium's page source (attributes only) ----

const ENTITIES: Record<string, string> = { "&lt;": "<", "&gt;": ">", "&amp;": "&", "&quot;": '"', "&apos;": "'" };
const decode = (s: string) => s.replace(/&(?:lt|gt|amp|quot|apos);|&#(\d+);|&#x([0-9a-f]+);/gi, (m, d, h) => ENTITIES[m] ?? String.fromCodePoint(d ? Number(d) : parseInt(h, 16)));

export interface UiElement {
  type: string;
  id?: string;
  text?: string;
  clickable?: boolean;
}

/** Elements of an Android (UiAutomator2) or iOS (XCUITest) page source that have an id or a text, in document order. */
export function summariseSource(xml: string, max = 200): UiElement[] {
  const out: UiElement[] = [];
  for (const m of xml.matchAll(/<([A-Za-z_][\w.$-]*)((?:\s+[\w:.-]+="[^"]*")*)\s*\/?>/g)) {
    const type = m[1];
    if (type === "hierarchy" || type === "AppiumAUT") continue;
    const a: Record<string, string> = {};
    for (const x of m[2].matchAll(/([\w:.-]+)="([^"]*)"/g)) a[x[1]] = decode(x[2]);
    // Android: content-desc is the accessibility id (`~id`), resource-id the platform id. iOS: name is the accessibility id.
    const id = a["content-desc"] || a["resource-id"] || a.name || undefined;
    const text = a.text || a.label || a.value || undefined;
    if (!id && !text) continue;
    out.push({ type: type.split(".").pop()!, id, text: text && text !== id ? text.slice(0, 80) : undefined, clickable: a.clickable === "true" || a.accessible === "true" || undefined });
    if (out.length >= max) break;
  }
  return out;
}

export function renderSummary(els: UiElement[]): string {
  if (!els.length) return "(no element with an id or a text)\n";
  return els.map((e) => `- ${e.type}${e.id ? ` id=${JSON.stringify(e.id)}` : ""}${e.text ? ` text=${JSON.stringify(e.text)}` : ""}${e.clickable ? " (tappable)" : ""}`).join("\n") + "\n";
}

// ---- Appium HTTP ----

interface Http {
  call(method: string, route: string, body?: unknown, timeoutMs?: number): Promise<any>;
}

function client(appiumUrl: string): Http {
  const u = new URL(appiumUrl);
  const auth = u.username || u.password ? `Basic ${Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString("base64")}` : undefined;
  u.username = "";
  u.password = "";
  const base = `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
  return {
    async call(method, route, body, timeoutMs = 30_000) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetch(`${base}${route}`, {
          method,
          signal: ctrl.signal,
          headers: { "content-type": "application/json", ...(auth ? { Authorization: auth } : {}) },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        const text = await res.text();
        let json: any;
        try {
          json = text ? JSON.parse(text) : {};
        } catch {
          json = { value: text };
        }
        if (!res.ok) throw new Error(`${method} ${route.replace(/\/session\/[^/]+/, "/session/:id")} answered ${res.status}: ${String(json?.value?.message ?? json?.value?.error ?? text).split("\n")[0].slice(0, 160)}`);
        return json;
      } catch (e) {
        if ((e as Error).name === "AbortError") throw new Error(`${method} ${route.replace(/\/session\/[^/]+/, "/session/:id")} timed out after ${Math.round(timeoutMs / 1000)}s`);
        throw e;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export interface SnapshotScreensOptions {
  appiumUrl: string;
  caps: Record<string, unknown>;
  screens: ScreenRequest[];
  /** Folder the files go to: <runDir>/screen-snapshots. */
  runDir: string;
  platform: "android" | "ios";
}

/** Snapshot the screens into <runDir>/screen-snapshots; never throws (a failure is the screen's `error`). */
export async function snapshotScreens(o: SnapshotScreensOptions): Promise<ScreenSnapshot[]> {
  const outDir = path.join(o.runDir, "screen-snapshots");
  fs.mkdirSync(outDir, { recursive: true });
  const slugs = new Map<string, string>();
  const nameOf = (n: string) => {
    let s = slug(n);
    for (let i = 2; [...slugs.values()].includes(s); i++) s = `${slug(n)}_${i}`;
    slugs.set(n, s);
    return s;
  };
  const results: ScreenSnapshot[] = [];
  const finish = () => {
    fs.writeFileSync(path.join(outDir, "README.md"), snapshotIndex(results, slugs, o.platform));
    return results;
  };
  let http: Http;
  try {
    http = client(o.appiumUrl);
  } catch {
    for (const s of o.screens) results.push({ screen: s.name, error: "the Appium URL is not a valid URL" });
    return finish();
  }
  let sid: string | undefined;
  try {
    const r = await http.call("POST", "/session", { capabilities: { alwaysMatch: o.caps, firstMatch: [{}] } }, 120_000);
    sid = r?.value?.sessionId ?? r?.sessionId;
    if (!sid) throw new Error("POST /session answered without a sessionId");
  } catch (e) {
    for (const s of o.screens) results.push({ screen: s.name, error: `no Appium session: ${(e as Error).message}`.slice(0, 300) });
    return finish();
  }
  try {
    for (const s of o.screens) {
      const r: ScreenSnapshot = { screen: s.name, deepLink: s.deepLink };
      results.push(r);
      const file = nameOf(s.name);
      try {
        if (s.deepLink) {
          if (o.platform === "ios") throw new Error("opening a deep link on iOS is not supported yet (the XCUITest command was not confirmed against the driver's documentation); open the screen by hand and use screen \"launch\"");
          const pkg = o.caps["appium:appPackage"];
          await http.call("POST", `/session/${sid}/execute/sync`, { script: "mobile: deepLink", args: [{ url: s.deepLink, ...(typeof pkg === "string" ? { package: pkg } : {}) }] });
        }
        const src = await http.call("GET", `/session/${sid}/source`);
        const xml = String(src?.value ?? "");
        if (!xml.trim()) throw new Error("the page source is empty");
        fs.writeFileSync(path.join(outDir, `${file}.xml`), xml);
        r.xml = path.join(outDir, `${file}.xml`);
        r.summary = renderSummary(summariseSource(xml));
        fs.writeFileSync(path.join(outDir, `${file}.summary.txt`), r.summary);
        // The tree matters more than the picture: a failing screenshot keeps the screen as captured.
        try {
          const shot = await http.call("GET", `/session/${sid}/screenshot`);
          if (typeof shot?.value === "string" && shot.value) {
            fs.writeFileSync(path.join(outDir, `${file}.png`), Buffer.from(shot.value, "base64"));
            r.screenshot = path.join(outDir, `${file}.png`);
          }
        } catch {
          /* no screenshot */
        }
      } catch (e) {
        r.error = (e as Error).message.slice(0, 300);
      }
    }
  } finally {
    await http.call("DELETE", `/session/${sid}`, undefined, 15_000).catch(() => undefined);
  }
  return finish();
}

function snapshotIndex(snaps: ScreenSnapshot[], slugs: Map<string, string>, platform: string): string {
  return [
    `# Screen snapshots (taken by qa-sentinel before authoring, ${platform})`,
    "",
    "Each screen: `<name>.xml` is the accessibility tree as Appium returns it, `<name>.summary.txt` lists its elements that have an id or a text (use the ids for `$(\"~id\")` selectors), `<name>.png` is a screenshot. Only what was on the screen at that moment is here: a list, a dialog or a state that needs a tap is not.",
    "",
    ...snaps.map((s) => (s.error ? `- \`${s.screen}\`: ${s.error}` : `- \`${s.screen}\`${s.deepLink ? ` (${s.deepLink})` : ""}: \`${slugs.get(s.screen)}.xml\`, \`${slugs.get(s.screen)}.summary.txt\`${s.screenshot ? `, \`${slugs.get(s.screen)}.png\`` : ""}`)),
    "",
  ].join("\n");
}

/** What `generate` calls: works out the screens, the capabilities and the URL from the config and environment. Never throws. */
export async function exploreMobile(o: { c: Config; runDir: string; screens: string[]; env: NodeJS.ProcessEnv }): Promise<ScreenSnapshot[]> {
  const m = o.c.tests.mobile;
  const platform = platformOf(o.env, m.platform);
  const requests: ScreenRequest[] = m.deepLinkBase
    ? o.screens.map((s) => ({ name: s, deepLink: deepLinkFor(m.deepLinkBase, s) }))
    : [{ name: "launch" }];
  const fail = (error: string) => requests.map((r) => ({ screen: r.name, deepLink: r.deepLink, error }));
  let caps: Record<string, unknown>;
  try {
    caps = buildCaps(o.env, m.platform);
  } catch (e) {
    return fail((e as Error).message);
  }
  // A farm may name the app inside its own caps block, so QA_APPIUM_CAPS counts as "an app is given".
  if (!caps["appium:app"] && !caps["appium:appPackage"] && !caps["appium:bundleId"] && !o.env.QA_APPIUM_CAPS?.trim())
    return fail("no app to open: set QA_APP, QA_APP_PACKAGE or QA_BUNDLE_ID (or name the app in QA_APPIUM_CAPS)");
  const withParams = new Set(o.screens.filter((s) => /[{}]|(^|\/):[A-Za-z_]/.test(s)));
  const real = requests.filter((r) => !withParams.has(r.name));
  const skipped: ScreenSnapshot[] = requests.filter((r) => withParams.has(r.name)).map((r) => ({ screen: r.name, error: "has a parameter, so there is no single deep link to open" }));
  const snaps = real.length ? await snapshotScreens({ appiumUrl: o.env[m.appiumUrlEnv] || m.appiumUrl, caps, screens: real, runDir: o.runDir, platform }) : [];
  if (skipped.length) {
    snaps.push(...skipped);
    fs.mkdirSync(path.join(o.runDir, "screen-snapshots"), { recursive: true });
    fs.appendFileSync(path.join(o.runDir, "screen-snapshots", "README.md"), skipped.map((s) => `- \`${s.screen}\`: ${s.error}`).join("\n") + "\n");
  }
  return snaps;
}
