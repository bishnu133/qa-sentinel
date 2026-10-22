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

## 4. Several stories in one merge request (needs a real Jira)

This step reads Jira (read only) and runs the AI once per story, so it costs a little. Skip it if you only want the free steps.

1. Set `requirements.source: jira`, `requirements.jira.baseUrl`, `projectKeys` and `featureIssueTypes: [Story]` in `qa-sentinel.config.yaml`. Set `JIRA_EMAIL` and `JIRA_API_TOKEN` (or `JIRA_PAT`).
2. Put two story keys in the title of a merge request, for example `SHOP-101 SHOP-102 shared fix`, and run the gap report in that MR's pipeline (or set `CI_MERGE_REQUEST_TITLE` by hand and run `qa-sentinel gap-report --service orders-service --dry-run`).

Expect "merge request names 2 stories" in the output and one report for each story. With a bug key whose parent is a story, the report says `SHOP-210 (Bug) → SHOP-12 via parent` and uses the story's acceptance criteria. `requirements.multiKey: first` goes back to one report.
