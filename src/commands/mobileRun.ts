import { loadConfig, type Config } from "../config.js";
import { SECRET_NAME } from "../env.js";
import { specArgs } from "../layers.js";
import { log } from "../log.js";
import { runProcess } from "../proc.js";
import { testEnv } from "../run.js";
import { safeUrl } from "../secrets.js";
import { quoteWord, wrapTestCommand } from "../wrapper.js";
import { extraCaps, platformOf } from "../mobile/caps.js";

export interface MobileRunPlan {
  command: string;
  env: NodeJS.ProcessEnv;
  platform: "android" | "ios";
  /** What to show a person: names only for anything that could be a secret, never the Appium URL's credentials. */
  shownEnv: string[];
  problems: string[];
  notes: string[];
}

/**
 * The command for one named target (tests.mobile.targets): the user's own run command with the spec files added, the
 * target's plain env, and the secret env copied by name. qa-sentinel calls no farm API: whatever the farm needs is in
 * the command, QA_APPIUM_URL and QA_APPIUM_CAPS the user supplies.
 */
export function planMobileRun(c: Config, targetName: string, specs: string[], processEnv: NodeJS.ProcessEnv = process.env): MobileRunPlan {
  const m = c.tests.mobile;
  const problems: string[] = [];
  const notes: string[] = [];
  const t = m.targets[targetName];
  if (!t) {
    const names = Object.keys(m.targets);
    return { command: "", env: {}, platform: m.platform, shownEnv: [], problems: [names.length ? `no target "${targetName}" in tests.mobile.targets (there: ${names.join(", ")})` : `tests.mobile.targets is empty: add a target, e.g. targets: { ios: { platform: ios, env: { QA_BUNDLE_ID: com.example.shop } } }`], notes };
  }
  const env: NodeJS.ProcessEnv = { ...testEnv(c, processEnv), ...t.env };
  if (t.platform && !t.env.QA_MOBILE_PLATFORM) env.QA_MOBILE_PLATFORM = t.platform;
  const missing: string[] = [];
  for (const n of t.passEnv) {
    if (processEnv[n] === undefined || processEnv[n] === "") missing.push(n);
    else env[n] = processEnv[n];
  }
  if (missing.length) problems.push(`not set in your environment: ${missing.join(", ")} (listed in the target's passEnv)`);
  try {
    extraCaps(env);
  } catch (e) {
    problems.push((e as Error).message);
  }
  const platform = platformOf(env, m.platform);
  if (platform === "ios") {
    notes.push("iOS runs are not proven yet: this code has not been run on a Mac or an iOS farm. Report what fails.");
    if (!env.QA_BUNDLE_ID && !env.QA_APP && !env.QA_APPIUM_CAPS) problems.push("iOS needs QA_BUNDLE_ID (an installed app) or QA_APP (an .app/.ipa to install), or the app named in QA_APPIUM_CAPS");
  } else if (!env.QA_APP && !env.QA_APP_PACKAGE && !env.QA_APPIUM_CAPS) problems.push("Android needs QA_APP (an .apk) or QA_APP_PACKAGE, or the app named in QA_APPIUM_CAPS");
  const base = (t.runCommand ?? m.runCommand).trim();
  const command = wrapTestCommand(c, specs.length ? `${base} ${specArgs({ specArg: "--spec" }, specs, quoteWord)}` : base);
  const shownEnv = [
    ...Object.entries(t.env).map(([k, v]) => `${k}=${SECRET_NAME.test(k) ? "***" : safeUrl(v)}`),
    ...(t.platform && !t.env.QA_MOBILE_PLATFORM ? [`QA_MOBILE_PLATFORM=${t.platform}`] : []),
    ...t.passEnv.map((n) => `${n}=*** (from your environment)`),
  ];
  return { command, env, platform, shownEnv, problems, notes };
}

/** `qa-sentinel mobile-run --target <name> [--spec f ...] [--dry-run]`. No AI. Exit code: the command's, 1 on a setup problem. */
export async function mobileRunCommand(cwd: string, o: { target: string; specs?: string[]; dryRun?: boolean; env?: NodeJS.ProcessEnv }): Promise<number> {
  const c = loadConfig(cwd);
  if (!c.tests.mobile.enabled) {
    log.fail("tests.mobile is not enabled (`qa-sentinel add-mobile`)");
    return 1;
  }
  const p = planMobileRun(c, o.target, o.specs ?? [], o.env ?? process.env);
  log.title(`mobile-run: target ${o.target} (${p.platform})`);
  for (const n of p.notes) log.warn(n);
  if (p.problems.length) {
    for (const x of p.problems) log.fail(x);
    return 1;
  }
  if (p.shownEnv.length) log.info(`env: ${p.shownEnv.join(" ")}`);
  log.info(`command: ${p.command}`);
  if (o.dryRun) return 0;
  const r = await runProcess(p.command, [], { cwd, env: p.env, timeoutMs: c.verification.timeoutMinutes * 60_000, shell: true, echoStdout: true, echoStderr: true });
  if (r.error) {
    log.fail(`could not start the command: ${r.error}`);
    return 1;
  }
  if (r.timedOut) {
    log.fail(`the command ran longer than verification.timeoutMinutes (${c.verification.timeoutMinutes}) and was stopped`);
    return 1;
  }
  return r.code ?? 1;
}
