# Checklists

## Token scopes

| Where | What | Scope / permission |
| --- | --- | --- |
| GitLab, your terminal (`GITLAB_TOKEN`) | a **group access token** of a bot user limited to the demo group (not your personal token) | `api` and `write_repository`; role Maintainer (reverts on the default branch, branch deletes and merges need it). |
| GitLab CI (`QA_SENTINEL_GITLAB_TOKEN`) | the same bot's token, variable **Protected** and **Masked** | `api` and `write_repository` (templates/ci/gitlab/README.md). Same user as above, so reset recognises the comments. |
| GitLab CI, split jobs (recommended, opt-in, `QA_SPLIT_JOBS=true`) | `QA_SENTINEL_GITLAB_READ_TOKEN` (environment scope `qa-analysis`), `QA_SENTINEL_GITLAB_WRITE_TOKEN` (scope `qa-publish`) | `read_api` + `read_repository`; `api` + `write_repository`. Not run on a real GitLab by the kit's author. |
| Jira Cloud | a **bot account** that sees only the TEST project: `JIRA_EMAIL` + `JIRA_API_TOKEN` (a plain API token), Protected + Masked | Project permissions: Browse, Create issues, Edit issues, Transition issues, Add comments, **Delete own comments**, Link issues, Create attachments, **Delete own attachments**. |
| Jira Server / Data Center | the bot's `JIRA_PAT`, `"auth": "pat"` in `demo.config.json` | Same project permissions. |
| Claude | `ANTHROPIC_API_KEY` (or Bedrock / Vertex), Protected + Masked; with split jobs scope it to `qa-analysis` | Set a spend limit on the key. |

If "Delete own comments" is missing, reset reports it as a failure and the comments stay.

## Expected durations (docs, not measured on this demo)

| Thing | Time | Where from |
| --- | --- | --- |
| `qa-gap-report` job | about 2 to 4 minutes | docs/SANDBOX.md, gitlab.com shared runners |
| `qa-generate` (generation and verification) | about 5 to 10 minutes | docs/SANDBOX.md |
| `api-tests` baseline job | not stated in the docs; time it in the rehearsal | |
| `seed-jira`, `setup-gitlab`, `demo-*`, `reset` | seconds to about a minute (setup also runs `npm install`) | not measured against real systems |

Write your own measured times here after the rehearsal: gap report ____ min, generation ____ min, baseline ____ min, reset ____ min.

## The day before

- [ ] qa-sentinel folder up to date and built: `git pull`, `npm ci`, `npm run build`.
- [ ] `demo/demo.config.json` filled in; the three `export` lines work in a new terminal (`GITLAB_TOKEN`, Jira login, `DEMO_JIRA_PROJECT`).
- [ ] Tokens are not expired (GitLab token expiry date; Jira API token).
- [ ] Claude key has credit and a spend limit.
- [ ] `node demo/scripts/reset.mjs --tests-dir demo/.work/shoplite-tests` (dry run) shows "Nothing to do", or a list you understand. If not: run reset with `--yes --i-know-this-is-a-test-project <KEY>`.
- [ ] **Full rehearsal once**, all the steps in `DEMO-SCRIPT.md`, then reset, then check "Nothing to do" on a second dry run. Write the real times above.
- [ ] After the rehearsal: in Jira, every card is back to its start status; in GitLab, `main` of each project equals `demo-baseline` (reset prints it).
- [ ] The tokens are the bot's, not yours; variables are Protected + Masked; the patterns `demo/*` and `hotfix/*` are protected branches (setup does it; check).
- [ ] CI/CD variables are present in GitLab (group level). Runners are online. The pipeline of the test repo's `main` passes (`api-tests`).
- [ ] Job-token allowlist is set both ways (service to tests, tests to service). Setup prints a WARNING if it could not.
- [ ] Browser tabs bookmarked; the recorded outputs (FALLBACK.md) open in an editor.
- [ ] Screen sharing works; font size big; terminal history cleared of anything secret.

## 30 minutes before

- [ ] New terminal; `echo ${#GITLAB_TOKEN}` shows a number (never print the token itself).
- [ ] `node demo/scripts/reset.mjs --tests-dir demo/.work/shoplite-tests` (dry run) says "Nothing to do". If it lists work, run it with `--yes --i-know-this-is-a-test-project <KEY>` now.
- [ ] Jira: all five cards are in their start status (stories "In Progress", bugs "To Do").
- [ ] GitLab: no open merge requests left in the three projects; no `qa-sentinel/*` or `demo/*` branches.
- [ ] In the test repo: Build > Pipelines > **Clear runner caches** (reset cannot do this; old story records and spend counts would come back).
- [ ] Runners are idle (Build > Pipelines: nothing running or pending; each revert of a reset starts pipelines, `reset --cancel-pipelines` cancels them). Check the number of CI minutes left.
- [ ] Dry run of the first step: `node demo/scripts/demo-merge.mjs --card delivery-slot` prints "change fits" and "dry run".
- [ ] Optional head start: run step 3 of the script now (`--yes`, without `--merge`) so the gap report is ready when you reach it. Then step 3 in the talk is "here is one I opened earlier".
- [ ] Close chat apps and notifications. Silence the phone.
- [ ] Have the fallback ready (FALLBACK.md): the recorded files open, and the local flow tested at least once.

## After the demo

- [ ] Clear the runner caches of the test repo, wait for idle runners.
- [ ] Run reset (`--yes --i-know-this-is-a-test-project <KEY>`) so the next demo starts clean. Check that the end of the output says "same files as demo-baseline".
- [ ] Note the AI cost of the session (Anthropic console) next to the numbers on this page.
