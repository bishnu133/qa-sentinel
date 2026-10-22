# Try it: one test merge request per story, end-to-end tests per AC, `stories --act` (PR 3)

Steps 1 to 3 need **no AI, no Jira and no GitLab**: they cost nothing and run on your laptop.
Steps 4 and 5 start a real AI run (about $1 to $5 each at today's defaults). Step 6 needs your real GitLab and Jira.
Every step that needs a real system or costs money says so.

## 1. Get the branch and run the tests (free)

1. `export QAS=~/Documents/qa-sentinel`
2. `cd $QAS && git fetch origin && git checkout pr3-story-test-mr && npm ci && npm run build`
3. `npx vitest run test/storyMode.test.ts test/storyBranch.test.ts test/writeReadiness.test.ts test/storiesAct.test.ts test/cloneServices.test.ts`

Expect: 5 files, 76 tests, all passing. They build a real test repo, two service repos and a "server" (a bare git repo),
and walk story SHOP-101 step by step with a fake AI. A mock GitLab and a mock Jira stand in for the real ones.

## 2. Set up the sandbox and merge a story (free)

1. `rm -rf ~/qa-try3 && mkdir -p ~/qa-try3 && cd ~/qa-try3`
2. `node $QAS/sandbox/shoplite/local.mjs setup --level maintenance`
3. `node $QAS/sandbox/shoplite/local.mjs run SHOP-106 --change-only`
4. `node $QAS/sandbox/shoplite/local.mjs merge SHOP-106`

## 3. See what the background check would start (free)

1. `cd ~/qa-try3/shoplite-local/qa-tests`
2. `mkdir -p stories`
3. Make a story file: `printf '# SHOP-106 Footer text\n\n## Acceptance criteria\n- AC-1: The email footer shows the shop name.\n' > stories/SHOP-106.md`
4. Save it in git, so the test repo is clean (qa-sentinel refuses to run on a repo with uncommitted changes): `git add stories && git commit -m "add the story file"`
5. `node $QAS/dist/cli.js stories --stories-dir stories --act --dry-run`

Expect a table with `SHOP-106  needs-expectations`, and at the end this line:
`would start: qa-sentinel generate --story SHOP-106 --push --once (the expected behaviour first, then the tests, on the story branch)`.
That line is exactly the command that would run. Nothing was started. Without `--dry-run` it would start at most 3 jobs that
really start AI work (`automation.act.maxJobsPerCheck`); a job that finds nothing to do does not use one up.
Without `--act` it never starts anything. (`--dry-run` without `--act` is an error.)

## 4. One test branch for the story (needs Claude, costs money)

You need the `claude` command logged in. `generation.scope: story` is the default. The story file from step 3 gives the story key and the AC.

1. `cd ~/qa-try3/shoplite-local/qa-tests` (the story file is committed, from step 3, so the repo is clean)
2. `node $QAS/dist/cli.js generate --service notifications-service --base HEAD~1 --story-file stories/SHOP-106.md`
   (no `--push`, so nothing leaves your laptop). Add `--dry-run` first to see the start without any AI call.
3. `git branch` shows `qa-sentinel/story-SHOP-106`. The log says which ACs were planned and which "wait for" another service.
4. Pretend to be a reviewer: `echo "please also check the empty case" > REVIEW.md && git add REVIEW.md && git commit -m "reviewer: note"`
5. Make a second change for the story: `cd ../notifications-service && echo more > more.txt && git add more.txt && git commit -m "SHOP-106 part 2: more" && cd ../qa-tests && git checkout main`
6. Run the command of step 2 again.
7. `git log --oneline qa-sentinel/story-SHOP-106`

Expect: the same branch, your "reviewer: note" commit is still in the log, and the new test commit sits on top.
The branch was never rebuilt. If you use a bare repo as `origin` and add `--push`, qa-sentinel pushes with a lease: it
never overwrites a commit somebody else pushed.

## 5. A conflict with main (free after step 4)

1. `git checkout main`, change a file that the story branch also changed (for example the test file the run added), and commit it on `main`.
2. Run the generate command of step 4 again.

Expect: `merging main into qa-sentinel/story-SHOP-106 conflicts in <file>` and exit code 1. Nothing was pushed, the AI was not
called, and your folder is back on the branch you started on. You resolve the conflict by hand (merge main into the story branch).
This stop is not counted as a failed attempt of the job, so after you fixed it the next run needs no `--force`.

## 6. Your real GitLab and Jira (you do this one)

1. Set `ci.testRepoProject` and a GitLab token (`QA_SENTINEL_GITLAB_TOKEN`) as you do for `generate --push` today.
2. Merge one service part of a two-service story. Wait for the `qa-generate` job. One merge request opens: `QA agent: tests for story KEY`.
   Its description has a "Waiting ACs" list.
3. Merge the second part. The same merge request gets a new commit (no second merge request). With the default
   `generation.crossService: when-ready-status`, the end-to-end tests of an AC that needs both services are written only once the Jira card is in a ready status
   (`requirements.jira.workflow.readyStatuses`). Set `when-ac-complete` to skip that wait.
4. Close the story merge request without merging, then merge a new part. A new branch and merge request start from main, and the description names the old one.
5. Add a schedule that sets `QA_STORIES=true` (hourly is fine). The `qa-stories` job runs `qa-sentinel stories --act --clone-services`: it clones the
   service repos (every service in `workspace.services` that has a `gitlabProject`) next to the test repo with the job token. Allow that token in each service
   project (Settings > CI/CD > Job token permissions). Exit code 4 (a budget or a failed-too-often limit) shows as a warning, not a failure.
   The story records are cached between runs (also when the job fails). Check the log of the first run: it must say `cloned <your services>`,
   and `qa-stories.md` (an artifact) must list your stories. For records that must never depend on a runner cache, set `automation.record: jira`.
6. Check that git has no Jira data: `git ls-tree -r --name-only origin/qa-sentinel/story-KEY` shows no `.qa-sentinel/` and no `qa-stories.md`.

Jenkins: the `Stories (background check)` stage in `Jenkinsfile.tests` is a template only. It is not proven on a real Jenkins server.
