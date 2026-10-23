# Automation: the background check, job keys and budgets (phase 2)

This is what lets qa-sentinel run from a schedule or a pipeline without you watching: it checks every story without
AI, knows what it already did, and cannot spend more than you allow.

## The background check (`qa-sentinel stories`, no AI)

```bash
qa-sentinel stories                         # stories from Jira (requirements.jira.search)
qa-sentinel stories --stories-dir ../stories # stories from markdown files (no Jira)
qa-sentinel stories --story SHOP-101 --json  # one story, machine-readable (stdout is only JSON)
```
For each story it works out one state and the next step, using fixed rules (no AI):

| State | Meaning | Next |
|---|---|---|
| skipped | opt-out label (`qa-skip`), not a feature type, or not in an approved status | nothing |
| needs-attention | no acceptance criteria, or the `expected/` file can't be read | a person fixes the story or file |
| needs-expectations | some ACs have no current expected behaviour | `spec` (AI) |
| needs-tests | expectations ready, ACs without tests | `generate` (AI), or wait if the code isn't merged |
| needs-cross-service-tests | an AC that needs several services has all of them merged (and, by default, a ready Jira status) but no end-to-end tests yet | `generate --story KEY --acs AC-1` (AI) |
| needs-triage | tests exist but are `fixme`/`skip` | QA decides |
| covered | every AC has a test, a known defect, or is untestable | nothing |

The to-do list says who acts (ai / qa / po / dev), the command, and why a step is **blocked** (budget reached, job
already ran, too many failed attempts). Questions for the PO never block. Output: `qa-stories.md`, and one record
per story under `.qa-sentinel/stories/`. Without `--act`, `stories` never starts an AI step; a scheduler or a person runs the command it names. With `--act` it starts the AI steps that are due (see "One test merge request per story").
With GitLab it first runs the merge-request sweep (below).

Jira settings (`requirements.jira.search`): `jql` (own query), `lookbackDays` 30, `maxStories` 50, `skipLabels`
`[qa-skip]`, `onlyLabels`, `api: auto|cloud|server`. Without `jql` you need `requirements.jira.projectKeys`. Statuses are filtered by qa-sentinel (`approvedStatuses`), not in the JQL, because a status name your workflow doesn't have makes Jira reject the whole query.

## The story record

`.qa-sentinel/stories/<KEY>.json`: AC hashes, the last check, AI jobs and what they cost. It is a **cache**: the truth is always recomputed from Jira, `expected/` and the tests. Delete it and you lose job history and spend counts, not a decision. A damaged file is moved aside (`.damaged-<time>`) and a new one started.
`automation.record: jira` also keeps a copy in the Jira issue property `qa-sentinel.record`, so a CI runner without a cache still knows. If Jira can't be reached the run goes on with the local file and says so.

## Story record and sweep

The record `.qa-sentinel/stories/<KEY>.json` holds, besides the AC hashes, the last check, the AI jobs and the spend:

- `parts`: every merge request (or branch) of the story, one entry per MR, with its service, number, state (opened, merged, closed, reverted), branch, head, merge or squash commit and when it was first and last seen. A closed MR stays in the list and is shown as "dropped".
- `linked`: the bugs, tasks and sub-tasks that were reached from this story, and how (parent or link).
- `results`: the last post-deploy results per environment (the newest 5 each), with the basis they were run against.
- `basis`: a short fingerprint of the merged commits and the AC hashes. When it changes, what was reported earlier was written against older code or ACs.
- Empty for now, filled by later steps: `agentMr`, `crossService`, `acEvidence`, `notified`, `overrides`.

It is a **cache**. Everything in it can be found again from GitLab and Jira. Delete a record and you lose job history and spend counts. To fill the parts again run `qa-sentinel stories --rebuild` (the sweep looks back 365 days).

**The sweep** makes `stories` aware of merge requests without cloning anything: for every service with `gitlabProject` it asks GitLab once (paged) for the merge requests updated since the last check. The last check is stored in `.qa-sentinel/stories/_sweep.json`; the next sweep starts `automation.sweep.overlapHours` (24) before it, so a merge request that changed while the last check ran is not missed. The first sweep looks back `requirements.jira.search.mrLookbackDays` (30). Each MR is matched to every story key in its title, branch or description. A bug, task or sub-task goes to its story by the fixed Jira rules, and the card is kept in `linked`. A key that is not in Jira is skipped with a note. Stories whose merge requests changed are checked even when the Jira search did not list them. Merge requests with no key are listed as a warning ("MRs with no story key: !12 orders-service"). Merge requests are read oldest first. If a GitLab call fails, the sweep does not move its "last check" forward, so the next run tries the same window again. If `maxPages` cuts the list, the sweep says so and the "last check" moves only to the last merge request it read, so the next run goes on from there. The "last check" also stays where it was when `stories` then stops (for example "Nothing to check"). A branch name is read case-insensitively for the configured `projectKeys` (`feature/shop-106-x`, `SHOP-106_notice`). A card that reaches no feature and is not a feature itself (a loose bug) is not recorded as a story. **The "last check" file is local to the runner**, also with `automation.record: jira` (only the records are in Jira): cache `.qa-sentinel/stories` between CI runs, or every run looks back `mrLookbackDays` (a warning says so). `--rebuild` ignores the stored time and looks back 365 days; it does not delete records.

Settings: `automation.sweep.enabled` (true), `overlapHours` (24), `maxPages` (5 pages of 100 MRs per repository). `stories --no-sweep` skips it.

The gap report also records its own merge request the first time it sees it, so later steps know the MR and its head without a story key in a commit message.

**The story's change** (`gap-report --story`, `generate --story`) is the union of what each merge request changed, not everything since the first story commit: a merge commit gives `M^1..M`, a squash commit `S^..S`, a rebased or fast-forwarded MR its `diff_refs` range (the list call has none, so the sweep asks GitLab for the single MR once and keeps the base in the record; without it the commit messages on the target branch are read and the note says so), an open MR the range from the merge base of the target branch to its head (fetched from `refs/merge-requests/<n>/head`, with the token only on the command line, never in `.git/config`). Without a record or GitLab it walks the last 500 commits of the target branch and takes every commit (or merge) that names the story, as its own range, so unrelated work merged in between stays out, and a branch that merged main into itself does not bring main's commits. A part whose commit is not in the local clone is skipped with a note ("fetch the target branch"). The merge requests of one service are one part (all their ranges, with one sub-header per range in the diff). The parts come from GitLab or the local clones; the story record adds the merge requests it knows (matched on service and MR number), so a commit the record does not list is still included. A part, or a range found in the commit messages, that a later "This reverts commit <sha>" commit reverted is left out with a note; this needs the revert to be in the local clone of the target branch.

**After a deployment** (`post-deploy`) every story key in the deployed commits counts, not only keys that already have tests. Each key goes to its feature (a bug or task fix runs its story's tests again), and the tests run are the feature's `@story:` tests plus the tests tagged `@bug:<KEY>` for the deployed fix. The report says why ("re-run: fix SHOP-210 (Bug → SHOP-12) deployed"). A feature with no tests is reported as "no tests tagged" at once (no waiting for deployment, and it does not count toward exit 75). A deployed bug fix is checked even while its feature has another MR open. A commit with no key (a squash titled without it) is matched through the recorded merge requests, then through GitLab's "merge requests of a commit". Without Jira the keys are used as they are. The result is written to the story record.

## One test merge request per story

Setting: `generation.scope: story` (the default) | `service`.

**What happens.** When a service change is merged and its commits or merge request name a story, qa-sentinel does not open a new test merge request for that merge. It adds the tests to one long-lived branch for the story, `qa-sentinel/story-KEY` (`generation.branchPrefix`), and one merge request for it. A change with no story key keeps its own branch, `qa-sentinel/<service>-<sha>`.

**What waits, and why.** Each acceptance criterion needs one or more services (the "Services" line of its entry in `expected/KEY.md`; if it is empty, the services of the card's Jira components plus every service that has a change in the story).
- An AC that needs **one** service gets its tests when that service merges.
- An AC that needs **several** services waits until every one of them is merged. By default (`generation.crossService: when-ready-status`) it also waits for the Jira card to be in a ready status (`requirements.jira.workflow.readyStatuses`); `when-ac-complete` does not look at the status. A story file with no Jira status counts as ready.
- A service with no change found yet, an open merge request, a revert: the AC waits. An open merge request that nobody has updated for `generation.staleMrDays` (30, 0 = never) days is treated as abandoned: it neither holds an AC back nor makes it a cross-service one (the readiness reason says which merge request was not waited for). The merge request description lists the waiting ACs and what each waits for. A person can mark an AC ready with an override (it never skips an open merge request or a revert; it can skip a service that has no change, and the status comment's `pending` section says so).
- At most `generation.maxAcsPerRun` (5) ACs are planned in one run; the rest wait for the next run.
- The planner is told which ACs to plan (`acScope`) and which wait (`heldAcs`). A plan that cites a waiting AC is rejected, and a waiting AC needs no scenario.

**The branch is built on, never rebuilt.** Each run takes the branch from the server, merges the main branch into it, adds its commit and pushes. The push uses `--force-with-lease` with the commit the run started from, so a commit a reviewer pushed meanwhile is never overwritten: it is fetched, merged in, and the push tried once more. A plain `--force` is never used on a story branch. The planner and the author work on the branch, so they see the tests already there and do not write them twice. `expected/KEY.md` is read from the branch too: a reviewer's edits to it are the reviewed version, and the expectation lock protects them.

**A run stops, before any AI call, when the branch cannot be built on.** Nothing is pushed, the merge request gets a note, the run exits 1, and the job is marked *aborted*: it does not count as a failed attempt, so once a person has fixed the cause the next check runs without `--force`. The cases:
- the main branch conflicts with the story branch (a person merges main into the story branch and pushes; the AI never resolves conflicts);
- the main branch was rewritten (rebased or force-pushed) after it was merged into the story branch, so merging it again would put every commit in twice (found from the main commit named in qa-sentinel's own merge commits);
- the merge request is open but its branch is gone (deleted, or the server could not be asked): a new branch from main would leave the reviewers' work behind;
- the branch exists here and on the server with different commits.

**A closed or merged story merge request is not reopened.** The next run starts a new branch from main with the same name and a new merge request; its description links the old one. The rejected tests are not on main, so the planner does not see them, and what the story record says was written on the old branch (`crossService`, `singleService`, `agentMr`) is cleared, so those ACs are written again. If the branch has several merge requests, an **open** one always wins (the branch is continued, whichever merge request was updated last); only "none open, the newest by creation time is closed or merged" starts again. A branch that no longer exists (and has no open merge request) also starts again from main.

**No duplicate runs.** In story scope, every run gets the same job key for the same work, however it was started (a merge pipeline, `generate --story KEY`, `--acs`, `stories --act`): `generate:KEY:acs-<ACs>:<digest of the merged commits of the services those ACs need>:<digest of all AC texts>`. If the run writes any cross-service AC, the key is made of the cross-service ACs alone (and the commits of the services they need); otherwise of the single-service ACs it plans. A second run with the same key is skipped when the first is done (in CI; `--once` outside it), and is not started while the first still runs. On top of the key, the story record keeps what was written: an AC whose tests were written for the same merged commits and the same AC text (`crossService` for ACs that need several services, `singleService` for the others) is not planned again, also when `--acs` names it; only `--force` plans it again. A new merge of one of its services, or a changed AC text, brings it back. The record is written only after the push succeeded (a refused push leaves nothing marked as written), and also for ACs the plan found nothing to change for. Only one generate job of a story runs at a time, because two would write the same branch. Budgets apply as always. `stories` reads the same things as `generate`: the story branch (its `expected/KEY.md` and the tests on it, while its merge request is open), the merge requests the record knows, and the same Jira-component mapping; an AC whose tests are already on the story branch is not due again, and an AC that cannot be written yet (waiting for a merge or for the status) starts nothing.

**Other open agent merge requests.** Before planning (in both scopes) the open merge requests labelled `qa-agent` in the test repo, other than this story's own, are listed with the spec files they add (`run/open-agent-mrs.md`); the planner is told, and a `create` decision whose `targetFile` one of them adds is rejected. Because the plan may leave `targetFile` out, the files the author really wrote are checked too: a new file at a path another open agent merge request adds (another story's, or a per-merge one with no story) is a guardrail violation and the run is rejected.

**`generation.scope: service`** keeps the per-merge branches and merge requests.

**`generate --story KEY`** plans the story's ready ACs (a story whose changes were all reverted is left alone: "nothing to generate"). `--acs AC-1,AC-3` plans only those: an id the story does not have is an error, a waiting AC is refused unless `--force`, and one already written for these commits is skipped unless `--force`. `--acs` needs `--story`. A story with no acceptance criteria that qa-sentinel can read is planned from the change itself (as a per-merge run would), on the story branch.

### `stories --act`

`qa-sentinel stories --act` runs the background check and then starts the AI steps that are due, one after the other, through the normal job keys, locks and budgets. At most `automation.act.maxJobsPerCheck` (3) jobs **start** per run: a job that turns out to be nothing to do (the same work is already done or running, nothing is ready yet) is not counted. What it starts is printed exactly, flags included (`generate --story KEY --push --once`). Exit code 0: every job that started ended done, or nothing was due, or the job was skipped because the same work is done or running; 4: a limit stopped a job (a budget, or the job failed too often with these exact inputs); 1: a job failed. `--act --dry-run` prints what it would start (`--dry-run` without `--act` is an error). The test repo is put back on the branch, or the detached commit, it started on after each story. For a story whose expected behaviour is due and whose code is merged, the story's generate run does the requirements pass itself and commits the file on the story branch (so it is reviewed in the story merge request); with no merged code yet it runs `spec`, which writes the file in the working tree only.

**In CI (GitLab).** The `qa-stories` job (a schedule with `QA_STORIES=true`) starts with the test repo only, so it runs `qa-sentinel stories --act --clone-services`: every service in `workspace.services` that has a `gitlabProject` and is not at its `path` yet is cloned there with the CI job token (allow it in each service project: Settings > CI/CD > Job token permissions), and the clone's remote is removed so no token stays in `.git/config`. Put the services next to the test repo in the config (`path: ../orders`); the runner must be able to write there. The story records are kept in `.qa-sentinel/stories/`; `qa-generate` and `qa-stories` share one cache for that folder (`key: qa-sentinel-records`, `when: always`), saved also when a job fails or stops on a limit, so spend and failure counts survive and a failing story stops being retried after `automation.jobs.maxAttempts`. A cache is best-effort: for records that must not depend on a runner cache, set `automation.record: jira` (the check warns in CI when the records are files). The job's timeout is 3 hours: up to three generate runs of up to `agent.timeoutMinutes.generate` (45) each. The Jenkins stage is a template, not proven.

## Job keys: the same work isn't done twice

Each AI step gets a key from its inputs: `spec:<STORY>:<digest of the ACs it needs>`, `generate:<STORY>:<scope>:<code version>:<digest of AC hashes>`. A job is `running`, `done`, `failed` or `aborted`.

- **Already done** (same key): in CI the step is skipped with exit 0 (`automation.jobs.skipDone: ci|always|never`; `--once` forces skipping, `--force` runs anyway).
- **Already running**: skipped until the lock expires (`automation.jobs.lockMinutes`, 90). A run killed with Ctrl-C on the same machine is detected (its process is gone) and doesn't block you.
- **Failed**: tried again until `automation.jobs.maxAttempts` (3), then stops with exit 4 until the cause is fixed or `--force`.
- **Aborted** (no credentials, Ctrl-C) doesn't count as an attempt.
A changed AC changes the key, so changed work always runs.

## Budgets

`automation.budgets`: `perStoryUsd` 25 (all time), `perDayUsd` 100 (UTC day), `perMonthUsd` 1000 (UTC month); 0 = unlimited. Every AI call is clamped to what is left, and a step that can't start usefully (less than $0.10 for `spec`, $1 for `generate`, $0.25 for the others) is refused with exit **4** and the setting to change. `--force` overrides job checks, **never budgets**. Spend by `gap-report`, `review-story`, `tag`, `lessons` and `learn` counts too (`gap-report` without `--story` counts under `_no-story`).

In a pipeline, treat exit 4 as "stopped by a limit", not a failure: `allow_failure: exit_codes: [4]` (GitLab).

## Credentials check

Before the first AI call qa-sentinel makes one tiny call (`agent.accessCheckSeconds`, default 60; 0 or `QA_SENTINEL_SKIP_ACCESS_CHECK=1` skips it) and stops at once with exit 3 and the fix if the key is missing, has a space/quote/newline, is wrong, or Claude Code isn't installed. A temporary API error only warns. `doctor` runs the same key checks; `doctor --online` makes the live call.

## Known defects fixed: `qa-sentinel known-defects` (no AI)

A known defect is `test.fail` (Playwright), `test.failing` (Jest) or `test.fails` (Vitest) + `// QA-BUG: <link>`. When the bug is fixed, Playwright reports it as failed with "Expected to fail, but passed". After a run:
```bash
qa-sentinel known-defects                    # report: fixed / still failing / inconclusive / not run
qa-sentinel known-defects --apply            # edit the files: test.fail -> test, remove the QA-BUG and QA-AGENT note lines above it
qa-sentinel known-defects --apply --commit   # also commit on qa-sentinel/defect-fixed-<date> ("Generated by qa-sentinel")
qa-sentinel known-defects --apply --commit --push   # also push and open a merge request (GitLab)
```
A person reviews and merges: that is the gate. A test that failed for another reason is *inconclusive* and untouched. Forms it can't edit safely (`describe.fail`, `test.fail()` in the body, an `issue` annotation) are listed to do by hand (exit 1).

## Limits

- Day and month budgets count the records this machine/cache has; separate runners without a shared cache each count their own.
- The story branch is not reopened after its merge request is closed or merged: a new branch starts from main. Reviewers' work on a closed branch is not carried over.
- Main being rewritten is found only from the merge commits qa-sentinel wrote itself; a person merging main by hand leaves no trace to compare with.
- A job that stops because the branch cannot be built on is retried at every check (it costs no AI): it needs a person.
- The AC "implemented in merged code" is not a gate in code (it needs an AI judgement). The gate is merged code and the status (or an override); what the plan said about each AC is stored in the record (`acEvidence`).
- The Jira record has no compare-and-set: two runners starting the same job at the same moment can both run.
- The sweep reads only merge requests GitLab lists as updated since the last check (and at most `maxPages` pages per repository). A key that only appears in a commit message, not in the MR's title, branch or description, is found by the story's own lookup (`feature`, `gap-report --story`) but not by the sweep.
- A repository that is not checked out is left out of a story's change, with a note.
- The Jira search was tested against mocked responses, not yet a live Jira (see the try guide for the live check).
- The per-story budget never resets.
- `stories` reads `expected/` from the story branch while its merge request is open, else from the checked-out branch: "approved" means merged on the branch you run from.


## Jira workflow, hierarchy and components

Set under `requirements.jira` (see the README for the YAML):

- `workflow.readyStatuses` (and `byProject.<KEY>`): the statuses that mean development is done. Jira's own "Done" category also counts. `stories --json` shows `jiraReady`.
- `hierarchy`: how a bug, task or sub-task is tied to its story. Fixed rules, not configurable: only cards with code; one hop; the parent first, links only when there is no parent feature; the target must be a `featureIssueTypes` type in `projectKeys`; a card reaching two features is attached to neither. With `featureIssueTypes` empty every card is its own feature and nothing is followed.
- `components`: maps a Jira Component name to a service name; components not mapped are listed as `unmappedComponents`.

Check it with `qa-sentinel story-check --story KEY` (section "Which feature this card belongs to") and `qa-sentinel doctor --online` (warns when a status, issue type or link name does not exist in your Jira). These only read Jira.


## Readiness per AC and the gap report on ready MRs (phase 3)

`qa-sentinel feature SHOP-12 --env uat` adds a table: for each AC, ✅ ready, 🛠️ not merged, ⏳ waiting for the Jira status, ⏳ waiting for deployment, or ❔ can't tell, each with the reason. Fixed rules, no AI: an AC depends on the services listed for it in `expected/SHOP-12.md` (none listed = every service the story changed); it is ready when each of them is merged and deployed (the service's `version` endpoint, see `workspace.services[].version`) and the card is in a ready status (`requirements.jira.workflow`). `feature --run` runs the tests whose ACs are all ready and says which ones wait.

`gap-report` on a dev MR: `automation.gapReport.when` is `ready` by default, so a draft MR gets no report until the author marks it ready; GitLab is asked for the current draft state, so a retried pipeline sees a change made after it started. Marking an MR ready does not start a pipeline by itself: push, or retry the job. `--even-if-draft` overrides.

Each push after that: the report on the MR carries a hidden stamp (a fingerprint of the diff of the test-relevant files, line numbers ignored, plus the ACs). If the stamp matches, nothing runs and the comment is left alone; if it differs, the same comment is updated and starts with "Updated for commit …". A failed report is not stamped, so the next push tries again. `--refresh` makes a new report regardless. Story-wide reports (`--story`) are not stamped. The stamp is read from the GitLab comment, so it works on runners with no cache; if the comment is deleted, the next push makes a fresh report.

While an MR is a draft, `gap-report --post` puts a short "waiting" note in the report's comment, so nobody assumes a report exists; the real report replaces it. The "nothing changed" check also covers the story's `expected/` file and scope items, and it only trusts the comment written by the GitLab token's own user.


## One QA status comment per story

On the Jira story qa-sentinel keeps **one** comment, "QA status · KEY", with a section per check: `pending` (what is waiting and why), `feature` (readiness per AC), `gap-report:<service>`, `story-review`, `bugs`, `post-deploy`, `showcase`. A command replaces only its own section and shows when it last ran; sections are always in the same order. Jira has no compare-and-set, so if two jobs update different sections in the same second one update can be lost; the next run of that check restores it. The comment is kept under Jira's size limit by shortening the biggest section (the full report is the CI artifact).

**Modes** (`reporting.jira.mode`):

- `status` (default): the single status comment. The showcase summary is a section of it, and the "ready for your review" mention is a separate short new comment (an edited comment notifies nobody).
- `legacy`: one comment per kind, as in earlier versions. `layout: separate`, the old key, means the same when `mode` is not set.
- `both`: writes the status section and the legacy comment. Use it while a team gets used to the new comment.

**Only qa-sentinel's own comments are ever edited or deleted.** qa-sentinel asks Jira which user its token belongs to (`/rest/api/2/myself`; asked once per process and remembered once it works) and ignores every other author, even when their comment contains one of qa-sentinel's markers. **If Jira will not say who the token belongs to, qa-sentinel writes no Jira comment at all** (not even a new one): the command prints a warning and carries on, and `doctor --online` shows the problem. A failed answer is not remembered; it is asked again on the next call, up to 3 failures in a process. Notes: a *personal* API token makes that person's own comments "qa-sentinel's own" too, so use a service account; Cloud accounts are compared by `accountId`, Data Center users by `key`, then `name`.

**Older comments** (`reporting.jira.cleanup`): while `mode` is `status`, qa-sentinel's own comments from the old layout (gap report, feature, post-deploy, bugs, story review, showcase, hotfix) are moved into the status comment, whenever there are any (also on a story that already has a status comment, and after switching from `both`). The text becomes the status comment's section of that kind; if the status comment already has a fresher section of that kind (for example the one just written), the old text is dropped as out of date. Only after the status comment holds it is the old comment edited into one line, "Replaced by the QA status comment: <link>", keeping its visibility (`delete` removes it instead; needs Jira's permission to delete your own comments, and falls back to the pointer if Jira refuses). `keep` leaves them all. A comment whose visibility differs from the status comment's is left alone, because moving its text would show it to more people. If one comment cannot be changed the others are done, its text is already in the status comment, and the next write tries again. The story record remembers that the move is done (`legacyCleanedAt`), so the extra read of the comments happens once; without a record (a CI runner that does not keep it) it looks again on each status write. `mode: legacy` and `both` never clean up, and forget the mark.

**Out of date.** Each result section (`feature`, `gap-report:*`, `post-deploy`, `showcase`) remembers a "basis": a short fingerprint of the merged code (by merge request number, so a merge commit filled in later changes nothing) and the AC texts, worked out when the section is written (including a merge the sweep has not recorded yet, when the command has seen it). When the basis moves on, `stories` shows the section with a first line "Out of date: new code was merged or the ACs changed after this was written (orders !12 merged 2026-10-22)". It is marked only if the record shows a merge (or a revert) after the section was written, or the AC digest differs; a different fingerprint alone is not enough. No AI and no new comment: `stories` only edits an existing status comment of its own, and only when something changed. A section written by an older version has no basis and is never marked. **The marks need a record that survives between runs**: `automation.record: jira` (shared), or a cached `.qa-sentinel/stories/` folder; on a CI runner with a fresh file record there is no basis and so no mark. The showcase says "Evidence older than the latest change" when the evidence was attached against an older basis; `showcase.reattachOnChange: true` lets the next full pass attach fresh evidence without the refresh label.

**Pending section.** Also with no AI, at the top of the status comment (section name `pending`): a test branch that cannot take the main branch (until a run goes through), ACs whose tests wait and for what ("the merge of payments !7"), held end-to-end ACs and why, "AC-1 looks not built, but the story status is Ready for QA", "every AC has a passing test but the story status is not ready", and every `/qa ready` in use. `stories` keeps it current; a merge conflict found by `generate` replaces it with the conflict line until the next `stories` run.

**Notifications** (`reporting.jira.notify`): a short new comment with @mentions, sent once per event and subject (the story record remembers it; it is marked before the comment is posted, so a failed save sends nothing and a failed post is tried again next time). Events: `showcase-ready` (on by default), `ac-not-built-but-ready`, `cross-service-tests-ready`, `stopped-by-budget`, `merge-conflict` (off by default; a conflict is announced again when the branch or main has moved on). `to: []` means `showcase.notify` **for `showcase-ready` only**; any other event with an empty list tells nobody. Notifications carry `reporting.jira.visibility` like every comment qa-sentinel writes: with a restricted visibility only people who can see it are told. In `mode: both` the showcase mention is in the legacy comment only (not in the section), so people are tagged once. A showcase whose comment or mention failed to post is posted on the next run without attaching the evidence again.

**Marking an AC ready by hand.** A person comments `/qa ready AC-1 checked on a device` on the story (a line of its own; not inside `{code}`, `{noformat}` or `{quote}`, a `bq.` line or a `>` quote). `stories` reads it (not from qa-sentinel's own comments, and not from app users) and the AC counts as ready for writing its tests, even if the Jira card is not in a ready status or a service it needs has no change. The `pending` section says what was skipped ("AC-1 marked ready by Dana on 2026-10-21; this skips: payments has no change"). It never skips a revert or an open merge request. A command naming an AC the story does not have is ignored and flagged in the `pending` section. `/qa unready AC-1` takes it back; deleting the comment does the same; an edited comment counts with its edit time. By default any human can do this; `reporting.jira.override.allowed` limits it to named Jira account ids or usernames; `override.command` changes the words.

**Jira reads.** Finding the status comment reads the story's comments, 100 per page. Redrawing it (`stories`, only when the basis, the overrides or the pending text changed) reads them again, also for stories that are skipped from further work. `/qa ready` reading is one more full read of the comments per story per `stories` check. Moving older comments is one more read, once per story. `stories --no-record` sends no notifications and keeps nothing.


## Linking: which work belongs to which story

- **Every key counts.** A merge request that names several stories (title, source branch or description) gets one gap report per story (`requirements.multiKey: each`, at most `requirements.maxKeysPerMr`). Each report goes to its own story in Jira and its cost is counted there. `multiKey: first` looks at the first key only.
- **A bug, task or sub-task is read as its story** when `featureIssueTypes` is set, by the fixed rules above. The story gives the acceptance criteria; the card's own text is added as "Work card KEY", evidence only. A key that is not in Jira is reported as such.
- **Many merge requests per service.** A story can have several MRs in one service. They are listed one per row. A service is merged only when it has a merged MR and no open one; a closed MR is "dropped" and ignored.
- **How merge requests are found.** GitLab's text search (every page) plus the MRs updated in the last `requirements.jira.search.mrLookbackDays` days whose source branch names the story. Older MRs with the key only in the branch name are not found. Without GitLab, every local branch that names the story is a part.
- **Nothing from Jira is committed.** `init` and `upgrade` put `.qa-sentinel/`, `qa-stories.md` and `qa-post-deploy.md` in `.gitignore`.

## Hotfixes, releases and environments (phase 5)

- **Hotfix flow.** The hotfix is branched from production and cherry-picked to main. The hotfix MR gets the gap report as usual, with a note that the regression selection is what to run against the hotfix environment. `generate` does not write tests on branches matching `ci.hotfixBranches`: tests are written once, when the change reaches main. `qa-sentinel hotfix --service s --commit <sha>` shows whether the cherry-pick exists (matched by its `-x` line or by patch id, so a plain cherry-pick works too) and whether tests were written.
- **Release contents.** `release-features --tag v3.4 --from v3.3` lists stories by the keys in commit messages. Needs the service repos checked out with the tags fetched.
- **Environment-aware suite.** `suite --env uat` asks each service which commit it runs and leaves out tests of features not deployed there; `suite --tag v3.4` uses what the tag contains. Stories with no change found, or where the environment cannot tell, are treated as established and run (the table says so). Tests without `@story` always run.
- **One lookup per service.** `suite` asks each service's version endpoint once and reads each repository's revert list once per run, however many stories there are.
- **Reverts.** A change reverted on main (a "This reverts commit" message) is shown as `reverted`; its tests are held back by `suite`, never deleted.
- Hotfix branches in `generate`: the service pipeline passes its branch as `QA_SERVICE_BRANCH` (the shipped GitLab template does; for Jenkins pass it yourself). Without it nothing is skipped. The gap-report note also appears for merge requests whose source branch matches `ci.hotfixBranches`.
- Limits: `generate --story` can still write tests for a reverted part when the revert is not visible in the local clone (shallow clone, repository not checked out, or older than the commits scanned). `suite --run` passes `file:line` to Playwright; Mocha, Jest and Vitest run the files and leave the tests of held-back stories out by title (`--grep … --invert`, `-t`), which needs the `@story:KEY` tag in the test title or on its `describe` (lists like `@story:A,B` work; Jest gets `--runTestsByPath`, npm gets ` --`, pnpm and yarn do not; Jest and pnpm are not verified against the real tools, and Windows `cmd.exe` quoting is not supported); WebdriverIO runs whole files (a warning says so); Cucumber scenarios are listed separately and not run. In a shallow clone, release/tag questions are answered "unknown" (those tests run). Matching reads the latest 500 commits of the main branch; `release-features` depends on story keys being in commit messages; squash-merged cherry-picks are matched only by their `-x` line or an identical diff.
