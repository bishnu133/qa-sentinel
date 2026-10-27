# Try it: Jira Data Center, self-hosted GitLab, budget suggestions, split CI jobs, wrapper and sandbox (PR 5)

Part 1 needs **nothing**: no AI, no Jira, no GitLab. It costs nothing.
Part 2 are the **owner proofs**. Each one says which real system it needs and what it costs.
Nothing was run by the builder against a real Jira Data Center, a self-hosted GitLab, GitLab CI split jobs or a large service.
Only fake servers on 127.0.0.1 were used.

## Part 1. Run the tests (free, no real systems)

1. `export QAS=~/Documents/qa-sentinel`
2. `cd $QAS && git fetch origin && git checkout pr5-hardening && npm ci && npm run build`
3. `npx vitest run test/realSystems.test.ts test/publish.test.ts test/bundlePolicy.test.ts test/splitJobs.test.ts test/metrics.test.ts`

Expect: 5 files, all passing `realSystems` 26 tests, `publish` 17, `bundlePolicy` 6, `splitJobs` 5, `metrics` 11. `publish.test.ts` and `bundlePolicy.test.ts` try to fool `qa-sentinel publish` with hand-made `publish.json` and `branch.bundle` files (a fake base commit, a branch called `main`, another project, a symlink, a submodule, a hidden change in a merge commit, a moved story branch, two publishes at once).
The tests start a fake Jira Data Center (token login, `/rest/api/2`) and a fake GitLab under a sub-path
(`http://127.0.0.1:PORT/gitlab`) on your own computer. They need no internet and no git name or e-mail.

## Part 2. Owner proofs

### R1. Jira Data Center with a token (needs real Jira Data Center; costs no AI money, a few Jira API calls)

1. Make a Personal Access Token in Jira (your profile, Personal Access Tokens). Give it read rights.
2. `export JIRA_PAT=<the token>` and make sure `JIRA_EMAIL` is **not** set.
3. In `qa-sentinel.config.yaml` set `requirements.jira.baseUrl` to your Jira address (the address Jira itself reports) and `auth: pat`.
4. Run `npx qa-sentinel doctor --online`.
   Expect: a line saying the Jira kind is Data Center, and the login check passes.
5. Run `npx qa-sentinel feature TEST-101` on a test story. Expect: it reads the story. A comment is only written if you add `--post`.
6. If you get a message saying "this looks like a web page", the address or the proxy is wrong. Fix `baseUrl`.

### R2. Self-hosted GitLab, also under a sub-path (needs your own GitLab; costs no AI money, a few GitLab API calls)

1. Set `ci.gitlabUrl` to your GitLab address. If it lives under a path, like `https://example.com/gitlab`, keep the path.
2. If your company uses its own certificate authority, run commands with `NODE_OPTIONS=--use-system-ca`.
3. Run `npx qa-sentinel doctor --online`. Expect: GitLab reachable.
4. Run `npx qa-sentinel generate <story> --push` on a test project. Look at the pushed branch. The remote address must keep the `/gitlab` part.

### R3. Split CI jobs (needs a real GitLab project with a runner; the analysis job costs AI money, the publish job costs none)

1. Copy the GitLab template: `npx qa-sentinel init` (CI choice GitLab), or copy `templates/ci/gitlab/`.
2. Set the CI variable `QA_SPLIT_JOBS` to `true`.
3. Make two tokens: a read one (`read_api` and `read_repository`) and a write one (`api` and `write_repository`).
   Save them as `QA_SENTINEL_GITLAB_READ_TOKEN` and `QA_SENTINEL_GITLAB_WRITE_TOKEN`.
4. Give each variable an **environment scope** (Settings, CI/CD, Variables): the model key gets `qa-analysis`; the write token and the Jira publishing login (`QA_JIRA_PUBLISH_PAT`, or `QA_JIRA_PUBLISH_EMAIL` and `QA_JIRA_PUBLISH_API_TOKEN`) get `qa-publish`. The jobs name these environments. This step is the real separation. Without it, GitLab shows every variable to every job.
5. The publish job also needs the non-secret test URL variables (for example `QA_BASE_URL`), so the check of URLs in the new tests knows your test environment.
6. Run the pipeline. Expect: `qa-generate` (or `qa-gap-report`) makes a `publish.json` and a `branch.bundle` in its artifacts and writes nothing to GitLab or Jira. Then `qa-generate-publish` pushes and opens the MR.
7. Open the log of the analysis job and the publish job. Check that the write token variable is not in the analysis job's list of variables, and the model key is not in the publish job's. Write down what you saw. We could not check this ourselves.
8. Open the log of the publish job. Expect: no model key and no agent run.
9. To test the safety check, edit `publish.json` in a copy of the artifact: add `"project": "99"`, or change the branch to `main`. Expect: publish refuses and pushes nothing.

### R4. Cost growth on a large service (needs a big service and its past run data; costs nothing new, reads old files)

1. Collect old run folders (`.qa-sentinel/runs`) and story records.
2. Run `npx qa-sentinel metrics --runs <dir> --records <dir>`.
3. Look at the section "Budgets for automation.budgets". With at least 10 samples you see suggested numbers
   (p90 times 1.5 per story and per day; per month is per day times 22, rounded up to 5 dollars).
   With fewer samples it tells you how many more are needed.
4. Copy the numbers into `automation.budgets` if you like them. qa-sentinel never changes your config.

### R5. Wrapper and sandbox (optional; needs Docker or similar for the wrapper, and Claude Code with bubblewrap and socat on Linux for the sandbox)

1. Wrapper: set `verification.wrapCommand: "docker run --rm -v $PWD:/w -w /w node:20 sh -c {cmd}"` (adjust to your image).
   Run `npx qa-sentinel doctor`. Expect: the wrapper check passes. Docker examples were not run by the builder.
2. Sandbox: set `agent.sandbox: { enabled: true, allowedDomains: ["your.gitlab.host"] }`, then run `npx qa-sentinel doctor`.
   Expect: it tells you if bubblewrap or socat is missing. The sandbox covers the agent's shell commands only.
3. Run one `generate`. Expect: it works as before. If the sandbox cannot start, it stops (`failIfUnavailable` is true by default).
