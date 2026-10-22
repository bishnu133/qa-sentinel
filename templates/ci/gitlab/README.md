# qa-sentinel on GitLab CI

Two files, two repos:

| File | Goes in | What it does |
| --- | --- | --- |
| `service.gitlab-ci.yml` | every service repo (via `include: project:`) | MR gap-report comment (Phase 1); triggers test generation after merge (Phase 2) |
| `tests.gitlab-ci.yml` | this test repo (via `include: local:`) | generates tests and opens an MR; blocking `qa-sentinel verify` gate on agent MRs; runs API tests |

## Flow
1. Dev opens an MR in a service repo → `qa-gap-report` posts or updates one comment on the MR. It is `allow_failure: true`, so it never blocks devs.
2. The MR is merged → `qa-trigger-generation` starts a pipeline in this repo with `QA_SERVICE_*` variables.
3. `qa-generate` pins the service clone to the merged SHA, fetches the acceptance criteria from the MR that introduced it, and writes or updates API tests. qa-sentinel then checks the guardrails and verifies the result independently. It opens an MR labelled `qa-agent` and `qa-sentinel::<status>` (Draft unless VERIFIED). Only one generation runs at a time for the whole test repo (`resource_group: qa-sentinel-generate`).
4. `qa-agent-mr-checks` runs `qa-sentinel verify --policy` on that MR, which blocks unless VERIFIED. A QA engineer reviews and merges.

## Split jobs (opt-in): analysis without publishing tokens, publishing without the model key

Set `QA_SPLIT_JOBS: "true"` (a CI/CD variable) and the work is done by two jobs instead of one:

| Job | Has | Does not have | Does |
| --- | --- | --- | --- |
| `qa-generate`, `qa-gap-report` (analysis) | the model key; `QA_SENTINEL_GITLAB_READ_TOKEN` (read_api + read_repository; the gap report needs read_api only); the Jira login for reading | the GitLab write token, the Jira publishing login | plan, write and verify the tests; leave the branch as `branch.bundle` and the rest in `publish.json` (`--defer-publish`) |
| `qa-generate-publish`, `qa-gap-report-publish` | `QA_SENTINEL_GITLAB_WRITE_TOKEN` (api + write_repository); optionally `QA_JIRA_PUBLISH_PAT` (or `QA_JIRA_PUBLISH_EMAIL` + `QA_JIRA_PUBLISH_API_TOKEN`) | the model key | `qa-sentinel publish`: checks the bundle against the agent write policy again, pushes it, opens or updates the merge request, comments on the MR and in Jira, writes the story record |

Not proven by us on a real GitLab (see docs/TRY-PR5.md). GitLab shows every project variable to every job, so the jobs `unset` the other half's secrets in their first lines; that keeps them from the programs the job starts, not from the job's variable list. To keep a secret out of a job completely, scope the variable to an environment (Settings › CI/CD › Variables › Environment scope) and give the job that environment (check how your GitLab version matches variables to jobs before relying on it).
Without `QA_SPLIT_JOBS` nothing changes: one job does everything with `QA_SENTINEL_GITLAB_TOKEN`.

## Setup checklist
- [ ] Masked variables in both repos (group level is easiest): `ANTHROPIC_API_KEY`, `QA_SENTINEL_GITLAB_TOKEN`. Using Amazon Bedrock or Google Vertex AI instead of an Anthropic key: `CLAUDE_CODE_USE_BEDROCK=1`, `AWS_REGION` and AWS credentials (or a runner role), or `CLAUDE_CODE_USE_VERTEX=1`, `CLOUD_ML_REGION`, `ANTHROPIC_VERTEX_PROJECT_ID` and GCP credentials; `qa-sentinel doctor` shows which route is used.
- [ ] `{{baseUrlEnv}}` in this repo, pointing to the QA environment
- [ ] Using Jira for requirements: `JIRA_EMAIL` + `JIRA_API_TOKEN` (Cloud) or `JIRA_PAT` (Server/DC) as masked variables in both repos. They are used by the CLI only and never passed to agents.
- [ ] `QA_TESTS_PROJECT` in each service repo's `variables:`
- [ ] Job token allowlist: this repo's CI_JOB_TOKEN can read service repos, service repos' tokens can read this repo
- [ ] (maintenance level) Test repo › Settings › CI/CD › Variables › **Minimum role to use pipeline variables: Developer**. Service repos trigger generation with variables; new gitlab.com projects default to "No one allowed" and the trigger job fails in seconds.
- [ ] `ci.testRepoProject` set in `qa-sentinel.config.yaml`
- [ ] Protect the `{{targetBranch}}` branch: MRs from `qa-sentinel/*` need 1 approval
- [ ] `gitlabProject` set for each service in `qa-sentinel.config.yaml` (or rely on `QA_SERVICE_PROJECT` from the trigger), so generation can fetch the MR's acceptance criteria
- [ ] Runners for these jobs have network access only to GitLab, the Anthropic API, your package registry and the QA environment
- [ ] (optional) Lower environment: add it under `environments:` in `qa-sentinel.config.yaml` and set `QA_ENVIRONMENT` (e.g. `sit`) in this repo's variables. Generation then runs the tests there before opening the MR; with `verification.requireVerifiedToPush: true` it pushes only when they pass.
- [ ] (optional) Feature manifests: a version endpoint per service (`services[].version: { path, field }`) that returns the deployed git SHA
- [ ] (optional) Showcase: `QA_SHOWCASE: "true"` in this repo's variables, Jira configured, and `reporting.targets` including `jira`. The job attaches evidence to the story once all ACs pass.
- [ ] (web) `{{webBaseUrlEnv}}` in this repo's variables (or exported by `QA_ENV_START`): the front end the web tests open. The suite job installs Chromium; videos are recorded for the showcase.
- [ ] (web, optional) Runtime healing: `tests.web.healing: bubblegum` in the config, `npm i -D @bubblegum-ai/node` in this repo. The suite job installs the Python engine and runs with `QA_HEALING=bubblegum`; `qa-healed` lists what was healed. Never used for agent MRs.
- [ ] (showcase) `QA_SHOWCASE=true`, Jira credentials, and `showcase.environments` / `showcase.notify` in the config. The job installs ffmpeg for the single showcase video.
{{#if mobileEnabled}}
- [ ] (mobile) `QA_APPIUM_URL` (an Appium server with a device, or a device farm's `https://user:key@…/wd/hub`, masked), `QA_APP` (or `QA_APP_PACKAGE` + `QA_APP_ACTIVITY` / `QA_BUNDLE_ID`) and `QA_MOBILE_PLATFORM`. Without `QA_APPIUM_URL` the `mobile-tests` job doesn't run, and agent MRs with mobile specs are verified as BLOCKED.
{{/if}}
- [ ] Run `qa-sentinel doctor --online` locally first
