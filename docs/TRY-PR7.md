# Try it: change types, access control, history and spec drift (PR 7)

Part 1 costs nothing (no AI, no Jira, no GitLab). Part 2 shows what the AI is given, also free (a dry run).
Part 3 costs a little AI money (about 10 to 30 US cents for each run) and needs Claude set up.

## Part 1. Run the tests (free)

1. `export QAS=~/Documents/qa-sentinel`
2. `cd $QAS && git fetch origin && git checkout pr7-risk-types && npm ci && npm run build`
3. `npx vitest run test/changeKinds.test.ts test/accessControl.test.ts test/historyRisk.test.ts test/specDrift.test.ts test/benchRisk.test.ts`

Expect 5 files, all passing. They use real temporary git folders and need no internet and no git name or e-mail.

## Part 2. See what the AI is given (free: `--dry-run` calls no AI)

1. `rm -rf ~/qa-try7 && mkdir -p ~/qa-try7/orders-service/src ~/qa-try7/qa-tests/tests/api && cd ~/qa-try7`
2. `cd orders-service && git init -q -b main && echo 'console.log(1)' > src/server.js && echo '{"name":"o","dependencies":{"express":"^4.21.2"}}' > package.json && git add -A && git commit -q -m base`
3. Add a database migration and commit it: `mkdir -p db/migrations && echo 'alter table orders add column notes text;' > db/migrations/002.sql && git add -A && git commit -q -m "SHOP-7: notes column"`
4. `cd ../qa-tests`. Paste this into `tests/api/orders.spec.ts`:
   ```
   import { test } from "@playwright/test";
   test("creates an order @service:orders-service @endpoint:POST_/orders @story:SHOP-1", async () => {});
   ```
5. `git init -q -b main && node $QAS/dist/cli.js init --yes --mode existing --workspace .. && git add -A && git commit -q -m tests`
6. Make the history file the team would write: `mkdir -p kb && printf 'endpoints:\n  "POST /orders":\n    incidents: 2\n    note: "double charge in March"\n' > kb/history.yaml`
7. `node $QAS/dist/cli.js gap-report --service orders-service --base HEAD~1 --head HEAD --dry-run`
   (run it from `qa-tests`; `HEAD~1` and `HEAD` are the commits of the service, given by `--base` and `--head`). Expect the line `dry run complete`.
8. `cat .qa-sentinel/runs/*/change-kinds.json`. Expect one entry: `"kind": "migration"` and `"file": "db/migrations/002.sql"`.
9. `grep -A12 '"changeKinds"' .qa-sentinel/runs/*/context.json`. Expect the same migration, then `endpointHistory` for `POST /orders` with `"signals": 2`, and `accessControl` with `"mode": "warn"`. This is what the AI will be given. It does not choose these; qa-sentinel found them.

## Part 3. See the risk in a real report (costs AI money, about 10 to 30 US cents)

Needs Claude set up (`node $QAS/dist/cli.js doctor`).

1. In `~/qa-try7/orders-service` add a small code change to the same commit range: `echo 'app.post("/orders", () => {});' >> src/server.js && git commit -qam "SHOP-7: orders"`.
2. In `~/qa-try7/qa-tests`: `node $QAS/dist/cli.js gap-report --service orders-service --base HEAD~2 --head HEAD --out report.md` (the `HEAD~2` and `HEAD` are the commits of the service; give the base and head that cover both commits).
3. `cat report.md`. Expect:
   - a section "Change types found in the code (no AI)" listing `db/migrations/002.sql`;
   - the report title says High risk (the migration makes it High even if the AI called the code change low);
   - if the AI found a change on `POST /orders`: a section "Risk raised by history (no AI)" saying why (2 incidents in `kb/history.yaml`), and that change one level higher than without the file. To compare, move `kb/history.yaml` away and run it again.
4. Access control: set a role in `qa-sentinel.config.yaml` (`tests.auth.roles: [{ name: admin }, { name: clerk }]`), then ask for a change that touches who may call an endpoint (for example, a check `if (!req.user.isAdmin) return 403`). The report asks for a `no-token` and a `forbidden` scenario, or lists a warning if the AI did not plan them. To make it an error, set `risk: { accessControl: require }` and run again.
5. Spec drift: in the service, make the code require a field that `openapi.yaml` does not list, commit, and run step 2 again. Expect the section "Spec drift: the spec and the code disagree. The developer fixes one of them." and a `review` decision. With `generate --push`, the MR gets the label `qa-sentinel::spec-drift`.

## What to remember

- Migration, config, toggle and dependency risk, and history risk, come from code. The same files give the same risk every time.
- History reads only `.qa-sentinel/runs/` (flaky), tests marked as known defects, and `kb/history.yaml`. Nothing from Jira or any incident tool.
- Not built on purpose: ranking risk across open merge requests.
- Not proven on a real large service.
