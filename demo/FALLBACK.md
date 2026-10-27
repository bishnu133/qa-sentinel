# Plan B: when Jira, GitLab or the AI are not available

Be honest with the audience: say what is recorded and what is live.

## Level 1: Show recorded output (no tools needed)

These files are real outputs from earlier runs of the same kind of change (the delivery-slot story with a cap of 5 in the code and 3 in the story). Open them in an editor:

| File | Shows |
| --- | --- |
| `examples/delivery-slot-demo/expected-output/gap-report.md` | the gap report (step 4 of the script) |
| `examples/delivery-slot-demo/expected-output/merge-request-summary.md` | the generated test merge request description (step 5) |
| `examples/delivery-slot-demo/expected-output/generated-tests.diff` | the generated tests |
| `examples/delivery-slot-demo/expected-output/verification.json`, `run-manifest.json` | what verification checked, cost and time of the run |
| `sandbox/shoplite/example-output/` | gap reports for the other ShopLite scenarios, a generated merge request, a showcase evidence page, a feature page across services |

Say: "These are from earlier runs. The wording changes from run to run, the findings are the same."

## Level 2: Run it locally (no GitLab, no Jira)

Needs: Node 20+, git, internet for `npm install` once. Steps 3 and later also need Claude (a login or `ANTHROPIC_API_KEY`) and cost money (about $0.10 to $0.40 for a gap report, $0.50 to $2 for a generation; docs).

1. **FREE:** `npm ci && npm run build` in the qa-sentinel folder.
2. **FREE:** `node sandbox/shoplite/local.mjs setup` makes `shoplite-local/` with the services and the test repo.
3. **FREE:** `node sandbox/shoplite/local.mjs run SHOP-101 --change-only` makes the developer's change without any AI. Show the diff.
4. **AI $:** `node sandbox/shoplite/local.mjs run SHOP-101` makes the change and writes the gap report. Add `--generate` to also write and verify tests.
5. **FREE:** `node sandbox/shoplite/local.mjs reset` puts every service back to `main` and stops the environment.
6. One-shot version of the same story: `./examples/delivery-slot-demo/run-demo.sh` (AI $, well under $1 according to its README).

Stories there come from local files, not Jira. Everything about Jira and GitLab merge requests is skipped, so say that.

## Level 3: Run the checks that need no AI and no network (FREE)

| Command | What it shows |
| --- | --- |
| `npx vitest run test/demoKit.test.ts` | The whole demo kit against a **fake Jira and a fake GitLab** (plain Node servers in `test/helpers/fakeDemo.ts`): seed, open a merge request, merge, fix a bug, hotfix, reset, reset again. About 10 seconds. Say clearly that it is fake. |
| `npm run bench -- --features` | A story across three services: which acceptance criteria are planned at each step, and which wait. No AI. |
| `npm run bench:mutate -- --scenario SHOP-101` | Plants known defects in the ShopLite orders service and shows which tests notice ("7 planted defects, 6 caught"; docs/TRY-PR8.md). Needs `node sandbox/shoplite/local.mjs setup` first. No AI. |
| `npx vitest run test/jiraIdentity.test.ts test/jira-report.test.ts` | Jira comment handling against the repository's mock Jira (`test/helpers/mockJira.ts`): only its own comments are edited. |

## Level 4: Only GitLab is down, Jira works (or the other way round)

- Jira only: show the cards (`seed-jira` output, the board) and the recorded reports from Level 1.
- GitLab only: skip the Jira clicks; the merge request comment is the same report. Set `reporting.targets` to `["gitlab-mr"]` in the test repo config if Jira errors fill the logs.

## Cleaning up after a partial live run

If some live steps ran and then something broke, run `node demo/scripts/reset.mjs --tests-dir demo/.work/shoplite-tests` (dry run) when the systems are back. It lists exactly what is left. Nothing is lost by waiting.
