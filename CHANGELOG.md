# Changelog

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
