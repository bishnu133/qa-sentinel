import type { Config, ServiceConfig } from "./config.js";
import { matchesAny } from "./fsutil.js";

/**
 * A test layer: where its tests live, how they run and which base URL they use. API is always on; web when
 * tests.web.enabled; mobile (WebdriverIO + Appium) when tests.mobile.enabled.
 */
export type Layer = "api" | "web" | "mobile";

export interface LayerConfig {
  layer: Layer;
  dir: string;
  /** API: request helpers. Web: page objects. */
  helpersDir: string;
  runCommand: string;
  baseUrlEnv: string;
  extraWritePaths: string[];
  isPlaywright: boolean;
  /** Put before each spec path (WebdriverIO: --spec); none for Playwright and most runners. */
  specArg?: string;
  /** Checked before the layer's tests run: the base URL plus this path (Appium: /status). */
  preflightPath?: string;
  /** Fallback when the base URL variable is not set. */
  defaultBaseUrl?: string;
  /** Where the runner writes JUnit when told by environment variable (a folder: one file per worker). */
  junitDirEnv?: string;
  /** Results with evidence (RunResult JSON files) written by the layer's own hooks. */
  resultsDirEnv?: string;
}

export function layers(c: Config): LayerConfig[] {
  const a = c.tests.api;
  const out: LayerConfig[] = [
    { layer: "api", dir: a.dir, helpersDir: a.helpersDir, runCommand: a.runCommand, baseUrlEnv: a.baseUrlEnv, extraWritePaths: a.extraWritePaths, isPlaywright: a.framework === "playwright" },
  ];
  const w = c.tests.web;
  if (w.enabled) out.push({ layer: "web", dir: w.dir, helpersDir: w.pagesDir, runCommand: w.runCommand, baseUrlEnv: w.baseUrlEnv, extraWritePaths: w.extraWritePaths, isPlaywright: true });
  const m = c.tests.mobile;
  if (m.enabled)
    out.push({
      layer: "mobile",
      dir: m.dir,
      helpersDir: m.screensDir,
      runCommand: m.runCommand,
      baseUrlEnv: m.appiumUrlEnv,
      defaultBaseUrl: m.appiumUrl,
      extraWritePaths: m.extraWritePaths,
      isPlaywright: false,
      specArg: "--spec",
      preflightPath: "/status",
      junitDirEnv: "QA_JUNIT_DIR",
      resultsDirEnv: "QA_RESULTS_DIR",
    });
  return out;
}

export function layerConfig(c: Config, layer: Layer): LayerConfig {
  const l = layers(c).find((x) => x.layer === layer);
  if (!l) throw new Error(`The ${layer} layer is not enabled. Set tests.${layer}.enabled: true in qa-sentinel.config.yaml.`);
  return l;
}

/** Which layer a test-repo file belongs to (by directory); undefined for shared files. */
export function layerOfFile(c: Config, file: string): Layer | undefined {
  // Most specific directory first, so tests/web inside tests/ still resolves to web.
  const sorted = layers(c).sort((x, y) => y.dir.length - x.dir.length);
  return sorted.find((l) => matchesAny(file, [`${l.dir}/**`]))?.layer;
}

/** The layer a service's changes are tested on first: front ends and apps through the UI, everything else through the API. */
export function primaryLayer(c: Config, service: ServiceConfig): Layer {
  if (service.kind === "web" && c.tests.web.enabled) return "web";
  if (service.kind === "mobile" && c.tests.mobile.enabled) return "mobile";
  return "api";
}

/** Layers that drive a user interface (recordings, screens/pages). */
export const isUiLayer = (l: Layer | undefined) => l === "web" || l === "mobile";

/** A path as a shell word: left as is when plainly safe (readable commands in reports), single-quoted otherwise. */
export const shellWord = (s: string) => (/^[\w./:@,+=-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/** Spec paths as the layer's runner takes them (WebdriverIO: `--spec file` each, no :line). */
export function specArgs(l: Pick<LayerConfig, "specArg">, files: string[], quote: (s: string) => string = shellWord): string {
  if (!l.specArg) return files.map(quote).join(" ");
  return [...new Set(files.map((f) => f.replace(/:\d+$/, "")))].map((f) => `${l.specArg} ${quote(f)}`).join(" ");
}

/** Variables every test run needs besides the API base URL: the web base URL and browser/healing switches. */
export function layerEnvNames(c: Config): string[] {
  const web = c.tests.web.enabled ? [c.tests.web.baseUrlEnv, "QA_BROWSER_PATH", "QA_BROWSER_CHANNEL", "QA_HEALING", "QA_HEADED", "QA_VIDEO", "QA_ACTION_TIMEOUT", "QA_CDP_PORT", "QA_BUBBLEGUM_PACKAGE"] : [];
  const mobile = c.tests.mobile.enabled
    ? [c.tests.mobile.appiumUrlEnv, "QA_MOBILE_PLATFORM", "QA_DEVICE_NAME", "QA_PLATFORM_VERSION", "QA_UDID", "QA_APP", "QA_APP_PACKAGE", "QA_APP_ACTIVITY", "QA_BUNDLE_ID", "QA_VIDEO", "ANDROID_HOME", "ANDROID_SDK_ROOT", "JAVA_HOME"]
    : [];
  return [...new Set([...web, ...mobile])];
}

/**
 * Commands that run these test files, one per layer, with the Playwright layers (`… playwright test --project=<name>`)
 * merged into one invocation (one run, one results.json for the showcase stage). Other runners (mobile) stay separate.
 */
export function runCommandsFor(c: Config, files: string[]): string[] {
  const groups = layers(c)
    .map((l) => ({ l, files: files.filter((f) => (layerOfFile(c, f.replace(/:\d+$/, "")) ?? "api") === l.layer) }))
    .filter((g) => g.files.length);
  const pw = groups.map((g) => ({ g, m: g.l.runCommand.trim().match(/^(.*\bplaywright test)\s+--project[= ](\S+)$/) })).filter((x) => x.m);
  const mergeable = pw.length > 1 && new Set(pw.map((x) => x.m![1])).size === 1;
  const out: string[] = [];
  if (mergeable) out.push(`${pw[0].m![1]} ${pw.map((x) => `--project=${x.m![2]}`).join(" ")} ${pw.flatMap((x) => x.g.files).map(shellWord).join(" ")}`);
  for (const g of groups) if (!mergeable || !pw.some((x) => x.g === g)) out.push(`${g.l.runCommand} ${specArgs(g.l, g.files)}`);
  return out;
}

/**
 * The whole suite in one command (CI's scheduled run): one Playwright invocation across projects when possible.
 * Mobile runs in its own job (it needs a device), so it is left out.
 */
export function suiteRunCommand(c: Config): string {
  const ls = layers(c).filter((l) => l.layer !== "mobile");
  const parts = ls.map((l) => l.runCommand.trim().match(/^(.*\bplaywright test)\s+--project[= ](\S+)$/));
  if (ls.length > 1 && parts.every(Boolean) && new Set(parts.map((p) => p![1])).size === 1) return `${parts[0]![1]} ${parts.map((p) => `--project=${p![2]}`).join(" ")}`;
  return ls.map((l) => l.runCommand).join(" && ");
}

/** The test runner behind a run command: named directly, or through an npm script (`npm run test --`, `npm test --`). */
export type Runner = "playwright" | "mocha" | "vitest" | "jest" | "wdio";

export function runnerOf(runCommand: string, scripts: Record<string, string> = {}): Runner | undefined {
  const direct = (cmd: string): Runner | undefined => {
    if (/\bplaywright\b/.test(cmd)) return "playwright";
    if (/\bwdio\b/.test(cmd)) return "wdio";
    if (/\bvitest\b/.test(cmd)) return "vitest";
    if (/\bmocha\b/.test(cmd)) return "mocha";
    if (/\bjest\b/.test(cmd)) return "jest";
    return undefined;
  };
  const npm = runCommand.match(/\b(?:npm|pnpm|yarn)\s+(?:run\s+)?([\w:.-]+)/);
  if (npm && scripts[npm[1]]) return direct(scripts[npm[1]]) ?? direct(runCommand);
  return direct(runCommand);
}

/**
 * Arguments that make the runner write JUnit to `file`, for runners that can do it without extra packages (mocha's
 * built-in xunit reporter, vitest's junit reporter) or with one the team already has (jest-junit). Extra arguments only
 * reach the runner when the command calls it directly or ends with `--` (npm passes what follows to the script).
 */
export function junitReporter(runner: Runner | undefined, runCommand: string, file: string, has: (pkg: string) => boolean, quote: (s: string) => string = shellWord): { args: string; env: Record<string, string> } | undefined {
  const viaNpm = /\b(?:npm|pnpm|yarn)\s/.test(runCommand);
  if (viaNpm && !/\s--(\s|$)/.test(runCommand) && !/^\s*yarn\s/.test(runCommand)) return undefined;
  if (runner === "mocha") return { args: ` --reporter xunit --reporter-option output=${quote(file)}`, env: {} };
  if (runner === "vitest") return { args: ` --reporter=junit --outputFile=${quote(file)}`, env: {} };
  if (runner === "jest" && has("jest-junit"))
    return { args: " --reporters=default --reporters=jest-junit", env: { JEST_JUNIT_OUTPUT_FILE: file, JEST_JUNIT_ADD_FILE_ATTRIBUTE: "true" } };
  return undefined;
}

/** A spec glob or directory baked into the run command: every run would include all tests, not only the ones asked for. */
export function runCommandRunsEverything(cmd: string): boolean {
  const words = cmd.trim().split(/\s+/).map((w) => w.replace(/^['"]|['"]$/g, ""));
  return words.some((w, i) => {
    if (i === 0 || w.startsWith("-")) return false;
    const prev = words[i - 1];
    if (prev.startsWith("-") && !prev.includes("=")) return false; // the value of an option (--ignore '*.e2e.ts')
    return w.includes("*") || /\.(spec|test)\.[cm]?[jt]sx?$/.test(w) || /^\.?\/?(tests?|specs?|__tests__)\//.test(w);
  });
}
