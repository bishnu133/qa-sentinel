# Demo script: 25 to 30 minutes

Audience: developers, QA, and leads. Goal: they see that a merge request in a service repo leads, without anyone asking, to a QA report, to generated and independently verified tests in a reviewed merge request, and to evidence in Jira, and that a person stays in charge.

Read `README.md` first (especially "What is NOT proven"). Everything marked "expect" comes from the docs and shipped templates; nobody has watched this exact demo run. **Rehearse it once.**

Tags: **[AI $]** costs money, **[JIRA W]** writes to Jira, **[GL W]** writes to GitLab. Cost numbers are from `docs/SANDBOX.md` (docs).

Before you start, do the "30 minutes before" list in `CHECKLIST.md`. Have these tabs open: Jira board, service merge requests (`shoplite-orders`), test repo merge requests (`shoplite-tests`), the test repo pipelines, and a terminal in the qa-sentinel folder with the three `export` lines done.

## Timing at a glance

| Time | Part | Live cost |
| --- | --- | --- |
| 0:00 | 1. The story (no screen sharing yet) | none |
| 2:00 | 2. Look at the Jira cards | none |
| 4:00 | 3. Developer opens a merge request (card 1) | [AI $] gap report, [GL W] |
| 9:00 | 4. Read the gap report | none |
| 13:00 | 5. Merge, and the tests appear | [AI $] generation, [GL W] |
| 19:00 | 6. A bug and its fix (card 3) | [AI $], [GL W] |
| 23:00 | 7. Cross-service and hotfix, in two minutes (talk, or live if time) | optional |
| 25:00 | 8. Reset and the "do it again" promise | [JIRA W], [GL W], no AI |
| 27:00 | 9. Limits and questions | none |

The pipelines take minutes (docs: gap report 2 to 4 minutes, generation 5 to 10). **Do not wait in silence.** Start each pipeline, then talk (the "while it runs" lines), then come back. If you can, start step 3 before the meeting begins and keep the merge request open (see `CHECKLIST.md`).

## 1. The story (0:00 to 2:00)

Say: "Today a developer merges a change. Normally QA hears about it late. Here, a tool called qa-sentinel reads the change and the Jira card, tells QA what is at risk, writes the missing tests, runs them itself to verify them, and opens a merge request for a person to review. It never merges anything by itself. I am the developer in this demo, and afterwards I will put everything back and do it again."

Show: nothing yet. One slide or just talk.

## 2. The Jira cards (2:00 to 4:00)

Click: the Jira board (the cards made by `seed-jira.mjs`).
Say: "Five cards: two stories with acceptance criteria, a bug linked to the first story, a story that needs two services, and a hotfix bug." Open story 1 (delivery slot): read the four numbered acceptance criteria aloud. Point at AC-3: "a slot takes at most 3 orders." Say: "Remember the number 3."
Expect on screen: the card is in "In Progress" (qa-sentinel counts that as approved).
If Jira is down: show `shoplite-demo/stories/delivery-slot.md` in an editor (same text).

## 3. The developer opens a merge request (4:00 to 9:00) [GL W] [AI $ about $0.10 to $0.40]

Run: `node demo/scripts/demo-merge.mjs --card delivery-slot --yes`
Say: "This is the developer's change: delivery slots, with a capacity. I did not tell qa-sentinel anything."
Expect in the terminal: "merge request !N opened" and the watch list. Click the merge request link. Click Pipelines: job `qa-gap-report`.
**While it runs (2 to 4 minutes, docs):** show the diff in the merge request. Say: "The developer wrote the number 5." (In the diff: `MAX_ORDERS_PER_SLOT = 5`.) "The card says 3. Will anyone notice in review?" Then explain that the gap report job never blocks the developer (`allow_failure`), and that qa-sentinel holds its Jira login separately from what the AI can see (optional split jobs in the CI README).
If the pipeline is slow: switch to the recorded output: `examples/delivery-slot-demo/expected-output/gap-report.md` (a real earlier run of the same scenario with the story key SHOP-42). Say so.

## 4. Read the gap report (9:00 to 13:00)

Click: the new comment on the merge request.
Expect (docs and the earlier real run): a heading "QA impact", a risk level (high), a table of changes with decisions, "Requirement conflicts: AC-3, the cap is 5 in the code and 3 in the story", existing tests that will break (the old happy-path test sends no `deliverySlot`), and spec drift (the OpenAPI file was not updated). The wording will differ from run to run.
Say: "The tool found the 5 versus 3. It is flagged as a decision for a human. It did not guess which one is right."
Click: the same report on the Jira card (a comment ending with a small grey `qa-sentinel:` marker). Say: "The marker is how qa-sentinel finds and updates its own comment instead of posting again. It only ever edits comments written by its own user."
If no comment appears: open the job log of `qa-gap-report` (look for 401 or 403), and switch to the recorded report.

## 5. Merge, and the tests appear (13:00 to 19:00) [GL W] [AI $ about $0.50 to $2]

Say: "In real life the team talks to the developer first. Here we merge, to see the next step."
Run: `node demo/scripts/demo-merge.mjs --card delivery-slot --yes --merge`
Expect: "merged !N" (the script first waits, up to 60 seconds, until GitLab says the merge request is mergeable; if you opened and merged in one go, the gap report job runs on an already merged request, which is why step 3 opens it first). In the service project: pipeline on `main` with `qa-trigger-generation`. In `shoplite-tests`: a new pipeline with `qa-generate`.
**While it runs (5 to 10 minutes, docs):** explain the guardrails: the AI can write only test files; qa-sentinel runs the tests itself against a QA environment and decides the status; the agent's own claim "VERIFIED" counts for nothing. Show `ci/qa-sentinel/README.md` in the test repo or the "Flow" section of `templates/ci/gitlab/README.md`.
Expect when done: a merge request in `shoplite-tests` titled "QA agent: tests for ...", labels `qa-agent` and `qa-sentinel::<status>`, branch `qa-sentinel/story-<KEY>`, a Draft unless VERIFIED. The description has the plan, the verification table and a section for **unresolved product discrepancies**: the AC-3 test is written to the requirement (cap 3) and held back, so the build does not break, and a human must decide.
Click: "Changes": the new test file, the fixed old test. Say: "A person reviews this like a colleague's merge request."
Click: pipeline job `qa-agent-mr-checks`. Say: "This gate blocks the merge unless the status is VERIFIED."
If generation fails or is BLOCKED: that is a feature, open the run's `guardrails.json` in the job artifacts and explain the reason. If nothing arrives in time: show `examples/delivery-slot-demo/expected-output/merge-request-summary.md` and `generated-tests.diff`.

## 6. A bug and its fix (19:00 to 23:00) [GL W] [AI $]

Click: the Bug card in Jira (linked to story 1 with "Relates"). Read: "The 4th order is accepted; the story says 409."
Say: "The team agrees the code is wrong. The developer fixes it."
Run: `node demo/scripts/demo-bugfix.mjs --card slot-cap-bug --yes --merge`
Expect: merge request titled with the bug key, merged; `qa-trigger-generation` again. Because the bug links to the story, expect (not observed on a real project) that qa-sentinel updates the story's tests instead of starting a second, separate feature.
Say: "Now the fixed behaviour is covered by a test that was written from the requirement, not from the fix."
If you are short of time: do not wait for this pipeline. Say what to expect and move on.

## 7. Cross-service and hotfix (23:00 to 25:00), talk only unless there is time

Cross-service (say that this is not proven on a real project): "A story that needs two services is planned per acceptance criterion. The criteria that need only one service get tests when that service merges. The one that needs both waits until both are merged. The merge request description lists what is waiting." (`docs/AUTOMATION.md`, "One test merge request per story".) Live option: `demo-merge.mjs --card cancel-refund --part payments-service --yes --merge` (needs the payments project).
Hotfix: "A fix on a release branch gets a note in the report, but no tests until it reaches the main branch." Live option: `demo-bugfix.mjs --card blank-item-hotfix --yes --merge`, then `--cherry-pick`.

### 7b. Extras, if someone asks (talk, or live if there is time)

Nothing here is a separate timed step. Say what is and is not set up in the demo.

- **Person override `/qa ready` (live, free):** open the story's test merge request or the Jira card, and comment `/qa ready AC-1 the payments part is not needed for this demo`. Say: "A person can mark an acceptance criterion ready by hand. It never skips an open merge request or a revert." Expect (not observed on a real project) the next run to take the AC as ready, and the status comment to say who did it. The command is set in the config under `reporting` (`override.command`, default `/qa ready`; `override.allowed` limits who may use it). Reset lists comments that say `/qa ready` so you can delete them by hand.
- **Readiness per acceptance criterion (talk, or read the merge request description):** the story's merge request description lists the "Waiting ACs" and what each waits for (a service not merged yet, an open merge request, a Jira status). Say: "The criteria that can be tested now are written now; the others wait." `docs/AUTOMATION.md`, "One test merge request per story".
- **Re-run after deploy (talk only):** say plainly that the demo template does **not** set this up: the `qa-trigger-post-deploy` job is not in the demo service pipelines (there is no deploy step in ShopLite), so "a bug fix re-runs the story's tests after deploy" is not shown. What it does: after a deploy, `qa-sentinel post-deploy --env sit` checks every service the story needs is deployed, runs the story's tests there and reports. To set it up for your own project, see `templates/ci/gitlab/service.gitlab-ci.yml`.
- **`release-features` (live, no AI, free):** `node dist/cli.js -C demo/.work/shoplite-tests release-features --tag <tag> --from demo-baseline` lists the stories whose keys appear in the commits between two tags, per service. It reads the cloned service folders, so run it after `setup-gitlab.mjs` has built them. Say: "This is the list for release notes."
- **`metrics` (live, no AI, free):** `node dist/cli.js -C demo/.work/shoplite-tests metrics` writes `qa-metrics.md`. Say honestly: it shows **0 runs** unless the run folders exist on this machine. Runs in CI are artifacts of the pipelines: download them and pass them with `--runs <folder>` (and the story records, a downloaded CI cache, with `--records <folder>`). With a few demo runs the numbers are too small to mean anything: show the shape of the report, not the values.

## 8. Reset (25:00 to 27:00) [JIRA W] [GL W]

Run the dry run first, on screen: `node demo/scripts/reset.mjs --tests-dir demo/.work/shoplite-tests`
Say: "This is the list of what it will do. Nothing has changed yet." Read the lines: close merge requests, revert the merges (new commits, no history rewrite), delete comments that carry the marker and were written by this login, remove the Jira properties, move the cards back.
Then run: `node demo/scripts/reset.mjs --tests-dir demo/.work/shoplite-tests --yes --i-know-this-is-a-test-project <KEY>`
Expect: "ok" lines, "same files as demo-baseline" for each branch, and the list "What reset cannot undo".
Say: "It cannot undo Jira's history tab, the money spent, or e-mails already sent. The runner cache of the test repo I clear by hand, and I wait for the revert pipelines to finish. Then I can run the demo again."
If reset prints MANUAL: read the one-line fix it gives, and say that is why the baseline tag exists. Do not improvise.

## 9. Limits and questions (27:00 to 30:00)

Say honestly: "It proposes; people decide. The numbers on cost come from a sandbox. We have run it end to end on gitlab.com with this sample service; Jenkins, Jira Data Center and self-hosted GitLab have not been proven. Today's Jira part of this exact demo project was rehearsed on [date]." (Fill in the date, or say it was not rehearsed.)

## If live parts fail

| What fails | What to show instead |
| --- | --- |
| Jira is down | The story text files in `demo/shoplite-demo/stories/`; a recorded gap report: `sandbox/shoplite/example-output/SHOP-101-gap-report.md`. |
| GitLab or pipelines are down/slow | `FALLBACK.md`: the local ShopLite flow (`sandbox/shoplite/local.mjs`) and the recorded outputs in `examples/delivery-slot-demo/expected-output/`. |
| The AI step is slow or the key is out of credit | Recorded outputs as above. Say it plainly. |
| A script stops with `STOP:` | Read the message aloud; it says what to do. Do not run reset live in the middle of the demo unless you want to end it. |
| Everything is down | Run `npx vitest run test/demoKit.test.ts` and show the fake Jira and fake GitLab doing the whole seed, merge, fix and reset flow (about 10 seconds; no network). Say clearly that it is a fake. |
