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
  dependsOn: z.array(z.string()).default([]),
});

export const ConfigSchema = z.object({
  version: z.literal(1),
  mode: z.enum(["existing", "scratch"]),
  project: z.object({
    name: z.string(),
  }),
  workspace: z.object({
    services: z.array(ServiceSchema).default([]),
  }),
  tests: z.object({
    language: z.enum(["typescript", "javascript"]).default("typescript"),
    api: z.object({
      framework: z.enum(API_FRAMEWORKS),
      dir: z.string().default("tests/api"),
      helpersDir: z.string().default("src/api"),
      runCommand: z.string().describe("Command that runs API tests; spec paths are appended"),
      baseUrlEnv: z.string().default("QA_BASE_URL"),
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
      jira: z
        .object({
          baseUrl: z.string().optional(),
          projectKeys: z.array(z.string()).default([]),
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
      model: z.string().optional().describe("Passed to `claude --model`; omit to use the CLI default"),
      maxTurns: z
        .object({
          gapReport: z.number().int().positive().default(30),
          generate: z.number().int().positive().default(60),
          learn: z.number().int().positive().default(40),
        })
        .default({}),
      maxFixAttempts: z.number().int().min(0).max(10).default(3),
      skipPaths: z
        .array(z.string())
        .default(["**/*.md", "docs/**", "**/*.lock", "**/package-lock.json", ".gitlab-ci.yml", "Jenkinsfile"]),
    })
    .default({}),
  guardrails: z
    .object({
      forbiddenUrlPatterns: z.array(z.string()).default(["prod", "production"]),
      allowAssertionRemoval: z.boolean().default(false),
    })
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
