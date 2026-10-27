/**
 * The Appium capabilities qa-sentinel itself uses (screen snapshots, `mobile-run` checks). The scaffolded wdio.conf.ts builds
 * the same set from the same variables; keep the two in step (test/mobileExplore.test.ts compares them).
 */

export type Platform = "android" | "ios";

export const CAPS_ENV = "QA_APPIUM_CAPS";

/** QA_APPIUM_CAPS: a JSON object merged over the capabilities (farm blocks such as "bstack:options"). Never echoes its content. */
export function extraCaps(env: NodeJS.ProcessEnv): Record<string, unknown> {
  const raw = env[CAPS_ENV];
  if (raw === undefined || raw.trim() === "") return {};
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    throw new Error(`${CAPS_ENV} is not valid JSON (its content is not shown here, it may hold a key). Set it to one JSON object, e.g. '{"bstack:options":{...}}'.`);
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`${CAPS_ENV} must be one JSON object (not a list or a single value).`);
  return v as Record<string, unknown>;
}

export function platformOf(env: NodeJS.ProcessEnv, fallback: Platform): Platform {
  return (env.QA_MOBILE_PLATFORM ?? fallback).toLowerCase() === "ios" ? "ios" : "android";
}

export function buildCaps(env: NodeJS.ProcessEnv, fallback: Platform): Record<string, unknown> {
  const ios = platformOf(env, fallback) === "ios";
  const e = (k: string) => env[k] || undefined;
  const caps: Record<string, unknown> = {
    platformName: ios ? "iOS" : "Android",
    "appium:automationName": ios ? "XCUITest" : "UiAutomator2",
    "appium:deviceName": e("QA_DEVICE_NAME") ?? (ios ? "iPhone 15" : "Android Emulator"),
    "appium:platformVersion": e("QA_PLATFORM_VERSION"),
    "appium:udid": e("QA_UDID"),
    "appium:app": e("QA_APP"),
    "appium:appPackage": e("QA_APP_PACKAGE"),
    "appium:appActivity": e("QA_APP_ACTIVITY"),
    "appium:bundleId": e("QA_BUNDLE_ID"),
    "appium:newCommandTimeout": 240,
    "appium:autoGrantPermissions": ios ? undefined : true,
    ...extraCaps(env),
  };
  for (const k of Object.keys(caps)) if (caps[k] === undefined) delete caps[k];
  return caps;
}
