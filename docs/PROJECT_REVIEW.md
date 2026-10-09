# qa-sentinel – Project Review Brief

> **Purpose of this document:** a self-contained brief for an external reviewer (human or AI) who has not seen our earlier discussions. It explains the problem, the approach, the architecture, what is built and verified, what is not, and the specific questions we want feedback on.
>
> **Status:** v0.1.0, pre-release. Not yet published to npm. Not yet run in a real GitLab/Jenkins pipeline.
> **Repo:** https://github.com/bishnu133/qa-sentinel · **License:** MIT · **Date:** October 2026

---

## 1. The problem

On teams with a microservice architecture, developers change services faster than QA can keep test suites up to date. Typical symptoms:

- A dev PR changes an API contract or a validation rule, and nobody notices that existing tests are now wrong, or that the new behaviour has no tests.
- Gaps are found late, in regression or after release.
- QA spends time on mechanical work, such as updating specs for a renamed field, instead of test design.
- Acceptance criteria and implementation drift apart without anyone noticing. For example, the story says "max 3" and the code allows 5.

The team context that started this:

- Web, API and mobile UI tests, all written in **TypeScript**.
- A **microservice** application, with all service repos available in one workspace.
- Mobile tests often need setup done first on the web portal or through the API.
- Tests must run in **CI**. **GitLab CI and Jenkins** are the first targets.

## 2. The goal

An **open-source, plug-in tool** that any team can add to an existing test repo, or use to start a new one. After running a few commands and filling in config and access, the team gets AI agents that:

1. **Watch** service code changes, through CI triggers on merge requests and merges.
2. **Report** which tests are affected, which coverage is missing, and where code and acceptance criteria disagree.
3. **Write or update** test files, plus the helpers and test data they need, and open a merge request for a human to review.

**Non-goals:** replacing QA engineers, merging anything automatically, or being a test runner or framework itself.

## 3. Core design decisions (and why)

| # | Decision | Rationale | Alternative considered |
| --- | --- | --- | --- |
| D1 | **Event-driven** (CI triggers on MR/merge), not an always-on listener | Cost is predictable, every run traces to one change, and review happens at the natural point | A daemon polling repos: more cost, harder to trace |
| D2 | **Claude Code in headless mode** (`claude -p`) is the agent engine | Mature agent loop, file and search tools, sub-agents, skills, permission controls. We write prompts, not an agent framework | Raw API plus our own tool loop; Claude Agent SDK (possible later) |
| D3 | **Multiple single-purpose sub-agents** with JSON handoffs | Each prompt is small and testable; failures are easy to localise | One large "write tests" prompt |
| D4 | **Agents, skills and conventions are plain Markdown in the test repo** (`.claude/`) | Versioned, reviewable and team-editable. No hidden prompts | Prompts bundled inside the npm package |
| D5 | **Acceptance criteria outrank code** | Tests generated from code alone encode current behaviour, including bugs (the "oracle problem") | Generate tests from the diff only |
| D6 | **Humans approve everything.** Agents push only to `qa-sentinel/*` branches and open MRs | Trust, accountability, and review as the quality gate | Auto-merge when tests pass |
| D7 | **Rollout: read-only gap report first, then API, then Web, then Mobile** | Low risk and immediate value build trust; API is the most deterministic layer | Generating all layers at once |
| D8 | **Two modes: `existing` and `scratch`** | Most teams have suites; new projects need a framework to start from | Supporting only greenfield projects |
| D9 | **No vector DB or RAG.** Agents search the repos directly (grep/read) | Always current and reviewable, with no index to maintain | Embedding the codebase |
| D10 | **Bubblegum** (our self-healing locator library) is an *optional* Web/Mobile adapter, not a core dependency | v1 is API-only; Bubblegum's npm client is still in progress; it solves runtime healing, not generation | Making it a hard dependency |
| D11 | **Test data is created through APIs, never through UI steps** | Fast and stable, and mobile tests can reuse the same helpers | UI-driven setup |

## 4. How it works

### 4.1 In one paragraph
A developer opens a merge request in a service repo. CI runs `qa-sentinel gap-report`, which collects the diff, the story or acceptance criteria and the test repo context. It then runs Claude Code headless with **read-only** tools. Sub-agents classify the change, find the tests that cover it, and post **one MR comment**. After the merge, CI triggers `qa-sentinel generate` in the test repo. That run writes or updates API tests, runs **only those specs** against the QA environment, fixes its own test-side mistakes, commits to a branch and opens a test MR for QA review.

### 4.2 Flow

```
 Dev MR / merge ─┐
 Story / AC ─────┼─► Change Analyzer ─► Test Mapper ─┬─► Gap report (MR comment)                    ← Phase 1
 Test repo KB ───┘   what changed?      which tests? └─► Test Data ─► API Test Author ─► Executor ─► Test MR ← Phase 2
                     AC mismatch?       what's missing?   setup via API  write/update      run, fix     human review
                                                                         specs + map       test bugs
```

### 4.3 The agents (`templates/agents/*.md`, installed into `.claude/agents/`)

| Agent | Tools | Input → Output | Key rules |
| --- | --- | --- | --- |
| **change-analyzer** | Read, Grep, Glob | diff + story + spec → JSON list of changes (`new-endpoint`, `contract-change`, `validation-change`, `business-rule`, `error-handling`, `removed`, `internal`), AC mismatches, spec drift | file:line evidence for every claim; never invent endpoints |
| **test-mapper** | Read, Grep, Glob | changes + `test-map.yaml` + tests → coverage per change (`covered` / `partial` / `missing` / `outdated`) and missing scenarios | a matching file name is not coverage: it must read the assertions |
| **test-data** | + Edit, Write | scenarios → precondition plan and API-based setup helpers | no UI setup; unique data per run |
| **api-test-author** | + Edit, Write | gaps → new or updated specs, `test-map.yaml` updates | follows the `write-api-test` skill; writes to the AC; mismatches become `fixme` tests; never silently weakens assertions |
| **test-executor** | + Bash (restricted) | changed specs → run results; fixes test bugs (max N attempts) | labels each failure `test-bug` / `environment` / `possible-product-bug`; never "fixes" a test to match buggy behaviour |

Orchestration lives in **skills** (`templates/skills/`):

- `qa-gap-report`: analyzer → mapper → fixed report format (read-only).
- `generate-api-tests`: analyzer → mapper → test-data → author → executor → self-review of the diff → MR summary.
- `write-api-test`: the project's test conventions (in scratch mode it ships with conventions; in existing mode `learn` fills it).
- `learn-conventions`: onboarding. Learns conventions from existing tests, drafts `test-map.yaml`, lists readiness gaps.

### 4.4 The CLI (`src/`, about 1,400 lines of TypeScript)

| Command | What it does |
| --- | --- |
| `init` | Detects the framework, tests, CI and sibling service repos (with OpenAPI specs). Writes `qa-sentinel.config.yaml`, agents, skills, `.claude/qa-sentinel.md` (imported from the team's `CLAUDE.md`, never overwriting it), CI templates and `test-map.yaml`. With `--mode scratch` it also scaffolds a Playwright API framework. |
| `learn` | Agent pass that fills the conventions section of the `write-api-test` skill and drafts `test-map.yaml`. A human reviews the git diff. |
| `doctor` | Readiness checks with fixes: CLI, keys, git, service paths, OpenAPI specs, test-map coverage, base URL, GitLab token. |
| `gap-report` | Builds the run context (`.qa-sentinel/runs/<id>/`: `context.json`, `change.diff`, `story.md`) and runs Claude with read-only tools. Skips docs- or config-only changes **without calling the LLM**. `--post` upserts a single MR comment, identified by a hidden marker. |
| `generate` | Same context, write-enabled tools, runs on a `qa-sentinel/<service>-<sha>` branch. Commits only test changes (run artifacts and reports are filtered out). `--push` opens a GitLab MR labelled `qa-agent`. |

**Tool restrictions passed to Claude Code** (`--allowedTools`):
- gap-report: `Read, Grep, Glob, Task, Agent`
- generate: the above plus `Edit, Write, Bash(<configured test command>:*), Bash(npx tsc --noEmit:*), Bash(npx eslint:*), Bash(git status:*), Bash(git diff:*)`

### 4.5 Knowledge base: what the agents "know"

All of it is plain files in git:

| Layer | Source |
| --- | --- |
| Test conventions | `.claude/skills/write-api-test/SKILL.md` (learned, then human-reviewed) |
| Project context | `CLAUDE.md` + `.claude/qa-sentinel.md` + `qa-sentinel.config.yaml` |
| Traceability | `test-map.yaml` (service → endpoint → spec files) |
| API contracts | OpenAPI specs in service repos |
| Requirements | MR title/description or `--story-file` |
| Examples | Existing specs and helpers in the test repo |
| Ground truth | Service source code (read via `--add-dir`) |

### 4.6 CI integration (`templates/ci/`)

- **GitLab**
  - `service.gitlab-ci.yml` is included in each service repo. On an MR it runs the gap report (`allow_failure: true`, so it never blocks developers). After a merge to the default branch it triggers a pipeline in the test repo.
  - `tests.gitlab-ci.yml` holds the generation job (`resource_group`, so only one run per service at a time), a gate that runs only the changed specs on agent MRs, and scheduled or post-deploy API runs.
- **Jenkins**
  - `Jenkinsfile.gap-report` is triggered by the GitLab plugin and marks the build UNSTABLE, never FAILED.
  - `Jenkinsfile.generate` is parameterised and called after service merges.
  - `Jenkinsfile.tests` runs the tests, with a changed-only mode.

### 4.7 Scratch scaffold (`templates/scaffold/playwright-api/`)
- Playwright API project with a typed `ApiClient` and fixtures (`api`, `data`).
- `DataFactory` for unique data.
- `expectSchema()` built on zod.
- An example spec, with HTML and JUnit reporters.
- Verified: `tsc --noEmit` is clean and `playwright test --list` works.

## 5. What has been done and verified

| Item | Status | Evidence |
| --- | --- | --- |
| CLI with 5 commands | ✅ built | `src/` |
| 5 agents and 4 skills | ✅ written | `templates/agents`, `templates/skills` |
| GitLab and Jenkins templates | ✅ written | `templates/ci` (**not yet run on a real GitLab or Jenkins server**) |
| Scratch scaffold | ✅ compiles and lists tests | smoke test |
| Unit tests | ✅ 14 passing (vitest) | `test/core.test.ts`: detection, init (both modes), template rendering with no leftover placeholders, doctor, Claude argument building, gap-report skip and dry-run, commit filtering |
| **End-to-end run with the real LLM** | ✅ done locally | `examples/delivery-slot-demo/` |

### 5.1 End-to-end demo (real outputs committed in the repo)

**Setup.** An Express `orders-service` has an OpenAPI spec and one existing spec file. The dev change (story SHOP-42) makes `POST /orders` require a future `deliverySlot`, caps each slot at `MAX_ORDERS_PER_SLOT = 5`, and returns 409 when a slot is full. **Planted defects:** the AC says the cap is **3**, and the OpenAPI spec was not updated.

**Gap report** (11 turns, 67 s, $0.27):
- Found the 3-vs-5 AC mismatch, rated high.
- Found that the existing "creates an order" test will now fail.
- Found that the qty-0 test still passes but only because the slot is missing, so it no longer tests qty.
- Found all four spec-drift items.
- **Unplanted findings:** `Date.parse` accepts non-ISO strings (AC1 violation), and the slot comparison is string-based, so `Z` and `+00:00` count as different slots.

**Generate** (19 turns, 89 s, $0.31):
- Fixed both existing tests and added 7 scenarios (including boundary and "a different slot still accepts orders").
- Added a `futureSlot()` builder and an orders setup helper.
- Wrote the capacity test **to the AC** as `test.fixme` with a `// QA-AGENT:` note.
- Committed only test files.
- An independent rerun by us gave **8 passed, 1 skipped (the fixme)**.

Outputs: `examples/delivery-slot-demo/expected-output/`.

### 5.2 Bugs found and fixed during the e2e run
- A commit-step path parsing bug: a trimmed `git status` output cut the first character off the first path. Fixed with `git status -z` parsing, and a unit test was added.
- `test-results/` and the summary file would have been committed. Fixed with artifact filtering plus `.gitignore` entries.
- Agent preamble text ("Now writing the summary…") leaked into reports. Fixed by trimming everything before the first heading.
- The Claude CLI waited 3 s for stdin. Fixed with `stdio: ignore`.

## 6. Known limitations and honest gaps

1. **Not exercised on real CI yet.** The GitLab and Jenkins files are written but unverified: job-token permissions, triggers, the `trigger:` variable passing, and Docker images.
2. **Multi-service features.** Each service merge triggers its own run, and each run sees only that service's diff. A feature spanning 3 services produces 3 separate analyses and 3 test MRs, and cross-service flows are not tested as a whole. (Proposal in §7.)
3. **Monorepos are not supported.** One repo is assumed per service.
4. **Some guardrails are prompt-only, not enforced by code:**
   - `guardrails.forbiddenUrlPatterns` and `allowAssertionRemoval` exist in the config but are not checked in code.
   - `Edit`/`Write` are not path-restricted. The agent *can* edit any file in the test repo, and any file in the `--add-dir` service checkout (a throwaway clone in CI).
   - Possible hardening: Claude Code permission deny rules in `.claude/settings.json`, plus a post-run diff check in the CLI that rejects changes outside allowed globs.
5. **The executor's results are self-reported.** The CLI does not rerun the specs itself. The CI gate (`qa-agent-mr-checks`) is the real check, and the CLI could add its own verification run.
6. **Requirements source is limited to the MR description or a story file.** `requirements.source: jira` is in the schema but not implemented (MCP is planned).
7. **The KB has no domain or environment layer, and no learning from reviews.** Corrections made by QA in agent MRs are not fed back.
8. **Non-determinism and cost.** Output wording and scenario choice vary between runs. Cost is about $0.25–$0.35 per run on a small service, and growth with service size is not yet measured.
9. **Web and Mobile are config placeholders only.**
10. **Only API frameworks other than Playwright have detection, no scaffold:** supertest, axios, pactum, jest, vitest, mocha.
11. **Prompt injection.** Diffs, stories and comments are untrusted. Agents are told to treat them as data, and gap-report tools are read-only, but there is no deeper mitigation yet.

## 7. Planned next steps (proposed, not built)

| Priority | Item | Idea |
| --- | --- | --- |
| P0 | Pilot on one real service in GitLab CI | Validate templates, permissions, cost and usefulness |
| P0 | Enforce guardrails in code | Post-run diff check (allowed globs, no removed `expect(`, forbidden URL patterns) plus Claude Code deny rules |
| P1 | **Story-key grouping across services** | Read the story key (e.g. `SHOP-42`) from the MR title or branch. After a merge, wait a configurable window and collect all merged diffs with the same key across services. Run **one** generation with all diffs, so cross-service flow tests are possible and one test MR is opened. Add `qa-sentinel generate --story SHOP-42` for manual runs. |
| P1 | **`kb/` folder** | `domain.md` (business rules, glossary), `environments.md` (auth, test users, seed data, flags), `team-rules.md`; agents read these first |
| P1 | **Review feedback loop** | When an agent MR merges, a "retro" agent compares the agent's commit with the final merged version and proposes KB/skill updates as a small MR |
| P1 | Jira/Confluence via MCP | Pull stories and AC automatically |
| P2 | `metrics` command | Merged-without-edits rate, flakiness of agent tests, cost per PR, time from merge to test MR |
| P2 | Monorepo support | Map folders to services and split the diff |
| P3 | Web adapter (Playwright UI) | The agent explores the live page via Playwright MCP and updates page objects first. Optional Bubblegum `recover()` fallback, with "recovered" traces fed back as page-object fixes |
| P3 | Mobile adapter (WebdriverIO + Appium) | All preconditions through Phase 2 API helpers |
| P3 | GitHub support, contract-test (Pact) suggestions | — |

### Proposed success metrics
| Metric | Target |
| --- | --- |
| Gap findings rated useful by QA | ≥ 70% |
| Agent API MRs merged with minor or no edits | ≥ 60% |
| Flakiness of agent tests | ≤ existing suite |
| Dev merge → test MR | < 30 min |
| Cost per dev change | tracked; budget set by the team |

## 8. Questions for the reviewer

We would value critical feedback on these in particular:

1. **Architecture.** Is the multi-agent split (analyzer → mapper → data → author → executor) right, or too granular for the cost and latency? Would fewer, larger agents work better?
2. **Engine choice.** Claude Code headless with Markdown agents and skills, versus building on an agent SDK or the raw API. What are the risks for long-term maintenance and portability (for example, other LLM providers)?
3. **Guardrails.** Is prompt-level plus tool-level restriction enough for v0.1, or must code-enforced diff checks come before any pilot? What else is missing for safe use in enterprise CI (secrets, prompt injection from MR text)?
4. **The oracle problem.** Is "AC outranks code, mismatches become `fixme` tests" a sound policy? What happens in practice when ACs are vague or missing?
5. **Multi-service changes.** Is story-key grouping with a time window the right model, or is there a better trigger (for example, release or deploy events, or a feature-flag manifest)?
6. **Knowledge base.** Is "no vector DB, agents search the repo plus curated Markdown KB" the right call at scale (50+ services, thousands of specs)? When would retrieval or indexing become necessary?
7. **Traceability.** Is a hand-maintained, agent-updated `test-map.yaml` sustainable, or should mapping be inferred at runtime (tags, coverage data, contract tests)?
8. **CI templates.** Any issues with the GitLab (`trigger:`, `CI_JOB_TOKEN`, `resource_group`) or Jenkins (GitLab plugin variables, credentials) designs?
9. **Adoption.** What would stop a QA team from adopting this? What is the minimum a team needs before it is useful?
10. **Code quality.** Anything in `src/` that is fragile: git handling, config schema, template rendering, error handling?

## 9. Repository map

```
src/
  cli.ts                 commander CLI
  config.ts              zod schema for qa-sentinel.config.yaml
  detect.ts              framework, test, CI and service detection
  claude.ts              headless Claude Code runner (JSON output, cost/turns)
  git.ts                 diffs, changed files (-z parsing)
  run.ts                 run directories, tool lists, artifact filters
  templates.ts           {{var}} / {{#if}} renderer
  commands/              init, learn, doctor, gapReport, generate
  scm/gitlab.ts          MR note upsert, MR creation
templates/
  agents/                5 sub-agents
  skills/                qa-gap-report, generate-api-tests, write-api-test, learn-conventions
  claude/                CLAUDE.md fragment
  ci/gitlab|jenkins/     pipelines and setup READMEs
  scaffold/playwright-api/
examples/delivery-slot-demo/   inputs, run-demo.sh, real outputs
test/core.test.ts        14 unit tests
docs/PROJECT_REVIEW.md   this document
```

## 10. How to try it

```bash
git clone https://github.com/bishnu133/qa-sentinel && cd qa-sentinel
npm install && npm run build && npm test
# full e2e demo: needs Claude Code logged in or ANTHROPIC_API_KEY, costs well under $1
./examples/delivery-slot-demo/run-demo.sh
```
