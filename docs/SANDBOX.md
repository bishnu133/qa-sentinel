# Testing qa-sentinel yourself: the ShopLite sandbox

This guide shows how to try qa-sentinel end to end on your own accounts, without touching an employer's or client's code. It has three stages, and each one builds on the previous:

| Stage | What you get | Cost | Time |
| --- | --- | --- | --- |
| **A. Local** | All six scenarios on your laptop: gap reports and test generation, with real agent runs | about $0.10–0.40 a gap report, $0.50–2 a generation | 15 min |
| **B. GitLab** | The real flow: a developer MR gets a QA comment; merging it opens a "QA agent" MR | the same, plus GitLab Free CI minutes | 45 min |
| **C. Jira** | Acceptance criteria and approval read from real Jira stories | Jira Free | 20 min |
| D. Jenkins (optional) | The Jenkins pipelines against the same GitLab projects | none | 1–2 h |
| **E. Replay** | Scoring against tests that real developers wrote in open-source repos | about $0.20 a commit | 20 min |

> **Use your own code and your own keys.** Don't run this on employer or client repositories with a personal API key unless you have approval. ShopLite and public open-source repos are safe to use.

## What ShopLite is

ShopLite is a tiny shop with three Node services and one test repo:

```
orders-service         POST /orders → payments-service /authorize → notifications-service /notify
payments-service       /authorize, /refunds
notifications-service  /notify
qa-tests               Playwright API tests (13 baseline tests, all passing), qa-sentinel config,
                       test-map.yaml, qa-env/ (starts all three services behind a gateway on :8080)
```

Six scenarios play the developer. Each one is a real code change and a story with acceptance criteria, and each has a known catch:

| Id | Service | Change | What qa-sentinel should find |
| --- | --- | --- | --- |
| SHOP-101 | orders | new `promoCode` discount | conflict between AC-3 and the code |
| SHOP-102 | payments | partial refunds | cumulative refunds can exceed the payment (critical, money) |
| SHOP-103 | orders | `total` renamed to `totalCents` | breaking contract, and a consumer is affected |
| SHOP-104 | notifications | internal refactor | low risk, nothing to test (skip) |
| SHOP-105 | notifications | templated messages | template injection flagged |
| SHOP-106 | orders | order history | AC-3 can't be verified from one service |

`node sandbox/shoplite/local.mjs list` prints them. Real outputs from our runs are in [sandbox/shoplite/example-output/](../sandbox/shoplite/example-output/), so you know what "good" looks like.

## Prerequisites

- Node 20+, git, bash.
- Claude Code CLI: `npm install -g @anthropic-ai/claude-code`.
- An Anthropic API key from console.anthropic.com. **Set a monthly spend limit first** (Settings › Limits); $20 is plenty for this guide.
- qa-sentinel, built from source (it isn't on npm yet):

```bash
git clone https://github.com/bishnu133/qa-sentinel.git
cd qa-sentinel
git checkout sandbox            # until the open PRs are merged into main
npm install && npm run build
export ANTHROPIC_API_KEY=sk-ant-...      # in your shell only; never commit it
```

---

## Part A: local mode (start here)

```bash
node sandbox/shoplite/local.mjs setup --level maintenance     # creates ./shoplite-local
node sandbox/shoplite/local.mjs run SHOP-101                  # dev change + gap report
```

`setup` creates four git repos in `./shoplite-local` (the three services and `qa-tests`) and runs `qa-sentinel init` in `qa-tests`. It also writes the stories to `./shoplite-local/stories/`.

`run SHOP-101` checks every repo out to `main`, commits the developer change on a branch, and runs `qa-sentinel gap-report` with the story file. The report goes to `shoplite-local/SHOP-101-gap-report.md`. Compare it with `example-output/SHOP-101-gap-report.md` and with the "expect" line printed before the run.

To try generation:

```bash
node sandbox/shoplite/local.mjs run SHOP-102 --generate
```

This starts the QA environment (all three services behind `http://127.0.0.1:8080`), runs `qa-sentinel generate`, and stops the environment again. Look at:

- `shoplite-local/qa-tests/qa-sentinel-summary.md`: the MR description qa-sentinel would post (verification status, tests, unresolved discrepancies);
- `git -C shoplite-local/qa-tests log -1 --stat` on the `qa-sentinel/...` branch: the generated tests;
- `shoplite-local/qa-tests/.qa-sentinel/runs/<latest>/`: the run manifest, the plan and the agent logs.

Other commands:

```bash
node sandbox/shoplite/local.mjs reset            # all repos back to main, env stopped
node sandbox/shoplite/local.mjs env start        # just the QA environment (for your own experiments)
node sandbox/shoplite/local.mjs env stop
```

**What to check for each scenario** (write it down; see Part F):

1. Did it find the expected catch?
2. Is the plan's decision right (reuse / update / create / review / skip)?
3. Is the risk level sensible?
4. For generation: VERIFIED? Would you merge the tests as they are, after small edits, or not at all?

---

## Part B: GitLab (the real flow)

### B1. Things only you can do (in the GitLab UI)

1. **Create a gitlab.com account** and verify it (Settings › Account; a phone or card check is needed before shared runners run your pipelines). The Free tier gives about 400 CI minutes a month, which is enough for the sandbox.
2. **Create a group**, for example `yourname-shoplite` (Groups › New group). gitlab.com doesn't allow top-level groups to be created through the API, which is why this step is manual.
3. **Create a personal access token**: User settings › Access tokens, scopes **`api`** and **`write_repository`**, with an expiry date of about 30 days.

### B2. Create the sandbox (scripted)

```bash
export GITLAB_TOKEN=glpat-...
export GITLAB_GROUP=yourname-shoplite
export ANTHROPIC_API_KEY=sk-ant-...

node sandbox/shoplite/setup-gitlab.mjs --dry-run            # shows every API call, changes nothing
node sandbox/shoplite/setup-gitlab.mjs --package github:bishnu133/qa-sentinel#sandbox
```

The script:

- creates four private projects: `orders-service`, `payments-service`, `notifications-service` and `qa-tests`;
- sets group CI/CD variables: `ANTHROPIC_API_KEY` (masked), `QA_SENTINEL_GITLAB_TOKEN` (masked; used to post comments and open MRs), and `QA_SENTINEL_PACKAGE` (where CI installs qa-sentinel from: a GitHub branch until it is on npm);
- pushes the code, with CI skipped for the first push;
- lets service jobs clone `qa-tests` and the other way round (job-token allowlists).

It starts at **level `intelligence`**: gap reports only, nothing is written. The working copies stay in `./shoplite-gitlab`.

> `--package` must point at a branch that contains the sandbox support. Use `#sandbox` until the PRs are merged into `main`; after that the default (`#main`) is fine.

### B3. Run it

1. **Baseline:** in `qa-tests`, open Build › Pipelines › Run pipeline on `main`. The `api-tests` job starts the QA environment inside the job and should report 13 tests passing. If this fails, fix it before going further (see Troubleshooting).
2. **Play the developer:**

   ```bash
   node sandbox/shoplite/dev.mjs open SHOP-101
   ```

   This pushes the change to a branch and opens a merge request. Within a few minutes the `qa-gap-report` job posts a **QA impact** comment on it. If you push again, the job updates the same comment instead of adding a new one.
3. Repeat with the other scenarios. `dev.mjs close SHOP-101` closes an MR and deletes its branch so you can run it again.

### B4. Turn on generation (level `maintenance`)

```bash
node sandbox/shoplite/setup-gitlab.mjs level maintenance
node sandbox/shoplite/dev.mjs open SHOP-102
# wait for the MR pipeline to finish, then:
node sandbox/shoplite/dev.mjs merge SHOP-102
```

After the merge, the service pipeline triggers `qa-generate` in `qa-tests`. It plans, writes tests, verifies them against the QA environment, and opens a **QA agent** merge request. The MR is a draft unless verification is VERIFIED, and its pipeline runs only the changed specs.

Review that MR the way you would a teammate's. That review is the real test of the tool.

---

## Part C: Jira (requirements from real stories)

1. Create a free Jira Cloud site at atlassian.com (up to 10 users).
2. Create a **Scrum** project with the key **`SHOP`**.
3. Create an API token at id.atlassian.com › Security › API tokens.
4. Seed the stories and switch the sandbox to Jira:

```bash
export JIRA_BASE_URL=https://yourname.atlassian.net
export JIRA_EMAIL=you@example.com
export JIRA_API_TOKEN=...
export JIRA_PROJECT=SHOP

node sandbox/shoplite/jira-seed.mjs                  # creates 6 stories, moves them to "In Progress"
node sandbox/shoplite/setup-gitlab.mjs --force --package github:bishnu133/qa-sentinel#sandbox
```

> `--force` re-pushes all four projects (it rewrites their `main`). Close any open sandbox MRs first.

From now on `dev.mjs open` uses the real Jira keys in MR titles and doesn't copy the story into the MR description, so the acceptance criteria can only come from Jira. The gap report's "Requirements" line should say `jira` with the issue's status.

Try this: move a story back to **To Do** and push again. The requirement should show as **not approved**, and the plan should treat its acceptance criteria accordingly.

---

## Part D: Jenkins (optional)

There's no script for this part; set it up by hand once GitLab works.

1. Run Jenkins in Docker:

   ```bash
   docker run -d --name jenkins -p 8081:8080 -v jenkins_home:/var/jenkins_home jenkins/jenkins:lts-jdk17
   ```

   Install the **GitLab**, **Pipeline** and **Docker Pipeline** plugins. Jenkins needs Node 20+ (use a Docker agent, or install Node in the image).
2. Add the credentials listed in [templates/ci/jenkins/README.md](../templates/ci/jenkins/README.md).
3. In a fresh `qa-tests` checkout, run `qa-sentinel init --ci jenkins` and create the three jobs from `ci/qa-sentinel/Jenkinsfile.*`.
4. GitLab can't reach `localhost`. Expose Jenkins with a tunnel (for example `cloudflared tunnel --url http://localhost:8081`) and add a webhook on a service project. Alternatively, run the parameterised jobs by hand with an MR IID.

---

## Part E: historical replay (real developers, real tests)

Replay checks qa-sentinel against tests that developers actually wrote. For each commit that changed both code and tests, it hides the test changes, runs the gap report on the code change alone, and compares the plan with what the developer did.

```bash
git clone https://github.com/lujakob/nestjs-realworld-example-app ../nestjs-realworld   # full clone, not --depth 1
npm run replay -- --repo ../nestjs-realworld --auto 10
npm run replay -- --repo ../some-api --commits abc123,def456 --spec openapi.yaml
```

Results go to `bench/replay-results/<repo>-<timestamp>.md` (`.json` too). See [bench/replay-results/examples/](../bench/replay-results/examples/).

Read the scores with care. A developer's unit tests for a rename aren't API gaps, so a "miss" isn't always a miss. The report puts the developer's new test titles next to qa-sentinel's proposed scenarios for you to judge.

Good repos to replay: small REST APIs in TypeScript or JavaScript with an OpenAPI spec and a test folder that changes often.

---

## Part F: keep a log

A tool is only as believable as its evidence. Keep one row per run, in a spreadsheet or a markdown table:

| Date | Scenario / MR | Level | Expected catch found? | Decision right? | Risk right? | Verification | Merge as-is / small edits / reject | Cost $ | Minutes | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |

Cost and time are in each run's `manifest.json` (`.qa-sentinel/runs/<id>/` locally, or the job artifacts in CI). After 20–30 rows you'll know where the tool is strong and where it needs work, and you'll have real numbers to show your team. Also run `npm run bench` after every change to the prompts or rules (about $0.70 a run).

---

## Troubleshooting

| Symptom | Likely cause and fix |
| --- | --- |
| Pipelines stay **pending** | Account not verified for shared runners (B1 step 1), or CI minutes are used up. |
| `qa-gap-report` can't clone `qa-tests` (403) | Job-token allowlist missing. In `qa-tests`: Settings › CI/CD › Job token permissions › add the service projects (and the other way round). |
| `npm install` of qa-sentinel fails in CI | `QA_SENTINEL_PACKAGE` points at a branch without a build. Use `github:bishnu133/qa-sentinel#sandbox`, or update the group variable. |
| No MR comment | `QA_SENTINEL_GITLAB_TOKEN` is missing or expired; check the job log for a 401. |
| `api-tests` fails at "QA environment did not start" | The job log shows the last lines of each service log. Usually a service clone failed (job-token allowlist again). |
| Gap report says *analysis incomplete* | The agent hit its turn or budget limit. The `agent` section of the run's `manifest.json` shows the status, turns and cost; raise `agent.maxTurns` or `maxBudgetUsd` in `qa-sentinel.config.yaml`. |
| Generation is **BLOCKED** | A guardrail rejected the change (path, host or secret). The reason is in the run's `guardrails.json`. This is the system working; check whether the rule or the agent is wrong. |
| `permission-denials.json` has entries | The agent tried a tool or command it isn't allowed to use. A few are normal; many suggest the prompt needs a clearer command form. |
| "Not logged in · Please run /login" | `ANTHROPIC_API_KEY` is empty in this terminal. Check with `echo ${#ANTHROPIC_API_KEY}` (it should be about 108), then set it with `read -s ANTHROPIC_API_KEY && export ANTHROPIC_API_KEY`. |
| "API Error … (429) … rate limit you configured in workspace" | The key belongs to a Console workspace with a zero or very low limit. Create the key in the **Default** workspace (or one with real limits) and delete the old one. |
| `claude -p` is silent for minutes | Claude Code is retrying an API error. Wait for the JSON, or press Ctrl+C and run `curl -sS -m 15 -o /dev/null -w "%{http_code}\n" https://api.anthropic.com/v1/messages` (405 or 401 means the network is fine). |
| Local `run` hangs | Something is holding port 3001–3003 or 8080. Run `node sandbox/shoplite/local.mjs env stop`. |
| Jira returns 401/403 | Check the email and token pair. The project key must be `SHOP`, or set `JIRA_PROJECT`. |

## Costs

- Anthropic: a gap report costs about $0.10–0.40 and a generation $0.50–2, depending on the change. The config caps every command (`agent.maxBudgetUsd`), and the spend limit on your key is the backstop.
- GitLab Free: a gap-report job takes about 2–4 minutes and generation about 5–10 minutes of the roughly 400 a month.
- Jira Free: no cost.

## Cleanup

- GitLab: delete the group (Settings › General › Advanced › Delete), and revoke the personal access token.
- Jira: revoke the API token; delete the site if you don't need it.
- Anthropic: delete or rotate the key you used for the sandbox.
- Locally: `rm -rf shoplite-local shoplite-gitlab`.
