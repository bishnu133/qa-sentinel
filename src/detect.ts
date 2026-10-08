import fs from "node:fs";
import path from "node:path";
import { readJson, walk } from "./fsutil.js";
import type { Config } from "./config.js";

export interface Detection {
  hasPackageJson: boolean;
  language: "typescript" | "javascript";
  frameworks: {
    playwright: boolean;
    webdriverio: boolean;
    appium: boolean;
    supertest: boolean;
    axios: boolean;
    pactum: boolean;
    jest: boolean;
    vitest: boolean;
    mocha: boolean;
  };
  apiFramework: Config["tests"]["api"]["framework"] | undefined;
  testFiles: string[];
  apiTestFiles: string[];
  apiDir: string | undefined;
  ci: { gitlab: boolean; jenkins: boolean };
  hasClaudeMd: boolean;
}

const TEST_FILE = /\.(spec|test)\.(ts|tsx|js|mjs|cjs)$/;
const API_HINTS = [
  /\brequest\.(get|post|put|patch|delete)\(/,
  /from ['"]supertest['"]/,
  /require\(['"]supertest['"]\)/,
  /from ['"]axios['"]/,
  /from ['"]pactum['"]/,
  /APIRequestContext/,
  /\bapiContext\b/,
];

export function detectProject(root: string): Detection {
  const pkg = readJson<any>(path.join(root, "package.json"));
  const deps: Record<string, string> = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  const has = (...names: string[]) => names.some((n) => n in deps);

  const files = walk(root);
  const testFiles = files.filter((f) => TEST_FILE.test(f));
  const apiTestFiles = testFiles.filter((f) => {
    if (/(^|\/)api(\/|\.)/i.test(f)) return true;
    try {
      const src = fs.readFileSync(path.join(root, f), "utf8").slice(0, 20000);
      const touchesUi = /\bpage\.(goto|click|locator|getBy)/.test(src);
      return !touchesUi && API_HINTS.some((r) => r.test(src));
    } catch {
      return false;
    }
  });

  const frameworks = {
    playwright: has("@playwright/test", "playwright"),
    webdriverio: has("webdriverio", "@wdio/cli"),
    appium: has("appium", "@wdio/appium-service"),
    supertest: has("supertest"),
    axios: has("axios"),
    pactum: has("pactum"),
    jest: has("jest"),
    vitest: has("vitest"),
    mocha: has("mocha"),
  };

  return {
    hasPackageJson: Boolean(pkg),
    language: has("typescript") || files.some((f) => f.endsWith(".ts")) ? "typescript" : "javascript",
    frameworks,
    apiFramework: pickApiFramework(frameworks, apiTestFiles.length > 0),
    testFiles,
    apiTestFiles,
    apiDir: commonDir(apiTestFiles),
    ci: {
      gitlab: fs.existsSync(path.join(root, ".gitlab-ci.yml")),
      jenkins: fs.existsSync(path.join(root, "Jenkinsfile")),
    },
    hasClaudeMd: fs.existsSync(path.join(root, "CLAUDE.md")),
  };
}

function pickApiFramework(
  f: Detection["frameworks"],
  hasApiTests: boolean,
): Detection["apiFramework"] {
  if (f.pactum) return "pactum";
  if (f.supertest) return "supertest";
  if (f.playwright && (hasApiTests || !f.axios)) return "playwright";
  if (f.axios) return "axios";
  if (f.jest) return "jest";
  if (f.vitest) return "vitest";
  if (f.mocha) return "mocha";
  return undefined;
}

/** Longest common directory of a set of files, or undefined. */
export function commonDir(files: string[]): string | undefined {
  if (files.length === 0) return undefined;
  const parts = files.map((f) => f.split("/").slice(0, -1));
  const first = parts[0];
  let i = 0;
  while (i < first.length && parts.every((p) => p[i] === first[i])) i++;
  return i === 0 ? undefined : first.slice(0, i).join("/");
}

export function defaultRunCommand(framework: Config["tests"]["api"]["framework"]): string {
  switch (framework) {
    case "playwright":
      return "npx playwright test --project=api";
    case "vitest":
      return "npx vitest run";
    case "mocha":
      return "npx mocha";
    case "supertest":
    case "axios":
    case "pactum":
    case "jest":
      return "npx jest";
    default:
      return "npm test --";
  }
}

export interface DiscoveredService {
  name: string;
  path: string; // relative to test repo
  openapi?: string; // relative to service root
}

const SERVICE_MARKERS = ["package.json", "pom.xml", "build.gradle", "build.gradle.kts", "go.mod", "pyproject.toml", "Cargo.toml", "*.csproj"];
const OPENAPI_NAMES = /(^|\/)(openapi|swagger)[^/]*\.(ya?ml|json)$/i;

/** Find service repos one level below a workspace directory. */
export function discoverServices(workspaceDir: string, testRepoRoot: string): DiscoveredService[] {
  if (!fs.existsSync(workspaceDir)) return [];
  const out: DiscoveredService[] = [];
  for (const entry of fs.readdirSync(workspaceDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const dir = path.join(workspaceDir, entry.name);
    if (path.resolve(dir) === path.resolve(testRepoRoot)) continue;
    const names = fs.readdirSync(dir);
    const isService =
      names.includes(".git") ||
      SERVICE_MARKERS.some((m) => (m.startsWith("*") ? names.some((n) => n.endsWith(m.slice(1))) : names.includes(m)));
    if (!isService) continue;
    const spec = walk(dir, 4).find((f) => OPENAPI_NAMES.test(f));
    out.push({
      name: entry.name,
      path: path.relative(testRepoRoot, dir).split(path.sep).join("/") || ".",
      openapi: spec,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
