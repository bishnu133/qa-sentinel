# Try it: Jira status comment modes, "out of date" marks, notifications, `/qa ready` (PR 4)

Part 1 needs **nothing**: no AI, no Jira, no GitLab. It costs nothing.
Part 2 writes real comments on a real Jira story. **Use a test project, never a project your team works in.**
Nothing in this PR calls the AI, so no step costs model money. Steps in Part 2 only cost a few Jira API calls.

Every step says if it needs a real system.

## Part 1. Run the tests (free, no real systems)

1. `export QAS=~/Documents/qa-sentinel`
2. `cd $QAS && git fetch origin && git checkout pr4-jira-status && npm ci && npm run build`
3. `npx vitest run test/jiraMode.test.ts test/notify.test.ts test/overrides.test.ts test/statusComment.test.ts test/storiesJira.test.ts test/jiraIdentity.test.ts test/showcase.test.ts`

Expect: 7 files, all tests passing. The tests start a small fake Jira on your own computer. The fake Jira keeps
comments with their authors, including comments from other people that contain qa-sentinel's marker text. One test checks
that qa-sentinel never changes or deletes a comment written by somebody else.

## Part 2. A real Jira (you do this part)

**Needs a real Jira. Writes comments. Use a test project.** Costs: no AI money, a few Jira API calls.

You need: a test story, say `TEST-101`, in a status like "In Progress" or "Ready for QA"; the Jira settings in
`qa-sentinel.config.yaml` (`requirements.jira.baseUrl`) and your Jira login in the environment
(`JIRA_EMAIL` and `JIRA_API_TOKEN` for Jira Cloud, or `JIRA_PAT` for Jira Data Center).
Use the same Jira user for every qa-sentinel command below. That user is "qa-sentinel" in these steps.
To play "another person" you comment from your own browser, signed in as yourself, if your token belongs to a different account.
(If the token is your own account, create a second Jira user, or ask a colleague. A comment written by the token's own user is treated as qa-sentinel's own.)

### A. Old comments move into the status comment

1. In `qa-sentinel.config.yaml` set:
   ```yaml
   reporting:
     jira: { mode: legacy }
   ```
2. `cd` to your test repo and run `npx qa-sentinel feature TEST-101 --post`.
   Look at TEST-101 in Jira. There is one comment that ends with `qa-sentinel:feature`. This stands for a comment from an older version.
3. In your browser, add a comment from the other person that contains the text `qa-sentinel:feature` (for example: `I copied qa-sentinel:feature by mistake`).
4. Change the config to `mode: status` (or remove the `mode` line; status is the default).
5. Run `npx qa-sentinel feature TEST-101 --post` again.

Expect: a new comment "QA status · TEST-101" with a Feature section. The old qa-sentinel comment now says one line:
`Replaced by the QA status comment: <link>`. The other person's comment is **unchanged**. Nothing was lost:
the text of other old comments (a gap report, a post-deploy report) is now a section of the status comment.
Run the command once more: nothing else changes.

6. Optional: to see `delete`, repeat A with `cleanup: delete` on a second test story. If your Jira does not let this user delete comments, qa-sentinel says so and makes a pointer instead.
7. Optional: `cleanup: keep` leaves the old comments alone.
8. Optional, the same on a story that already has a status comment: set `mode: both`, run the command, then set `mode: status` and run it again. The legacy comment becomes a pointer.

If Jira will not tell qa-sentinel who its token belongs to (for example a token with no permission to browse), qa-sentinel writes nothing and says so.
Run `npx qa-sentinel doctor --online` first: it prints "Jira user: ..." when all is well.

### B. "Out of date" marks

**Owner only. Needs a real Jira test project.** The marks need qa-sentinel to remember the story between runs, so run all the steps from the same folder.
This way works without GitLab (you change the story's acceptance criteria in Jira):

1. Run `npx qa-sentinel stories --story TEST-101 --no-sweep`. This remembers the story's acceptance criteria in `.qa-sentinel/stories/TEST-101.json` (this folder stays out of git).
2. Run `npx qa-sentinel feature TEST-101 --post` (or `post-deploy --post`, or `gap-report --post`). The section it writes remembers the story as it is now.
3. In Jira, change the text of one acceptance criterion of TEST-101.
4. Run `npx qa-sentinel stories --story TEST-101 --no-sweep` again.

Expect: the status comment now shows a red first line `Out of date: new code was merged or the ACs changed after this was written` on the section from step 2.
Sections written by an older version are not marked. Run step 4 again: no new edit. `stories` used no AI.

With GitLab (also owner only): configure the services' `gitlabProject` and `QA_SENTINEL_GITLAB_TOKEN`, run `npx qa-sentinel stories --story TEST-101` (this reads the merge requests), run step 2, merge another change for the story, and run `stories` again. The mark names the merge ("orders !12 merged 2026-10-22").
In CI the record must be kept between runs (`automation.record: jira`, or cache `.qa-sentinel/stories/`), or there is nothing to compare with.

### C. `/qa ready AC-1`

**Owner only. Needs a real Jira test project and two Jira users.**

1. In Jira, as the other person, comment: `/qa ready AC-1 checked on a device`.
2. Run `npx qa-sentinel stories --story TEST-101 --no-sweep --json`.

Expect: the JSON for the story has `overrides` with AC-1 and that person's name (the story record keeps it too).
If the status comment already exists, it has a "Waiting" section at the top: `AC-1 marked ready by <name> on <date>`.
If a service the AC needs has no change yet, the line also says what is skipped: `this skips: payments has no change`.
3. Comment `/qa ready AC-99` (an AC the story does not have): it is ignored and the Waiting section says so.
4. Comment `/qa unready AC-1`, run step 2 again. The override and its line are gone.
5. To limit who can do this, set `reporting.jira.override.allowed: ["<Jira account id or username>"]` and repeat: other people are ignored.

Note: this only lets tests for the AC be **written** (it replaces the wait for the Jira status or for a service with no change). It never skips an open merge request or a revert.

### D. Notifications

1. Set, with your own Jira account id (Cloud) or username (Data Center):
   ```yaml
   reporting:
     jira:
       notify:
         ac-not-built-but-ready: { on: true, to: ["<your account id or username>"] }
   ```
2. You need a story in a ready status ("Ready for QA") whose latest generate run said an AC is not built. If you do not have one, skip this step; the automated tests cover it.
3. Run `npx qa-sentinel stories --story TEST-101 --no-sweep`. You get one new short comment that mentions you, and (if Jira email is on) a notification.
4. Run it again. No second comment.

The other events are `showcase-ready` (on by default; if its list is empty it tags `showcase.notify`), `cross-service-tests-ready`, `stopped-by-budget` and `merge-conflict`. Turn each on the same way, with its own `to` list: only `showcase-ready` falls back to `showcase.notify`.

### E. Showcase

1. Run `npx qa-sentinel showcase --story TEST-101` after a passing test run (see the showcase docs). In `status` mode the summary is a section of the status comment and the people in `showcase.notify` get their own short comment.
2. Set `showcase.reattachOnChange: true` to attach fresh evidence automatically when the code changed after the evidence. Leave it off to just see "Evidence older than the latest change" in `qa-showcase.md`.

## What to send back

For A to D: did the pointer, the mark, the override and the notification appear as described? Any step where a comment by another person was changed is a bug: please send the Jira comment's text and the command you ran.
