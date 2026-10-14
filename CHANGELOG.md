# Changelog

## 0.7.0 (in progress) — Learning from review, mobile end to end in the sandbox

### Learning from review
- `qa-sentinel lessons [--since] [--push] [--dry-run]`: for agent commits merged with reviewer edits (merge commit: the MR branch after the agent's commit; squash: the agent's files against the squashed result), an agent (read-only, skill `learn-from-review`) writes general lessons with the commits they come from, or skips one-off fixes; code validates them (known commits only; `updates` must name an existing lesson) and writes `kb/review-lessons.md` on `qa-sentinel/review-lessons` (MR with `--push`). The reviewed commits are recorded in the file, so nothing is learned twice.
- `metrics`: merged-without-edits by month.
- GitLab template: scheduled `qa-lessons` job (`QA_LESSONS=true`).

### Mobile end to end in the sandbox
- `local.mjs setup --mobile`: the ShopLite Android app (`services/shoplite-app`: Java, programmatic UI with accessibility ids, deep links `shoplite://orders/<id>`, built by `build.sh` with javac/d8/aapt2/zipalign/apksigner), screen objects (`HomeScreen`, `NewOrderScreen`, `OrderScreen`) and app tests, the app as a `kind: mobile` service with its screens in `test-map.yaml`.
- Scenario SHOP-109 (mobile). `local.mjs app build`; `run` builds the app from the developer's change, checks Appium and the emulator, runs selected app tests with `--regression`, and includes the app tests in `--showcase`.
- GitHub Actions `android-sandbox`: builds the app, runs the app tests and `qa-sentinel verify` on an Android emulator.
- Mobile scaffold: `openDeepLink` takes the app package from the session (installed APKs); `add-mobile` adds `wdio.conf.ts` to `tsconfig.json`.

## 0.6.0 — One showcase video per story, Mobile, "is the story built?", story-wide runs, bug cards, metrics

### Showcase pack (replaces the manual Biz showcase)
- `showcase.format: pack` (default): when every AC of a story passed, qa-sentinel re-records the chosen test per AC in showcase mode (slowed down, the element being used outlined, a pause on the result; `showcase.video`) and joins them with title cards into **one `<STORY>-showcase.mp4`**, plus **one `<STORY>-showcase.pdf`** with the results per AC, a screenshot per UI test and the API requests and responses. Picks per AC: a test tagged `@showcase`, else a web test, else a mobile test, else any passing test.
- Attached once, only after all ACs passed, and only from runs on `showcase.environments`. `showcase.notify` tags the reviewers; the comment names exactly what was attached.
- Needs a full ffmpeg with libx264 (`showcase.video.ffmpeg`, `QA_FFMPEG`, PATH or `ffmpeg-static`); without it the PDF and the separate recordings are attached. `format: files` keeps the v0.5 behaviour.
- In the video every step is captioned ("Click Checkout button", "Enter "2" into Quantity") next to the outlined element, held long enough to read (`showcase.video.stepMs`), and each test ends on "✓ Verified: <test>". The blank start of each recording is trimmed (`trimStartMs`). A failed showcase recording pass now says why.
- Phone recordings are made at the device's own size and orientation, and each ends on its last frame for `holdMs` (Android only records frames when the screen changes, so a still screen would otherwise vanish from the video).
- Secrets in API evidence (password, token, authorization, card fields, JWTs, bearer tokens) are redacted in the PDF and the evidence file.
- GitLab template: the showcase job installs ffmpeg and starts the environment.

### Mobile (WebdriverIO + Appium)
- New layer `tests.mobile` (dir, screensDir, runCommand, appiumUrlEnv, platform) and service `kind: mobile`. `init --mobile` / `add-mobile` scaffold `wdio.conf.ts` (device and app from the environment; device-farm URLs with credentials), screen objects, a ui helper with intents, evidence hooks (screen recording, final screenshot, API setup calls, one result file per test) and the `write-mobile-test` skill, and add the WebdriverIO packages.
- Plans: scenarios with `layer: mobile` and a screen; `@screen:` tags are indexed like pages; UI setup steps are allowed for mobile tests (with a reason).
- Verification: Appium `/status` preflight (credentials sent as a header, never printed), `--spec` per file, JUnit from a folder; regression and `feature --run` run mobile specs with their own command. The showcase pack re-records mobile tests and includes their recordings.
- CI: a `mobile-tests` job (GitLab, when `QA_APPIUM_URL` is set) and a `Mobile tests` stage (Jenkins). The scheduled suite command leaves mobile out.
- The device and evidence files (`wdio.conf.ts`, `src/mobile/evidence.ts`, `src/mobile/ui.ts`, `src/fixtures/mobile.ts`) are blocked for agent writes.

### Requirements: "is the story built?"
- Scope items: list items under the story's "Tech scope" / "Expected results" headings (`requirements.scope.sections`) or Jira fields (`requirements.jira.scopeFields`) become TS-n / ER-n, traced like ACs.
- Every plan has `requirementStatus`: implemented · partial · not-found · conflict · elsewhere · not-applicable per AC and scope item, with evidence and the ACs that cover it. The gap report has an "Is the story built?" table and lists scope items no AC covers; the Jira summary shows "⛔ Not built".
- `review-story`: before development, a read-only review of the story (ambiguous ACs, missing negative and edge cases, scope without an AC, open questions), optionally posted on the story.

### Onboarding and story templates
- `requirements.template`: each team describes how its stories are written as sections with a role (acceptance-criteria, scope with an id prefix, out-of-scope, context, showcase, ignore) and the headings that start them. Defaults cover common names (In-scope, Tech notes / Implementation, Expected results, Out of scope, Assumptions, Questions, Feature toggles, Showcase approach, Checklist). `requirements.scope.sections` from earlier 0.6 builds still works.
- Acceptance criteria from numbered/bulleted lists, `AC-n` lines, Gherkin scenarios, and Given / When / Then **tables** (any column order, a number or scenario column, multi-line cells, `—` for empty steps); the story's own AC numbers are kept when present.
- Nested bullets stay with their parent item; a short label before a list (a service name, "Data model") groups its items; a tech note is tied to the service it names. Jira wiki (`**` depth, `||` tables) and ADF (nested lists, tables) both convert faithfully.
- Out-of-scope items are given to the agents as exclusions; context sections (assumptions, questions, feature toggles) as evidence; the showcase approach goes into the showcase PDF. A story proven only by API tests gets the PDF without a video.
- Story-mode and single-service gap reports say when the story names a service that has no change for it.
- `story-check --story KEY [--fields]` (no AI call): how a story is read, what to change in the template, and the issue's Jira field ids. `init` asks for the requirements source, Jira URL and project keys, GitLab URL and test repo project, and the test layers (also as flags). `doctor` checks the story key pattern and the template. New guide: `docs/ONBOARDING.md`.

### Story-wide runs
- `gap-report --story KEY` and `generate --story KEY`: everything the story changed across services as one plan and one test MR (`qa-sentinel/story-KEY`). For merged parts only the story's own change is taken (the merge's or squash's net change), never other work merged meanwhile. Regression selections are merged across parts.

### Bug cards
- `bugs.mode: off | suggest | create`. Sources: failing tests written to an AC (`qa-sentinel bugs` after a run), the fixme tests a generation wrote because the product disagrees, and (story-wide, `bugs.notBuilt`) ACs nothing builds (labelled suspected).
- Each bug has expected vs actual, the test and command to reproduce, the environment, where to look in the code, evidence, and a `{code:json}` block for coding agents. Recorded on the story as soon as it is created (never raised twice); "now passes" is noted on the bug when its tests pass.

### Quality
- Verification retries failed specs once (`verification.retryFailed`); a pass on retry is reported as flaky, matched by file and title.
- `tag`: one-off backfill of `@service`/`@endpoint`/`@page` tags on existing tests; only added tags inside test titles are accepted.
- `learn` also writes web and mobile conventions into their skills.
- Accessibility: `tests.web.accessibility: new-pages` adds one axe (WCAG 2 AA) test per new or changed page; the check fails if `@axe-core/playwright` is missing.
- Risk factors `user-journey`, `ui-visible` and `price-display`.
- `metrics`: verification rate, merged-without-edits rate (merge, squash, fast-forward), cost per command, plan repairs, guardrail stops, from run manifests (local or downloaded CI artifacts) and git history.
- `upgrade`: refreshes qa-sentinel's agents, skills, CI templates and project context after an update, keeping learned conventions.
- Spec paths are shell-quoted wherever a command line is built.

### Also
- Existing projects (`init --mode existing`, `add-web`, `add-mobile`) get the packages the new scaffold files import added to package.json.
- Scaffold files follow `pagesDir`, `screensDir` and the tests' `dir` in their relative imports.
- Benchmark on v0.6: 100% gap recall, precision and decision accuracy, no repair rounds, $0.73.

## 0.5.0 — Web tests, workflow planner, video evidence, optional Bubblegum healing

### Web (Playwright UI)
- New test layer `tests.web` (dir, pagesDir, runCommand, baseUrlEnv) and service `kind: web` with `routes`. `init --web` scaffolds it for new projects, `add-web` adds it to existing ones (and prints the Playwright project to add).
- Scaffold: `src/web/ui.ts` (page-object actions with intents), `src/pages/base-page.ts` (routes with `:params`, relative to the base URL), `src/fixtures/web.ts` (`ui`, plus `api` and `data` for test data through the API), example spec. Playwright `web` project records video and screenshots; `QA_BROWSER_CHANNEL=chrome` / `QA_BROWSER_PATH` when Playwright's browser can't be downloaded, `QA_VIDEO=off` without ffmpeg.
- Plans: change type `ui-change` with `page`, risk factors `user-journey` (high) and `ui-visible` (medium). Scenarios carry `layer` and `page`.
- Before authoring, qa-sentinel opens the affected pages (routes with params via links on known pages) and saves each page's accessibility tree and a screenshot to `page-snapshots/` for the agent (`tests.web.explore`).
- New `write-web-test` skill: page objects before specs, locator rules, `@page` tags, data through the API. The plan, generation, analyzer and mapper prompts know about web.
- Verification runs each layer's changed specs with its own command, base URL and preflight (`tests (web)` in the MR). Test index reads `@page` tags; `test-map.yaml` `screens` are checked; regression selection adds `changed-page`; selected tests run as one Playwright invocation across projects.
- `feature --run`, doctor (base URL, page objects, browser, Bubblegum), guardrails (web host allowed), env forwarding (`QA_WEB_URL`, browser and healing switches) all cover the web layer.

### Workflow planner
- Scenario `setup` is a dependency graph of steps (`id`, `via`: api · test-data-service · db-helper · ui, `helper`, `dependsOn`, `why`). Validated in code: unknown or cyclic dependencies are errors; UI setup only in web tests and only with a reason; DB helpers only with a reason. Plain strings still work (ordered API steps). The gap report prints the flow per scenario.

### Optional runtime healing (Bubblegum)
- `tests.web.healing: bubblegum`: with `QA_HEALING=bubblegum`, a failed page-object action is performed by `@bubblegum-ai/node` `recover()` from its intent, attached over CDP to the same browser (one port per worker). Each healed step is attached to the test and annotated.
- Healing is always off when qa-sentinel verifies agent-written tests; `feature --run` and scheduled CI runs may use it.
- Showcase `maxFiles` default raised to 20 (a web test brings a video and a screenshot; videos are kept first).
- New `qa-sentinel healed`: lists healed steps per page-object call site (`qa-healed.md`), keeps them for the next generation run (`qa-healed.json`), exits 1 with `failOnHeal`.
- GitLab template: the suite job runs API and web together with `QA_HEALING`, installs the browser, and an optional `qa-healed` job. Jenkins: same suite command.

### Sandbox
- New `storefront` service (web front end on :8081, no dependencies) with page objects and 4 baseline web tests; `qa-env` starts it. Scenarios SHOP-107 (renamed button breaks two web tests; planted total bug → AC-3 conflict) and SHOP-108 (clean; Showcase with a video per AC). `setup` installs Chromium or explains the Chrome fallback.

### Also
- Verification JUnit: API results stay in `.qa-sentinel/runs/<run>/junit.xml`, web results go to `junit-web.xml` (CI templates collect `junit*.xml`).
- The web scaffold files that decide healing (`src/web/healing.ts`, `src/web/ui.ts`, `src/fixtures/web.ts`) are blocked for agent writes, and the agent's own test runs always use `QA_HEALING=off`.
- `add-web` also refreshes `.claude/qa-sentinel.md` and the CI templates in `ci/qa-sentinel/`.
- The template renderer supports nested `{{#if}}` blocks.

## 0.4.0 — Simple Jira comments, lower-environment runs, Showcase, feature manifests

### Jira comments in plain language
- `reporting.jira.format: summary` (default): the story gets a short comment for POs, developers and QA leads (risk, what changed, what QA will do, a table of acceptance criteria with a status each, decisions needed, open questions, a link to the full report on the MR). `full` keeps the technical report.
- After `generate --push`, the same comment is updated with the results per AC (tested and passing, weak test, product doesn't match the story, waiting for a fix, no test yet) and the environment the tests ran on.
- Publishing moved to `src/reporting/publish.ts`, shared by gap reports, generation and feature manifests.

### Run on a lower environment before the MR
- New `environments:` (name → `baseUrl`, description). `generate --env sit` and `verify --env sit` run the verification against that environment; `verification.defaultEnvironment` sets the default.
- `verification.requireVerifiedToPush: true`: nothing is pushed or opened as an MR unless verification was VERIFIED on the environment.

### Showcase agent
- `qa-sentinel showcase --story KEY` reads the run results (Playwright JSON preferred, JUnit attachments as fallback) and checks the story is ready: every AC has active passing tests, none failed or did not run, no pending fixme (`showcase.requireNoPending`).
- Attaches an evidence file (per AC: tests, environment, and the request/response of each API call) plus videos and screenshots from the run, within `maxFiles`/`maxFileMb`, and posts a short comment.
- One time per story: what was attached is stored in the issue property `qa-sentinel.showcase`. It attaches again only when QA adds the `qa-showcase-refresh` label (removed afterwards; the previous evidence is deleted with `replaceOnRefresh`) or with `--force`.
- `--dry-run`, or no Jira configured: the evidence is saved to `qa-showcase/<story>/`.
- Scaffolded API client records each call (no headers; bodies clipped) and fixtures attach `api-log.json` to the test (`QA_API_LOG=off` disables it). The Playwright config adds the JSON reporter.
- GitLab template: optional `qa-showcase` job after `api-tests` (`QA_SHOWCASE: "true"`).

### Feature manifests across services
- `qa-sentinel feature KEY [--env sit]`: finds the story's MRs (GitLab) or branches and commits (local git, exact-key match) in every service, checks each service's `version` endpoint for the deployed SHA, and reports a status: no changes found, in development, merged, waiting for deployment, ready for feature tests. `--run` runs the story's tests when ready; `--post` updates the Jira story. Writes `qa-feature-<KEY>.md/.json`.
- Gap reports say which other services change in the same feature.

### Also
- `generate` ignores qa-sentinel's own output files when checking for a clean repo.
- Benchmark: injected instructions are no longer matched against expected product changes (they are scored by the suspicious-content check). Decision accuracy back to 100% on the saved plans.
- Sandbox: SHOP-106 is a two-service feature (notifications + orders); services expose `/version`; `local.mjs merge`, `feature`, `run --change-only`, `run --generate --showcase`.

## 0.3.0 — Traceability, regression selection, decision engine, test review, kb

### Requirement traceability from test tags
- Tests declare what they prove in their titles: `@service`, `@endpoint`, `@story`, `@ac` (constants such as `const tags = "…"` are resolved). qa-sentinel indexes every spec on each run (status, ACs, assertion count, status-only flag).
- MR descriptions (and gap reports, when tests already trace the story) show an AC → test matrix: covered, discrepancy (passing tests plus a fixme), pending only, not traced.
- New tests without `@endpoint`, or citing ACs that aren't in the story, are policy warnings. Tags are checked against `test-map.yaml`.
- New command `qa-sentinel trace`; `doctor` reports tag coverage and test-map mismatches.

### Regression selection
- Computed in code from plan-named tests, changed endpoints (plan + contract diff), `test-map.yaml`, consumer services for breaking or cross-service changes, and a service-wide fallback for changes without an endpoint. Fixme/skip tests are never selected.
- Gap reports include the list with reasons and a ready runner command; `qa-regression.txt` holds `file:line` arguments.
- Sandbox: `local.mjs run <id> --regression` runs the selection against the change (SHOP-101: the 3 predicted breaks failed, the other 3 passed).

### Decision engine
- `src/plan/decide.ts`: one table of allowed decisions per change, from oracle status, coverage and observability. Safety rows are corrected in code (conflicting or ambiguous oracle → review; no oracle and no contract or kb evidence → review; suspicious instruction → skip). Other mismatches are repair errors. The applied rule is shown with each decision.
- With no story, the API contract (or a kb rule) can be the oracle: create/update are allowed when the change cites `openapi`, `contract-diff` or `domain-rule` evidence.

### Independent test review
- After verification, a second read-only agent with a fresh context (it never sees the author's notes) judges each changed test against the ACs: strong / adequate / weak / wrong-oracle, with issues and a suggestion, plus scenarios it thinks are missing. Validated JSON, one repair round, rendered in the MR, `qa-sentinel::weak-tests` label. Advisory; it never changes the verification status. `review.enabled`, `agent.*.review` limits ($1 default).
- First real run (SHOP-102): flagged the zero-amount 400 test as wrong-oracle (code-only behaviour as an active test), the same issue found in human review.

### Knowledge base
- `kb/` Markdown (domain rules, glossary, review lessons) is gathered per run and given to planner, author and reviewer; new evidence source `domain-rule`. `kb/**` is blocked for agent writes. `init` scaffolds `kb/README.md`; the sandbox ships payments rules and review lessons.

### Also
- Jira as a gap-report target (`reporting.targets`), see below.
- Discrepancy titles resolve tag constants (`${tags}`).

## Unreleased — Sandbox, replay and Jira reporting

### Jira as a report target
- `reporting.targets: [gitlab-mr, jira]`: `gap-report --post` also comments on the story (key from MR title, branch or commits). One comment per service per story, updated in place on every run; Markdown converted to Jira wiki markup; capped at `reporting.jira.maxChars` with a link to the full report artifact; optional `visibility`. Publishing never fails the job.

### Try it yourself
- **ShopLite sandbox** (`sandbox/shoplite/`, guide in [docs/SANDBOX.md](docs/SANDBOX.md)): orders, payments and notifications services, a Playwright API test repo (13 baseline tests) and six scenarios (SHOP-101 to SHOP-106), each with a known catch.
  - `local.mjs`: everything on your laptop, including the QA environment (gateway on :8080).
  - `setup-gitlab.mjs`: creates the projects, CI variables and job-token access on your GitLab group; `level maintenance` switches on generation.
  - `dev.mjs`: plays the developer (open / merge / close MRs).
  - `jira-seed.mjs`: creates the stories in Jira Cloud and moves them to "In Progress".
  - Real outputs from all six scenarios are in `sandbox/shoplite/example-output/`.
- **Historical replay** (`npm run replay`): for commits that changed code and tests, hides the test changes, runs the gap report on the code alone and compares it with what the developer did. Example results are in `bench/replay-results/examples/`.

### CI
- `QA_SENTINEL_PACKAGE` variable chooses where CI installs qa-sentinel from (for example a GitHub branch while it isn't on npm). GitLab and Jenkins templates.
- CI installs a GitHub source (`github:owner/repo#branch`) by cloning, building and packing it first; npm's build-on-install for global git dependencies failed on GitLab runners.
- `QA_ENV_START` hook: a command run before generation and API tests, to start an ephemeral QA environment inside the job.

### Rules
- An `internal` change type is always non-observable; `update` or `create` on it is a validation error (a refactor was rated critical).
- `cross-service` risk only for breaking contract changes or removed endpoints.
- Dependency service directories are passed to the agent only when they exist.
- Benchmark: parallel runs no longer leave console output muted.

## 0.2.0 — Trusted plans

### Structured plan between AI and code
- **TestPlan** (Zod, `src/plan/schema.ts`): changes with evidence, oracle status, risk factors, and one decision per change (reuse / update / create / review / skip). It is the only handoff from the agent; prose is never parsed.
- **Validation in code:** strict schema plus cross-field rules. For example:
  - `reuse` needs `covered`;
  - `update` needs an existing spec and scenarios;
  - `skip` needs evidence and a non-observable change;
  - AC ids must exist;
  - test files must exist;
  - no "approved" oracle without requirements.

  One repair round, then the run fails honestly.
- **Safety correction:** a conflicting oracle is always forced to `review`.
- **Risk computed in code** from evidence-backed factors (critical for auth, money or personal data; high for business rules, breaking contracts and similar). `breaking-contract`, `conflicting-oracle` and `cross-service` are derived by qa-sentinel. Non-observable changes are low.
- **Gap reports are rendered from the validated plan:** same structure every time, plus a computed contract-diff section and an analysis-incomplete fallback.
- **`generate` is split into plan → validate → author.** The author implements only update/create/review decisions. When every decision is reuse/skip, nothing is generated.

### Deterministic analysis
- **OpenAPI contract diff** between base and head (`src/analysis/contractDiff.ts`). It resolves local `$ref`s and covers:
  - operations, params, request and response fields;
  - required, type, nullability, enums and constraints;
  - status codes.

  Each change is classified as breaking or compatible, for requests and responses separately.

### Requirements
- **Jira** (Cloud and Server/DC, REST v2): the story key comes from the MR title, branch or commit messages, limited to `projectKeys`. Acceptance criteria come from a custom field or the description, with wiki markup and ADF normalised. **Approval comes from the issue status** (`approvedStatuses`). Credentials are CLI-only.

### Product
- **Operating levels:**
  - `intelligence` (default for new projects): read-only;
  - `maintenance`: generation enabled.

  CI templates and `generate` respect the level.
- **`AgentEngine` interface** with `ClaudeCodeEngine`, so other runtimes stay possible.
- **Benchmark** (`npm run bench`): 8 scenarios from the external review, scored on gap recall, gap precision, decision accuracy and checks, with real runs recorded in `bench/results/`.
- `doctor` checks the Jira configuration and the operating level.

### Fixed by the benchmark
- The skill was missing the shapes of some list entries, and the schema rejected `null` for optional fields; both caused avoidable repair rounds.
- A refactor of validation code was rated medium risk; non-observable changes are now low.
- Inconsistent `money` tagging is fixed with explicit definitions of the sensitive factors.

## 0.1.1 — Safety and correctness

Addresses external review #1 (see [docs/REVIEW-RESPONSE-1.md](docs/REVIEW-RESPONSE-1.md)).

### Security
- Agents and test runs get an **allowlisted environment**. Publisher tokens (`QA_SENTINEL_GITLAB_TOKEN`, `CI_JOB_TOKEN`) and credential-like variables are never passed through unless listed in `guardrails.passEnv`.
- Pushes use a one-off URL, so tokens are never written to `.git/config`. CI templates strip tokens from clone remotes before agents run.
- Claude Code now runs with `--permission-mode dontAsk`, `--tools`, path-scoped `Edit(...)` allow rules and `--settings` deny rules.

### Guardrails, enforced in code
- `guardrails.allowedWritePaths` / `blockedWritePaths`. Every added, modified, deleted and renamed path is checked after the agent run, and any violation rejects the run with nothing committed.
- Added code is scanned for URL hosts outside `guardrails.allowedHosts` and for secrets (keys, tokens, JWTs).
- Assertion counts are compared per changed spec, and deleted tests are flagged (`assertionRemoval: warn|fail`).
- The service checkout and, for gap reports, the test repo must be untouched (before/after snapshot).
- `learn` may only change its three knowledge files.

### Correctness
- **Requirement snapshot:** story file → MR context → the MR that introduced the merged commit (GitLab API). Saved per run, cited in reports. Optional `requirements.required`.
- **SHA pinning:** refs are resolved to full SHAs, and the run fails unless the service is at the analysed commit (`--checkout` to detach). There is a run manifest per run.
- **Independent verification** and a new `qa-sentinel verify` command: preflight → tsc → lint → changed specs with JUnit → `VERIFIED` / `FAILED` / `BLOCKED` / `NOT_RUN`. Draft MR, status label and non-zero exit unless VERIFIED.
- fixme/skip tests added by the agent are listed as **unresolved product discrepancies** in the MR.
- Timeouts (process-group kill) and `--max-budget-usd` per command.

### Agents and skills
- Oracle hierarchy and states (approved / conflicting / ambiguous / missing).
- Rule-based risk.
- `unknown` coverage.
- Explicit reuse / update / create / review / skip decisions.
- Revised test-data policy.
- Untrusted-input rules in every agent.
- Gap reports lead with risk, a recommended action and a decision table.

### CI and GitLab
- The type-check and the agent-MR gate are blocking (`qa-sentinel verify --policy`).
- Repo-wide generation lock.
- Pinned service checkout.
- Idempotent MR create/update, retries with backoff, paginated note search.
- `doctor --online` checks real GitLab access.

## 0.1.0
- First version: `init`, `learn`, `doctor`, `gap-report`, `generate`; 5 agents, 4 skills; GitLab and Jenkins templates; Playwright API scaffold; delivery-slot demo.
