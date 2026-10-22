# Try it: Jira status comment modes, "out of date" marks, notifications, `/qa ready` (PR 4)

Part 1 needs **nothing**: no AI, no Jira, no GitLab. It costs nothing.
Part 2 writes real comments on a real Jira story. **Use a test project, never a project your team works in.**
Nothing in this PR calls the AI, so no step costs model money. Steps in Part 2 only cost a few Jira API calls.

Every step says if it needs a real system.

## Part 1. Run the tests (free, no real systems)

1. `export QAS=~/Documents/qa-sentinel`
2. `cd $QAS && git fetch origin && git checkout pr4-jira-status && npm ci && npm run build`
3. `npx vitest run test/jiraMode.test.ts test/notify.test.ts test/overrides.test.ts test/statusComment.test.ts test/storiesJira.test.ts test/showcase.test.ts`

Expect: 6 files, all tests passing (52 tests). The tests start a small fake Jira on your own computer. The fake Jira keeps
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

### A. Old comments become pointers

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
`Replaced by the QA status comment: <link>`. The other person's comment is **unchanged**.
Run the command once more: nothing else changes.

6. Optional: to see `delete`, repeat A with `cleanup: delete` on a second test story. If your Jira does not let this user delete comments, qa-sentinel says so and makes a pointer instead.
7. Optional: `cleanup: keep` leaves the old comments alone.

### B. "Out of date" marks

1. The status comment from A has a section written by `feature`. Merge another change for the story (or run on a story that has more than one merge request), so the story's merged code changes.
2. Run `npx qa-sentinel stories --story TEST-101` (add `--no-sweep` if you do not use GitLab).

Expect: the comment now shows a red first line `Out of date: new code was merged or the ACs changed after this was written (...)` on result sections written before the change.
Sections written by an older version (no basis) are not marked. Run the command again: no new edit. `stories` used no AI.
Editing the story's acceptance criteria in Jira and running `stories` again gives the same kind of mark.

### C. `/qa ready AC-1`

1. In Jira, as the other person, comment: `/qa ready AC-1 checked on a device`.
2. Run `npx qa-sentinel stories --story TEST-101 --json`.

Expect: the JSON for the story has `overrides` with AC-1 and that person's name (the story record `.qa-sentinel/stories/TEST-101.json` keeps it too; that folder stays out of git).
The status comment has a "Waiting" section at the top: `AC-1 marked ready by <name> on <date>`.
3. Comment `/qa unready AC-1`, run step 2 again. The override and the line are gone.
4. To limit who can do this, set `reporting.jira.override.allowed: ["<Jira account id or username>"]` and repeat: other people are ignored.

Note: this only lets tests for the AC be **written** (it replaces the wait for the Jira status). It never skips an open merge request.

### D. Notifications

1. Set, with your own Jira account id (Cloud) or username (Data Center):
   ```yaml
   reporting:
     jira:
       notify:
         ac-not-built-but-ready: { on: true, to: ["<your account id or username>"] }
   ```
2. You need a story in a ready status ("Ready for QA") whose latest generate run said an AC is not built. If you do not have one, skip this step; the automated tests cover it.
3. Run `npx qa-sentinel stories --story TEST-101`. You get one new short comment that mentions you, and (if Jira email is on) a notification.
4. Run it again. No second comment.

The other events are `showcase-ready` (on by default; tags `showcase.notify`), `cross-service-tests-ready`, `stopped-by-budget` and `merge-conflict`. Turn each on the same way.

### E. Showcase

1. Run `npx qa-sentinel showcase --story TEST-101` after a passing test run (see the showcase docs). In `status` mode the summary is a section of the status comment and the people in `showcase.notify` get their own short comment.
2. Set `showcase.reattachOnChange: true` to attach fresh evidence automatically when the code changed after the evidence. Leave it off to just see "Evidence older than the latest change" in `qa-showcase.md`.

## What to send back

For A to D: did the pointer, the mark, the override and the notification appear as described? Any step where a comment by another person was changed is a bug: please send the Jira comment's text and the command you ran.
