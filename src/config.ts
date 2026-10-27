import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { DEFAULT_TEMPLATE, SECTION_ROLES } from "./storyTemplate.js";
import { ContractSourceSchema } from "./contractSource.js";

export const CONFIG_FILE = "qa-sentinel.config.yaml";
/** The hosts a fresh config allows. `data sweep` in CI uses only these when the config comes from the work tree (generated code can edit that file). */
export const DEFAULT_ALLOWED_HOSTS = ["localhost", "127.0.0.1", "example.com", "example.test", "example.org"];

const validRegex = (r: string) => {
  try {
    new RegExp(r);
    return true;
  } catch {
    return false;
  }
};

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
  /**
   * For a gateway or BFF: which paths it forwards to which service. `path` here is served as `servicePath` there
   * (default: the same path), e.g. { path: /api/orders, service: orders-service, servicePath: /orders }. A change to
   * orders-service GET /orders/{id} then also selects tests of this service's GET /api/orders/{id}.
   */
  gateway: z.array(z.object({ path: z.string(), service: z.string(), servicePath: z.string().optional(), methods: z.array(z.string()).optional() })).optional(),
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

const NotifyRule = (on: boolean) => z.object({ on: z.boolean().default(on), to: z.array(z.string()).default([]) }).default({});

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
    /** Manual test cards (one markdown file per story) for requirements that can't be automated. */
    manualDir: z.string().default("manual-tests"),
    /** Expected behaviour per story (expected/<STORY>.md): written from the ACs alone, reviewed by QA, locked against the code. */
    expectedDir: z.string().default("expected"),
    /** Write expected behaviour from the story (requirements pass) before planning tests: "write" or "off". */
    expectations: z.enum(["write", "off"]).default("write"),
    /**
     * Test hooks the system offers for behaviour tests can't reach directly: run a scheduled job now, move the
     * clock, read the emails sent, publish a queue message. Agents use these instead of waiting, and story review
     * flags requirements that need a hook nobody has built yet.
     */
    /**
     * Logging in: where the project's auth helpers live (agents reuse them, never invent a login), and the roles
     * tests may log in as. Each role's credentials come from environment variables (masked CI variables), passed to
     * test runs and never written into tests or reports.
     */
    auth: z
      .object({
        helpers: z.string().optional().describe("e.g. src/api/auth.ts or src/support/login.ts"),
        roles: z.array(z.object({ name: z.string(), env: z.array(z.string()).default([]).describe("e.g. [QA_ADMIN_USER, QA_ADMIN_PASSWORD]") })).default([]),
        notes: z.string().optional().describe("How login works here: SSO, OTP, DPoP, MockPass in test environments…"),
        /**
         * false (default): the roles' credentials reach qa-sentinel's own test runs only; the agent's runs while it
         * writes tests go without them (tests needing a login fail there, and qa-sentinel verifies them with the
         * credentials). true: the agent gets them too, so it can run those tests itself.
         */
        shareWithAgent: z.boolean().default(false),
      })
      .default({}),
    hooks: z.array(z.object({ name: z.string(), how: z.string().describe("e.g. POST /test/jobs/{job}/run (test environments only)"), notes: z.string().optional() })).default([]),
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
        /**
         * Before authoring, qa-sentinel opens the affected app screens on a device itself and saves what is on them (the
         * accessibility tree as XML and a screenshot), over plain Appium (W3C) HTTP calls. none (default): it does not,
         * because it needs a device or emulator during generation. snapshot: it does; a failure is a warning, never a stop.
         */
        explore: z.enum(["snapshot", "none"]).default("none"),
        /**
         * How a screen name becomes a deep link when exploring: "myapp://" + "orders/new". Empty: no deep links, so only the
         * screen the app opens on is saved (named "launch"). iOS deep links are not supported yet (see docs).
         */
        deepLinkBase: z.string().default(""),
        /**
         * Named ways to run the mobile suite on another platform or a device farm. qa-sentinel does not call any farm's API:
         * `qa-sentinel mobile-run --target <name>` builds the command you give here and runs it (or prints it).
         */
        targets: z
          .record(
            z.string().regex(/^[\w.-]+$/, "use letters, digits, dot, dash or underscore"),
            z.object({
              platform: z.enum(["android", "ios"]).optional(),
              /** Your command; qa-sentinel adds `--spec <file>` per spec. Default: tests.mobile.runCommand. */
              runCommand: z.string().optional(),
              /** Plain (not secret) values set for the run, e.g. QA_MOBILE_PLATFORM, QA_BUNDLE_ID. */
              env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string()).default({}),
              /** Names of variables copied from your environment (secrets such as a farm key). Must be set; their values are never printed. */
              passEnv: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)).default([]),
            }),
          )
          .default({}),
      })
      .default({}),
  }),
  requirements: z
    .object({
      source: z.enum(["mr-description", "jira", "none"]).default("mr-description"),
      /** When true, generation refuses to run without requirements (gap reports still run and say so). */
      required: z.boolean().default(false),
      storyKeyPattern: z.string().default("[A-Z][A-Z0-9]+-\\d+"),
      /** A merge request that names several stories: each (the stories it leads to) gets its own gap report, or only the first one counts. */
      multiKey: z.enum(["each", "first"]).default("each"),
      /** At most this many stories are analysed for one merge request (each costs one AI run). */
      maxKeysPerMr: z.number().int().min(1).max(5).default(3),
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
          /**
           * How to log in. auto (default): Jira Cloud (JIRA_EMAIL + JIRA_API_TOKEN) when JIRA_EMAIL is set, else the
           * Data Center personal access token JIRA_PAT. cloud / pat force one form.
           */
          auth: z.enum(["auto", "cloud", "pat"]).default("auto"),
          projectKeys: z.array(z.string()).default([]),
          /** Custom field holding acceptance criteria, e.g. customfield_10045 (else they are read from the description). */
          acceptanceCriteriaField: z.string().optional(),
          /** Extra fields that describe the expected behaviour beyond the ACs, read as scope items (e.g. a "Tech scope" field). */
          scopeFields: z.array(z.object({ field: z.string(), name: z.string(), prefix: z.string().regex(/^[A-Z]{1,4}$/) })).default([]),
          /** Statuses that mean the story is agreed and testable. Anything else is "unverified". */
          approvedStatuses: z.array(z.string()).default(["Ready for Development", "Ready for Dev", "Selected for Development", "In Progress", "In Development", "In Review", "In QA", "Ready for QA", "Done"]),
          /**
           * Issue types that are features with acceptance criteria (e.g. ["Story", "Enhancement"]): only these get
           * expected behaviour and the every-AC-gets-a-scenario rule. Others (Bug, Task, Spike) are still tested from
           * their text, without those. Empty (default): every issue type counts as a feature.
           */
          featureIssueTypes: z.array(z.string()).default([]),
          /**
           * Which statuses mean what, per Jira project (one test repository often serves projects with different
           * workflows). `readyStatuses`: development is done and the story can be tested end to end (matched without
           * regard to case; Jira's own "Done" category counts too, where known). `byProject` overrides either list for
           * one project key.
           */
          workflow: z
            .object({
              readyStatuses: z.array(z.string()).default(["Ready for Testing", "Ready for QA", "Dev Done", "In Testing", "In QA"]),
              byProject: z.record(z.object({ readyStatuses: z.array(z.string()).optional(), approvedStatuses: z.array(z.string()).optional() })).default({}),
            })
            .default({}),
          /**
           * How a bug, task or sub-task is traced to its feature (only when `featureIssueTypes` is set; with no
           * feature types every card is its own feature). The rules that keep wrong links out are fixed in code:
           * only cards with code, one hop, parent first, the target must be a feature in `projectKeys`, and a card
           * that reaches two features is not attached to either.
           */
          hierarchy: z
            .object({
              followParent: z.boolean().default(true),
              /** Link types to follow when a card has no parent that is a feature: `name` is the link type or its inward/outward wording ("is caused by"). `from`: issue types it applies to (empty: any non-feature). */
              links: z.array(z.object({ name: z.string().min(1), from: z.array(z.string()).default([]) })).default([]),
            })
            .default({}),
          /** Jira Components mapped to services of `workspace.services` (the firmest "which services does this story need" signal). */
          components: z.record(z.string()).default({}),
          /**
           * Which stories the background check (`qa-sentinel stories`) looks at when it is not given keys. Without
           * `jql`, it asks for stories of `projectKeys` in an approved status, of a feature issue type, changed
           * within `lookbackDays`.
           */
          search: z
            .object({
              /** Your own JQL instead of the built one (it should be ordered; maxStories still applies). */
              jql: z.string().optional(),
              lookbackDays: z.number().int().min(1).max(365).default(30),
              /** Finding a story's merge requests also looks at MRs updated in the last N days whose source branch names the story (the GitLab text search only reads titles and descriptions). */
              mrLookbackDays: z.number().int().min(1).max(365).default(30),
              maxStories: z.number().int().min(1).max(500).default(50),
              /** Stories with one of these labels are left alone (QA opts a story out by adding it). */
              skipLabels: z.array(z.string()).default(["qa-skip"]),
              /** When not empty, only stories with one of these labels are looked at (QA opts a story in). */
              onlyLabels: z.array(z.string()).default([]),
              /** Jira Cloud and Server/Data Center search differently. auto: try the Cloud search, fall back to the Server one. */
              api: z.enum(["auto", "cloud", "server"]).default("auto"),
            })
            .default({}),
        })
        .default({}),
    })
    .default({}),
  /**
   * Background work: where the story record is kept, how repeated AI jobs are handled, and how much the AI may spend.
   * Budgets count what the story record knows about (see docs/AUTOMATION.md); 0 means no limit.
   */
  automation: z
    .object({
      /** file: .qa-sentinel/stories/ (keep it with the CI cache). jira: also a Jira issue property, so a runner with no cache still knows. */
      record: z.enum(["file", "jira"]).default("file"),
      jobs: z
        .object({
          /** ci (default): in CI, a job whose inputs were already done is skipped; always: also on a laptop; never. */
          skipDone: z.enum(["ci", "always", "never"]).default("ci"),
          lockMinutes: z.number().int().min(5).max(1440).default(90),
          maxAttempts: z.number().int().min(1).max(10).default(3),
        })
        .default({}),
      /** ready (default): the gap report on a dev MR is made once the MR is no longer a draft; always: on every pipeline run. */
      gapReport: z.object({ when: z.enum(["ready", "always"]).default("ready") }).default({}),
      /** The merge-request sweep of `stories`: one paged list call per repository for MRs updated since the last check. */
      sweep: z
        .object({
          enabled: z.boolean().default(true),
          /** Look back this far before the last check, so an MR updated while the last check ran is not missed. */
          overlapHours: z.number().int().min(1).max(720).default(24),
          /** Pages of 100 merge requests read per repository. */
          maxPages: z.number().int().min(1).max(50).default(5),
        })
        .default({}),
      /** `stories --act`: the background check starts the AI steps that are due. */
      act: z
        .object({
          /** At most this many jobs are started by one check (each one costs money). */
          maxJobsPerCheck: z.number().int().min(1).max(50).default(3),
        })
        .default({}),
      budgets: z
        .object({
          perStoryUsd: z.number().min(0).default(25),
          perDayUsd: z.number().min(0).default(100),
          perMonthUsd: z.number().min(0).default(1000),
        })
        .default({}),
    })
    .default({}),
  /**
   * Where generated tests go. story (default): one long-lived test branch and merge request per story, built on after
   * every merge (only when a story key is found; a change with no story keeps its own branch). service: one branch and
   * merge request per merge, as before.
   */
  generation: z
    .object({
      scope: z.enum(["story", "service"]).default("story"),
      /**
       * When the end-to-end tests of an acceptance criterion that needs several services are written:
       * when-ready-status (default): every service it needs is merged AND the Jira card is in a ready status;
       * when-ac-complete: as soon as every service it needs is merged (the status is not looked at).
       */
      crossService: z.enum(["when-ready-status", "when-ac-complete"]).default("when-ready-status"),
      /** The story's test branch is `<branchPrefix><KEY>`. Kept configurable for repositories with branch naming rules. */
      branchPrefix: z
        .string()
        .regex(/^[A-Za-z0-9._\-/]*$/, "letters, digits, . _ - / only")
        .refine((v) => !v.startsWith("-") && !v.startsWith("/") && !v.includes(".."), "must not start with - or / and must not contain ..")
        .default("qa-sentinel/story-"),
      /** An open merge request that nobody has touched for this many days no longer holds back the ACs of its service (0: it always does). */
      staleMrDays: z.number().int().min(0).max(3650).default(30),
      /** At most this many acceptance criteria are planned in one run (the rest wait for the next one). */
      maxAcsPerRun: z.number().int().min(1).max(50).default(5),
    })
    .default({}),
  /**
   * Risk inputs that qa-sentinel computes itself (no AI): which changed files count as which kind of change, whether
   * missing access-control scenarios are a warning or an error, and how past defects, flaky tests and incidents raise risk.
   */
  risk: z
    .object({
      changeTypes: z
        .object({
          /** Globs are case-insensitive; a glob starting with "!" excludes (test code, fixtures and plain query files are no migrations). */
          migration: z
            .array(z.string())
            .default([
              "**/migrations/**",
              "**/migration/**",
              "**/migrate/**",
              "**/db/changelog/**",
              "**/flyway/**",
              "**/liquibase/**",
              "**/alembic/versions/**",
              "**/prisma/schema.prisma",
              "**/*.sql",
              "!**/test/**",
              "!**/tests/**",
              "!**/__tests__/**",
              "!**/fixtures/**",
              "!**/queries/**",
              "!**/*.test.*",
              "!**/*.spec.*",
            ]),
          config: z
            .array(z.string())
            .default([
              "**/application*.yml",
              "**/application*.yaml",
              "**/application*.properties",
              "**/bootstrap*.yml",
              "**/bootstrap*.yaml",
              "**/bootstrap*.properties",
              "config/**",
              "**/src/config/**",
              "**/helm/**",
              "**/values*.yaml",
              "**/*.env.example",
              "!**/*eslint*",
              "!**/*prettier*",
              "!**/*jest*",
              "!**/*.test.*",
              "!**/*.spec.*",
              "!**/test/**",
              "!**/tests/**",
            ]),
          toggle: z.array(z.string()).default(["**/toggles/**", "**/feature-toggles/**", "**/feature-flags/**", "**/featureflags/**", "**/feature_flags/**", "**/flags.json", "**/flags.y*ml"]),
          dependency: z
            .array(z.string())
            .default([
              "**/package.json",
              "**/pom.xml",
              "**/build.gradle*",
              "**/libs.versions.toml",
              "**/go.mod",
              "**/requirements*.txt",
              "**/requirements/*.txt",
              "**/pyproject.toml",
              "**/Pipfile",
              "**/Gemfile",
              "**/Cargo.toml",
              "**/composer.json",
              "**/*.csproj",
              "**/Directory.Packages.props",
            ]),
        })
        .default({}),
      /** A changed endpoint with an auth change (or a new endpoint when roles are configured) needs no-token / forbidden scenarios. warn: shown, never fails the plan. require: the plan is rejected without them. */
      accessControl: z.enum(["warn", "require"]).default("warn"),
      /** Endpoints that are open on purpose ("POST /login", "GET /health"): a changed one is not asked for a "no-token" scenario. */
      publicEndpoints: z.array(z.string()).default([]),
      history: z
        .object({
          /** How far back flaky runs in .qa-sentinel/runs/*\/verification.json count. */
          days: z.number().int().min(1).max(730).default(90),
          /** An endpoint with at least this many signals (known-defect tests, flaky runs, incidents) gets the `history` factor: its change's risk goes up one level (never to critical). */
          threshold: z.number().int().min(1).max(100).default(2),
          /** Team file with incidents per endpoint, inside knowledge.dir (agents cannot write there). Optional. */
          file: z.string().default("history.yaml"),
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
      sweepAuthEnv: z.string().regex(/^QA_CLEANUP_[A-Z0-9_]*$/, "must start with QA_CLEANUP_ (the sweeper sends this variable to the test environment, so it may not name any other credential)").default("QA_CLEANUP_AUTH"),
      /** How this project creates and removes test data (project mode): helpers, naming conventions, its own sweeper. */
      notes: z.string().optional(),
    })
    .default({}),
  /**
   * Feature toggles. Tests say what they need in their title (@toggle:new-checkout=on). Before qa-sentinel runs them,
   * it sets those toggles with these shell commands ({toggle} and {value} are filled in) for the environment ("*" for
   * any), and always puts them back afterwards. A lock (lockAcquire/lockRelease) keeps runs on a shared environment
   * from flipping toggles under each other.
   */
  toggles: z
    .object({
      environments: z
        .record(
          z.object({
            get: z.string().optional(),
            set: z.string(),
            reset: z.string().optional(),
            lockAcquire: z.string().optional(),
            lockRelease: z.string().optional(),
          }),
        )
        .default({}),
      /** A toggle's normal value, for putting it back when there is no `get` command. */
      defaults: z.record(z.string()).default({}),
      /** Credentials the toggle commands need (e.g. FLAGS_TOKEN): passed to them only, never to tests or agents. */
      passEnv: z.array(z.string()).default([]),
      timeoutSeconds: z.number().int().positive().default(60),
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
      /** When the story's code or ACs changed after the evidence was attached: attach fresh evidence on the next full pass, without the refresh label. Default off: the status only says the evidence is older. */
      reattachOnChange: z.boolean().default(false),
      /** Only showcase runs against these environments (e.g. [sit, uat]); empty = any. */
      environments: z.array(z.string()).default([]),
      /** A story with a fixme/skip test (known product discrepancy) is not showcased. */
      requireNoPending: z.boolean().default(true),
      /**
       * Personal data guard: before evidence goes to Jira, its text (API requests and responses, the PDF, title cards,
       * summaries) is scanned for NRIC/FIN, email, phone (international form or under phone-like keys) and card
       * numbers. block (default): attach nothing and report what was found (masked); warn: attach and report; off.
       * Video frames and screenshots are not read: run showcases on test data.
       */
      pii: z
        .object({
          mode: z.enum(["block", "warn", "off"]).default("block"),
          detect: z.array(z.enum(["nric", "email", "phone", "card"])).default(["nric", "email", "phone", "card"]),
          /** Regexes for values that are known test data, e.g. "^\\+65 ?9000 ?00\\d\\d$". */
          allow: z.array(z.string().refine(validRegex, "not a valid regex")).default([]),
          /** Test email domains besides example.com/.org/.net and the reserved .test, .example, .invalid, .localhost, .local. */
          allowEmailDomains: z.array(z.string()).default([]),
          /** Other patterns to treat as personal data, e.g. { name: "member-id", pattern: "\\bMBR\\d{8}\\b" }. */
          custom: z.array(z.object({ name: z.string(), pattern: z.string().refine(validRegex, "not a valid regex") })).default([]),
        })
        .default({}),
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
      /** Add "Was this useful? 👍 / 👎" to the gap report comment on a merge request. `qa-sentinel metrics --online` counts the votes (GitLab emoji reactions). Optional: false leaves the line out. */
      votes: z.boolean().default(true),
      jira: z
        .object({
          /** summary: plain-language status per acceptance criterion (default); full: the whole technical report. */
          format: z.enum(["summary", "full"]).default("summary"),
          /** Deprecated: use `mode`. single = status, separate = legacy. Only read when `mode` is not set. */
          layout: z.enum(["single", "separate"]).default("single"),
          /** status (default): one QA status comment per story, a section per check; legacy: one comment per kind (the old layout); both: write both. */
          mode: z.enum(["status", "legacy", "both"]).optional(),
          /** What happens to qa-sentinel's own older comments on the first status write: pointer (edit into a one-line pointer), delete, or keep. Only qa-sentinel's own comments are ever touched. */
          cleanup: z.enum(["pointer", "delete", "keep"]).default("pointer"),
          /** Short new comments that mention people when something needs them. Each is sent once per story and subject. `to: []` = showcase.notify. */
          notify: z
            .object({
              "showcase-ready": NotifyRule(true),
              "ac-not-built-but-ready": NotifyRule(false),
              "cross-service-tests-ready": NotifyRule(false),
              "stopped-by-budget": NotifyRule(false),
              "merge-conflict": NotifyRule(false),
            })
            .default({}),
          /** A person can mark an AC ready by hand with a comment: `/qa ready AC-1 reason`. allowed: [] = any human; else Jira account ids or usernames. */
          override: z.object({ command: z.string().min(2).default("/qa ready"), allowed: z.array(z.string()).default([]) }).default({}),
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
    /** Branches that carry hotfixes to production (patterns). A change merged here gets no test generation: tests are written once, when the change reaches the target branch by cherry-pick. */
    hotfixBranches: z.array(z.string()).default(["hotfix/*", "release/*"]),
  }),
  agent: z
    .object({
      /** Agent runtime. claude-code (built in), or command: an external program you give in agent.command. */
      engine: z.enum(["claude-code", "command"]).default("claude-code"),
      /**
       * engine: command only. A shell command that reads the task as JSON on stdin and prints the result as JSON on stdout
       * (docs/ENGINE-COMMAND.md). `{taskFile}` is replaced by the path of a file holding the same task JSON, quoted.
       * verification.wrapCommand wraps it like the test commands.
       */
      command: z
        .string()
        .min(1)
        .refine((s) => !/["']\{taskFile\}|\{taskFile\}["']/.test(s), "write {taskFile} without quotes around it: qa-sentinel quotes the path itself")
        .optional(),
      model: z.string().optional().describe("Passed to `claude --model`; omit to use the CLI default"),
      maxTurns: z
        .object({
          gapReport: z.number().int().positive().default(30),
          generate: z.number().int().positive().default(60),
          learn: z.number().int().positive().default(40),
          review: z.number().int().positive().default(25),
          /** The code-blind requirements pass (expected behaviour per story). */
          spec: z.number().int().positive().default(20),
        })
        .default({}),
      maxFixAttempts: z.number().int().min(0).max(10).default(3),
      /** Seconds to wait for a one-word test call before the first agent run, so bad credentials fail in seconds. 0 = skip the check. */
      accessCheckSeconds: z.number().int().min(0).max(600).default(60),
      timeoutMinutes: z
        .object({
          gapReport: z.number().positive().default(15),
          generate: z.number().positive().default(30),
          learn: z.number().positive().default(20),
          review: z.number().positive().default(10),
          spec: z.number().positive().default(10),
        })
        .default({}),
      maxBudgetUsd: z
        .object({
          gapReport: z.number().positive().default(2),
          generate: z.number().positive().default(5),
          learn: z.number().positive().default(3),
          review: z.number().positive().default(1),
          spec: z.number().positive().default(1),
        })
        .default({}),
      /**
       * Claude Code's built-in sandbox around the AGENT's shell commands (its Bash tool), off by default. On: the agent
       * runs with `--settings {"sandbox":{"enabled":true,"failIfUnavailable":true,"allowUnsandboxedCommands":false,
       * "network":{"allowedDomains":[...]}}}`. It covers shell commands only, not Claude's file tools, and needs
       * bubblewrap and socat on Linux (docs/SECURITY.md). Tests qa-sentinel itself runs: verification.wrapCommand.
       */
      sandbox: z
        .object({
          enabled: z.boolean().default(false),
          /** Hosts the agent's shell commands may reach (the QA environment's host, the package registry). Empty: none. */
          allowedDomains: z.array(z.string()).default([]),
          /** Stop at startup when the sandbox cannot start, instead of running unsandboxed. */
          failIfUnavailable: z.boolean().default(true),
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
      allowedHosts: z.array(z.string()).default(DEFAULT_ALLOWED_HOSTS),
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
      /**
       * Run every test command qa-sentinel starts (verification, post-deploy, suite, feature, showcase recording)
       * inside this wrapper. `{cmd}` is replaced by the command as one shell-quoted word, so use `sh -c {cmd}` or
       * similar, e.g. `docker run --rm --network qa-net -v $PWD:/w -w /w node:22 sh -c {cmd}`.
       */
      wrapCommand: z.string().refine((s) => s.includes("{cmd}"), { message: "must contain {cmd}, where the test command goes (e.g. \"firejail sh -c {cmd}\")" }).optional(),
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
  if (c.agent.engine === "command" && !c.agent.command) ctx.addIssue({ code: "custom", path: ["agent", "command"], message: "agent.engine is command, so agent.command is required (e.g. \"node my-engine.mjs\")" });
  const names = new Set(c.workspace.services.map((s) => s.name));
  for (const s of c.workspace.services)
    for (const r of s.gateway ?? [])
      if (!names.has(r.service)) ctx.addIssue({ code: "custom", path: ["workspace", "services"], message: `${s.name}: gateway route ${r.path} points to "${r.service}", which is not a service in workspace.services` });
});

export type Config = z.infer<typeof ConfigSchema>;

/** How qa-sentinel writes on a Jira story: `mode`, or the old `layout` (single = status, separate = legacy) when `mode` is not set. */
export function jiraMode(c: Pick<Config, "reporting">): "status" | "legacy" | "both" {
  const j = c.reporting.jira;
  return j.mode ?? (j.layout === "separate" ? "legacy" : "status");
}
export type ServiceConfig = z.infer<typeof ServiceSchema>;

export function configPath(cwd: string): string {
  return path.join(cwd, CONFIG_FILE);
}

export function loadConfig(cwd: string, fromFile?: string): Config {
  const file = fromFile ?? configPath(cwd);
  if (!fs.existsSync(file)) {
    throw new Error(fromFile ? `No config file at ${fromFile}.` : `No ${CONFIG_FILE} in ${cwd}. Run \`qa-sentinel init\` first.`);
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
