# Try it: small items and docs fixes (PR 6)

Everything here is free. No AI, no Jira, no GitLab.

## 0. Get the branch

1. `export QAS=~/Documents/qa-sentinel`
2. `cd $QAS && git fetch origin && git checkout pr6-small-items && npm ci && npm run build`
3. `npx vitest run test/smallItems` and expect all tests passing (two files).

## 1. A quiet doctor after init

1. `rm -rf ~/qa-try6 && mkdir -p ~/qa-try6/orders-service ~/qa-try6/qa-tests/tests/api && cd ~/qa-try6`
2. `git -C orders-service init -q`
3. Make a tagged test. Paste this into `qa-tests/tests/api/orders.spec.ts`:
   ```
   import { test } from "@playwright/test";
   test("creates an order @service:orders-service @endpoint:POST_/orders @story:SHOP-1", async () => {});
   ```
4. `cd qa-tests && git init -q`
5. `node $QAS/dist/cli.js init --yes --mode existing --workspace ..`
   Look for the line `created  test-map.yaml (1 tagged test file(s) listed)`.
6. `cat test-map.yaml`. Expect `POST /orders` under `orders-service`, with `tests/api/orders.spec.ts`.
7. `node $QAS/dist/cli.js doctor`. Expect no line saying "test-map.yaml agrees with test tags".
8. Make the map empty: edit `test-map.yaml` so it reads `endpoints: {}` under `orders-service`. Run `doctor` again. Expect exactly one warning about the map: "test-map.yaml agrees with test tags" with "test-map.yaml is empty but 1 test(s) are tagged: run `qa-sentinel learn` to fill it".

## 2. The hotfix exit code

1. `cd ~/qa-try6/orders-service && git commit -q --allow-empty -m start && git branch -M main`
2. `git checkout -q -b hotfix/orders-1 && echo fix > f.txt && git add f.txt && git commit -q -m "SHOP-5: urgent fix"`
3. `FIX=$(git rev-parse HEAD) && git checkout -q main && git commit -q --allow-empty -m "other work"`
4. `cd ../qa-tests`
5. `node $QAS/dist/cli.js hotfix --service orders-service --commit $FIX --fail-if-waiting; echo $?` expects `75`.
6. `node $QAS/dist/cli.js hotfix --service orders-service --commit $FIX; echo $?` expects `0` (no flag, as before).
7. `git -C ../orders-service cherry-pick -x $FIX`
8. Run step 5 again. Expect `0`.
9. `node $QAS/dist/cli.js hotfix --service orders-service --commit $FIX --strict; echo $?` expects `0`: the change landed today and the default allows 2 days for tests.
10. `node $QAS/dist/cli.js hotfix --service orders-service --commit $FIX --strict --grace-days 0; echo $?` expects `1`: no test was written from the hotfix and no days are allowed.

## 3. `suite` asks each service once

Needs the ShopLite sandbox from docs/TRY-PR2.md step 1.

1. `cd ~/qa-try2 && node $QAS/sandbox/shoplite/local.mjs env start` (it prints the base URL; set `QA_BASE_URL` to it if the command says so).
2. `cd shoplite-local/qa-tests`
3. `node $QAS/dist/cli.js suite --env local`
   Look for the dim line `lookups this run: N version endpoint call(s), M revert scan(s) for S stories`.
4. `node $QAS/dist/cli.js suite --env local --json | grep -A3 '"asked"'`
   Expect `versionCalls` equal to the number of services that have a version endpoint (one each), and `revertScans` equal to the number of service folders. It does not grow with the number of stories. (A failed answer from a version endpoint is kept for the run too, so a service that is down is asked once, not once per story.)
5. `cd ~/qa-try2 && node $QAS/sandbox/shoplite/local.mjs env stop`

## 4. `suite --run` leaves held-back tests out by title

1. `rm -rf ~/qa-try6b && mkdir -p ~/qa-try6b/orders ~/qa-try6b/qa/tests/api && cd ~/qa-try6b`
2. `cd orders && git init -q && git commit -q --allow-empty -m start && git tag v1 && git commit -q --allow-empty -m "SHOP-7: after the release" && cd ..`
3. Paste this into `qa/tests/api/a.test.js`:
   ```
   it("kept @story:SHOP-1", () => {});
   it("held @story:SHOP-7", () => { throw new Error("must not run"); });
   it("held in a list @story:SHOP-1,SHOP-7", () => { throw new Error("must not run"); });
   ```
4. `cd qa && git init -q` and paste this into `qa-sentinel.config.yaml`:
   ```
   version: 1
   mode: scratch
   project: { name: try }
   tests: { api: { framework: mocha, runCommand: "$QAS/node_modules/.bin/mocha", dir: tests/api } }
   ci: { platform: gitlab }
   workspace: { services: [{ name: orders, path: ../orders }] }
   ```
   (write the real path of `$QAS` instead of the text `$QAS`)
5. `node $QAS/dist/cli.js suite --tag v1 --run`
   Expect a line `running: … mocha --grep '@story:(?:[^\s,]+,)*(?:SHOP-7)(?![\w-])' --invert tests/api/a.test.js` and `1 passing`. Both SHOP-7 tests were left out, also the one with a comma list.
6. Cucumber scenarios: `qa-suite.md` has a section "Cucumber scenarios (N; qa-sentinel does not run them, your BDD job does)" when there are any, and `qa-suite.txt` has no `.feature` lines.
