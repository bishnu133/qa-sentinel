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
| needs-triage | tests exist but are `fixme`/`skip` | QA decides |
| covered | every AC has a test, a known defect, or is untestable | nothing |

The to-do list says who acts (ai / qa / po / dev), the command, and why a step is **blocked** (budget reached, job
already ran, too many failed attempts). Questions for the PO never block. Output: `qa-stories.md`, and one record
per story under `.qa-sentinel/stories/`. `stories` never starts an AI step; a scheduler or a person runs the command it names.

Jira settings (`requirements.jira.search`): `jql` (own query), `lookbackDays` 30, `maxStories` 50, `skipLabels`
`[qa-skip]`, `onlyLabels`, `api: auto|cloud|server`. Without `jql` you need `requirements.jira.projectKeys`. Statuses are filtered by qa-sentinel (`approvedStatuses`), not in the JQL, because a status name your workflow doesn't have makes Jira reject the whole query.

## The story record

`.qa-sentinel/stories/<KEY>.json`: AC hashes, the last check, AI jobs and what they cost. It is a **cache**: the truth is always recomputed from Jira, `expected/` and the tests. Delete it and you lose job history and spend counts, not a decision. A damaged file is moved aside (`.damaged-<time>`) and a new one started.
`automation.record: jira` also keeps a copy in the Jira issue property `qa-sentinel.record`, so a CI runner without a cache still knows. If Jira can't be reached the run goes on with the local file and says so.

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
- The Jira record has no compare-and-set: two runners starting the same job at the same moment can both run.
- The Jira search was tested against mocked responses, not yet a live Jira (see the try guide for the live check).
- The per-story budget never resets.
- `stories` reads `expected/` on the checked-out branch: "approved" means merged on the branch you run from.


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


## One QA status comment per story (phase 4)

On the Jira story qa-sentinel keeps **one** comment, "QA status · KEY", with a section per check: `feature` (readiness per AC), `gap-report:<service>`, `story-review`, `bugs`, `post-deploy`. A command replaces only its own section and shows when it last ran; sections are always in the same order. Jira has no compare-and-set, so if two jobs update different sections in the same second one update can be lost; the next run of that check restores it. The comment is kept under Jira's size limit by shortening the biggest section (the full report is the CI artifact). `reporting.jira.layout: separate` goes back to one comment per kind. The showcase comment is separate because it @mentions people. Old comments from earlier versions are not deleted.


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
- **Reverts.** A change reverted on main (a "This reverts commit" message) is shown as `reverted`; its tests are held back by `suite`, never deleted.
- Hotfix branches in `generate`: the service pipeline passes its branch as `QA_SERVICE_BRANCH` (the shipped GitLab template does; for Jenkins pass it yourself). Without it nothing is skipped. The gap-report note also appears for merge requests whose source branch matches `ci.hotfixBranches`.
- Limits: `generate --story` can still write tests for a reverted part. `suite --run` passes `file:line` to the runner (Playwright, Vitest); runners that take only files run the whole file, and Cucumber scenarios are listed but not run. In a shallow clone, release/tag questions are answered "unknown" (those tests run). Matching reads the latest 500 commits of the main branch; `release-features` depends on story keys being in commit messages; squash-merged cherry-picks are matched only by their `-x` line or an identical diff.
