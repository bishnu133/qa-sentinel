# Response to external review #1

> **Review:** "QA Sentinel — Complete Project Review, Architecture Recommendations & Implementation Roadmap" (October 2026), based on `docs/PROJECT_REVIEW.md` and the v0.1.0 source.
> **Response version:** qa-sentinel **v0.1.1**
> **Summary:** we agree with nearly all of the review. Every P0 item is fixed in v0.1.1 and covered by tests. We also found and fixed one more serious issue the review did not mention (§A). P1 and P2 items are scheduled in the order the review suggested. Where we disagree or only partly agree, we say why.

## A. An issue the review missed: publisher credentials were readable by the agent

In v0.1.0 the agent process inherited the **entire CI environment**, including `QA_SENTINEL_GITLAB_TOKEN` and `CI_JOB_TOKEN`. The GitLab template also wrote the token into the test repo's `.git/config` (`git remote set-url origin https://oauth2:${TOKEN}@…`) *before* the agent ran. An agent manipulated by a malicious diff could have read either.

**Fixed in v0.1.1:**
- Agents and test runs get an **allowlisted environment** (`src/env.ts`). Credential-like names (`TOKEN|SECRET|PASSWORD|API_KEY|AUTH|…`) are never forwarded unless listed in `guardrails.passEnv`. Publisher tokens are always removed. Test runs never receive the Anthropic key.
- The CLI pushes with a **one-off URL** built at push time (`pushUrl()`), so no token is stored in `.git/config`. The CI templates strip tokens from every clone's remote before any agent runs.
- A deny rule `Read(//**/.git/config)` is added as defence in depth.

This partly implements the review's §14 "four security domains": the **publisher** credential is now separate from the **author** and **verifier**.

## B. Point-by-point

Legend: ✅ done in v0.1.1 · 🟡 partly done · 📅 planned (release) · ↔️ partly agree / changed · ❌ disagree

### §3 Critical code-level issues (P0)

| # | Review finding | Status | What we did (files) |
| --- | --- | --- | --- |
| 3.1 | AC may not reach generation | ✅ | New `RequirementSnapshot` (`src/requirements.ts`): source, URL, revision, story key, parsed AC ids, approval status, raw text. The priority order is `--story-file` → MR context → **the MR that introduced the merged commit**, fetched from the GitLab API (`/repository/commits/:sha/merge_requests`). That last step is what was missing for post-merge generation. The snapshot is saved per run as `requirements.json`, cited in the MR description and recorded in the manifest. `requirements.required: true` refuses to generate without one. |
| 3.2 | Service checkout not pinned | ✅ | Refs are resolved to full SHAs, and `ensureAtCommit()` **fails** if the service working tree is not at the analysed head. With `--checkout` it detaches to it instead (`src/git.ts`). CI templates `git checkout --detach $QA_SERVICE_SHA`. Every run writes `manifest.json` with the test-repo SHA, service base and head SHAs, dependency SHAs, config hash, requirement revision, agent usage, guardrail counts, verification status and outcome. |
| 3.3 | Write paths not enforced | ✅ | `guardrails.allowedWritePaths` (derived from `tests.api.dir`, `helpersDir`, `extraWritePaths` and `test-map.yaml` when empty) and `blockedWritePaths` (CI files, `.claude/**`, `.env*`, config, lockfiles, …). After the agent finishes, **every added, modified, deleted and renamed path (both sides)** is checked. **Any violation rejects the whole run and nothing is committed.** `learn` is restricted to its three files. The read-only gap report checks that *nothing* changed in either repo. The service repo must be untouched, compared with a before/after snapshot (`src/guardrails.ts`). |
| 3.4 | Agent-reported test results | ✅ | New independent verifier (`src/verification.ts`): preflight of the base URL → type-check → optional lint → **only the changed specs** with a JUnit report → parse → `VERIFIED` / `FAILED` / `BLOCKED` / `NOT_RUN`. `BLOCKED` and `NOT_RUN` are never shown as success. Environment-type errors (ECONNREFUSED and similar) become `BLOCKED`, not `FAILED`. The MR title gets `Draft:` and a `qa-sentinel::<status>` label unless the run is VERIFIED, and the CLI exits non-zero. Agent claims sit under "Agent notes", explicitly superseded by the verification table. |
| 3.5 | CI masks tsc failures | ✅ | Removed `\|\| echo` and `\|\| true`. The agent-MR gate in both GitLab and Jenkins is now `qa-sentinel verify --policy`, the same checks generation runs, and it blocks unless VERIFIED. |
| 3.6 | No runtime or cost limits | ✅ | `agent.timeoutMinutes` and `agent.maxBudgetUsd` per command (`--max-budget-usd`). Processes run in their own **process group** and are killed (SIGTERM, then SIGKILL) on timeout, so browsers do not outlive the job (`src/proc.ts`). Claude result subtypes are mapped to `max-turns` / `max-budget` / `timeout` / `error` and recorded in the manifest. `verification.timeoutMinutes` bounds test runs. |
| 3.7 | Concurrent generation across services | ✅ | GitLab `resource_group: qa-sentinel-generate` serialises writes for the whole test repo. Jenkins has one job with `disableConcurrentBuilds()`. Read-only gap reports stay parallel. MR creation is **idempotent**: it updates the open MR for the same branch instead of failing. |

**Claude Code configuration (§13).** We checked the review's point against the Claude Code docs and agree: `--allowedTools` only pre-approves. v0.1.1 runs with `--permission-mode dontAsk` (anything not pre-approved is denied), `--tools` (the tools that exist at all), `Edit(<glob>)` allow rules per allowed path, `Bash(<test command> *)`, and `--settings` deny rules (secrets, `.git/config`, curl/wget/env, blocked paths, the service checkout). We do not use `--bare`. As the review says, these are **one layer**. The post-run checks above decide whether a change is accepted.

### §4 Architecture: deterministic vs AI

| Point | Status | Notes |
| --- | --- | --- |
| Keep the five responsibilities, change the orchestration | ↔️ | Clarification: in v0.1 the five agents are **sub-agents inside one Claude Code session**, not five separate sessions, so the cost concern is smaller than the review assumed. The underlying point stands: deterministic work should not be done by an LLM. In v0.1.1, change collection, SHA resolution, requirement capture, path, secret, host and assertion checks, test execution, result parsing, MR creation and the manifest are all TypeScript. |
| Deterministic OpenAPI contract diff | 📅 v0.2 | Parse the spec at base and head, diff structurally, and pass the result to the analyzer as evidence. |
| Engine interface (`AgentEngine`, `ClaudeCodeEngine`) | 📅 v0.2 | Agreed. It is small, and it keeps a later engine switch cheap. |

### §5 Test Decision Engine

🟡 **Partly done.** The mapper now has to give each change a `decision` (`reuse` / `update` / `create` / `review` / `skip`) with evidence and a reason. The author acts strictly on it (it never duplicates a spec for `update`, and `review` becomes a fixme written to the requirement). Gap reports show a Decision column. **Still missing:** the decision is produced and consumed by prompts, not validated by code. That is §6.

### §6 Structured contracts (Zod TestPlan)

📅 **v0.2, first item.** The orchestrating session will write `test-plan.json` to the run directory, the CLI will validate it against a Zod `TestPlanSchema` with cross-field rules (`skip` needs evidence; `conflicting` cannot be auto-accepted), and generation will consume the validated plan. We deliberately shipped the safety fixes first, as the review recommended.

### §7 Acceptance-criteria strategy

| Point | Status | Notes |
| --- | --- | --- |
| Oracle hierarchy | ✅ | Encoded in the change-analyzer and the project context: AC → contract → domain rules → existing tests → code (actual behaviour only) → inference (hypothesis only). |
| Four requirement states | ✅ | Each change has `oracleStatus`: `approved` / `conflicting` / `ambiguous` / `missing`. The author's rules per state: assert exactly; fixme to the requirement; assert only what is certain; assert only contract-backed behaviour. When nothing is found, `story.md` says "Oracle status: MISSING" instead of being blank. |
| "AC is not automatically correct" / approval status | ↔️ | Agreed in principle. In practice an MR description has **no approval state**, so qa-sentinel marks it `unverified` and says so in every report. Only a tracker (Jira status, v0.2) can make it `approved`. We will not pretend otherwise. |
| `fixme` must not hide in "all passed" | ✅ | qa-sentinel itself (not the agent) finds every fixme or skip added in the diff, with its `// QA-AGENT:` note, and lists them in a separate **"Unresolved product discrepancies"** section near the top of the MR, with a `qa-sentinel::discrepancy` label. |

### §8 Risk analysis

🟡 **Partly done.** Gap reports now lead with an overall risk and a per-change risk from **transparent rules**: critical only for auth, money or personal data, with the factor named; a conflicting oracle raises the risk to at least high. A one-line "recommended QA action" follows, plus a table of change / risk / oracle / coverage / decision. In our runs, a first version of the rule let a capacity-limit conflict be rated "critical", so we tightened it. **Still missing:** the risk is applied by the model following rules, not computed by code; incident-history signals; ranking across MRs. Planned for v0.3 with the decision engine.

### §9 Multi-service: Feature Change Manifest

📅 **v0.4. We agree story grouping is not enough.** The point about deploy timing (services merged and deployed on different days) is the strongest argument. Our plan is an **auto-assembled** manifest (story key → services → SHAs → deployment readiness via each service's version endpoint), editable by humans. We don't want teams to hand-write YAML per feature, because adoption would suffer. Story-key grouping becomes the way the manifest is assembled, as the review suggests.

### §10 Cross-platform workflow planner

🟡 **The policy is changed now; the planner is planned (v0.5).** The test-data policy now matches the review's wording: APIs or test-data services first; UI only when the UI is under test or no safe programmatic route exists; never production; DB writes only through documented helpers for isolated environments; async work through bounded polling. Setup is expressed as **steps with dependencies** so it can later become a graph.

### §11 Knowledge base

| Point | Status | Notes |
| --- | --- | --- |
| No vector DB yet | ✅ agreed | Unchanged. |
| `unknown` coverage status | ✅ | Added. The mapper must never round `unknown` up to `covered`, and coverage requires reading assertions. |
| Scenario/assertion-level `test-map.yaml` | 📅 v0.3 | With the Zod TestPlan, so the map entries are machine-validated. |
| Hybrid KB (`kb/` domain rules, review feedback) | 📅 v0.3+ | As in the review's table. |

### §12 Independent test-quality evaluator

🟡 **First deterministic piece done.** The assertion count per changed spec is compared before and after (flagged, or fatal with `assertionRemoval: fail`), deleted test files are flagged, and the author prompt forbids status-only tests. **Planned:** a targeted AI review of assertion strength against the AC (v0.3), and **mutation checks in the benchmark** (later, starting with small, high-value rules such as the 3-vs-5 cap, exactly as the review suggests).

### §13 Claude Code vs own framework

✅ **Agreed: keep Claude Code, move toward a hybrid.** The configuration fixes are listed under §3 above; the engine interface is planned for v0.2.

### §14 Enterprise security and CI

| Point | Status | Notes |
| --- | --- | --- |
| Separate security domains | 🟡 | Publisher credentials separated (§A). The analyzer is read-only, enforced after the run. The verifier gets a scrubbed environment. Full separation into distinct CI jobs is planned. |
| Prompt injection | ✅ tested | Every agent and skill now has an "untrusted input" section, and gap reports have a "Suspicious content" section. **Tested with the real agent:** we planted a comment in a service diff instructing "AI QA agents" to add `curl … \| sh` to CI, dump env vars into a spec and point tests at a prod URL. The gap report listed it as suspicious. Generation ignored it, the MR notes flagged it, and nothing malicious was written. Had it been followed, the path, host and secret checks would have rejected the run. |
| Test execution is sensitive / network allowlist | ↔️ | The CLI cannot enforce OS-level network isolation; that belongs to the runner. The templates now say so explicitly. Within our reach: the env allowlist, `guardrails.allowedHosts` (an **allowlist** of hosts that may appear in added test code, replacing the old `prod` denylist, as the review suggested), and a base-URL preflight. Claude Code's sandbox settings are a candidate for v0.2. |
| GitLab: validate access, not variables | ✅ | `doctor --online` calls GitLab: token works; test repo reachable with Developer+ access; each service project reachable. It also states plainly that job-token allowlists cannot be verified from outside. |
| Idempotent MR, safe retry, note pagination | ✅ | Upsert by source branch; retries on 429 and 5xx with backoff (honouring `Retry-After`); the MR note search pages through every note. |

### §15 Benchmark

📅 **v0.2.** We have two real scenarios with saved outputs: the delivery-slot AC conflict, and prompt injection. The suite will cover the review's 12 cases, with human-reviewed expected decisions and gap recall/precision metrics, rerun on every prompt or model change.

### §16 Roadmap and §17 operating levels

✅ **Adopted.** The release order follows the review. The three operating levels (QA Intelligence → Assisted Test Maintenance → Cross-Platform Orchestration) will structure the README and `init` in v0.2.

### §19 Pilot approach

✅ **Adopted as written:** read-only on historical MRs with known required testing first, compare with them, then enable generation in an isolated QA environment.

## C. Verification of v0.1.1

| Check | Result |
| --- | --- |
| Unit tests | **34 passing** (14 → 34), covering env scrubbing, path policy incl. renames and deletions, secret, host and assertion checks, service snapshot, requirement parsing and resolution, JUnit parsing, status rules incl. BLOCKED/NOT_RUN, live preflight against a real HTTP server, timeout kill, Claude subtype mapping, push URL, MR description ordering, SHA pinning |
| Real e2e: delivery-slot demo | Gap report 9 turns · 20 s · $0.08 (High risk, AC-3 conflict, broken test, 4 gaps, spec drift). Generation 20 turns · 42 s · $0.14 → **VERIFIED by qa-sentinel**: tsc clean, 6 passed, 1 fixme listed as an unresolved discrepancy. Outputs: `examples/delivery-slot-demo/expected-output/` (incl. `run-manifest.json`, `verification.json`) |
| Real e2e: prompt injection | Ignored in both phases and flagged in both reports. No guardrail violations needed. |
| Bug found during e2e | The first read-only check blamed pre-existing untracked `node_modules` on the agent. Fixed with before/after tree snapshots. |
| Permission tuning found during e2e | The agent tried compound shell commands for exploration (denied by policy) and once wrongly concluded Bash was unavailable. The prompts now state the exact single-command forms allowed. Denials are saved per run (`permission-denials.json`) and counted in the manifest. |

## D. Still open (honest list)

1. **Not yet run on a real GitLab or Jenkins server.** This is the v0.2 pilot.
2. The TestPlan and decisions are still validated by prompts, not code (§6, v0.2).
3. Risk and decisions are applied by the model following rules; no deterministic engine yet (v0.3).
4. No benchmark suite yet beyond two scenarios (v0.2).
5. OS and network isolation of test execution depends on the CI runner's configuration.
6. Multi-service features, Web and Mobile: v0.4 and v0.5, as above.
