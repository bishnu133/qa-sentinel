import type { Config, ServiceConfig } from "./config.js";
import { matchesAny } from "./fsutil.js";

/**
 * A test layer: where its tests live, how they run and which base URL they use. API is always on; web when
 * tests.web.enabled. Mobile (v0.6) becomes a third layer with the same shape.
 */
export type Layer = "api" | "web";

export interface LayerConfig {
  layer: Layer;
  dir: string;
  /** API: request helpers. Web: page objects. */
  helpersDir: string;
  runCommand: string;
  baseUrlEnv: string;
  extraWritePaths: string[];
  isPlaywright: boolean;
}

export function layers(c: Config): LayerConfig[] {
  const a = c.tests.api;
  const out: LayerConfig[] = [
    { layer: "api", dir: a.dir, helpersDir: a.helpersDir, runCommand: a.runCommand, baseUrlEnv: a.baseUrlEnv, extraWritePaths: a.extraWritePaths, isPlaywright: a.framework === "playwright" },
  ];
  const w = c.tests.web;
  if (w.enabled) out.push({ layer: "web", dir: w.dir, helpersDir: w.pagesDir, runCommand: w.runCommand, baseUrlEnv: w.baseUrlEnv, extraWritePaths: w.extraWritePaths, isPlaywright: true });
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

/** The layer a service's changes are tested on first: front ends through the UI, everything else through the API. */
export function primaryLayer(c: Config, service: ServiceConfig): Layer {
  return service.kind === "web" && c.tests.web.enabled ? "web" : "api";
}

/** Variables every test run needs besides the API base URL: the web base URL and browser/healing switches. */
export function layerEnvNames(c: Config): string[] {
  return c.tests.web.enabled ? [c.tests.web.baseUrlEnv, "QA_BROWSER_PATH", "QA_BROWSER_CHANNEL", "QA_HEALING", "QA_HEADED", "QA_VIDEO", "QA_ACTION_TIMEOUT", "QA_CDP_PORT", "QA_BUBBLEGUM_PACKAGE"] : [];
}

/**
 * Commands that run these test files, one per layer, merged into one Playwright invocation when every layer is a
 * `… playwright test --project=<name>` command (one run, one results.json for the showcase stage).
 */
export function runCommandsFor(c: Config, files: string[]): string[] {
  const groups = layers(c)
    .map((l) => ({ l, files: files.filter((f) => (layerOfFile(c, f.replace(/:\d+$/, "")) ?? "api") === l.layer) }))
    .filter((g) => g.files.length);
  const parts = groups.map((g) => g.l.runCommand.trim().match(/^(.*\bplaywright test)\s+--project[= ](\S+)$/));
  if (groups.length > 1 && parts.every(Boolean) && new Set(parts.map((p) => p![1])).size === 1) {
    return [`${parts[0]![1]} ${parts.map((p) => `--project=${p![2]}`).join(" ")} ${groups.flatMap((g) => g.files).join(" ")}`];
  }
  return groups.map((g) => `${g.l.runCommand} ${g.files.join(" ")}`);
}

/** The whole suite in one command (CI's scheduled run): one Playwright invocation across projects when possible. */
export function suiteRunCommand(c: Config): string {
  const ls = layers(c);
  const parts = ls.map((l) => l.runCommand.trim().match(/^(.*\bplaywright test)\s+--project[= ](\S+)$/));
  if (ls.length > 1 && parts.every(Boolean) && new Set(parts.map((p) => p![1])).size === 1) return `${parts[0]![1]} ${parts.map((p) => `--project=${p![2]}`).join(" ")}`;
  return ls.map((l) => l.runCommand).join(" && ");
}
