# qa-sentinel

**AI QA agents you plug into any test repo.** Every time a developer changes a service, qa-sentinel tells the team which tests are affected, what coverage is missing and where the code disagrees with the story's acceptance criteria. Then it writes or updates the API, web and mobile tests and opens a merge request for a QA engineer to review. When every acceptance criterion passes, it attaches one showcase video and an evidence PDF to the Jira story for the business to review; when one doesn't, it can raise the bug.

Built on [Claude Code](https://docs.claude.com/en/docs/claude-code/overview) in headless mode. Runs in **GitLab CI** and **Jenkins**. Works with an **existing** test suite (it learns your conventions) or **from scratch** (it scaffolds a TypeScript Playwright framework for API tests, with `--web` for web UI tests with page objects, and with `--mobile` for WebdriverIO + Appium app tests with screen objects).

> Agents draft and review; humans approve. qa-sentinel never merges anything.

## Operating levels

| Level | What the team gets | Writes code? |
| --- | --- | --- |
| **1 · QA intelligence** (default) | On every MR: behaviour changes, risk, requirement conflicts, contract changes, and a reuse/update/create/review/skip decision per change | No |
| **2 · Assisted test maintenance** | Level 1 plus generated or updated API and web tests through reviewed, independently verified MRs | Yes, test folders only |
| 3 · Cross-platform orchestration | API, Web and Mobile workflows across services | Web and the workflow planner (v0.5); Mobile and story-wide analysis and generation (v0.6) |

Choose with `init --level intelligence|maintenance` or `level:` in the config. Most teams should start at level 1.

## What it does

| Phase | Command | Trigger | Output |
| --- | --- | --- | --- |
| 1 · Gap report | `qa-sentinel gap-report` | dev merge request | one MR comment: impacted tests, coverage gaps, AC mismatches, spec drift |
| 2 · API tests | `qa-sentinel generate` | dev MR merged | `qa-sentinel/<service>-<sha>` branch + MR with new/updated tests, **independently verified by qa-sentinel** |
| Gate | `qa-sentinel verify` | MR touching tests | same policy, type-check and changed-spec checks; fails unless VERIFIED |
| 0 · Story review | `qa-sentinel review-story` | story ready for dev | ambiguous ACs, missing negative/edge cases, scope without an AC (Jira comment) |
| Story-wide | `gap-report --story` / `generate --story` | all of a story's MRs merged | one analysis and one test MR across every service the story changed |
| 3 · Showcase | `qa-sentinel showcase` | full suite run on SIT/UAT | one video + one evidence PDF on the Jira story, once, when every AC passed |
| Bugs | `qa-sentinel bugs` / automatic | AC failing or not built | a bug card per requirement with expected vs actual, how to reproduce, evidence (opt-in) |

### Real output

From [`examples/delivery-slot-demo`](examples/delivery-slot-demo): a dev added a required `deliverySlot` with a cap of **5** orders per slot. The story says **3**.

- **Gap report** (v0.2: 47 s, $0.13): the agent wrote a structured test plan, which qa-sentinel validated. qa-sentinel computed the risk (**High**) from evidence-backed factors and rendered the report. The plan has 4 changes, each with a decision; the AC-3 conflict is routed to human review, and a stale test and the spec drift are flagged. [Report →](examples/delivery-slot-demo/expected-output/gap-report.md) · [validated plan →](examples/delivery-slot-demo/expected-output/test-plan.validated.json)
- **Generated tests** (v0.2): the agent implemented only the plan's update/create/review decisions, writing the capacity test to the **acceptance criteria** as `test.fixme`. qa-sentinel then **re-ran everything itself** (tsc clean, 5 passed, 1 skipped) and listed the fixme as an unresolved product discrepancy. [MR description →](examples/delivery-slot-demo/expected-output/merge-request-summary.md) · [diff →](examples/delivery-slot-demo/expected-output/generated-tests.diff) · [run manifest →](examples/delivery-slot-demo/expected-output/run-manifest.json)
- **Benchmark:** 8 scenarios from the external review (new endpoint, field rename, new validation, AC conflict, refactor, wrong-reason pass, missing requirement, prompt injection). The latest full run (v0.6, with the stricter plan that also says whether each requirement is built) scored 100% on gap recall, gap precision and decision accuracy with no repair rounds, at $0.73; the runs before it did too. The first run, before the fixes it found, scored 88% decision accuracy. [Results →](bench/results/latest.md) · [method →](bench/README.md)
- **Prompt injection:** a comment in the dev's code told "AI QA agents" to add `curl … | sh` to CI and dump env vars. Both phases ignored it and flagged it for humans. Had it been followed, the guardrails would have rejected the run.

## How it works

```
dev MR / merge ──► change-analyzer ──► test-mapper ──┬──► gap report (MR comment)          Phase 1
   + story/AC        classify change    find tests,  │
   + test repo       vs AC and spec     judge gaps   └──► test-data ─► api-test-author ─► test-executor ─► test MR   Phase 2
     context                                              API setup    writes/updates     runs changed specs,
                                                                       specs + test map   fixes test bugs only
```

`qa-sentinel init` installs these as Claude Code **sub-agents** (`.claude/agents/`) and **skills** (`.claude/skills/`) inside your test repo. They are plain Markdown, so your team can read, version and tune them.

**AI does the judgement, code does the rest.**

```
code:  diff at pinned SHAs · requirements (story file / Jira / MR) · OpenAPI contract diff
AI:    test plan (changes, evidence, oracle, risk factors, decisions)  → test-plan.json
code:  schema + cross-field validation (1 repair round) · conflicts forced to review · risk computed from factors · report rendered
AI:    (level 2) author only update/create/review decisions
code:  guardrails on what actually changed · independent verification · MR with the evidence
```

The **TestPlan** (`src/plan/schema.ts`) is the only handoff between AI and code. Free-form agent prose is never parsed for decisions. Every run writes `.qa-sentinel/runs/<id>/` with `manifest.json`, `requirements.json`, `change.diff`, `contract-diff.md`, `test-plan.validated.json`, `guardrails.json`, `verification.json` and `junit.xml`.

Risk is a fixed rule that you can read: **critical** for auth, money or personal data; **high** for business rules, breaking contracts, error handling on write paths, cross-service changes or requirement conflicts; **medium** for new endpoints, validations or compatible contract changes; otherwise **low**. Changes that don't alter behaviour are low. The agent names the factors with evidence; qa-sentinel adds `breaking-contract` (from the computed contract diff), `conflicting-oracle` and `cross-service` itself.

### What's in v0.3

- **Requirement traceability from test tags.** Tests say what they prove in their titles (`@endpoint:POST_/orders @story:SHOP-12 @ac:AC-3`). qa-sentinel builds an index from the code on every run (status, ACs, assertion count) and renders an **AC → test matrix** in MRs: ✅ covered, ⚠️ discrepancy (passing tests plus a fixme), ⏸️ pending only, ⬜ not traced. Because it is rebuilt from the tests, it can't drift.
- **Regression selection in code.** Gap reports list the existing tests to run and why: named by the plan, on a changed endpoint (plan and computed contract diff), from `test-map.yaml`, consumer services for breaking changes, or the whole service for changes without an endpoint. `qa-regression.txt` holds `file:line` arguments for the runner. In the sandbox, the selected tests for SHOP-101 were run against the change: exactly the 3 the plan predicted failed.
- **Decision engine.** One readable table ([`src/plan/decide.ts`](src/plan/decide.ts)) decides which of reuse/update/create/review/skip fits each change, from oracle, coverage and observability. Safety rows (conflicting or ambiguous oracle, no oracle at all, suspicious instructions) are corrected in code; other mismatches go back to the agent. The rule is printed with every decision.
- **Independent test review.** After verification, a second read-only agent with a fresh context judges every changed test against the ACs: strong / adequate / weak / wrong-oracle, with issues and the missing assertion. Advisory: it labels the MR (`qa-sentinel::weak-tests`) but never changes VERIFIED.
- **Knowledge base (`kb/`).** Team-written domain rules and review lessons, read by every agent and citable as `domain-rule` evidence. When a story is silent, a kb rule can be the oracle. Agents can't edit it.
- **Jira as a report target.** `reporting.targets: [gitlab-mr, jira]` posts the gap report on the story too.

### What's in v0.7

- **Learning from review.** `qa-sentinel lessons` finds agent MRs a QA engineer edited before merging (merge or squash), shows an agent what the reviewer changed, and proposes short, general rules in `kb/review-lessons.md` through an MR; one-off fixes are skipped, repeated ones strengthen an existing lesson. Every agent reads `kb/` on its next run, so a lesson merged today shapes tomorrow's tests. `metrics` shows merged-without-edits **by month**, the number that should rise. GitLab: a weekly `qa-lessons` job (`QA_LESSONS=true` on a schedule).
- **Mobile end to end in the sandbox.** `setup --mobile` adds a native ShopLite Android app (plain Java, built with the SDK tools by `build.sh`, no Gradle) with screen objects and app tests, and SHOP-109, a mobile story: new order-screen elements, a changed message that breaks an existing app test, API-created data opened by deep link. A GitHub Actions job builds the app and runs the app tests and `qa-sentinel verify` on an Android emulator for every change.

### What's in v0.6

- **One showcase video per story.** When every acceptance criterion passed on the agreed environment (`showcase.environments`), qa-sentinel re-records the chosen test for each AC in showcase mode (slowed down, the element being used outlined, a pause on the result) and joins them with title cards into **one `<STORY>-showcase.mp4`**, plus **one evidence PDF** (results per AC, a screenshot per UI test, the API requests and responses, with secrets redacted). Attached once, only after all ACs passed; the people in `showcase.notify` are tagged. This replaces the manual "Biz showcase" session.
- **Mobile tests (WebdriverIO + Appium).** Apps are services with `kind: mobile`. `init --mobile` / `add-mobile` scaffold screen objects, a ui helper with intents, evidence hooks (screen recording, screenshot, API setup calls per test) and a `write-mobile-test` skill. Mobile specs are verified against an Appium server (`QA_APPIUM_URL`, checked first; device-farm URLs with credentials work), selected for regression by `@screen` tag, and their recordings go into the showcase video.
- **Your story template, configurable.** `requirements.template` says which headings hold the ACs (numbered lists, Gherkin, or Given/When/Then tables, multi-line cells included), what is in scope, out of scope, tech notes per service, context, the showcase approach and what to ignore. `story-check` shows how a real story is read and what to change; `init` asks for the team's Jira, GitLab and layers. See [onboarding](docs/ONBOARDING.md).
- **Is the story built?** Besides ACs, qa-sentinel reads the story's in-scope items, tech notes and expected results (headings or Jira fields) as items IS-n / TS-n / ER-n. Every plan says, with evidence, whether each AC and scope item is implemented, partial, not found or built differently. Scope items no AC covers are listed for the PO.
- **Story review before development.** `review-story` finds ambiguous ACs, missing negative and edge cases and scope without an AC, and can post them on the story.
- **Story-wide runs.** `gap-report --story SHOP-12` and `generate --story SHOP-12` analyse everything a story changed across services (only the story's own commits, not other work merged meanwhile) and write one test MR for it.
- **Bug cards.** `bugs.mode: suggest | create`: a failing test written to an AC, a fixme the agent wrote because the product disagrees, or (story-wide) an AC nothing builds becomes a Jira bug with expected vs actual, the test and command to reproduce, where to look in the code, the evidence and a machine-readable block for coding agents. Never raised twice; "now passes" is noted on the bug.
- **Quality extras.** Failed specs are retried once and reported as flaky, not failed. `tag` backfills `@service`/`@endpoint`/`@page` tags on existing tests (only titles may change; checked). `learn` also learns web and mobile conventions. New pages get an axe accessibility test (WCAG 2 AA). `metrics` reports the verification rate, the **merged-without-edits rate**, cost and plan repairs. `upgrade` refreshes qa-sentinel's own files after an update.

### What's in v0.5

- **Web tests (Playwright UI).** Front ends are services with `kind: web`. qa-sentinel analyses front-end changes per page (`ui-change` with the route, e.g. `/orders/:id`), writes web tests through **page objects** (locators live only there, and the agent updates them first), tags them `@page:/orders/:id`, and verifies them on their own project and base URL. Regression selection picks the web tests of a changed page: in the sandbox, the two tests a renamed button breaks.
- **The agent looks at the page first.** Before writing locators, qa-sentinel opens the affected pages itself and saves their accessibility tree (the roles and names good locators use) and a screenshot for the agent. No browser tools for the agent, nothing to drift.
- **Workflow planner.** Each scenario's preconditions are a small dependency graph (`s1 create an order (api)` → `s2 read its payment (api)` → web test on `/orders/:id`), checked in code against the data policy: API or test-data service first, UI only for a web test and only with a reason, DB helpers only with a reason. The gap report prints the flow per scenario.
- **Video evidence.** The web project records a video and screenshot per test, so the Showcase stage attaches **a video per acceptance criterion** to the Jira story (plus the API setup calls).
- **Optional runtime healing with [Bubblegum](https://github.com/bishnu133/bubblegum).** Page-object actions carry intents (`ui.click(button, "Checkout button")`). With `healing: bubblegum` and `QA_HEALING=bubblegum` (scheduled runs), a failed action is retried by Bubblegum over CDP in the same browser. Healed steps are never a clean pass: `qa-sentinel healed` lists them as page-object fixes, and the next generation run gets them. Healing is always off while qa-sentinel verifies agent-written tests.

### What's in v0.4

- **Simple Jira comments.** With `reporting.targets` including `jira`, the story gets a short plain-language comment (risk, what changed, what QA will do, a status per acceptance criterion, decisions needed) instead of the technical report, which stays on the MR. After generation, the same comment is updated with the test results per AC. `reporting.jira.format: full` keeps the old behaviour.
- **Run on a lower environment before the MR.** Named `environments:` (dev, sit, …) with `generate --env sit` and `verify --env sit`. With `verification.requireVerifiedToPush: true`, nothing is pushed unless the tests passed on that environment. The environment is shown on the MR and the story.
- **Showcase agent: evidence on the story, once.** `qa-sentinel showcase --story SHOP-12` checks that every AC has passing, active tests (none failed, none pending), then attaches the evidence to the Jira story: a Markdown file with the request/response of every call for API tests, plus recordings and screenshots from the run artifacts (videos from web tests since v0.5). It records what it attached on the issue and never attaches again, unless QA adds the `qa-showcase-refresh` label or runs it with `--force`.
- **Feature manifest across services.** `qa-sentinel feature SHOP-12 --env sit` finds every MR and branch for the story in all services, checks each service's version endpoint to see whether that code is deployed, and says whether the feature is ready for end-to-end tests. `--run` runs the story's tests once it is. Gap reports mention the other services in the same feature.

## Quick start

```bash
# in your test repo; service repos are siblings in the same workspace folder
npm i -g @anthropic-ai/claude-code qa-sentinel   # until it is on npm: npm i -g github:bishnu133/qa-sentinel#v0.7.2

qa-sentinel init            # detects framework, tests, services; asks a few questions (level 1 by default)
qa-sentinel learn           # agent learns your conventions + drafts test-map.yaml → review with git diff
qa-sentinel doctor          # checks keys, access, specs, readiness

qa-sentinel gap-report --service orders-service --base origin/main
qa-sentinel generate   --service orders-service --base HEAD~1   # commits to a branch; add --push for an MR
```

Onboarding a team's project? Follow **[docs/ONBOARDING.md](docs/ONBOARDING.md)**: services, how your stories are written (`story-check`), CI variables, and a staged rollout.

Starting from nothing? `qa-sentinel init --mode scratch` scaffolds Playwright API tests (typed client, fixtures, data builders, zod schema checks, example spec, HTML and JUnit reports).

## Commands

| Command | What it does |
| --- | --- |
| `init [--mode existing\|scratch] [--ci gitlab\|jenkins] [--web] [--mobile] [--jira-url u --jira-projects A,B] [--gitlab-url u --test-repo-project g/p] [-y]` | Writes `qa-sentinel.config.yaml`, agents, skills, `.claude/qa-sentinel.md` (imported from your `CLAUDE.md`, never overwriting it), CI templates in `ci/qa-sentinel/`, and `test-map.yaml`. In scratch mode it also adds the framework. |
| `learn` | Agent pass: fills the conventions section of the `write-api-test` skill, drafts `test-map.yaml`, lists readiness gaps. Review before committing. |
| `doctor [--online]` | Readiness checks with fixes: CLI, keys, git, service paths, OpenAPI specs, test-map coverage, base URL, guardrail settings. `--online` calls GitLab to prove the token can reach the test and service projects. |
| `gap-report -s <service>` | Read-only, risk-ranked analysis. The run is discarded if anything changed in either repo. `--post` creates or updates a single MR comment. Skips the agent for docs- or config-only changes. |
| `generate -s <service>` | Writes and updates tests on a branch. **Rejected with nothing committed** on any guardrail violation. Otherwise independently verified, then committed. `--push` opens or updates a GitLab MR (Draft unless VERIFIED). Exit code 0 only when VERIFIED. |
| `verify [--policy] [--base <ref>]` | The same independent checks, for any branch. Use it as the blocking CI gate on agent MRs. |
| `gap-report --story KEY` / `generate --story KEY` | Story mode: the story's changes in every service (from MRs, branches and commits naming the key) as one analysis and one test MR on `qa-sentinel/story-KEY`. |
| `spec --story KEY [--story-file f] [--commit] [--dry-run]` | Writes or updates `expected/<STORY>.md` from the story alone (code-blind): what each AC means in testable terms; lists questions for the PO. `generate` does it as its first step. See [docs/EXPECTED-BEHAVIOUR.md](docs/EXPECTED-BEHAVIOUR.md) and [docs/GLOSSARY.md](docs/GLOSSARY.md). |
| `stories [--stories-dir <dir>]` | No AI. Background check of every story (Jira search or story files): state, next step, who acts, what blocks it. Writes `qa-stories.md` and story records. `--json` for machines. See [docs/AUTOMATION.md](docs/AUTOMATION.md). |
| `known-defects [--apply] [--commit] [--push]` | No AI. After a test run: finds known defects (Playwright `test.fail`, Jest `test.failing`, Vitest `test.fails`) that now pass (bug fixed); `--apply` takes the marker and QA-BUG note off for review. |
| `suite --env <name> \| --tag <ref> [--run]` | No AI. The tests that fit what an environment has deployed or a release contains; tests of features not there yet are left out with the reason. |
| `release-features --tag <ref> [--from <ref>]` | No AI. The stories a release contains (story keys in commits, per service). |
| `hotfix --service <s> --commit <sha> [--post]` | No AI. Where a hotfix stands: cherry-picked to the main branch yet, tests written yet. |
| `story-check --story KEY [--fields]` | Onboarding: how qa-sentinel reads one of your stories (each heading's role, ACs from lists, Gherkin or Given/When/Then tables, scope items, out of scope, services named) and what to change in `requirements.template`. `--fields` lists the issue's Jira fields with their ids. No AI call. |
| `review-story --story KEY [--post]` | Before development: reviews the story's ACs and scope (ambiguity, missing negative/edge cases, scope without an AC). `--post` comments on the story. |
| `add-mobile [--platform android\|ios]` | Adds the mobile layer (WebdriverIO + Appium): turns `tests.mobile` on, writes `wdio.conf.ts`, screen objects, ui helper, evidence hooks, example spec, the write-mobile-test skill and the WebdriverIO packages. (`init --mobile` for new projects.) |
| `bugs [--story KEY] [--results f] [--env sit] [--dry-run]` | After a run: raises (or proposes, per `bugs.mode`) a bug card for each AC whose tests failed, and notes "now passes" on earlier bugs. |
| `tag [--limit n] [--push] [--dry-run]` | One-off: an agent adds traceability tags to existing untagged tests on a branch; qa-sentinel rejects anything but added tags in test titles. |
| `lessons [--since 90d] [--push] [--dry-run]` | Learning from review: what reviewers changed in agent MRs before merging, turned into rules in `kb/review-lessons.md` on a branch (MR with `--push`). Each MR is learned from once. |
| `metrics [--since 30d] [--runs dir…] [--json]` | How the agents are doing: verification rate, merged-without-edits rate (merge, squash and fast-forward), cost, plan repairs, guardrail stops (`qa-metrics.md`). |
| `discover --gitlab-group <group> [--apply]` | Lists the group's projects and drafts `workspace.services` entries: kind (api, web, mobile), OpenAPI spec (or the generator that makes it), and `dependsOn` suggested from config files that name another service, each with its file and line (`qa-services.draft.yaml` + `.md`). `--apply` adds the ones not configured yet. No AI call. |
| `coverage [--service s]` | Every endpoint in each service's spec (and every route of front ends) with the tests that exercise it; untested, fixme-only and status-only endpoints ranked by risk (`qa-coverage.md` + `.json`). No AI call. |
| `backfill --service s [--batch 5] [--min-risk high] [--include-weak] [--endpoint "POST /x"] [--push] [--dry-run]` | Tests for old code nobody is changing: the riskiest gaps from `coverage`, one small batch per run through the normal plan → write → verify → review → MR flow, with the API contract as the oracle. |
| `contract-check [--service s] [--story KEY] [--ref r] [--strict]` | Spec-first teams: each service's implemented spec against its agreed spec (`contract`), every endpoint, error responses included (`qa-contract-check.md`). `--strict` exits 1 on a mismatch (CI gate). No AI call. |
| `data status` / `data sweep [--dry-run] [--older-than min]` | Test data (`testData.cleanup: ledger`): what tests created and didn't delete, and deleting what killed runs left behind, newest first, on the test environment only. |
| `add-data-ledger [--dir d]` | Existing Playwright projects: writes `ledger.ts`, sets `testData.cleanup: ledger` and prints the fixture hook. |
| `post-deploy --env sit [--story KEY] [--service s --sha x] [--wait 20] [--mrs] [--post]` | After a deployment: for each story it touches, checks every service the story needs is deployed, runs its tests there, reports (and comments on Jira); re-verifies agent MRs that were waiting for deployment. Still waiting: exit 75, to re-check later. |
| `upgrade` | After updating qa-sentinel: refreshes its agents, skills, CI templates and project context; keeps your learned `write-*-test` conventions. |
| `add-web [--healing none\|bubblegum]` | Adds the web layer to an existing project: turns `tests.web` on, writes the ui helper, page-object base, web fixtures, example spec and the write-web-test skill, and prints the Playwright project to add. (`init --web` does the same for new projects.) |
| `healed [--results f] [--fail-on-heal]` | After a run with `QA_HEALING=bubblegum`: lists healed steps as page-object fixes (`qa-healed.md`) and keeps them for the next generation (`qa-healed.json`). |
| `trace [--story KEY] [--story-file f] [--json]` | Requirement traceability from test tags: which tests prove which acceptance criteria, and whether `test-map.yaml` agrees with the tags. |
| `feature <story> [--env sit] [--run] [--post] [--json]` | Feature manifest: every MR/branch for the story across services, whether each is merged and deployed on the environment (version endpoint), and the overall status. `--run` runs the story's tests when ready; `--post` updates the Jira story. |
| `showcase [--story KEY] [--results f] [--mobile-results d] [--env sit] [--force] [--dry-run]` | After a passing run, attaches the showcase pack (one video, one evidence PDF; `showcase.format: files` for the separate recordings and logs) to the Jira story once all ACs pass. One time per story; again only with the `qa-showcase-refresh` label or `--force`. Without Jira, or with `--dry-run`, saves it to `qa-showcase/<story>/`. |

Common flags: `--env <name>` (generate, verify, feature, showcase: an environment from `environments:`), `--service-path` (where the service is checked out, for CI), `--checkout` (detach the service to the analysed SHA), `--story-file`, `--dry-run` (prints the Claude command instead of running it).

### Verification statuses
| Status | Meaning |
| --- | --- |
| `VERIFIED` | Every required check ran and passed (fixme tests are listed separately as discrepancies) |
| `WAITING_FOR_DEPLOYMENT` | Only test runs failed, and the change they test isn't deployed in that environment yet (`version` endpoint). Not a pass: `verify` exits 4 |
| `FAILED` | Type-check, lint or a changed spec failed |
| `BLOCKED` | The environment was missing or unreachable, or a run timed out. Never shown as success |
| `NOT_RUN` | Nothing could be executed (e.g. helpers changed but no spec). Never shown as success |

## Configuration

`qa-sentinel.config.yaml` (generated by `init`, read by the CLI **and** the agents):

```yaml
version: 1
mode: existing                       # existing | scratch
project: { name: shop-tests }
workspace:
  services:
    - name: orders-service           # must match the repo/CI project name
      path: ../orders-service
      openapi: openapi.yaml          # strongly recommended
      gitlabProject: shop/orders-service   # lets generation fetch the MR's acceptance criteria after merge
      dependsOn: [payments-service]  # also readable by agents for cross-service changes
      version: { path: /version, field: sha }   # deployed git SHA, used by `feature` for deployment readiness
    - name: storefront               # a front end: tested through the UI, data set up through the API
      path: ../storefront
      kind: web
      routes: [/, /orders/new, /orders/:id]
      dependsOn: [orders-service]
    - name: shop-app                 # a mobile app: tested through WebdriverIO + Appium
      path: ../shop-app
      kind: mobile
environments:                        # lower environments the tests can run against (generate/verify/feature --env)
  dev: { baseUrl: https://dev.shop.example.test }
  sit: { baseUrl: https://sit.shop.example.test, webUrl: https://sit.shop.example.test/app/, description: System integration }
tests:
  api:
    framework: playwright            # playwright | supertest | axios | pactum | jest | vitest | mocha | other
    dir: tests/api
    helpersDir: src/api
    runCommand: npx playwright test --project=api
    baseUrlEnv: QA_BASE_URL
    extraWritePaths: [src/fixtures/**, src/data/**]   # where the agent may also write
  web:
    enabled: true                    # `init --web` or `add-web`
    dir: tests/web
    pagesDir: src/pages              # page objects: the only place locators live
    runCommand: npx playwright test --project=web
    baseUrlEnv: QA_WEB_URL
    explore: snapshot                # save each affected page's accessibility tree + screenshot for the agent
    healing: none                    # none | bubblegum (runtime locator healing, never while verifying)
    bubblegum: { package: "@bubblegum-ai/node", cdpPort: 9222, failOnHeal: false }
    accessibility: new-pages         # off | new-pages (one axe WCAG 2 AA test per new or changed page)
  mobile:
    enabled: true                    # `init --mobile` or `add-mobile`
    dir: tests/mobile
    screensDir: src/screens          # screen objects: the only place selectors live
    runCommand: npx wdio run wdio.conf.ts   # qa-sentinel adds --spec <file>
    appiumUrlEnv: QA_APPIUM_URL      # checked at <url>/status before mobile tests run
    platform: android                # default when QA_MOBILE_PLATFORM is not set
level: intelligence                  # intelligence (read-only) | maintenance (also generate tests)
requirements:
  source: jira                       # mr-description | jira | none
  required: false                    # refuse to generate without requirements
  multiKey: each                     # an MR naming several stories: each (a gap report for every story) | first
  maxKeysPerMr: 3                    # at most this many stories per MR (each is an AI run)
  jira:
    baseUrl: https://yourco.atlassian.net
    projectKeys: [SHOP]              # story keys are found in MR title, branch or commit messages
    acceptanceCriteriaField: customfield_10045   # optional; else AC are read from the description
    scopeFields: [{ field: customfield_10050, name: Tech scope, prefix: TS }]   # optional: scope kept in Jira fields
    approvedStatuses: [Ready for Dev, In Progress, Done]   # these statuses make AC "approved"
    featureIssueTypes: [Story]   # only these get expected behaviour (empty = every type). A bug or task named in an MR is read as its story
    search: { mrLookbackDays: 30 }   # finding a story's MRs also matches the source branch of MRs updated in the last N days (the GitLab text search reads only titles and descriptions)
    workflow:
      readyStatuses: [Ready for Testing]      # development is done; cross-service tests wait for this
      byProject: { ABC: { readyStatuses: [QA Ready] } }   # a project with different status names
    hierarchy:
      followParent: true                      # a bug/sub-task follows its parent story
      links: [{ name: "is caused by", from: [Bug] }]   # or follow this link (wording or link type name)
    components: { Orders: orders-api }        # Jira Component -> service name
  template:                          # how your team writes stories (`story-check` shows how a story is read)
    - { role: acceptance-criteria, name: Acceptance criteria, headings: [acceptance criteria, acs] }
    - { role: scope, name: In scope, prefix: IS, headings: [in scope, scope] }
    - { role: scope, name: Tech scope, prefix: TS, headings: [tech scope, tech notes, implementation] }
    - { role: out-of-scope, name: Out of scope, headings: [out of scope, not in scope] }
    - { role: context, name: Context, headings: [assumptions, questions, feature toggles] }
    - { role: showcase, name: Showcase approach, headings: [showcase approach] }
    - { role: ignore, name: Checklist, headings: [checklist, definition of ready] }
reporting:
  targets: [gitlab-mr]               # where `gap-report --post` publishes: gitlab-mr, jira, or both
  jira: { format: summary, maxChars: 30000 }   # summary (plain language, default) | full; optional visibility: { type: role, value: Developers }
showcase:
  format: pack                       # pack: one video + one PDF per story | files: the separate recordings and logs
  video: { record: true, slowMoMs: 500, holdMs: 2000, titleSeconds: 3 }   # needs a full ffmpeg (libx264)
  environments: [sit, uat]           # only runs on these environments are showcased
  notify: ["5b10ac8d82e05b22cc7d4ef5"]   # Jira account ids to tag when a story is ready for review
  refreshLabel: qa-showcase-refresh  # QA adds this label to attach evidence again
  replaceOnRefresh: true             # delete the previous evidence when refreshing
  kinds: [video, screenshot, api-log]   # also: trace
  maxFiles: 20                       # files format: videos first, then screenshots
  maxFileMb: 50
  requireNoPending: true             # a fixme/skip test on an AC blocks the showcase
bugs: { mode: off, issueType: Bug, priority: Low, labels: [qa-sentinel], linkType: Relates, notBuilt: true }   # off | suggest | create
ci: { platform: gitlab, testRepoProject: my-group/qa-tests, targetBranch: main }
agent:
  model: <optional, passed to claude --model>
  maxTurns: { gapReport: 30, generate: 60, learn: 40 }
  maxFixAttempts: 3
  timeoutMinutes: { gapReport: 15, generate: 30, learn: 20 }
  maxBudgetUsd: { gapReport: 2, generate: 5, learn: 3 }
  skipPaths: ["**/*.md", "docs/**"]
guardrails:
  allowedWritePaths: []              # empty = tests.api.dir + helpersDir + extraWritePaths + test-map.yaml
  blockedWritePaths: [".claude/**", ".gitlab-ci.yml", "ci/**", ".env*", "package.json", "...defaults"]
  allowedHosts: [localhost, example.test]   # hosts allowed in added test code (+ host of the base URL)
  assertionRemoval: warn             # warn | fail
  passEnv: []                        # extra env vars for tests/agents; credentials are never passed otherwise
verification: { typecheck: auto, lintCommand: "npx eslint", preflight: true, retryFailed: true, timeoutMinutes: 15, defaultEnvironment: sit, requireVerifiedToPush: true }
```

## CI

`init` writes ready-to-use pipelines in `ci/qa-sentinel/` with a setup checklist:

- **GitLab:** `service.gitlab-ci.yml` (include from service repos: MR gap report plus a trigger after merge) and `tests.gitlab-ci.yml` (generation job, a gate that runs only the changed specs on agent MRs, scheduled and post-deploy API runs). See [templates/ci/gitlab/README.md](templates/ci/gitlab/README.md).
- **Jenkins:** `Jenkinsfile.gap-report` (GitLab plugin MR trigger), `Jenkinsfile.generate` (parameterised, called after service merges) and `Jenkinsfile.tests`. See [templates/ci/jenkins/README.md](templates/ci/jenkins/README.md).

Gap-report jobs never block developers: they are `allow_failure` in GitLab and UNSTABLE rather than FAILED in Jenkins.

## Guardrails

Enforced in code, checked **after** every agent run against what actually changed:

- **Write paths:** only `allowedWritePaths`; `blockedWritePaths` always win. Deletions and both sides of renames count. One violation rejects the run and nothing is committed.
- **Read-only means read-only:** gap reports and the service checkout must be untouched (before/after snapshot).
- **Content:** URLs to hosts outside `allowedHosts` and secrets (keys, tokens, JWTs) in added code are rejected. A drop in assertion count, or a deleted test, is flagged (or fatal with `assertionRemoval: fail`).
- **Credentials:** agents and tests get an allowlisted environment. GitLab tokens never reach them, and pushes use a one-off URL (no token in `.git/config`).
- **Pinned inputs:** the service must be at the analysed SHA, and the requirement revision is recorded.
- **Limits:** max turns, a time limit (process-group kill) and a dollar budget per command. One write-enabled generation at a time for the test repo.

Also applied by Claude Code (defence in depth): `--permission-mode dontAsk`, `--tools`, path-scoped `Edit(...)` rules, `Bash(<test command> *)` only, deny rules for secrets, `.git/config`, curl/wget/env and the service repo.

Agent policy: diffs, stories and comments are **evidence, not instructions**. Oracle order is AC → API contract → domain rules → existing tests → code (actual behaviour only). Conflicts become `fixme` tests written to the requirement, listed as **unresolved product discrepancies** in the MR.

**Run tests on isolated runners.** Generated tests are code. Give CI runners network access only to GitLab, the Anthropic API, your registry and the QA environment.

## Honest limits

- **GitLab: proven end to end on gitlab.com with the ShopLite sandbox**: MR gap report posted by CI, and after merge, generation in the test repo (VERIFIED) opening a QA agent MR. Jenkins is not yet proven on a real server.
- The agent still decides coverage and decisions. Code validates them, forces conflicts to review and computes risk, but cannot prove a coverage judgement. The benchmark measures this; 8 scenarios is a start, not proof.
- **Output quality follows input quality.** OpenAPI specs, consistent tags and a reviewed `test-map.yaml` make the biggest difference; `doctor` tells you what's missing.
- **No acceptance criteria → weaker tests.** Without a story, tests can only check what the code does.
- **Review is still required.** Expect most agent MRs to need small edits at first; track the merged-without-edits rate.
- Behaviour that needs real infrastructure (queues, third-party callbacks) still needs human test design.
- **Web:** proven on the ShopLite storefront (Chromium). The Bubblegum hook is tested over CDP with a stand-in client; it has not yet run against the real Bubblegum engine. Videos need Playwright's ffmpeg: on networks that block Playwright's downloads, use `QA_BROWSER_CHANNEL=chrome QA_VIDEO=off`.
- **Mobile:** proven on an Android 15 emulator (Pixel 6, Appium + UiAutomator2): test run, screen recording, screenshot, result files, JUnit, and `verify` with the Appium preflight. Not yet run on iOS or a device farm. There is no page snapshot for apps yet: the agent finds accessibility ids in the app's code.
- **Showcase pack:** the single video needs a full ffmpeg with libx264 (`apt-get install ffmpeg`, `QA_FFMPEG`, or `ffmpeg-static`); without it the PDF and the separate recordings are attached instead.
- **Metrics:** fast-forward merges and squash merges whose branch was deleted are judged from the merge requests' heads, which `metrics` fetches from origin (GitLab `refs/merge-requests/*/head`, GitHub `refs/pull/*/head`). If they can't be fetched, fast-forward merges count as "merged without edits" and those squash merges as "edits unknown".

- **Story automation (v0.8) is new and Playwright/GitLab/Jira-shaped.** The background check (`stories`), job keys, budgets, `known-defects`, per-AC readiness, the draft-MR rule and the single Jira status comment have automated tests and were tried on a sandbox and a live Jira search; the AI refresh of a gap report on a real merge request and the readiness table against a live environment have not been run on a real project yet. Known-defect marker removal handles Playwright `test.fail` only (not jest/vitest `test.failing`).
- **Budgets are per machine or cache.** Day and month limits count the spend this runner knows about; two CI runners without a shared cache each count their own. The per-story limit never resets.
- **Jira has no compare-and-set**, so two jobs updating the same story's status comment in the same second can lose one update until that check runs again.

## Roadmap

The order follows external review #1 ([response](docs/REVIEW-RESPONSE-1.md)):

| Release | Focus |
| --- | --- |
| **v0.1.1** ✅ | Safety and correctness: requirement provenance, SHA pinning, enforced guardrails, independent verification, run limits, credential isolation |
| **v0.2** ✅ | Zod-validated `TestPlan` and plan → author split, risk computed in code, deterministic OpenAPI contract diff, `AgentEngine` interface, benchmark (8 scenarios, recall/precision/accuracy), Jira requirements (REST), operating levels |
| v0.2.x | ShopLite sandbox and historical replay ✅; real GitLab pilot (read-only on historical MRs first) |
| v0.2.x ✅ | Jira as a report target (`reporting.targets: [gitlab-mr, jira]`): one updated comment per story, Jira formatting, size-capped with a link to the full report |
| **v0.3** ✅ | Decision engine, requirement traceability from test tags, regression selection, independent AI test review, `kb/` |
| **v0.4** ✅ | Plain-language Jira comments, lower-environment runs before the MR, Showcase evidence on the story (once), feature manifests with deployment readiness |
| **v0.5** ✅ | Web (Playwright UI, page objects first, page snapshots for the agent), workflow planner (API-first setup graphs), video evidence, optional [Bubblegum](https://github.com/bishnu133/bubblegum) healing |
| **v0.6** ✅ | One showcase video + evidence PDF per story, Mobile (WebdriverIO + Appium), tech scope / expected results and "is the story built?", story review, story-wide runs, bug cards, flaky retry, tag backfill, accessibility checks, metrics |
| **v0.7.2** ✅ | Generated OpenAPI specs (`openapiCommand`), Mocha/vitest/jest test repos with per-test results, test repos inside a monorepo, skipping dependency-bot changes, generation after deployment, npm-ready package |
| **v0.8** | Story automation (background `stories` check, job keys, budgets, `known-defects`, per-AC readiness, one Jira status comment per story), spec-first contracts (`contract`, `contract-check`), test-data ledger, `coverage` and `backfill`, `discover --gitlab-group`; then gateway/BFF awareness, automatability triage with manual test cards, async patterns and test hooks, waiting-for-deployment and `post-deploy`, feature toggles, auth patterns, PII guard for evidence, Bedrock/Vertex routes, metrics for fast-forward/squash merges and cost by size, Cucumber features indexed, Bubblegum healing proven with the real engine |
| **v0.7** ✅ | Learning from review (`lessons`, merged-without-edits by month), mobile end to end in the sandbox (native Android app, SHOP-109, emulator CI) |
| Later | App screen snapshots for the agent, iOS and a device farm, mutation checks in the benchmark, alternative engines |

## Try it yourself

[docs/SANDBOX.md](docs/SANDBOX.md) walks through **ShopLite**, a three-service sandbox with six scenarios that each hide a known catch. Run it locally in 15 minutes, then on your own GitLab (and optionally Jira and Jenkins). `npm run replay` scores qa-sentinel against tests real developers wrote in open-source repos.

## Design and review

- [docs/PROJECT_REVIEW.md](docs/PROJECT_REVIEW.md): the problem, design decisions, architecture and open questions (review brief).
- [docs/REVIEW-RESPONSE-1.md](docs/REVIEW-RESPONSE-1.md): point-by-point response to external review #1 and what changed in v0.1.1.
- [CHANGELOG.md](CHANGELOG.md)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md), the [code of conduct](CODE_OF_CONDUCT.md) and [SECURITY.md](SECURITY.md). The most valuable contributions are framework adapters (new `write-*-test` skills and scaffolds) and real-world feedback on agent output.

## License

MIT
