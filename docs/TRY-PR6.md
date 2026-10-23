# Try it: small items and docs fixes (PR 6)

Everything here is free. No AI, no Jira, no GitLab.

## 0. Get the branch

1. `export QAS=~/Documents/qa-sentinel`
2. `cd $QAS && git fetch origin && git checkout pr6-small-items && npm ci && npm run build`
3. `npx vitest run test/smallItems.test.ts` and expect 14 tests passing.

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
8. Make the map empty: delete the lines under `endpoints:` so it reads `endpoints: {}`. Run `doctor` again. Expect one line: "test-map.yaml is empty but 1 test(s) are tagged: run `qa-sentinel learn`".

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

You need the ShopLite sandbox (see docs/TRY-PR2.md, step 1) and its environment running.

1. `cd ~/qa-try2 && node $QAS/sandbox/shoplite/local.mjs env start`
2. `cd shoplite-local/qa-tests`
3. `node $QAS/dist/cli.js suite --env local`
4. Look at the sandbox log of the services (`~/qa-try2` has the log folder named in the `env start` output). Each service's `/version` line shows once for the whole run, not once per story.
5. `cd ~/qa-try2 && node $QAS/sandbox/shoplite/local.mjs env stop`

## 4. `suite --run` leaves held-back tests out by title

The automatic test (`npx vitest run test/smallItems.test.ts -t "real vitest"`) runs a real Vitest file with a held-back test that throws if it runs. Expect it to pass. To see the command text:
`npx vitest run test/smallItems.test.ts -t "Mocha"`.
Cucumber scenarios: `qa-suite.md` has a section "Cucumber scenarios (N; qa-sentinel does not run them, your BDD job does)" and `qa-suite.txt` has no `.feature` lines.
