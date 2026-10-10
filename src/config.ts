import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";

export const CONFIG_FILE = "qa-sentinel.config.yaml";

export const API_FRAMEWORKS = [
  "playwright",
  "supertest",
  "axios",
  "pactum",
  "jest",
  "vitest",
  "mocha",
  "other",
] as const;

const ServiceSchema = z.object({
  name: z.string(),
  path: z.string().describe("Path to the service repo, relative to the test repo"),
  openapi: z.string().optional().describe("Path to the OpenAPI spec inside the service repo"),
  gitlabProject: z.string().optional().describe("GitLab project path of the service, e.g. group/orders-service"),
  dependsOn: z.array(z.string()).default([]),
});

export const ConfigSchema = z.object({
  version: z.literal(1),
  mode: z.enum(["existing", "scratch"]),
  /**
   * Operating level. intelligence = read-only analysis on every MR (gap reports, risk, conflicts);
   * maintenance = also generate/update tests through reviewed MRs. (orchestration – cross-platform – is planned.)
   */
  level: z.enum(["intelligence", "maintenance"]).default("maintenance"),
  project: z.object({
    name: z.string(),
  }),
  workspace: z
    .object({
      services: z.array(ServiceSchema).default([]),
    })
    .default({}),
  tests: z.object({
    language: z.enum(["typescript", "javascript"]).default("typescript"),
    api: z.object({
      framework: z.enum(API_FRAMEWORKS),
      dir: z.string().default("tests/api"),
      helpersDir: z.string().default("src/api"),
      runCommand: z.string().describe("Command that runs API tests; spec paths are appended"),
      baseUrlEnv: z.string().default("QA_BASE_URL"),
      /** Extra paths the agent may write besides dir and helpersDir (fixtures, data builders, schemas). */
      extraWritePaths: z.array(z.string()).default([]),
    }),
    web: z
      .object({
        enabled: z.boolean().default(false),
        framework: z.enum(["playwright"]).default("playwright"),
        healing: z.enum(["none", "bubblegum"]).default("none"),
      })
      .default({}),
    mobile: z
      .object({
        enabled: z.boolean().default(false),
        framework: z.enum(["webdriverio-appium"]).default("webdriverio-appium"),
      })
      .default({}),
  }),
  requirements: z
    .object({
      source: z.enum(["mr-description", "jira", "none"]).default("mr-description"),
      /** When true, generation refuses to run without requirements (gap reports still run and say so). */
      required: z.boolean().default(false),
      storyKeyPattern: z.string().default("[A-Z][A-Z0-9]+-\\d+"),
      jira: z
        .object({
          baseUrl: z.string().optional(),
          projectKeys: z.array(z.string()).default([]),
          /** Custom field holding acceptance criteria, e.g. customfield_10045 (else they are read from the description). */
          acceptanceCriteriaField: z.string().optional(),
          /** Statuses that mean the story is agreed and testable. Anything else is "unverified". */
          approvedStatuses: z.array(z.string()).default(["Ready for Development", "Ready for Dev", "Selected for Development", "In Progress", "In Development", "In Review", "In QA", "Ready for QA", "Done"]),
        })
        .default({}),
    })
    .default({}),
  /** Team knowledge base (domain rules, glossary, review lessons) read by every agent. */
  knowledge: z
    .object({
      dir: z.string().default("kb"),
      maxChars: z.number().int().min(1000).max(200_000).default(40_000),
    })
    .default({}),
  /** Independent review of generated tests (assertion strength against the acceptance criteria). */
  review: z
    .object({
      enabled: z.boolean().default(true),
    })
    .default({}),
  /** Where `gap-report --post` publishes. One comment per target, updated in place on every run. */
  reporting: z
    .object({
      targets: z.array(z.enum(["gitlab-mr", "jira"])).min(1).default(["gitlab-mr"]),
      jira: z
        .object({
          /** summary: plain-language status per acceptance criterion (default); full: the whole technical report. */
          format: z.enum(["summary", "full"]).default("summary"),
          /** Restrict the Jira comment, e.g. { type: "role", value: "Developers" }. */
          visibility: z.object({ type: z.enum(["role", "group"]), value: z.string() }).optional(),
          /** Jira caps comments at 32,767 characters; longer reports are cut and linked to the CI artifact. */
          maxChars: z.number().int().min(2000).max(32000).default(30000),
        })
        .default({}),
    })
    .default({}),
  ci: z.object({
    platform: z.enum(["gitlab", "jenkins"]),
    scm: z.enum(["gitlab", "github", "none"]).default("gitlab"),
    gitlabUrl: z.string().default("https://gitlab.com"),
    testRepoProject: z
      .string()
      .optional()
      .describe("GitLab project path or id of the test repo, e.g. group/qa-tests"),
    targetBranch: z.string().default("main"),
  }),
  agent: z
    .object({
      /** Agent runtime. Only Claude Code today; the engine interface keeps others possible. */
      engine: z.enum(["claude-code"]).default("claude-code"),
      model: z.string().optional().describe("Passed to `claude --model`; omit to use the CLI default"),
      maxTurns: z
        .object({
          gapReport: z.number().int().positive().default(30),
          generate: z.number().int().positive().default(60),
          learn: z.number().int().positive().default(40),
          review: z.number().int().positive().default(25),
        })
        .default({}),
      maxFixAttempts: z.number().int().min(0).max(10).default(3),
      timeoutMinutes: z
        .object({
          gapReport: z.number().positive().default(15),
          generate: z.number().positive().default(30),
          learn: z.number().positive().default(20),
          review: z.number().positive().default(10),
        })
        .default({}),
      maxBudgetUsd: z
        .object({
          gapReport: z.number().positive().default(2),
          generate: z.number().positive().default(5),
          learn: z.number().positive().default(3),
          review: z.number().positive().default(1),
        })
        .default({}),
      skipPaths: z
        .array(z.string())
        .default(["**/*.md", "docs/**", "**/*.lock", "**/package-lock.json", ".gitlab-ci.yml", "Jenkinsfile"]),
    })
    .default({}),
  guardrails: z
    .object({
      /** Globs the agent may change during `generate`. Empty = derived from tests.api (dir, helpersDir, extraWritePaths, test-map.yaml). */
      allowedWritePaths: z.array(z.string()).default([]),
      /** Globs that may never change, even if they match allowedWritePaths. */
      blockedWritePaths: z
        .array(z.string())
        .default([
          ".claude/**",
          "CLAUDE.md",
          "kb/**",
          "qa-sentinel.config.yaml",
          ".gitlab-ci.yml",
          "**/*.gitlab-ci.yml",
          "Jenkinsfile*",
          "ci/**",
          ".github/**",
          ".env*",
          "**/.env*",
          "package.json",
          "package-lock.json",
          "pnpm-lock.yaml",
          "yarn.lock",
          "playwright.config.*",
          "tsconfig*.json",
        ]),
      /** Hosts that may appear in URLs added to test code. The host of the base URL env var is always allowed. */
      allowedHosts: z.array(z.string()).default(["localhost", "127.0.0.1", "example.com", "example.test", "example.org"]),
      /** What to do when a changed test file has fewer assertions than before: warn (flag in MR) or fail the run. */
      assertionRemoval: z.enum(["warn", "fail"]).default("warn"),
      /** Environment variables passed to the agent and to test runs. Token-like variables are never passed unless listed here. */
      passEnv: z.array(z.string()).default([]),
    })
    .default({}),
  verification: z
    .object({
      /** Run `npx tsc --noEmit` before tests ("auto" = when tsconfig.json exists). */
      typecheck: z.enum(["auto", "always", "never"]).default("auto"),
      /** Optional lint command; changed files are appended. */
      lintCommand: z.string().optional(),
      /** Where the test runner writes JUnit XML. For Playwright this is set automatically. */
      junitPath: z.string().optional(),
      /** Check that the base URL answers before running tests (unreachable = BLOCKED). */
      preflight: z.boolean().default(true),
      timeoutMinutes: z.number().positive().default(15),
      /** Environment `generate`/`verify` run against when --env is not given (a key of `environments`). */
      defaultEnvironment: z.string().optional(),
      /** With --push: keep the branch local unless verification is VERIFIED (no draft MRs). */
      requireVerifiedToPush: z.boolean().default(false),
    })
    .default({}),
  /** Named lower environments the tests can run against before an MR is opened, e.g. dev and sit. */
  environments: z
    .record(
      z.object({
        baseUrl: z.string().url(),
        description: z.string().optional(),
      }),
    )
    .default({}),
});

export type Config = z.infer<typeof ConfigSchema>;
export type ServiceConfig = z.infer<typeof ServiceSchema>;

export function configPath(cwd: string): string {
  return path.join(cwd, CONFIG_FILE);
}

export function loadConfig(cwd: string): Config {
  const file = configPath(cwd);
  if (!fs.existsSync(file)) {
    throw new Error(`No ${CONFIG_FILE} in ${cwd}. Run \`qa-sentinel init\` first.`);
  }
  const raw = YAML.parse(fs.readFileSync(file, "utf8"));
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid ${CONFIG_FILE}:\n${issues}`);
  }
  return parsed.data;
}

export function serializeConfig(config: Config): string {
  const header =
    "# qa-sentinel configuration. Docs: https://github.com/bishnu133/qa-sentinel#configuration\n" +
    "# Agents read this file too, so keep it accurate.\n";
  return header + YAML.stringify(config, { lineWidth: 100 });
}

export function writeConfig(cwd: string, config: Config): void {
  ConfigSchema.parse(config);
  fs.writeFileSync(configPath(cwd), serializeConfig(config));
}
