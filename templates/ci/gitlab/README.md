# qa-sentinel on GitLab CI

Two files, two repos:

| File | Goes in | What it does |
| --- | --- | --- |
| `service.gitlab-ci.yml` | every service repo (via `include: project:`) | MR gap-report comment (Phase 1); triggers test generation after merge (Phase 2) |
| `tests.gitlab-ci.yml` | this test repo (via `include: local:`) | generates tests and opens an MR; checks agent MRs; runs API tests |

## Flow
1. Dev opens an MR in a service repo → `qa-gap-report` posts or updates one comment on the MR. It is `allow_failure: true`, so it never blocks devs.
2. The MR is merged → `qa-trigger-generation` starts a pipeline in this repo with `QA_SERVICE_*` variables.
3. `qa-generate` writes/updates API tests on a `qa-sentinel/<service>-<sha>` branch and opens an MR labelled `qa-agent`.
4. `qa-agent-mr-checks` runs only the changed specs on that MR. A QA engineer reviews and merges.

## Setup checklist
- [ ] Masked variables in both repos (group level is easiest): `ANTHROPIC_API_KEY`, `QA_SENTINEL_GITLAB_TOKEN`
- [ ] `{{baseUrlEnv}}` in this repo, pointing to the QA environment
- [ ] `QA_TESTS_PROJECT` in each service repo's `variables:`
- [ ] Job token allowlist: this repo's CI_JOB_TOKEN can read service repos, service repos' tokens can read this repo
- [ ] `ci.testRepoProject` set in `qa-sentinel.config.yaml`
- [ ] Protect the `{{targetBranch}}` branch: MRs from `qa-sentinel/*` need 1 approval
- [ ] Run `qa-sentinel doctor` locally first
