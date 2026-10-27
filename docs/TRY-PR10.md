# Try it: GitHub Actions and pull requests (PR 10)

Steps marked **FREE** cost nothing. Steps marked **GITHUB** need a real GitHub repository of yours. Steps marked **AI** also cost model money (the gap report on a small pull request; a few cents to a few dollars, I have not measured it on GitHub).
Nothing here has been run on real GitHub yet. Part 3 is the first real proof.

## Part 1. Run the tests (FREE)

1. `export QAS=~/Documents/qa-sentinel`
2. `cd $QAS && git fetch origin && git checkout pr10-github && npm ci && npm run build`
3. `npx vitest run test/github.test.ts test/githubProvider.test.ts`

Expect 2 files, all passing. They use a fake GitHub on your own computer, a fake AI and temporary folders. No internet and no git name or e-mail needed.

## Part 2. See the files init writes (FREE)

1. `mkdir /tmp/gh-try && cd /tmp/gh-try && git init -q`
2. `node $QAS/dist/cli.js init --yes --mode scratch --ci github --level intelligence --name try --test-repo-project YOUR_NAME/qa-tests`
3. Open `qa-sentinel.config.yaml`. Expect `ci.platform: github` and `ci.provider: github`.
4. Open `ci/qa-sentinel/qa-gap-report.yml`. Expect two jobs: `analysis` (read-only permissions) and `publish` (`pull-requests: write`, no `ANTHROPIC_API_KEY`).
5. `GITHUB_TOKEN=x node $QAS/dist/cli.js doctor` and look for "GitHub token set" (and no GitLab lines).

## Part 3. A real pull request (GITHUB, AI)

You need two repos of your own: a service repo (any small code repo) and a test repo (the one from Part 2, pushed to GitHub).

1. Push the Part 2 folder to GitHub as `YOUR_NAME/qa-tests` (private is fine).
2. **GITHUB.** In the service repo: Settings, Secrets and variables, Actions. Add variable `QA_TESTS_REPOSITORY` = `YOUR_NAME/qa-tests`. Add secret `ANTHROPIC_API_KEY`. If the test repo is private, add secret `QA_TESTS_READ_TOKEN` (a token with read access to it).
3. In the test repo config, make sure the service name equals the service repo's name (`workspace.services[].name`). Commit and push.
4. Copy `ci/qa-sentinel/qa-gap-report.yml` to `.github/workflows/qa-gap-report.yml` in the service repo. Commit to the default branch.
5. **GITHUB, AI.** Open a pull request in the service repo that changes some code. Wait for the workflow.
6. Expect: a comment on the pull request starting with "QA impact", ending with "Was this useful? 👍 / 👎". Both jobs green.
7. Push another commit to the pull request. Expect the **same** comment to be edited, not a second one.
8. Mark the pull request as a draft and push. Expect a short "waiting" note instead of a report (only if `automation.gapReport.when` is `ready`).
9. React with 👍 on the comment, then on your computer: `QA_SENTINEL_GITHUB_TOKEN=<a token that can read the repo> qa-sentinel metrics --online` in a folder that holds the run (download the `qa-gap-report` artifact into `.qa-sentinel/runs`). Expect the 👍 count in the table.
10. Tell me what broke. The things I could not check without GitHub: the real answers' field names, that the Actions token's comment is found again on step 7 (the job cannot ask `/user`), the artifact hand-over between the jobs, and the permissions of the `publish` job.

## Part 4. Open the test pull request (GITHUB)

Only the pull request step can be tried by hand; there is no workflow for generation yet.

1. `export QA_SENTINEL_GITHUB_TOKEN=<token with contents and pull requests write on the test repo>`
2. `node $QAS/dist/cli.js doctor --online` in the test repo folder. Expect "test repo (YOUR_NAME/qa-tests) reachable".
3. Run `generate --push` for a real change (AI, costs money, see the README) and expect a pull request labelled `qa-agent`, as Draft unless VERIFIED.
