# Try it: linking (PR 1)

These steps need **no AI**, no Jira and no GitLab. They use the ShopLite sandbox on your laptop and cost nothing.

## 0. Get the branch

1. `export QAS=~/Documents/qa-sentinel`
2. `cd $QAS && git fetch origin && git checkout pr1-linking && npm ci && npm run build && npm test` (all green)

## 1. Set up the sandbox

1. `rm -rf ~/qa-try1 && mkdir -p ~/qa-try1 && cd ~/qa-try1`
2. `node $QAS/sandbox/shoplite/local.mjs setup --level maintenance`
3. `node $QAS/sandbox/shoplite/local.mjs run SHOP-106 --change-only`
   This makes the developer change for story SHOP-106 (a branch in notifications-service). No AI runs.

## 2. Two branches in one service

1. `cd ~/qa-try1/shoplite-local/notifications-service`
2. `git checkout -b feature/SHOP-106-second-part main`
3. `echo x > second.txt && git add second.txt && git commit -m "second part, no key in this message"`
4. `git checkout main`
5. `cd ../qa-tests && node $QAS/dist/cli.js feature SHOP-106`

Expect two rows for `notifications-service`, one for `feature/SHOP-106-second-part` and one for `feature/SHOP-106-shipping-notice`. Both say "not yet" under Merged, and the status is "In development". Before this change only one row was shown, and the second branch (its commit has no story key) was not found.

## 3. Jira data stays out of git

1. Still in `~/qa-try1/shoplite-local/qa-tests`:
2. `git check-ignore .qa-sentinel/stories/x.json qa-stories.md qa-post-deploy.md`

Expect all three paths printed (each one is ignored). An older project gets the same lines with `node $QAS/dist/cli.js upgrade`.

## 4. Several stories in one merge request (needs Jira)

This step reads Jira (read only). It needs a Jira with the ShopLite stories: set one up with Part C of `docs/SANDBOX.md` (`jira-seed.mjs`), then run the sandbox `setup` of step 1 again with `JIRA_BASE_URL`, `JIRA_EMAIL` and `JIRA_API_TOKEN` set, so that `qa-sentinel.config.yaml` has `requirements.source: jira`. Without Jira the gap report cannot tell which stories the title names, and makes one report as before.

1. In `~/qa-try1/shoplite-local/qa-tests/qa-sentinel.config.yaml` set `requirements.jira.featureIssueTypes: [Story]` (this turns on bug-to-story linking). Keep `JIRA_EMAIL` and `JIRA_API_TOKEN` (or `JIRA_PAT`) exported.
2. The gap report analyses the commits of a branch, so put the service on the branch from step 1: `git -C ../notifications-service checkout feature/SHOP-106-shipping-notice`
3. Act as the merge request pipeline would. Use two real keys of your Jira (see `shoplite-local/.jira-keys.json`; below `SHOP-101` and `SHOP-102`):
   ```
   export CI_MERGE_REQUEST_TITLE="SHOP-101 SHOP-102 shared fix"
   export CI_MERGE_REQUEST_DIFF_BASE_SHA=$(git -C ../notifications-service rev-parse main)
   node $QAS/dist/cli.js gap-report --service notifications-service --dry-run
   ```

Expect "merge request names 2 stories" and "report 1" and "report 2" in the output. `--dry-run` reads Jira and the code but calls **no AI**, so it costs nothing and the report file has no analysis in it (the sections are empty). Without `--dry-run` the same command runs the AI once for each story (a small cost, and it needs Claude to be set up) and writes `qa-gap-report.md` with one section for each story; a story that could not be analysed says "not analysed" and why.

With a bug key whose parent is a story (the title `SHOP-210 shared fix`, say), the report says `SHOP-210 (Bug) → SHOP-12 via parent` and uses the story's acceptance criteria. Two bugs of one story are one report, and both bugs are shown as evidence. `requirements.multiKey: first` goes back to one report, and `requirements.maxKeysPerMr` (default 3) caps the number of reports: the report names the stories left out.

In the pipeline of a real merge request (with `--post`), the joined comment carries a hidden stamp: push again without changing the code or the stories, and the job says "nothing changed" and makes no AI run. `--refresh` makes new reports anyway.
