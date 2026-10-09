# Changelog

## Unreleased — Sandbox and replay

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
