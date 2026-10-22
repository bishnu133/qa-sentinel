# Try it: story record, merge-request sweep, story change, bug fix (PR 2)

Steps 1 to 4 need **no AI, no Jira and no GitLab**. They use the ShopLite sandbox on your laptop and cost nothing. Step 5 needs your real GitLab and Jira (read only).

## 0. Get the branch

1. `export QAS=~/Documents/qa-sentinel`
2. `cd $QAS && git fetch origin && git checkout pr2-story-record && npm ci && npm run build && npm test` (all green)

## 1. Set up the sandbox

1. `rm -rf ~/qa-try2 && mkdir -p ~/qa-try2 && cd ~/qa-try2`
2. `node $QAS/sandbox/shoplite/local.mjs setup --level maintenance`
3. `node $QAS/sandbox/shoplite/local.mjs run SHOP-106 --change-only`
   This makes the developer change for story SHOP-106 (a branch in notifications-service).

## 2. Merge a story in two steps, with other work in between

1. `node $QAS/sandbox/shoplite/local.mjs merge SHOP-106`
   This merges part 1 of the story into main of notifications-service.
2. `cd ~/qa-try2/shoplite-local/notifications-service`
3. `echo other > unrelated.txt && git add unrelated.txt && git commit -m "SHOP-999 unrelated work"`
4. `echo more > followup.txt && git add followup.txt && git commit -m "SHOP-106 follow-up: footer text"`
5. `cd ../qa-tests`
6. `node $QAS/dist/cli.js gap-report --story SHOP-106 --dry-run`
   It does not call the AI. It only prints what it would ask. Look for the line `story SHOP-106: notifications-service (2 file(s))`: one part for the service with the files of both merge requests.
7. `grep -n "^# =====\|^diff --git" $(ls -d .qa-sentinel/runs/*gap-story-SHOP-106 | tail -1)/change.diff`

Expect one line starting with `# =====` followed by two lines starting with `# -----` (one per merge request) and these files after them: `followup.txt` and `src/server.js` (in some order). There is no `unrelated.txt`. Before this change the follow-up commit made the first part disappear, or the unrelated work came in.

## 3. A bug fix is deployed: its feature's tests run again

This step starts the sandbox environment on your laptop.

1. `cd ~/qa-try2/shoplite-local/notifications-service`
2. `echo fix > fix.txt && git add fix.txt && git commit -m "SHOP-210 fix: wrong footer"`
3. `node $QAS/sandbox/shoplite/local.mjs env start` (run it from `~/qa-try2`; it starts the services at this commit)
4. `cd ~/qa-try2/shoplite-local/qa-tests`
5. Make a test for the fix. Copy these lines into `tests/api/footer.spec.ts`:
   ```
   import { test, expect } from "@playwright/test";
   test("the footer fix holds @service:notifications-service @story:SHOP-106 @bug:SHOP-210 @ac:AC-1", async ({ request }) => {
     const res = await request.get(`${process.env.QA_BASE_URL}/notifications/version`);
     expect(res.ok()).toBe(true);
   });
   ```
6. `N=../notifications-service; node $QAS/dist/cli.js post-deploy --env local --service notifications-service --sha $(git -C $N rev-parse HEAD) --before $(git -C $N rev-parse HEAD~1)`

Expect `SHOP-210: every part is deployed on local; running 1 test(s)` and `SHOP-210: tests passed`. The key SHOP-210 was found in the deployed commit, and its `@bug:SHOP-210` test ran. Before this change a key with no `@story` test was dropped and nothing ran.
With Jira connected the bug is looked up: if its parent is SHOP-106, the report says `re-run: fix SHOP-210 (Bug → SHOP-106) deployed` and runs every SHOP-106 test as well (see step 5).

7. `cat .qa-sentinel/stories/SHOP-210.json` shows a `results` entry with the environment `local`, the time and `passed`.
8. Stop the environment: `cd ~/qa-try2 && node $QAS/sandbox/shoplite/local.mjs env stop`

## 4. The story record is ignored by git

1. `cd ~/qa-try2/shoplite-local/qa-tests`
2. `git status --short` must not list anything under `.qa-sentinel/`.

## 5. Your real GitLab and Jira (you do this one; it only reads)

1. In your test repo set `requirements.source: jira`, the Jira settings, and `ci.gitlabUrl`. Give every service its `gitlabProject`. Set `QA_SENTINEL_GITLAB_TOKEN` (read_api is enough) and `JIRA_EMAIL` and `JIRA_API_TOKEN` (or `JIRA_PAT`).
2. `qa-sentinel stories --json > /dev/null`
   Expect in the log: `looking at merge requests updated since …`, then `sweep: N merge request(s) …, M story record(s) updated`. If an MR has no story key you see `MRs with no story key: !12 orders-service`.
3. `cat .qa-sentinel/stories/<A-STORY-KEY>.json` (or `jq .parts` on it). Expect one entry in `parts` for each MR of that story, in every service. A bug that points to the story at its parent shows in `linked`.
4. Run the same command again. Expect the log to start from about 24 hours before the first run (the file `.qa-sentinel/stories/_sweep.json` holds the time).
5. `qa-sentinel stories --rebuild` fills the records again from the last 365 days.
6. For the bug fix: run `qa-sentinel post-deploy --env <env> --service <service> --sha <deployed sha> --before <previous sha>` for a deployment that had only a bug fix. Expect `re-run: fix SHOP-… (Bug → SHOP-…) deployed` and the story's tests running.
7. **Needs real Jira and GitLab (not in the sandbox):** a bug fix is deployed while its feature still has another merge request open. Pick a Story SHOP-A that has one merged MR and one open MR, and a Bug under it (parent = SHOP-A) with a `@bug:<BUG>` test. Run `post-deploy` for the bug's deployed commit. Expect `## SHOP-A: tests passed` with `re-run: fix <BUG> (Bug → SHOP-A) deployed`, not "not merged yet", and the bug's test and SHOP-A's tests in the run. A bug with no tests anywhere is shown as "no tests tagged" straight away, without waiting.
