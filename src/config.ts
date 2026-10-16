import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { DEFAULT_TEMPLATE, SECTION_ROLES } from "./storyTemplate.js";
import { ContractSourceSchema } from "./contractSource.js";

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
  /**
   * For specs generated at build time (tsoa, swagger-jsdoc, springdoc, …): a shell command run in the service repo that
   * writes the spec to `openapi`, e.g. "npx tsoa spec". qa-sentinel runs it at the base and the head commit (in a
   * throwaway worktree that shares the repo's node_modules) and diffs the results, so the spec needn't be committed.
   */
  openapiCommand: z.string().optional(),
  openapiCommandTimeoutSeconds: z.number().int().positive().optional(),
  gitlabProject: z.string().optional().describe("GitLab project path of the service, e.g. group/orders-service"),
  /**
   * For a service that is a folder of a larger repository (a monorepo): the folder inside that repository, e.g.
   * services/orders. In CI the service is checked out at the repository root (--service-path), so qa-sentinel joins
   * this folder onto it; `path` (local) already points at the folder.
   */
  subdir: z.string().optional(),
  /**
   * Spec-first teams: the agreed API spec (the source of truth), when it lives outside the service repo or differs
   * from what the code generates. The implemented spec (`openapi`) is checked against it field by field.
   */
  contract: ContractSourceSchema.optional(),
  dependsOn: z.array(z.string()).default([]),
  /** api: a backend service (API tests); web: a front end (web UI tests through page objects); mobile: an app (WebdriverIO + Appium, screen objects). UI layers set data up via the API. */
  kind: z.enum(["api", "web", "mobile"]).default("api"),
  /** Web front ends: the routes this service serves (e.g. /orders/new), used when a change doesn't name its page. */
  routes: z.array(z.string()).default([]),
  /** How to ask a running environment which commit of this service is deployed (for feature readiness). */
  version: z
    .object({
      /** Path appended to the environment's base URL, e.g. /orders/version or /actuator/info. */
      path: z.string(),
      /** Field holding the commit SHA in the JSON response (dot path), e.g. commit or git.commit.id. */
      field: z.string().default("commit"),
    })
    .optional(),
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
        dir: z.string().default("tests/web"),
        /** Page objects: locators live here and only here; the agent updates them before the specs. */
        pagesDir: z.string().default("src/pages"),
        runCommand: z.string().default("npx playwright test --project=web").describe("Command that runs web tests; spec paths are appended"),
        baseUrlEnv: z.string().default("QA_WEB_URL"),
        extraWritePaths: z.array(z.string()).default([]),
        /** Before authoring, qa-sentinel opens the affected pages and saves what is on them (accessibility tree + screenshot) for the agent. */
        explore: z.enum(["snapshot", "none"]).default("snapshot"),
        /** new-pages: new or changed pages get one accessibility test (axe, WCAG 2 AA; critical and serious issues). */
        accessibility: z.enum(["off", "new-pages"]).default("new-pages"),
        /**
         * Runtime locator healing. none: plain Playwright. bubblegum: when a page-object action fails, the ui helper asks
         * Bubblegum (@bubblegum-ai/node) to recover it over CDP. Never used while qa-sentinel verifies agent-written tests.
         */
        healing: z.enum(["none", "bubblegum"]).default("none"),
        bubblegum: z
          .object({
            package: z.string().default("@bubblegum-ai/node"),
            /** First remote-debugging port; each Playwright worker uses cdpPort + workerIndex. */
            cdpPort: z.number().int().min(1024).max(65000).default(9222),
            /** true: a healed step fails `qa-sentinel healed` (and the CI job running it) even though the test passed. */
            failOnHeal: z.boolean().default(false),
          })
          .default({}),
      })
      .default({}),
    mobile: z
      .object({
        enabled: z.boolean().default(false),
        framework: z.enum(["webdriverio-appium"]).default("webdriverio-appium"),
        dir: z.string().default("tests/mobile"),
        /** Screen objects: selectors live here and only here; the agent updates them before the specs. */
        screensDir: z.string().default("src/screens"),
        /** Command that runs mobile tests; qa-sentinel adds `--spec <file>` per spec. */
        runCommand: z.string().default("npx wdio run wdio.conf.ts"),
        /** The Appium server; qa-sentinel checks <url>/status before running mobile tests. */
        appiumUrlEnv: z.string().default("QA_APPIUM_URL"),
        appiumUrl: z.string().default("http://127.0.0.1:4723"),
        /** Default platform when QA_MOBILE_PLATFORM is not set. */
        platform: z.enum(["android", "ios"]).default("android"),
        extraWritePaths: z.array(z.string()).default([]),
      })
      .default({}),
  }),
  requirements: z
    .object({
      source: z.enum(["mr-description", "jira", "none"]).default("mr-description"),
      /** When true, generation refuses to run without requirements (gap reports still run and say so). */
      required: z.boolean().default(false),
      storyKeyPattern: z.string().default("[A-Z][A-Z0-9]+-\\d+"),
      /**
       * How your team writes stories: which headings hold the acceptance criteria, what is in scope (items IS-1, TS-1,
       * ER-1 … checked for "is it built?" and traced like ACs), what is out of scope (never planned or raised as bugs),
       * context for the agents, the showcase approach, and what to ignore. Headings match ignoring case, punctuation
       * and markup. Check how your real stories are read with `qa-sentinel story-check --story KEY`.
       */
      template: z
        .array(
          z
            .object({
              role: z.enum(SECTION_ROLES),
              name: z.string(),
              headings: z.array(z.string()).min(1),
              prefix: z.string().regex(/^[A-Z]{1,4}$/).optional(),
            })
            .refine((s) => s.role !== "scope" || s.prefix, { message: "scope sections need a prefix (e.g. IS)" }),
        )
        .default(DEFAULT_TEMPLATE),
      /** Turn scope items off (only ACs are traced). `sections` is the v0.6.0 form of scope sections; prefer `template`. */
      scope: z
        .object({
          enabled: z.boolean().default(true),
          sections: z.array(z.object({ prefix: z.string().regex(/^[A-Z]{1,4}$/), name: z.string(), headings: z.array(z.string()).min(1) })).default([]),
        })
        .default({}),
      jira: z
        .object({
          baseUrl: z.string().optional(),
          projectKeys: z.array(z.string()).default([]),
          /** Custom field holding acceptance criteria, e.g. customfield_10045 (else they are read from the description). */
          acceptanceCriteriaField: z.string().optional(),
          /** Extra fields that describe the expected behaviour beyond the ACs, read as scope items (e.g. a "Tech scope" field). */
          scopeFields: z.array(z.object({ field: z.string(), name: z.string(), prefix: z.string().regex(/^[A-Z]{1,4}$/) })).default([]),
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
  /**
   * Test data the tests create. ledger: every created record is written to a ledger with the request that deletes it;
   * the test fixture deletes them in reverse order when the test ends (pass or fail), and `qa-sentinel data sweep`
   * removes what a killed run left behind. project: the project has its own cleanup pattern (describe it in `notes`).
   * none: data is left behind (say so in reports).
   */
  testData: z
    .object({
      cleanup: z.enum(["ledger", "project", "none"]).default("project"),
      ledgerDir: z.string().default(".qa-data"),
      /** Environment variable with the Authorization header value the sweeper sends (e.g. "Bearer …"). */
      sweepAuthEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/).default("QA_CLEANUP_AUTH"),
      /** How this project creates and removes test data (project mode): helpers, naming conventions, its own sweeper. */
      notes: z.string().optional(),
    })
    .default({}),
  /** Independent review of generated tests (assertion strength against the acceptance criteria). */
  review: z
    .object({
      enabled: z.boolean().default(true),
    })
    .default({}),
  /** Showcase stage: attach test evidence to the story once every acceptance criterion has passed. */
  showcase: z
    .object({
      /** QA adds this label to a story to have the evidence attached again (it is removed afterwards). */
      refreshLabel: z.string().default("qa-showcase-refresh"),
      /** On refresh, delete the evidence attached last time instead of adding a second copy. */
      replaceOnRefresh: z.boolean().default(true),
      /** Evidence kinds to attach, in order of preference. api-log is folded into the evidence summary file. */
      kinds: z.array(z.enum(["video", "screenshot", "trace", "api-log"])).default(["video", "screenshot", "api-log"]),
      maxFiles: z.number().int().min(1).max(50).default(20),
      maxFileMb: z.number().positive().max(500).default(50),
      /**
       * pack (default): ONE video of the whole story (a title card per AC, then its test, recorded slowly with the
       * actions highlighted) plus ONE PDF with the results and the API requests/responses: what Biz users review.
       * files: the run's own videos, screenshots and logs, one attachment each.
       */
      format: z.enum(["pack", "files"]).default("pack"),
      video: z
        .object({
          /** Re-run the chosen web and mobile tests once in showcase mode (slowed down, highlighted) instead of reusing the fast CI recordings. */
          record: z.boolean().default(true),
          slowMoMs: z.number().int().min(0).max(3000).default(500),
          holdMs: z.number().int().min(0).max(10000).default(2000),
          /** Pause on each step, with its caption shown ("Click Checkout button"), so viewers can follow. */
          stepMs: z.number().int().min(0).max(10000).default(1200),
          /** Cut this much from the start of each recording (the blank page before the site loads). */
          trimStartMs: z.number().int().min(0).max(5000).default(800),
          titleSeconds: z.number().min(0.5).max(10).default(3),
          /** Path to a full ffmpeg (libx264). Default: QA_FFMPEG, then ffmpeg on PATH, then the ffmpeg-static package. */
          ffmpeg: z.string().optional(),
        })
        .default({}),
      /** Who to tag when a story is ready for review: Jira Cloud account ids (or Server/DC usernames). */
      notify: z.array(z.string()).default([]),
      /** Only showcase runs against these environments (e.g. [sit, uat]); empty = any. */
      environments: z.array(z.string()).default([]),
      /** A story with a fixme/skip test (known product discrepancy) is not showcased. */
      requireNoPending: z.boolean().default(true),
    })
    .default({}),
  /**
   * Bug cards from evidence. off (default) · suggest: list the proposed bugs on the story, ready to create ·
   * create: create them in Jira, linked to the story, once per story and AC; comment on them when the test passes.
   * "Not working" bugs come from tests written to an AC that fail (on a run, or the fixme a generation wrote);
   * "not built" bugs from a story-wide gap report, only when every part of the story is merged (suspected).
   */
  bugs: z
    .object({
      mode: z.enum(["off", "suggest", "create"]).default("off"),
      /** Jira project for the bugs (default: the story's project). */
      project: z.string().optional(),
      /** Issue type; falls back to Task (labelled "bug") when the project has no such type. */
      issueType: z.string().default("Bug"),
      priority: z.string().optional(),
      labels: z.array(z.string()).default(["qa-sentinel"]),
      linkType: z.string().default("Relates"),
      /** Also raise "not built" bugs from story-wide gap reports (static analysis: labelled suspected). */
      notBuilt: z.boolean().default(true),
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
    /** MRs from these source branches (regexes) get no gap report and no generation: dependency bots, by default. */
    skipBranches: z
      .array(
        z.string().refine((r) => {
          try {
            new RegExp(r);
          } catch {
            return false;
          }
          // Also written into GitLab rules (RE2, unquoted YAML): plain regex characters only.
          return /^[A-Za-z0-9_.\-/^$|()?*+[\]\\]+$/.test(r) && !/\(\?[=!<]/.test(r);
        }, "ci.skipBranches entries must be simple regexes (letters, digits, _ . - / ^ $ | ( ) ? * + [ ] and backslash; no lookarounds or spaces)"),
      )
      .default(["^renovate/", "^dependabot/"]),
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
      /** Globs the agent may change during `generate`. Empty = derived from tests.api and tests.web (dirs, helpers, page objects, extraWritePaths, test-map.yaml). */
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
      /** Re-run failed specs once; a test that passes on retry is reported as flaky instead of failed. */
      retryFailed: z.boolean().default(true),
      /** With --push: keep the branch local unless verification is VERIFIED (no draft MRs). */
      requireVerifiedToPush: z.boolean().default(false),
    })
    .default({}),
  /** Named lower environments the tests can run against before an MR is opened, e.g. dev and sit. */
  environments: z
    .record(
      z.object({
        baseUrl: z.string().url(),
        /** Web front end of this environment (sets tests.web.baseUrlEnv). */
        webUrl: z.string().url().optional(),
        description: z.string().optional(),
      }),
    )
    .default({}),
}).superRefine((c, ctx) => {
  // Services are looked up by name (CLI flags, dependsOn, stories, CI): two with one name would silently use the first.
  const seen = new Set<string>();
  for (const s of c.workspace.services) {
    if (seen.has(s.name)) ctx.addIssue({ code: "custom", path: ["workspace", "services"], message: `two services are named "${s.name}"; names must be unique` });
    seen.add(s.name);
  }
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
