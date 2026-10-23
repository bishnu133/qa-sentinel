# Changelog

## Unreleased — more quality gaps: change types, access control, history, spec drift (PR 7 of the finishing plan)

- **Change types as risk (no AI).** New `src/analysis/changeKinds.ts` looks at **all** changed files (not only the ones planning keeps; lock files are still ignored) and finds database migrations, config files, feature-toggle files and dependency files by the globs in `risk.changeTypes`. For `package.json` only the `dependencies`, `devDependencies` and `peerDependencies` sections count, and a major version jump (`^1` to `^2`) is flagged. New risk factors: `db-migration` (high), `config-change` (medium), `toggle-change` (medium), `dependency-bump` (medium) and `dependency-major` (high). They are added to a synthetic change `c0`, so the overall risk includes them; the report has a "Change types found in the code (no AI)" section with the files, and `c0` is left out of the decision table. A migration or dependency change selects the whole service suite for regression (in story mode only the service that has it).
- **The agent cannot choose these factors.** They live in a separate list (`DERIVED_RISK_FACTORS`); the plan schema rejects them in `riskFactors`. The agent only sees them (`changeKinds`, `endpointHistory` and `accessControl` in `context.json`).
- **Access-control scenarios.** A scenario can carry `access: { role, expect: allowed | forbidden | no-token }`, and a decision can carry `noScenario` (why it needs none). For each changed endpoint with the `auth` factor (or a new endpoint when `tests.auth.roles` has a role) whose decision writes tests, the plan needs a `no-token` scenario, plus a `forbidden` one when two or more roles are configured. `risk.accessControl: warn` (default) shows a warning; `require` rejects the plan. The test index reads `@role:<name>`. The `write-api-test` skill and the author agent say how to write them with `tests.auth`.
- **Risk from history (no AI).** An endpoint with at least `risk.history.threshold` (default 2) signals gets the `history` factor and its change's risk goes up one level (never to critical). Signals: known-defect tests with an `@endpoint` tag, flaky tests from `.qa-sentinel/runs/*/verification.json` in the last `risk.history.days` (default 90), and incidents in the team's optional `kb/history.yaml`. The report shows what raised it. Only data qa-sentinel or the team keeps is read; no incident tool is called. **Not built, on purpose:** ranking risk across open merge requests (it needs an AI gap report per merge request).
- **Spec drift is a gap.** `specDrift` still accepts plain strings; it now also accepts `{ endpoint, spec, code, evidence }`. Validation needs `source-code` evidence with file and line and a `review` decision for the endpoint's change (test written to the spec, held as fixme with a `// QA-AGENT:` note). The report says "the spec and the code disagree. The developer fixes one of them." `generate` adds the label `qa-sentinel::spec-drift`. No bug card is raised.
- **Benchmark.** New scenarios `db-migration`, `dependency-major` (checks that need no AI) and `spec-drift`; new checks `changeKind` and `specDrift` in `bench/`.
- **Deviations from the plan:** the derived factors are not in `RISK_FACTORS` (so the agent cannot pick them); a major dependency bump has its own factor `dependency-major` (high) because risk is a function of factors; the spec's "decision `noScenario`" is a new optional `noScenario` field on decisions; access rules apply to decisions that write tests (create, update, review), not to `reuse`.
- Try it: [docs/TRY-PR7.md](docs/TRY-PR7.md).

## Unreleased — small items and docs fixes (PR 6 of the finishing plan)

- **`suite` asks once.** Each service's version endpoint is asked once per run and each repository's revert list is read once, however many stories there are (before: once per story and service).
- **`suite --run` leaves held-back tests out by title** where the runner cannot take `file:line`: Mocha (`--grep <pattern> --invert`), Jest and Vitest (`-t '<negative pattern>'`) run only the files that hold a selected test and skip the tests of held-back stories (`@story:KEY` in the test title, also `@story:A,B` lists and tags on a `describe`; `SHOP-1` never matches `SHOP-10`). Jest gets `--runTestsByPath` so its file arguments are plain paths; npm gets ` --` before the options, pnpm and yarn do not. Not verified against a real Jest or pnpm here; `cmd.exe` quoting on Windows is not supported. Playwright keeps exact `file:line`. WebdriverIO still runs whole files, and a warning says so. Cucumber scenarios are now listed in their own section of `qa-suite.md` and in `--json` (`cucumber`), and are left out of `qa-suite.txt`.
- **`hotfix --fail-if-waiting`** exits 75 (the same "still waiting" code as `post-deploy`) while a hotfix commit is not on the main branch. **`hotfix --strict`** does that and also exits 1 when a commit is on the main branch but no test was written from it after `--grace-days` (default 2). The days count from when the commit reached the main branch (a cherry-pick's date, or the first merge commit that brought it), not from its commit date. If one commit is still waiting and another is late, 75 wins; `--json` lists `waiting` and `late`. `--grace-days` needs `--strict` and a number of 0 or more. Without the flags the exit code is 0 as before.
- **`init` then `doctor` is quiet.** `init` lists the tests that are already tagged (`@endpoint`, `@page`) in `test-map.yaml` (no AI), under the service named by `@service`; a page or screen test with no (known) service goes under the first web or mobile service, an endpoint test under the first service that is not web or mobile, and when there is none the file stays in `unmapped`. `doctor` shows one line when the map is empty ("run `qa-sentinel learn`") instead of one mismatch per test, shows the number of tagged tests, gives an example with other mismatches, and warns about services that are in the config but not in the map, and the other way round.
- **Tags on a `describe`:** `@story:` on an enclosing `describe` now counts for the tests inside (the runner's name filter already saw it; the index did not).
- `suite --json` has `asked` (how many version calls and revert scans the run made), and `suite` prints that on one dim line; a version-endpoint answer that failed is kept for the run. `suite --run` prints each command it starts.
- Test timeout is 30 s (was 5 s) so loaded runners do not fail the git-heavy tests.
- **Cosmetic:** the label of a story's change no longer repeats the branch ("feature/SHOP-106-shipping-notice merged (3 changes)").
- **Docs:** README no longer says Bubblegum healing was never run with the real engine (CI job `bubblegum-healing` does; the mobile scaffold still has no hook) and no longer says known-defect marker removal is Playwright only. `docs/TRY-PR2.md` says which folder each command runs from and that the step-3 test file must be pasted. `docs/AUTOMATION.md` limits updated.
- **Test fixture:** `test/fixtures/jest-fails/results.xml` had an unclosed `<failure>` tag; it is well-formed now. The Vitest report fixture is real Vitest 2.1.9 JUnit output (paths and times aside); the Jest one is a hand-written sample in jest-junit's format, not a recorded run, and was not checked against a real jest-junit here.
- `generate --story` skipping reverted parts was already built in an earlier PR; no change.
- Try it: [docs/TRY-PR6.md](docs/TRY-PR6.md).

## Unreleased — Jira Data Center and self-hosted GitLab hardening, budget suggestions, split CI jobs, a wrapper for test runs (PR 5 of the finishing plan)

- **Fix: Jira login.** `JIRA_PAT` used to win even when `JIRA_EMAIL` and `JIRA_API_TOKEN` were also set, and Jira Cloud then answered 401 to the Bearer token. New `requirements.jira.auth: auto | cloud | pat` (default `auto`): `auto` uses Cloud when `JIRA_EMAIL` is set, the Data Center token otherwise. `doctor` warns when both are set.
- **Fix: a login or SSO page in front of Jira or GitLab.** The page came back as HTML and was read as JSON ("Unexpected token <"). Now the error says: "Jira answered with a web page, not JSON (a login or SSO proxy in front of Jira? …)", and the same for GitLab.
- **Fix: GitLab under a sub-path.** The push URL dropped the path of `https://corp.example/gitlab` and pushed to `https://corp.example/<project>.git`. It keeps the path now (`CI_SERVER_URL` too). GitLab calls and file reads use the same network call as Jira, so a TLS, DNS or proxy failure shows its cause (and the `NODE_OPTIONS=--use-system-ca` hint) instead of "fetch failed".
- **Clearer attachment error.** An attachment on another origin than `requirements.jira.baseUrl` (a reverse proxy) is still refused, and the error now names both origins and says to set `baseUrl` to the URL Jira itself reports.
- **`doctor --online` names the Jira flavour** (Cloud or Data Center, from `/rest/api/2/serverInfo`), checks the search API that flavour uses, and warns when `baseUrl` is not the URL Jira reports or `auth` does not fit the flavour.
- **`metrics` suggests `automation.budgets`.** From 10 stories with a generate job it suggests `perStoryUsd` (p90 of a story's cost x 1.5); from 10 days with spend, `perDayUsd` (p90 of the daily sums x 1.5) and `perMonthUsd` (per day x 22, up to the next $5). Below that it says how many more it needs. `--records <dir>` reads story records from a downloaded CI cache (read only).
- **Split CI jobs (opt-in, `QA_SPLIT_JOBS: "true"`, GitLab templates).** `gap-report --defer-publish` and `generate --defer-publish` do the analysis and leave `publish.json` (and, for generate, `branch.bundle`) in the run folder instead of writing to GitLab or Jira: also the bug cards, the merge-conflict notice and note, and the Jira story record (kept in files in this mode). The new `qa-sentinel publish [--run <id|dir|all>] [--target gitlab-mr|jira|mr-create]` does the writing with write tokens and no model key, and never starts an agent. **The run folder is treated as untrusted**: `publish.json` is validated strictly (zod, unknown fields refused); the project, merge request, target branch and remote come from the publish job's config and CI variables; only `qa-sentinel/...` branches are pushed (a story branch only as the config names it for the story); the base of the policy check is taken from the server (the story branch's tip, else the merge-base with a freshly fetched target); every commit the target does not have counts as the agent's; the whole repository is checked, with the expected-behaviour lock and `test.fail` markers as in `verify --policy`; generated artifacts, symlinks and submodule links are violations; the push is `--force-with-lease` on that branch only (a story branch must build on the server's copy); labels are limited to qa-sentinel's shapes. Runs are claimed with a lock file, what finished is recorded per part (`--target` runs and `--run all` do not repeat), one bad run does not stop the others, and the exit code is non-zero when any part failed or could not be done. The templates get `qa-generate-publish` and `qa-gap-report-publish` (own `resource_group`, `GIT_DEPTH: 0`, environment `qa-publish`) and the analysis jobs their own `after_script` that drops the publish secrets and sources nothing from the work tree. Not covered: the `VERIFIED` status in the MR and Jira is the analysis job's claim; a variable GitLab hands to a job is still in its environment unless scoped to an environment (docs). The old single-job form stays the default.
- **Fix: `verify --policy` and `changesBetween` looked only at the test folder of a monorepo**; a change elsewhere in the repository never reached the write policy. They see the whole repository now (paths outside the folder show as `../…` and are outside the allowed paths). `verify --policy` also refuses symbolic links and submodule links, and content checks no longer follow a symbolic link.
- **Small fixes:** `gitlab rawFile` says a login page (text/html) is not the file; `ci.gitlabUrl` loses every trailing slash; a plain `http://` push URL gets a warning; with `QA_JIRA_PUBLISH_*` set, publishing uses only that login (a Cloud `JIRA_EMAIL` read login is no longer picked by `auto`); budget suggestions merge a story that sits in two folders (jobs and ledger summed, a job in both counted once) and leave out `$0` stories.
- **`verification.wrapCommand`**: an optional wrapper (`... sh -c {cmd}`) for every test command qa-sentinel starts (verification, post-deploy, suite, feature, showcase recording). `doctor` runs a command with spaces and quotes that exits 7 through it and fails unless the output and the exit code come back.
- **`agent.sandbox`** (off by default): starts the agent with Claude Code's built-in Bash sandbox (`sandbox.enabled`, `failIfUnavailable`, `allowUnsandboxedCommands: false`, `network.allowedDomains`; key names checked in the Claude Code documentation). It covers the agent's shell commands only. `doctor` checks `bubblewrap` and `socat` on Linux.
- Docs: README "CI" (what each split job can reach) and "Honest limits", SECURITY.md (wrapper, runner network allowlist, the sandbox), `templates/ci/gitlab/README.md`.
- Not done on purpose: nothing here has run against a real Jira Data Center, a real self-hosted GitLab or a large service. Try it, and which steps need those: [docs/TRY-PR5.md](docs/TRY-PR5.md).

## Unreleased — Jira status modes, out-of-date marks, notifications, `/qa ready` (PR 4 of the finishing plan)

- **Behaviour change: older qa-sentinel comments move into the status comment.** While `mode` is `status`, qa-sentinel's own comments from the old layout (gap report, feature, post-deploy, bugs, story review, showcase, hotfix) are carried into the status comment as sections (a section already there is fresher and wins), and only then edited into "Replaced by the QA status comment: <link>". This runs whenever such comments exist (also on a story that already has a status comment, and after `both` -> `status`), and once per story as far as the record is kept (`legacyCleanedAt`). A comment with a different visibility is left alone. `reporting.jira.cleanup: keep` keeps today's behaviour, `delete` removes them after carrying the text. `reporting.jira.mode: status | legacy | both` replaces `layout` (`layout: separate` still works and means `legacy`).
- **Behaviour change: the showcase summary is a section of the status comment** (mode `status`); the mention is a separate short new comment (`notify.showcase-ready`, on by default, tags `showcase.notify`). In `legacy` mode the showcase comment is as before. In `both` the mention is only in the legacy comment. A showcase comment or mention that failed to post is posted on the next run without attaching the evidence again.
- **Fix: only qa-sentinel's own comments are found and edited, and with no answer from Jira nothing is written.** Before, any comment holding the marker text was edited, whoever wrote it. qa-sentinel now asks Jira who its token belongs to (`/rest/api/2/myself`, Cloud `accountId`, Data Center `key`/`name`, asked once per process). If Jira will not say, it writes no Jira comment at all (a warning, the command carries on); a failed answer is not remembered (3 tries per process). `doctor --online` shows who the credentials belong to. A personal API token makes that person's own comments "ours": use a service account.
- **Fix: the hotfix comment in `legacy` mode** had the marker `qa-sentinel:gap-report:hotfix-<service>`; it is now `qa-sentinel:hotfix-<service>`. A comment written with the old marker is moved into the status comment like the others.
- **Out-of-date marks.** Each result section of the status comment remembers the story's basis (merged code by merge request, and AC texts), worked out when it is written (including a merge the sweep has not recorded yet). When it moves on, `stories` redraws the comment with "Out of date: … (orders !12 merged 2026-10-22)", but only if the record shows a merge or revert after the section was written, or the ACs changed. No AI, no new comment. Sections without a basis are never marked. The marks need a record that survives between runs (`automation.record: jira`, or a cached `.qa-sentinel/stories/`). A merge commit filled in later no longer changes the basis. Text in a section that looks like a section stamp or mark cannot create a fake one.
- **`pending` section** at the top of the status comment: a test branch that cannot take main, ACs that wait (and for what), held end-to-end ACs, "not built but ready" and "looks complete" mismatches, and every `/qa ready` in use, with what it skips ("payments has no change").
- **`/qa ready AC-n [reason]`** in a Jira comment marks an AC ready by hand for writing its tests; `/qa unready AC-n` takes it back. Any human by default, shown with the person's name and date; `reporting.jira.override.allowed` restricts it. Not read from qa-sentinel's own or app comments, not inside code/quote blocks. An AC the story does not have is ignored and flagged. It never skips a revert or an open merge request.
- **`reporting.jira.notify`**: `showcase-ready`, `ac-not-built-but-ready`, `cross-service-tests-ready`, `stopped-by-budget`, `merge-conflict`: short new comments with mentions, once per event and subject. Only `showcase-ready` falls back to `showcase.notify` when `to` is empty. The record is marked before posting (a failed save sends nothing; a failed post is retried). A merge conflict is announced again when the branch or main has moved on. The record keeps up to 200 notifications from the last 180 days.
- `showcase.reattachOnChange` (default false). New config keys all have defaults, so old config files load unchanged.
- Try it: [docs/TRY-PR4.md](docs/TRY-PR4.md).

## Unreleased — one test merge request per story, end-to-end tests per AC, `stories --act` (PR 3 of the finishing plan)

- **Behaviour change: one test merge request per story.** When a merged change names a story, qa-sentinel adds its tests to one long-lived branch, `qa-sentinel/story-KEY`, and one merge request (`QA agent: tests for story KEY`), instead of a new `qa-sentinel/<service>-<sha>` merge request per merge. A change with no story key keeps the old branch. To keep the old way for every merge, set `generation.scope: service`. Other settings: `generation.branchPrefix` (`qa-sentinel/story-`), `generation.maxAcsPerRun` (5).
- **The branch is built on, never rebuilt, never force-pushed.** Each run continues from the branch on the server, merges the main branch into it, and pushes with `--force-with-lease` using the commit it started from. A commit a reviewer pushed meanwhile is fetched, merged in and kept (one retry, then a clear error). A run that cannot build on the branch stops before any AI call: nothing is pushed, the merge request gets a note, exit 1, and the job is marked aborted (not a failed attempt, so no `--force` is needed after a person fixed it). Causes: a merge conflict with main; main rewritten (rebased or force-pushed) after it was merged in; an open merge request whose branch was deleted; local and server branches that diverged. An open merge request always wins: if a branch has several merge requests the branch is continued, whichever was updated last. A closed or merged story merge request is not reopened: a new branch starts from main, its description links the old one, and what the story record said was written on the old branch is cleared. The planner and the author work on the branch, so they see the tests already there. `expected/KEY.md` is read from the branch, so a reviewer's edits are the reviewed version.
- **End-to-end tests are written per AC, when the AC is ready.** An AC that needs one service gets its tests when that service merges. An AC that needs several services waits until all of them are merged and, by default, the Jira card is in a ready status (`generation.crossService: when-ready-status`; `when-ac-complete` ignores the status). Waiting ACs are listed in the merge request with what they wait for. The planner is given `acScope` and `heldAcs`; a plan that cites a waiting AC is rejected. What was written is kept in the story record (`crossService`, `acEvidence`, `agentMr`).
- **`stories --act`** starts the AI steps that are due, at most `automation.act.maxJobsPerCheck` (3) per run, through the normal job keys, locks and budgets. Exit 0 all done, 4 a limit stopped one, 1 one failed. `--dry-run` only says what it would start. New state `needs-cross-service-tests`. The GitLab template has a `qa-stories` job (schedule with `QA_STORIES=true`); the Jenkins stage is a template, not proven on a real server.
- **No second AI run for the same change.** In story scope every run has the same job key for the same work, however it was started (a merge pipeline, `generate --story`, `--acs`, `stories --act`): the story, the ACs (the cross-service ones alone when there are any), the merged commits of the services they need and the AC texts. On top of that the story record remembers which ACs were written for which commits and AC text (`crossService` and `singleService`, written only after the push succeeded), and `--acs` does not get around it (only `--force` does). `stories` reads the story branch, the record's merge requests and the Jira-component mapping the same way `generate` does, so an AC whose tests are on the branch is not due again and an AC that cannot be written yet starts nothing. Only one generate job per story runs at a time (they write the same branch).
- **Per-merge branches no longer duplicate tests** (`generation.scope: service`): the open merge requests labelled `qa-agent` are listed for the planner, and a `create` of a spec file another open agent merge request adds is rejected (`targetFile` on a `create` decision).
- **`stories --act` in CI.** The `qa-stories` job now clones the service repos (`--clone-services`, with the CI job token; the remote is removed so no token stays in `.git/config`): before, it could not find the story's code and failed at every check. `qa-generate` and `qa-stories` share one records cache saved also when a job fails (`when: always`), so spend and failure counts survive; the job timeout is 3 hours. A job that turns out to be nothing to do does not use up `maxJobsPerCheck`; the printed plan is the exact command; a detached checkout is restored to its commit; exit 0 is also given for a job skipped because the same work is done or running (only a budget or too many failed attempts give 4).
- **Smaller fixes.** A story with no readable acceptance criteria is planned from the change itself on the story branch (it used to get no tests); Jira components are mapped through `requirements.jira.components` in `generate` too; `--acs` rejects an unknown id and needs `--story`; a story key and `generation.branchPrefix` that git could read as an option are refused; an open service merge request nobody touched for `generation.staleMrDays` (30) days no longer holds an AC back; the duplicate-file check also looks at the files the author really wrote and at other stories' and per-merge open agent merge requests; a cross-service AC with nothing to change is recorded as written.
- `generate --story` says "nothing to generate" (exit 0) when all of the story's changes were reverted, and takes `--acs AC-1,AC-3` (a waiting AC is refused unless `--force`).
- Nothing Jira-derived is committed: the story record, `qa-stories.md` and the run folders stay out of the story branch.
- Try it: [docs/TRY-PR3.md](docs/TRY-PR3.md).

## Unreleased — story record, merge-request sweep, story change from each MR (PR 2 of the finishing plan)

- **The story record keeps every merge request of the story** (`parts`: service, number, state, branch, head, merge/squash commit, when seen), the bugs and tasks reached from it (`linked`), post-deploy results per environment (`results`) and a `basis` fingerprint of the merged commits and AC hashes. It is still a cache; old records load as before. New fields for later steps (`agentMr`, `crossService`, `acEvidence`, `notified`, `overrides`) are in the file format already.
- **`stories` first looks at merge requests (GitLab only, no AI, no clones).** One paged call per repository for the MRs updated since the last check; each is recorded on every story it names (a bug or task goes to its story by the fixed Jira rules). Stories whose MRs changed are checked even if the Jira search did not list them. MRs with no key are listed as a warning. `--no-sweep` skips it, `--rebuild` fills the records again from the last 365 days. Settings: `automation.sweep.enabled`, `overlapHours` (24), `maxPages` (5).
- **The gap report records its merge request when it first sees it**, so a later step knows the MR even if no commit message has the key.
- **The story's change is built from each MR** (`gap-report --story`, `generate --story`): a merge commit, a squash commit, a rebased MR and an open MR (fetched from its merge-request ref) each give their own range. Before, the change ran from the first commit naming the story and stopped at the first commit that did not, so an earlier MR was lost when other work was merged in between, and main merged into a branch leaked in. Without GitLab the last 500 commits of the target branch are scanned and each commit that names the story is its own range. A service is one part with the ranges of all its merge requests (`heads` lists every tip); the combined diff has a sub-header per range. The parts come from GitLab or the local clones and the story record is added to them (matched on service and MR number), so a commit the record does not list is still included. A merge request whose commits a later commit reverts ("This reverts commit <sha>", seen in the local clone, for record parts too) is left out with a note; a revert the clone cannot see is not noticed. A merged MR with no merge or squash commit (rebase, fast-forward) is read from its diff base (`diff_refs`, asked from GitLab once and kept in the record), else from the commit messages, and the note says which.
- **A deployed bug fix runs its feature's tests again** (`post-deploy`). Every key in the deployed commits counts (before, a key without tagged tests was dropped); a bug, task or sub-task goes to its feature through Jira, and the feature's `@story:` tests plus `@bug:<KEY>` tests run. The report says why. The fix is checked even while its feature has another MR still open. A key with no tests is shown as "no tests tagged" at once: no waiting for deployment, and it never makes the run exit 75. A commit without a key is matched through the story record, then GitLab's merge requests of the commit. A key that is not in Jira is left out with a note.
- The sweep reads merge requests oldest first; if `automation.sweep.maxPages` cuts the list it says so and the next run goes on after the last one it saw. Branch names are read case-insensitively for the configured Jira projects (`feature/shop-106-x`, `SHOP-106_notice`). A loose bug (no feature behind it) is not recorded as a story. Commit ids in a record must be hex; others are dropped when it is read. The last-check time is kept in the local records folder (also with `automation.record: jira`): cache it between CI runs.
- Try it: [docs/TRY-PR2.md](docs/TRY-PR2.md).

## Unreleased — linking: every key, every merge request (PR 1 of the finishing plan)

- **A merge request that names several stories gets a report for each** (`requirements.multiKey: each`, the default; `first` keeps the old way of looking at the first key only). At most `requirements.maxKeysPerMr` (default 3) stories are analysed, because each one is an AI run. Each report is posted on its own story in Jira, its cost is counted on that story, and the merge request gets one comment with a section per story. A key that is not in Jira ("SHOP-1012") is said so in the report and never guessed at.
- **A bug, task or sub-task is read as its story** (when `requirements.jira.featureIssueTypes` is set). The gap report and `generate` take the acceptance criteria from the story. The bug's own text is kept as evidence under "Work card KEY" and never sets an expected value; if it disagrees with an AC the planner asks the product owner. The report says how the card was reached ("SHOP-210 (Bug) → SHOP-12 via parent"). The fixed rules do not change.
- **A service can have many merge requests for one story.** `feature` and the readiness table show one row per MR (or branch). A service counts as merged only when it has a merged MR and no open one. A closed MR is shown as "dropped" and never holds anything back.
- **Merge requests are found by their branch name too.** Before, GitLab was searched only in titles and descriptions, one page of 50. Now every page is read, and merge requests updated in the last `requirements.jira.search.mrLookbackDays` days (default 30) are also matched on their source branch. An MR older than that, with the key only in its branch name, is not found.
- In local git, every branch that names the story is its own part (a branch is found even when its commits do not name the story).
- Tests can carry `@bug:KEY` (indexed as `bugs`).
- **Jira data stays out of git.** `init` and `upgrade` now add `.qa-sentinel/` (story records hold Jira statuses and titles), `qa-stories.md` and `qa-post-deploy.md` to `.gitignore`.
- **The joined comment of a multi-story merge request is stamped** like a one-story report: a push that changes nothing the reports depend on (the diff, any story's ACs, expected behaviour, scope) makes no AI run; `--refresh` forces it. A draft merge request gets the waiting note (and the report file) before any Jira read. A story that fails or is refused by a budget is shown as "not analysed: why" and the comment is still posted; the regression list is the whole suite when a story made no valid selection. Every bug of a story is kept as a work card, and each Jira card and recent-MR scan is read once per run.
- Only `gap-report` and `generate` link a bug to its story; `review-story`, `spec` and the expected-behaviour check read the card they are given. A change made for a bug is written with `@story:` and `@bug:` tags.
- Story mode makes one range per service (the merged work and each open branch, from where it left the main branch), so unrelated work on the main branch is no longer analysed. A change that was reverted and then landed again is not "reverted".
- Try it: [docs/TRY-PR1.md](docs/TRY-PR1.md).

## Unreleased — hotfixes, release tags, environment-aware runs (phase 5)

- **`qa-sentinel hotfix`** (no AI): where a hotfix stands. Matches each hotfix commit to its cherry-pick on the main branch (a `cherry-pick -x` line, or the same change by patch id) and says whether tests were written from it. `--post` puts it in the Jira QA status comment (section `hotfix:<service>`).
- **Hotfix branches** (`ci.hotfixBranches`, default `hotfix/*`, `release/*`): the gap report still runs on the hotfix MR and says the regression selection is what to run; `generate` does not write tests there. Tests are written once, when the change reaches main.
- **`qa-sentinel release-features --tag v3.4 [--from v3.3]`** (no AI): the stories a release contains, from commit messages per service.
- **`qa-sentinel suite --env uat | --tag v3.4 [--run]`** (no AI): the tests that fit what an environment has deployed or a release contains. Tests of features that are not there yet are left out with the reason; tests without a `@story` tag always run. Nothing is deleted.
- **Reverted changes** are noticed: a feature whose change was reverted on the main branch has status `reverted`; its ACs are `reverted` and its tests are held back by `suite`.
- **Known-defect markers for Jest and Vitest**: `known-defects` also handles Jest `test.failing` and Vitest `test.fails` (with `// QA-BUG:`), recognising the "now passes" reports of both (the fixtures are hand-written samples in the reporters' format).

## Unreleased — one QA status comment per story (phase 4)

- **One comment on the Jira story** (`reporting.jira.layout: single`, the default). Feature readiness, each service's gap report, the story review, proposed bugs and post-deploy results are sections of one "QA status" comment. A command replaces only its own section; the comment is edited in place, with the time each section was last updated. The old layout (one comment per kind) stays available as `layout: separate`.
- The showcase comment stays separate: it @mentions reviewers, and an edited comment does not notify anyone.
- Comments made by earlier versions are left as they are (nothing is deleted); remove them by hand if you want.

## Unreleased — automation (phase 2)

- **Credentials check** before the first AI call (one tiny call, `agent.accessCheckSeconds`): a missing, malformed or wrong key, a wrong Bedrock region or a missing `claude` stops at once (exit 3) with the fix. `doctor --online` runs it too.
- **`qa-sentinel stories`** (no AI): a background check of every story from Jira (`requirements.jira.search`) or story files: state, next step, who acts, and what blocks it. Writes `qa-stories.md` and a record per story (`.qa-sentinel/stories/`, optionally mirrored to a Jira issue property with `automation.record: jira`).
- **Job keys:** `spec` and `generate` skip work already done for the same ACs (in CI by default; `--once`, `--force`), respect running locks (dead local runs are detected), and stop after `automation.jobs.maxAttempts` failures.
- **Budgets** (`automation.budgets`: per story, per day, per month): every AI call is clamped to what is left; a refused step exits 4. All AI commands count, `--force` never overrides budgets. See [docs/AUTOMATION.md](docs/AUTOMATION.md).
- **`qa-sentinel known-defects`** (no AI): finds `test.fail` tests whose bug is fixed and, with `--apply`, takes the marker and the QA-BUG / QA-AGENT notes off (optionally on a branch / MR for review).

- **Jira workflow and hierarchy settings** (`requirements.jira.workflow`, `hierarchy`, `components`): ready statuses (global and per project), which link wording ties a bug/task to its story, and Jira Component → service names. A card named with `--story` that is a bug, task or sub-task is reported under its story by strict fixed rules (only cards with code, one hop, parent first, target must be a feature type in `projectKeys`, two features means neither). `story-check` shows how a card resolves; `doctor --online` checks that the statuses, issue types and link names exist in your Jira.

### Fixed in review (phase 2)

- `known-defects` did not recognise a fixed bug in real Playwright reports: the JSON report has no error for a `test.fail` test that passes, and JUnit puts "Expected to fail, but passed." in the failure body. Both are read now (checked against Playwright 1.64 output).
- Guide step 6 and the `known-defects` error message told you to write the JSON report with a shell redirect into `test-results/`, which Playwright empties at the start of a run; they now use `PLAYWRIGHT_JSON_OUTPUT_NAME`.
- `generate`: tests committed while verification was not VERIFIED (e.g. waiting for deployment) counted as a failed job, so a retry generated them again and three retries blocked the job. Committed tests now end the job as done.
- Job attempts count failures in a row; a done run resets the count.
- Trimming the story record drops finished gap-report / review jobs first, so a done spec or generate job is not forgotten (and paid for again).
- In CI, a missing local process no longer marks a job's lock dead (CI containers share host names and reuse PIDs); the lock time decides.
- Removing a known-defect marker also removes QA-BUG / QA-AGENT notes separated from the test by other comments.
- Ready status: Jira's "Done" status category counts as ready (a finished story is not stuck waiting).

## Unreleased — one test MR per story, readiness per AC (phase 3)

- **Readiness per acceptance criterion** in `qa-sentinel feature <STORY>`: an AC is ready for its end-to-end tests when every service it names (`Services` in `expected/<STORY>.md`; none named = every service the story changed) is merged and deployed in `--env`, and the Jira card is in a ready status. The report shows a table with the reason for each AC. `--run` now runs only the tests whose ACs are all ready (a test with no `@ac` tag waits for all of them); `--force` runs everything.
- **Gap report once, when the MR is ready for review:** with `automation.gapReport.when: ready` (the default) a dev MR that is still a draft gets no gap report (exit 0, a short note instead). `--even-if-draft` or `when: always` restores the old behaviour. Story-wide reports (`--story`) are not affected.
- **One comment, refreshed only when something changed:** the MR comment carries a hidden fingerprint of the test-relevant diff and the story's ACs. A later push with the same fingerprint (rebase, merge from main, docs/config only) makes no AI run and no edit; a changed one updates the same comment and adds an "Updated for commit …" line on top. `--refresh` forces a new report.
- Review fixes (Opus) for the above: the fingerprint reads each file's diff from git (non-ASCII paths, paths with spaces and binary files used to be missed, which could skip a needed report); it also covers the expected-behaviour file and scope items; only the comment written by the token's own user counts, and the stamp must be the last line; the draft and unchanged checks run before any job or budget is claimed (no exit 4 for a draft); a draft MR now gets a visible "waiting" note; a partial `feature --run` ends with a warning naming the ACs that did not run; "Draft-mode toggle" is no longer taken for a draft.
- Already in place and unchanged: `generate --story` writes one test branch and MR for the whole story across services.


## Unreleased — AC-first generation (phase 1)

**Upgrading:** `qa-sentinel upgrade` refreshes the planning and authoring skills, but not your `write-api-test`, `write-web-test` and `write-mobile-test` skills (they hold your learned conventions). Copy the discrepancy line (`test.fixme` + `// QA-AGENT:` with the behaviour id, never `test.fail`) and the "never assert the code's value" line from `templates/skills/…` by hand.

- **Expected behaviour per story** (`expected/<STORY>.md`, `tests.expectedDir`): what each acceptance criterion means in testable terms, with stable behaviour ids, values, states (ready / needs-review / unspecified with a question for the PO), clarifications agreed outside Jira, and a hash of the AC's normalised text. QA edits the data block; the readable view is generated. Updates are diff-only: unchanged ACs keep QA's edits; edited ACs are re-proposed for review; an AC missing from the story is never retired by qa-sentinel (a person sets `removed: true`). See [docs/EXPECTED-BEHAVIOUR.md](docs/EXPECTED-BEHAVIOUR.md).
- **Expectation lock** (generate and `verify --policy`): an AI run may not change, weaken, re-tag, switch off or remove a requirement test or its stored expectation while the AC's text is unchanged. Covers assertion values and any literal in the test, top-level constants it uses, `test.each` tables, describe-level tags and early returns or skips. `verify --policy` checks an agent MR's net change and tells qa-sentinel's commits from people's (people's changes are listed as QA overrides). qa-sentinel's commits record the AC hashes they were written for (`QA-Sentinel-ACs:`).
- **Requirements pass, code-blind** (`qa-sentinel spec --story KEY`, and the first step of `generate`): an AI run that sees only the story, the team's domain rules and the agreed API spec (never the test or service code) writes the expected behaviour. Every value it writes must appear in the words it quotes as its basis; what the story doesn't say becomes `unspecified` with a question for the PO. One repair round, then it fails without writing. Only new or changed ACs are sent; nothing runs when every AC is current. In `generate`, the file is committed on the agent branch before the tests are written, so the lock protects it from that run too. `tests.expectations: off` turns it off.
- **Tests name their behaviours (`@b:B1`)** and must contain each expected number and text; otherwise the run is rejected (`expected-value-missing`). `verify --policy` now also locks an expected file that is new on the branch (from qa-sentinel's commit that wrote it) and rejects `test.fail` in qa-sentinel's commits, in any code file.
- **AC-first planning:** every AC gets at least one scenario, existing tests that cover it, or a stated reason (`noScenario`, `elsewhere`, manual, …); the plan is rejected otherwise. Scenarios cite the expected behaviours they prove (`behaviourIds`: ready ones only, of the ACs they name), and assert their values, not the code's. `gap-report` plans against the stored expected file too.
- **Editing the data block** is no longer reported as editing the readable view: a view that only went stale is a warning, and `qa-sentinel spec` refreshes it without an AI run.
- **Known defects (`test.fail`):** a test QA confirmed as a product defect, with its bug link (`// QA-BUG: <link>` or an `issue` annotation). It runs in regression (passes while the defect is there, goes red when fixed) and shows as a known defect in traceability; it is no longer counted as fixme. Only a person adds the marker: an AI run that writes `test.fail` is rejected (`known-defect-by-agent`). The agent's own discrepancies stay `test.fixme` with a `// QA-AGENT:` note naming the behaviour id.
- **Result categories and a glossary** ([docs/GLOSSARY.md](docs/GLOSSARY.md)): a failing requirement test is *unclassified – needs triage* by default; *product defect* only once QA marks it; *environment* (network, certificates, gateway errors: no bug card is drafted), *not built* and *not deployed* when the evidence says so. Verification reports label each failure.
- **`requirements.jira.featureIssueTypes`** (e.g. `[Story, Enhancement]`): only these issue types get expected behaviour and the every-AC rule; a Bug or Task is still tested from its text. Empty (default): every type counts.

## Unreleased — fixes from the first full v0.8 test run

- **post-deploy runs only the story's tests:** it ran every test in the files that hold them, so an unrelated failing test in the same file failed the story. Playwright layers now get `--grep @story:<key>`; other runners still run whole files, and the report says so.
- **Healing on macOS:** Bubblegum started its engine with `python`, which macOS doesn't have (`spawn python ENOENT`). The scaffold now falls back to `python3` (or `BUBBLEGUM_PYTHON`, or the active virtualenv); `doctor` checks the same Python.
- **Jenkins sandbox behind a company proxy:** `PKIX path building failed` when downloading plugins. A root certificate put in `sandbox/jenkins/certs/` is now trusted by Java, npm and git, in Jenkins and in the pipeline's containers.
- **Jenkins sandbox job found no Jenkinsfile:** the ShopLite sandbox's qa-tests uses GitLab CI. `node sandbox/shoplite/local.mjs jenkins` adds the Jenkinsfiles (rendered from its config); the storefront URL for web tests is set for the pipeline.
- **Jenkins sandbox: tests got no base URLs (`Invalid URL`):** Docker Pipeline leaves out of the pipeline's container any variable the Jenkins container has with the same value; the compose file now passes them under `SANDBOX_*` names.
- **Sandbox `reset` undoes `merge`:** a merged scenario (SHOP-101's required delivery slot) stayed on main and made later scenarios' tests fail.

## 0.8.0-beta.2 — Environments, toggles, manual checks, gateways, personal data

- **Waiting for deployment (C1):** tests that fail only because the change isn't running in the environment yet (the service's `version` endpoint) come back as `WAITING_FOR_DEPLOYMENT`, not `FAILED`, in `generate` and `verify` (exit 4). The agent MR goes up as a draft labelled `qa-sentinel::waiting_for_deployment`.
- **Post-deploy stage (C2):** `post-deploy --env sit`: for each story a deployment touches, every service it needs deployed? Then its tests run there, results go to the report and the story; `--wait` keeps checking, still waiting = exit 75; `--mrs` re-verifies agent MRs that were waiting and marks them ready when verified. CI: `.qa-trigger-post-deploy` (service) and `qa-post-deploy` (test repo, trigger or schedule).
- **Feature toggles (C3):** `@toggle:name=value` in test titles; `toggles.environments` holds the team's get/set/reset (and lock) commands; tests run in groups with their toggles set and the toggles are always put back, also on failure or interrupt.
- **Gateways and BFFs (A2):** `gateway` rules on a gateway/BFF service and `upstream` composites in `test-map.yaml`: a service change selects the tests that reach it through the BFF; coverage counts them.
- **Automatability triage (A3):** each requirement is automated, needs a test hook (named), is better tested in the service, or is manual (with a reason). Manual ones get manual test cards in `manual-tests/<story>.md`, counted as "checked by hand" in reports, traceability and the showcase.
- **Async patterns (A4):** `pollUntil` in the scaffold, skills trigger through `tests.hooks` instead of sleeping and check side effects, fixed waits flagged, story review flags ACs that need a test hook.
- **Auth patterns (D3):** `tests.auth` (helpers agents must reuse, roles with credentials from the environment); scaffolded `tokenFor`, TOTP and DPoP helpers; Singpass via MockPass; `doctor` checks roles.
- **Personal data guard (F5):** showcase evidence is scanned for NRIC/FIN, real emails, phones and card numbers before it goes to Jira; `showcase.pii.mode: block` (default), `warn` or `off`; allowlists for test data.
- **Model routes (E5):** `doctor` names the route (Claude login, Anthropic key, Bedrock, Vertex, or an organisation's gateway from managed settings) and what it is missing; auth errors give route-specific fixes.
- **Metrics (B5, B6):** fast-forward and squash merges with deleted branches are judged from the merge requests' heads (fetched from origin); cost by change size per command, with budget suggestions after 10 runs.
- **Cucumber (D4):** `.feature` scenarios are indexed for traceability, coverage and regression; writing features is planned (docs/decisions/cucumber.md).
- **Proven:** runtime healing with the real Bubblegum engine (`sandbox/bubblegum/e2e.sh`, also in CI); a local Jenkins sandbox for `Jenkinsfile.tests` (`sandbox/jenkins`).

## 0.8.0-beta.1 — Spec-first contracts, test-data cleanup, coverage and backfill, service discovery

- **Spec-first contracts:** `workspace.services[].contract` points to the agreed API spec when it lives outside the service repo: a file next to the tests, a specs repository (local clone or GitLab project, at a ref), a URL (with an optional `Authorization` header from an env var) or an attachment on the Jira story (newest match). Gap reports compare the implemented spec at head with it, field by field and including error responses, for the endpoints the MR touches (the rest are counted); the agreed spec is saved for the agents, who treat it as the API oracle, and mismatches count as breaking for risk. `contract-check [--strict]` checks every endpoint; `doctor` checks that the agreed spec is there. Jira attachments are downloaded only from the Jira site itself.
- **Test-data ledger:** `testData.cleanup: ledger | project | none`. With the ledger, tests record each record they create with the request that deletes it (`data.track(kind, id, { path })`); the fixture deletes them newest first when the test ends, pass or fail. `data status` and `data sweep` handle what killed runs left behind (newest first, relative paths on the test environment only, 404 counts as gone, failures kept for the next sweep). New frameworks get the ledger; `add-data-ledger` adds it to existing Playwright projects. `generate` sweeps after verification and reports what stays behind; the CI templates sweep after every job. The test-data agent and the review skill follow `testData.cleanup`.
- **Coverage and backfill:** `coverage` lists every endpoint (from the implemented spec, else the agreed contract) and every front-end route with the tests that exercise it (tags and `test-map.yaml`), and ranks untested, fixme-only and status-only endpoints by a readable risk heuristic (auth, money, personal data, writes with business-rule errors). `backfill --service` takes the riskiest gaps in small batches through the normal generation flow, with the API contract as the oracle, one MR per batch.
- **Service discovery:** `discover --gitlab-group` lists a group's projects, classifies them (api, web, mobile, library), finds OpenAPI specs (or the generator that makes them) and suggests `dependsOn` from config files that name another service, each with file and line evidence. It writes a commented draft; `--apply` adds services not configured yet.
- `.gitignore` and the uncommitted-changes check know the new output files (`.qa-data/`, `qa-coverage.*`, `qa-contract-check.md`, `qa-services.draft.*`).

## 0.7.2 — Fits more projects as they are

- **Specs generated at build time:** `workspace.services[].openapiCommand` (e.g. `npx tsoa spec`). qa-sentinel runs it at the MR's base and head commits in throwaway worktrees that share the service's `node_modules`, diffs the two specs, and gives the agent the generated head spec. The command runs with the test environment (no publishing credentials) and a time limit (`openapiCommandTimeoutSeconds`, default 180). `doctor` and `tag` understand it.
- **Mocha, vitest and jest test repos:** qa-sentinel finds the runner behind npm scripts and switches on a JUnit reporter it can use (mocha's built-in xunit, vitest's junit, jest-junit when installed), so verification, traceability and the showcase see per-test results. The team's own filters (e.g. `--grep <env>`) are kept. `doctor` warns when a spec glob in the run command or `.mocharc` would make every run include all tests, and when per-test results aren't readable.
- **Test repo inside a monorepo** (e.g. `packages/api-tests`), and services that are folders of a shared repo (`workspace.services[].subdir` for CI): paths are taken from the folder, files elsewhere count as outside the test repo, a service sees only its own diff, and `init` renders GitLab CI that runs from the folder (`QA_TESTS_DIR` in the service template).
- **Dependency bots:** `ci.skipBranches` (default `^renovate/`, `^dependabot/`): no gap report and no generation, in the CLI and as GitLab rules (merge commits name their branch). Entries must be simple regexes (they're also written into GitLab rules). **Behaviour change:** bot MRs that used to get gap reports no longer do; set `ci.skipBranches: []` to keep them.
- **Generation after deployment:** `QA_GENERATE_AFTER: "deploy"` plus a job that `extends: .qa-trigger-generation` after the team's deploy job, instead of generating right after the merge.
- **npm-ready:** package metadata, `publishConfig`, Node 20+. Until it is published, install from GitHub (`github:bishnu133/qa-sentinel#v0.7.2`).
- Safety: with `--checkout`, qa-sentinel refuses to move a service that shares a repository with the test repo; spec generation runs with git hooks off and the test environment.
- Fixes: JUnit `classname` is used as a file only when it is one; the showcase read a test's `name` from inside `classname`, so JUnit results could match the wrong tests.

## 0.7.1 — Credentials masked in everything published; fixes from the first macOS run

- **Credentials never published:** before anything goes to GitLab (MR descriptions, notes) or Jira (comments, bug cards, text attachments), the values of credential-like environment variables and the `user:password@` part of any URL are replaced with `[redacted]`. Agents and test runs need some credentials, such as a device farm's key inside `QA_APPIUM_URL`, so agent-written text could otherwise quote one. `doctor` no longer prints the Appium URL's credentials.
- **AC numbering:** `story-check` warns when a story's ACs aren't numbered (ids by position shift when an AC is inserted or reordered); ONBOARDING step 3d explains why to number them.
- **macOS:** Finder's `.DS_Store` files (and `Thumbs.db`, `desktop.ini`) no longer count as changes: `lessons` and `generate` refused to run because of them. `init` adds them to `.gitignore`.
- `lessons`: no "fatal: path … does not exist" on a first run; after a refusal it returns to the starting branch (not a detached HEAD).
- Sandbox: `build.sh` accepts minor SDK platforms (`android-36.1`); mobile runs ignore `QA_APP_PACKAGE`/`QA_APP_ACTIVITY` left in the shell; `reset` stashes untracked leftovers in qa-tests.

## 0.7.0 — Learning from review, mobile end to end in the sandbox

### Learning from review
- `qa-sentinel lessons [--since] [--push] [--dry-run]`: for agent commits merged with reviewer edits (merge commit: the MR branch after the agent's commit; squash: the agent's files against the squashed result), an agent (read-only, skill `learn-from-review`) writes general lessons with the commits they come from, or skips one-off fixes; code validates them (known commits only; `updates` must name an existing lesson) and writes `kb/review-lessons.md` on `qa-sentinel/review-lessons` (MR with `--push`). The reviewed commits are recorded in the file, so nothing is learned twice.
- Only the reviewer's edits count: for merge commits the MR branch's own non-merge commits on the agent's files (main merged into the branch and later agent runs excluded); for squash merges a three-way interdiff (the target before the squash plus the agent's change, against the squash result), so other MRs merged meanwhile don't count.
- Lesson text is one plain line per field (no headings, code fences or HTML comments can be written into the file agents read); an update matches the exact lesson heading; a repeated lesson strengthens the existing one.
- An open lessons MR is built on, never replaced (reviewers' edits on it survive the next run); the branch starts from the target branch and the command returns to the branch it started on.
- `metrics`: merged-without-edits by month.
- GitLab template: scheduled `qa-lessons` job (`QA_LESSONS=true`).

### Mobile end to end in the sandbox
- `local.mjs setup --mobile`: the ShopLite Android app (`services/shoplite-app`: Java, programmatic UI with accessibility ids, deep links `shoplite://orders/<id>`, built by `build.sh` with javac/d8/aapt2/zipalign/apksigner), screen objects (`HomeScreen`, `NewOrderScreen`, `OrderScreen`) and app tests, the app as a `kind: mobile` service with its screens in `test-map.yaml`.
- Scenario SHOP-109 (mobile): the gap report names the one app test the change breaks and gives the `wdio --spec` command for it.
- Regression selection: a changed page or screen selects only its own service's tests (an app screen and a web route can share a name). `local.mjs app build`; `run` builds the app from the developer's change, checks Appium and the emulator, runs selected app tests with `--regression`, and includes the app tests in `--showcase`.
- GitHub Actions `android-sandbox`: builds the app, runs the app tests and `qa-sentinel verify` on an Android emulator.
- Mobile scaffold: `openDeepLink` takes the app package from the session (installed APKs); `add-mobile` adds `wdio.conf.ts` to `tsconfig.json`.

## 0.6.0 — One showcase video per story, Mobile, "is the story built?", story-wide runs, bug cards, metrics

### Showcase pack (replaces the manual Biz showcase)
- `showcase.format: pack` (default): when every AC of a story passed, qa-sentinel re-records the chosen test per AC in showcase mode (slowed down, the element being used outlined, a pause on the result; `showcase.video`) and joins them with title cards into **one `<STORY>-showcase.mp4`**, plus **one `<STORY>-showcase.pdf`** with the results per AC, a screenshot per UI test and the API requests and responses. Picks per AC: a test tagged `@showcase`, else a web test, else a mobile test, else any passing test.
- Attached once, only after all ACs passed, and only from runs on `showcase.environments`. `showcase.notify` tags the reviewers; the comment names exactly what was attached.
- Needs a full ffmpeg with libx264 (`showcase.video.ffmpeg`, `QA_FFMPEG`, PATH or `ffmpeg-static`); without it the PDF and the separate recordings are attached. `format: files` keeps the v0.5 behaviour.
- In the video every step is captioned ("Click Checkout button", "Enter "2" into Quantity") next to the outlined element, held long enough to read (`showcase.video.stepMs`), and each test ends on "✓ Verified: <test>". The blank start of each recording is trimmed (`trimStartMs`). A failed showcase recording pass now says why.
- Phone recordings are made at the device's own size and orientation, and each ends on its last frame for `holdMs` (Android only records frames when the screen changes, so a still screen would otherwise vanish from the video).
- Secrets in API evidence (password, token, authorization, card fields, JWTs, bearer tokens) are redacted in the PDF and the evidence file.
- GitLab template: the showcase job installs ffmpeg and starts the environment.

### Mobile (WebdriverIO + Appium)
- New layer `tests.mobile` (dir, screensDir, runCommand, appiumUrlEnv, platform) and service `kind: mobile`. `init --mobile` / `add-mobile` scaffold `wdio.conf.ts` (device and app from the environment; device-farm URLs with credentials), screen objects, a ui helper with intents, evidence hooks (screen recording, final screenshot, API setup calls, one result file per test) and the `write-mobile-test` skill, and add the WebdriverIO packages.
- Plans: scenarios with `layer: mobile` and a screen; `@screen:` tags are indexed like pages; UI setup steps are allowed for mobile tests (with a reason).
- Verification: Appium `/status` preflight (credentials sent as a header, never printed), `--spec` per file, JUnit from a folder; regression and `feature --run` run mobile specs with their own command. The showcase pack re-records mobile tests and includes their recordings.
- CI: a `mobile-tests` job (GitLab, when `QA_APPIUM_URL` is set) and a `Mobile tests` stage (Jenkins). The scheduled suite command leaves mobile out.
- The device and evidence files (`wdio.conf.ts`, `src/mobile/evidence.ts`, `src/mobile/ui.ts`, `src/fixtures/mobile.ts`) are blocked for agent writes.

### Requirements: "is the story built?"
- Scope items: list items under the story's "Tech scope" / "Expected results" headings (`requirements.scope.sections`) or Jira fields (`requirements.jira.scopeFields`) become TS-n / ER-n, traced like ACs.
- Every plan has `requirementStatus`: implemented · partial · not-found · conflict · elsewhere · not-applicable per AC and scope item, with evidence and the ACs that cover it. The gap report has an "Is the story built?" table and lists scope items no AC covers; the Jira summary shows "⛔ Not built".
- `review-story`: before development, a read-only review of the story (ambiguous ACs, missing negative and edge cases, scope without an AC, open questions), optionally posted on the story.

### Onboarding and story templates
- `requirements.template`: each team describes how its stories are written as sections with a role (acceptance-criteria, scope with an id prefix, out-of-scope, context, showcase, ignore) and the headings that start them. Defaults cover common names (In-scope, Tech notes / Implementation, Expected results, Out of scope, Assumptions, Questions, Feature toggles, Showcase approach, Checklist). `requirements.scope.sections` from earlier 0.6 builds still works.
- Acceptance criteria from numbered/bulleted lists, `AC-n` lines, Gherkin scenarios, and Given / When / Then **tables** (any column order, a number or scenario column, multi-line cells, `—` for empty steps); the story's own AC numbers are kept when present.
- Nested bullets stay with their parent item; a short label before a list (a service name, "Data model") groups its items; a tech note is tied to the service it names. Jira wiki (`**` depth, `||` tables) and ADF (nested lists, tables) both convert faithfully.
- Out-of-scope items are given to the agents as exclusions; context sections (assumptions, questions, feature toggles) as evidence; the showcase approach goes into the showcase PDF. A story proven only by API tests gets the PDF without a video.
- Story-mode and single-service gap reports say when the story names a service that has no change for it.
- `story-check --story KEY [--fields]` (no AI call): how a story is read, what to change in the template, and the issue's Jira field ids. `init` asks for the requirements source, Jira URL and project keys, GitLab URL and test repo project, and the test layers (also as flags). `doctor` checks the story key pattern and the template. New guide: `docs/ONBOARDING.md`.

### Story-wide runs
- `gap-report --story KEY` and `generate --story KEY`: everything the story changed across services as one plan and one test MR (`qa-sentinel/story-KEY`). For merged parts only the story's own change is taken (the merge's or squash's net change), never other work merged meanwhile. Regression selections are merged across parts.

### Bug cards
- `bugs.mode: off | suggest | create`. Sources: failing tests written to an AC (`qa-sentinel bugs` after a run), the fixme tests a generation wrote because the product disagrees, and (story-wide, `bugs.notBuilt`) ACs nothing builds (labelled suspected).
- Each bug has expected vs actual, the test and command to reproduce, the environment, where to look in the code, evidence, and a `{code:json}` block for coding agents. Recorded on the story as soon as it is created (never raised twice); "now passes" is noted on the bug when its tests pass.

### Quality
- Verification retries failed specs once (`verification.retryFailed`); a pass on retry is reported as flaky, matched by file and title.
- `tag`: one-off backfill of `@service`/`@endpoint`/`@page` tags on existing tests; only added tags inside test titles are accepted.
- `learn` also writes web and mobile conventions into their skills.
- Accessibility: `tests.web.accessibility: new-pages` adds one axe (WCAG 2 AA) test per new or changed page; the check fails if `@axe-core/playwright` is missing.
- Risk factors `user-journey`, `ui-visible` and `price-display`.
- `metrics`: verification rate, merged-without-edits rate (merge, squash, fast-forward), cost per command, plan repairs, guardrail stops, from run manifests (local or downloaded CI artifacts) and git history.
- `upgrade`: refreshes qa-sentinel's agents, skills, CI templates and project context after an update, keeping learned conventions.
- Spec paths are shell-quoted wherever a command line is built.

### Also
- Existing projects (`init --mode existing`, `add-web`, `add-mobile`) get the packages the new scaffold files import added to package.json.
- Scaffold files follow `pagesDir`, `screensDir` and the tests' `dir` in their relative imports.
- Benchmark on v0.6: 100% gap recall, precision and decision accuracy, no repair rounds, $0.73.

## 0.5.0 — Web tests, workflow planner, video evidence, optional Bubblegum healing

### Web (Playwright UI)
- New test layer `tests.web` (dir, pagesDir, runCommand, baseUrlEnv) and service `kind: web` with `routes`. `init --web` scaffolds it for new projects, `add-web` adds it to existing ones (and prints the Playwright project to add).
- Scaffold: `src/web/ui.ts` (page-object actions with intents), `src/pages/base-page.ts` (routes with `:params`, relative to the base URL), `src/fixtures/web.ts` (`ui`, plus `api` and `data` for test data through the API), example spec. Playwright `web` project records video and screenshots; `QA_BROWSER_CHANNEL=chrome` / `QA_BROWSER_PATH` when Playwright's browser can't be downloaded, `QA_VIDEO=off` without ffmpeg.
- Plans: change type `ui-change` with `page`, risk factors `user-journey` (high) and `ui-visible` (medium). Scenarios carry `layer` and `page`.
- Before authoring, qa-sentinel opens the affected pages (routes with params via links on known pages) and saves each page's accessibility tree and a screenshot to `page-snapshots/` for the agent (`tests.web.explore`).
- New `write-web-test` skill: page objects before specs, locator rules, `@page` tags, data through the API. The plan, generation, analyzer and mapper prompts know about web.
- Verification runs each layer's changed specs with its own command, base URL and preflight (`tests (web)` in the MR). Test index reads `@page` tags; `test-map.yaml` `screens` are checked; regression selection adds `changed-page`; selected tests run as one Playwright invocation across projects.
- `feature --run`, doctor (base URL, page objects, browser, Bubblegum), guardrails (web host allowed), env forwarding (`QA_WEB_URL`, browser and healing switches) all cover the web layer.

### Workflow planner
- Scenario `setup` is a dependency graph of steps (`id`, `via`: api · test-data-service · db-helper · ui, `helper`, `dependsOn`, `why`). Validated in code: unknown or cyclic dependencies are errors; UI setup only in web tests and only with a reason; DB helpers only with a reason. Plain strings still work (ordered API steps). The gap report prints the flow per scenario.

### Optional runtime healing (Bubblegum)
- `tests.web.healing: bubblegum`: with `QA_HEALING=bubblegum`, a failed page-object action is performed by `@bubblegum-ai/node` `recover()` from its intent, attached over CDP to the same browser (one port per worker). Each healed step is attached to the test and annotated.
- Healing is always off when qa-sentinel verifies agent-written tests; `feature --run` and scheduled CI runs may use it.
- Showcase `maxFiles` default raised to 20 (a web test brings a video and a screenshot; videos are kept first).
- New `qa-sentinel healed`: lists healed steps per page-object call site (`qa-healed.md`), keeps them for the next generation run (`qa-healed.json`), exits 1 with `failOnHeal`.
- GitLab template: the suite job runs API and web together with `QA_HEALING`, installs the browser, and an optional `qa-healed` job. Jenkins: same suite command.

### Sandbox
- New `storefront` service (web front end on :8081, no dependencies) with page objects and 4 baseline web tests; `qa-env` starts it. Scenarios SHOP-107 (renamed button breaks two web tests; planted total bug → AC-3 conflict) and SHOP-108 (clean; Showcase with a video per AC). `setup` installs Chromium or explains the Chrome fallback.

### Also
- Verification JUnit: API results stay in `.qa-sentinel/runs/<run>/junit.xml`, web results go to `junit-web.xml` (CI templates collect `junit*.xml`).
- The web scaffold files that decide healing (`src/web/healing.ts`, `src/web/ui.ts`, `src/fixtures/web.ts`) are blocked for agent writes, and the agent's own test runs always use `QA_HEALING=off`.
- `add-web` also refreshes `.claude/qa-sentinel.md` and the CI templates in `ci/qa-sentinel/`.
- The template renderer supports nested `{{#if}}` blocks.

## 0.4.0 — Simple Jira comments, lower-environment runs, Showcase, feature manifests

### Jira comments in plain language
- `reporting.jira.format: summary` (default): the story gets a short comment for POs, developers and QA leads (risk, what changed, what QA will do, a table of acceptance criteria with a status each, decisions needed, open questions, a link to the full report on the MR). `full` keeps the technical report.
- After `generate --push`, the same comment is updated with the results per AC (tested and passing, weak test, product doesn't match the story, waiting for a fix, no test yet) and the environment the tests ran on.
- Publishing moved to `src/reporting/publish.ts`, shared by gap reports, generation and feature manifests.

### Run on a lower environment before the MR
- New `environments:` (name → `baseUrl`, description). `generate --env sit` and `verify --env sit` run the verification against that environment; `verification.defaultEnvironment` sets the default.
- `verification.requireVerifiedToPush: true`: nothing is pushed or opened as an MR unless verification was VERIFIED on the environment.

### Showcase agent
- `qa-sentinel showcase --story KEY` reads the run results (Playwright JSON preferred, JUnit attachments as fallback) and checks the story is ready: every AC has active passing tests, none failed or did not run, no pending fixme (`showcase.requireNoPending`).
- Attaches an evidence file (per AC: tests, environment, and the request/response of each API call) plus videos and screenshots from the run, within `maxFiles`/`maxFileMb`, and posts a short comment.
- One time per story: what was attached is stored in the issue property `qa-sentinel.showcase`. It attaches again only when QA adds the `qa-showcase-refresh` label (removed afterwards; the previous evidence is deleted with `replaceOnRefresh`) or with `--force`.
- `--dry-run`, or no Jira configured: the evidence is saved to `qa-showcase/<story>/`.
- Scaffolded API client records each call (no headers; bodies clipped) and fixtures attach `api-log.json` to the test (`QA_API_LOG=off` disables it). The Playwright config adds the JSON reporter.
- GitLab template: optional `qa-showcase` job after `api-tests` (`QA_SHOWCASE: "true"`).

### Feature manifests across services
- `qa-sentinel feature KEY [--env sit]`: finds the story's MRs (GitLab) or branches and commits (local git, exact-key match) in every service, checks each service's `version` endpoint for the deployed SHA, and reports a status: no changes found, in development, merged, waiting for deployment, ready for feature tests. `--run` runs the story's tests when ready; `--post` updates the Jira story. Writes `qa-feature-<KEY>.md/.json`.
- Gap reports say which other services change in the same feature.

### Also
- `generate` ignores qa-sentinel's own output files when checking for a clean repo.
- Benchmark: injected instructions are no longer matched against expected product changes (they are scored by the suspicious-content check). Decision accuracy back to 100% on the saved plans.
- Sandbox: SHOP-106 is a two-service feature (notifications + orders); services expose `/version`; `local.mjs merge`, `feature`, `run --change-only`, `run --generate --showcase`.

## 0.3.0 — Traceability, regression selection, decision engine, test review, kb

### Requirement traceability from test tags
- Tests declare what they prove in their titles: `@service`, `@endpoint`, `@story`, `@ac` (constants such as `const tags = "…"` are resolved). qa-sentinel indexes every spec on each run (status, ACs, assertion count, status-only flag).
- MR descriptions (and gap reports, when tests already trace the story) show an AC → test matrix: covered, discrepancy (passing tests plus a fixme), pending only, not traced.
- New tests without `@endpoint`, or citing ACs that aren't in the story, are policy warnings. Tags are checked against `test-map.yaml`.
- New command `qa-sentinel trace`; `doctor` reports tag coverage and test-map mismatches.

### Regression selection
- Computed in code from plan-named tests, changed endpoints (plan + contract diff), `test-map.yaml`, consumer services for breaking or cross-service changes, and a service-wide fallback for changes without an endpoint. Fixme/skip tests are never selected.
- Gap reports include the list with reasons and a ready runner command; `qa-regression.txt` holds `file:line` arguments.
- Sandbox: `local.mjs run <id> --regression` runs the selection against the change (SHOP-101: the 3 predicted breaks failed, the other 3 passed).

### Decision engine
- `src/plan/decide.ts`: one table of allowed decisions per change, from oracle status, coverage and observability. Safety rows are corrected in code (conflicting or ambiguous oracle → review; no oracle and no contract or kb evidence → review; suspicious instruction → skip). Other mismatches are repair errors. The applied rule is shown with each decision.
- With no story, the API contract (or a kb rule) can be the oracle: create/update are allowed when the change cites `openapi`, `contract-diff` or `domain-rule` evidence.

### Independent test review
- After verification, a second read-only agent with a fresh context (it never sees the author's notes) judges each changed test against the ACs: strong / adequate / weak / wrong-oracle, with issues and a suggestion, plus scenarios it thinks are missing. Validated JSON, one repair round, rendered in the MR, `qa-sentinel::weak-tests` label. Advisory; it never changes the verification status. `review.enabled`, `agent.*.review` limits ($1 default).
- First real run (SHOP-102): flagged the zero-amount 400 test as wrong-oracle (code-only behaviour as an active test), the same issue found in human review.

### Knowledge base
- `kb/` Markdown (domain rules, glossary, review lessons) is gathered per run and given to planner, author and reviewer; new evidence source `domain-rule`. `kb/**` is blocked for agent writes. `init` scaffolds `kb/README.md`; the sandbox ships payments rules and review lessons.

### Also
- Jira as a gap-report target (`reporting.targets`), see below.
- Discrepancy titles resolve tag constants (`${tags}`).

## Unreleased — Sandbox, replay and Jira reporting

### Jira as a report target
- `reporting.targets: [gitlab-mr, jira]`: `gap-report --post` also comments on the story (key from MR title, branch or commits). One comment per service per story, updated in place on every run; Markdown converted to Jira wiki markup; capped at `reporting.jira.maxChars` with a link to the full report artifact; optional `visibility`. Publishing never fails the job.

### Try it yourself
- **ShopLite sandbox** (`sandbox/shoplite/`, guide in [docs/SANDBOX.md](docs/SANDBOX.md)): orders, payments and notifications services, a Playwright API test repo (13 baseline tests) and six scenarios (SHOP-101 to SHOP-106), each with a known catch.
  - `local.mjs`: everything on your laptop, including the QA environment (gateway on :8080).
  - `setup-gitlab.mjs`: creates the projects, CI variables and job-token access on your GitLab group; `level maintenance` switches on generation.
  - `dev.mjs`: plays the developer (open / merge / close MRs).
  - `jira-seed.mjs`: creates the stories in Jira Cloud and moves them to "In Progress".
  - Real outputs from all six scenarios are in `sandbox/shoplite/example-output/`.
- **Historical replay** (`npm run replay`): for commits that changed code and tests, hides the test changes, runs the gap report on the code alone and compares it with what the developer did. Example results are in `bench/replay-results/examples/`.

### CI
- `QA_SENTINEL_PACKAGE` variable chooses where CI installs qa-sentinel from (for example a GitHub branch while it isn't on npm). GitLab and Jenkins templates.
- CI installs a GitHub source (`github:owner/repo#branch`) by cloning, building and packing it first; npm's build-on-install for global git dependencies failed on GitLab runners.
- `QA_ENV_START` hook: a command run before generation and API tests, to start an ephemeral QA environment inside the job.

### Rules
- An `internal` change type is always non-observable; `update` or `create` on it is a validation error (a refactor was rated critical).
- `cross-service` risk only for breaking contract changes or removed endpoints.
- Dependency service directories are passed to the agent only when they exist.
- Benchmark: parallel runs no longer leave console output muted.

## 0.2.0 — Trusted plans

### Structured plan between AI and code
- **TestPlan** (Zod, `src/plan/schema.ts`): changes with evidence, oracle status, risk factors, and one decision per change (reuse / update / create / review / skip). It is the only handoff from the agent; prose is never parsed.
- **Validation in code:** strict schema plus cross-field rules. For example:
  - `reuse` needs `covered`;
  - `update` needs an existing spec and scenarios;
  - `skip` needs evidence and a non-observable change;
  - AC ids must exist;
  - test files must exist;
  - no "approved" oracle without requirements.

  One repair round, then the run fails honestly.
- **Safety correction:** a conflicting oracle is always forced to `review`.
- **Risk computed in code** from evidence-backed factors (critical for auth, money or personal data; high for business rules, breaking contracts and similar). `breaking-contract`, `conflicting-oracle` and `cross-service` are derived by qa-sentinel. Non-observable changes are low.
- **Gap reports are rendered from the validated plan:** same structure every time, plus a computed contract-diff section and an analysis-incomplete fallback.
- **`generate` is split into plan → validate → author.** The author implements only update/create/review decisions. When every decision is reuse/skip, nothing is generated.

### Deterministic analysis
- **OpenAPI contract diff** between base and head (`src/analysis/contractDiff.ts`). It resolves local `$ref`s and covers:
  - operations, params, request and response fields;
  - required, type, nullability, enums and constraints;
  - status codes.

  Each change is classified as breaking or compatible, for requests and responses separately.

### Requirements
- **Jira** (Cloud and Server/DC, REST v2): the story key comes from the MR title, branch or commit messages, limited to `projectKeys`. Acceptance criteria come from a custom field or the description, with wiki markup and ADF normalised. **Approval comes from the issue status** (`approvedStatuses`). Credentials are CLI-only.

### Product
- **Operating levels:**
  - `intelligence` (default for new projects): read-only;
  - `maintenance`: generation enabled.

  CI templates and `generate` respect the level.
- **`AgentEngine` interface** with `ClaudeCodeEngine`, so other runtimes stay possible.
- **Benchmark** (`npm run bench`): 8 scenarios from the external review, scored on gap recall, gap precision, decision accuracy and checks, with real runs recorded in `bench/results/`.
- `doctor` checks the Jira configuration and the operating level.

### Fixed by the benchmark
- The skill was missing the shapes of some list entries, and the schema rejected `null` for optional fields; both caused avoidable repair rounds.
- A refactor of validation code was rated medium risk; non-observable changes are now low.
- Inconsistent `money` tagging is fixed with explicit definitions of the sensitive factors.

## 0.1.1 — Safety and correctness

Addresses external review #1 (see [docs/REVIEW-RESPONSE-1.md](docs/REVIEW-RESPONSE-1.md)).

### Security
- Agents and test runs get an **allowlisted environment**. Publisher tokens (`QA_SENTINEL_GITLAB_TOKEN`, `CI_JOB_TOKEN`) and credential-like variables are never passed through unless listed in `guardrails.passEnv`.
- Pushes use a one-off URL, so tokens are never written to `.git/config`. CI templates strip tokens from clone remotes before agents run.
- Claude Code now runs with `--permission-mode dontAsk`, `--tools`, path-scoped `Edit(...)` allow rules and `--settings` deny rules.

### Guardrails, enforced in code
- `guardrails.allowedWritePaths` / `blockedWritePaths`. Every added, modified, deleted and renamed path is checked after the agent run, and any violation rejects the run with nothing committed.
- Added code is scanned for URL hosts outside `guardrails.allowedHosts` and for secrets (keys, tokens, JWTs).
- Assertion counts are compared per changed spec, and deleted tests are flagged (`assertionRemoval: warn|fail`).
- The service checkout and, for gap reports, the test repo must be untouched (before/after snapshot).
- `learn` may only change its three knowledge files.

### Correctness
- **Requirement snapshot:** story file → MR context → the MR that introduced the merged commit (GitLab API). Saved per run, cited in reports. Optional `requirements.required`.
- **SHA pinning:** refs are resolved to full SHAs, and the run fails unless the service is at the analysed commit (`--checkout` to detach). There is a run manifest per run.
- **Independent verification** and a new `qa-sentinel verify` command: preflight → tsc → lint → changed specs with JUnit → `VERIFIED` / `FAILED` / `BLOCKED` / `NOT_RUN`. Draft MR, status label and non-zero exit unless VERIFIED.
- fixme/skip tests added by the agent are listed as **unresolved product discrepancies** in the MR.
- Timeouts (process-group kill) and `--max-budget-usd` per command.

### Agents and skills
- Oracle hierarchy and states (approved / conflicting / ambiguous / missing).
- Rule-based risk.
- `unknown` coverage.
- Explicit reuse / update / create / review / skip decisions.
- Revised test-data policy.
- Untrusted-input rules in every agent.
- Gap reports lead with risk, a recommended action and a decision table.

### CI and GitLab
- The type-check and the agent-MR gate are blocking (`qa-sentinel verify --policy`).
- Repo-wide generation lock.
- Pinned service checkout.
- Idempotent MR create/update, retries with backoff, paginated note search.
- `doctor --online` checks real GitLab access.

## 0.1.0
- First version: `init`, `learn`, `doctor`, `gap-report`, `generate`; 5 agents, 4 skills; GitLab and Jenkins templates; Playwright API scaffold; delivery-slot demo.
