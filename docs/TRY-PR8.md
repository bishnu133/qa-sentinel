# Try it: mutation checks, benchmark cases, consistency and new metrics (PR 8)

Steps marked **FREE** cost nothing (no AI, no Jira, no GitLab). Steps marked **AI** cost money; the cost is written next to the step.
Run the free ones first.

## Part 1. Run the tests (FREE)

1. `export QAS=~/Documents/qa-sentinel`
2. `cd $QAS && git fetch origin && git checkout pr8-trust-metrics && npm ci && npm run build`
3. `npx vitest run test/mutate.test.ts test/agreement.test.ts test/benchCases.test.ts test/generateBench.test.ts test/trustMetrics.test.ts`

Expect 5 files, all passing. They use temporary folders and a fake AI. They need no internet and no git name or e-mail.

## Part 2. The mutation check (FREE)

It plants known bugs in the ShopLite orders service and tells you which ones your tests notice.

1. `cd $QAS && node sandbox/shoplite/local.mjs setup` (this installs packages, so it needs internet once; add `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` in front if you do not want a browser download, the API tests do not need one).
2. `npm run bench:mutate -- --scenario SHOP-101`
3. Wait about a minute. It starts and stops the local ShopLite environment 8 times.
4. Read the table. Expect: `7 planted defects, 6 caught, 1 survived`. The row `cap-3-to-5` says caught, and the failing test is the AC-3 test ("the 4th order for the same slot is rejected"). The row `slot-equal-to-now-accepted` says **survived**; that one is on purpose, no test can hit the same millisecond.
5. The same table is saved in `bench/results/mutations-<time>.md`.
6. If it says `/tmp/services/... exist(s)`, remove that folder (it is a leftover of a CI-style run) and run again; with it, the defects would not be tested at all.
7. If the first line says "Nothing was scored", the tests do not pass on the correct code. Look at the failing test names it lists. Check that port 8080 and ports 3001 to 3003 are free (`node sandbox/shoplite/local.mjs env stop` stops an old ShopLite).

## Part 3. A feature across three services (FREE)

1. `npm run bench -- --features`
2. Expect a table with 4 steps and a tick on each. Step 1 says orders merged and payments is still open, so AC-2 and AC-3 are `waiting-merge` and only AC-1 is planned. The last step says all three are merged and the Jira card is ready, and then AC-1, AC-2 and AC-3 are all planned.

## Part 4. Consistency of repeated runs

1. **AI, about 36 US cents** (measured: about 12 cents for each run of this scenario): `npm run bench -- --only ac-conflict --runs 3`. For reference, all 12 scenarios once cost $1.64 when measured.
2. Expect, at the end of the table, a block "Consistency across runs". It shows, for `ac-conflict`, how many of the 3 runs agreed on each decision, on the risk, and how many tests each run proposed.
3. **FREE:** make the table again from the saved file, any time: `npm run bench -- --summarise bench/results/<the newest .json>`. The file name is required: without it you get the usage and exit code 2, and nothing runs.

## Part 5. The generation benchmark

1. **AI, a rough estimate is 1 to 3 US dollars for each scenario, so about 2 to 6 dollars** (I could not measure it; the number printed at the end is the real one): `npm run bench -- --generate`
2. It runs the whole `generate` on `new-validation` and `test-data-collision` in temporary folders. It runs `npm install` in them and starts the sample service on a free port, so it needs internet. It can take 10 minutes or more.
3. Read `bench/results/latest-generate.md`. For each scenario: the outcome, the verification status (VERIFIED means the written tests passed against the sample service), how many expected values were missing, how many tests the review called weak, and the checks. For `test-data-collision` look at "tests do not use a fixed reference value".
4. Run one scenario only: `npm run bench -- --generate --only test-data-collision`.

## Part 6. The new numbers in `metrics`

1. **FREE**, in any test repo that already has runs: `npx qa-sentinel metrics --no-fetch`. Three new rows: agent-written tests that were flaky, hours from service change to test merge request, and gap report comments (a dash until Part 7). The first two fill up as you use `generate` and keep the run folders (or pass `--runs <folder>` with downloaded CI artifacts).
2. Only runs made after this change have the times. Older runs are left out, and the row says so.

## Part 7. Votes on gap reports (real GitLab, FREE, needs a GitLab token)

1. Run a merge request pipeline with `gap-report --post` so that the comment appears. Its last line says "Was this useful? 👍 / 👎 on this comment". (To turn the line off: `reporting: { votes: false }` in `qa-sentinel.config.yaml`.)
2. In GitLab, add 👍 (or 👎) to that comment.
3. `export QA_SENTINEL_GITLAB_TOKEN=<a token with read_api>` and run `npx qa-sentinel metrics --online --no-fetch --runs <folder with the run's manifest.json>`.
4. Expect the row "Gap report comments: 👍 / 👎" to show the counts, for example `1 / 0 on 1 comment(s)`. The run's `manifest.json` must be in the folders read: the comment id is stored there (`mr.noteId`).
5. Jira comments have no reactions, so they are not counted. There is nothing to set up for the votes; if nobody reacts the row shows `0 / 0`.

## What to remember

- "N planted defects, M caught" is about these hand-written defects and these tests. It is not a general mutation score.
- The reference tests in `bench/mutations/SHOP-101/tests` stand in for what an agent should write. To measure tests an agent really wrote, run `generate` for SHOP-101 in the sandbox, then `npm run bench:mutate -- --scenario SHOP-101 --tests-ref <the branch in shoplite-local/qa-tests>`.
- Not proven on real systems: `bench --generate`, `--runs 3` and `metrics --online`.
