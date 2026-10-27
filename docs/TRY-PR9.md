# Try it: app screen snapshots, iOS and farm code side, a command engine (PR 9)

Steps marked **FREE** cost nothing. Steps marked **DEVICE** need a real emulator, a Mac or a device farm. Steps marked **AI** cost money (the cost is written next to the step). Do the FREE steps first.

## Part 1. Run the new tests (FREE)

1. `export QAS=~/Documents/qa-sentinel`
2. `cd $QAS && git fetch origin && git checkout pr9-device-engines && npm ci && npm run build`
3. `npx vitest run test/mobileExplore.test.ts test/mobileRun.test.ts test/commandEngine.test.ts test/engineConformance.test.ts`
4. Expect 4 files, all passing. They use temporary folders, a fake Appium server and a scripted engine. They need no internet, no device, no AI, no git name or e-mail.

## Part 2. The command engine with the scripted fixture (FREE)

1. Make a test project: `mkdir /tmp/pr9try && cd /tmp/pr9try && git init && node $QAS/dist/cli.js init --mode scratch --yes`
2. Open `qa-sentinel.config.yaml`. In the `agent:` block set:
   `engine: command` and `command: "node $QAS/test/fixtures/engine-fixture.mjs {taskFile}"` (write the real path of your qa-sentinel folder instead of `$QAS`).
3. `node $QAS/dist/cli.js doctor`. Expect a line `agent.engine: command (node found)` and a warning that `qa-sentinel learn` still calls Claude Code. No "Claude Code CLI" line.
4. Add `sandbox: { enabled: true }` under `agent:` and run doctor again. Expect a **fail**: `agent.sandbox covers only Claude Code`. Take the line out again.
5. `node $QAS/dist/cli.js gap-report --dry-run --service <name>` (it needs a service from `workspace.services`). The reviewer ran this and saw the engine command line printed.

## Part 3. The command engine with a real AI program (AI)

1. **AI, cost depends on your program** (not measured; the budget in the task, `maxBudgetUsd`, is only checked after the run). Write or take a program that follows [docs/ENGINE-COMMAND.md](ENGINE-COMMAND.md).
2. Put it in `agent.command`, make sure its key is in `guardrails.passEnv`, and run one cheap `gap-report` on a small change.
3. Look for: a result line, the cost in the usage line (if your program prints `costUsd`), and a guardrail finding if it writes outside the test folders. Report anything surprising.

## Part 4. Run the mobile suite with a target (FREE for the dry run)

1. In a project with the mobile layer (`add-mobile`), the config already has `targets: {}` under `tests.mobile`. **Replace** that line with:
   `targets: { ios: { platform: ios, env: { QA_BUNDLE_ID: com.example.shop } } }`
2. `node $QAS/dist/cli.js mobile-run --target ios --dry-run`. Expect the warning "iOS runs are not proven yet", the line `env: QA_BUNDLE_ID=com.example.shop QA_MOBILE_PLATFORM=ios` and the command `npx wdio run wdio.conf.ts`. Nothing runs.
3. `node $QAS/dist/cli.js mobile-run --target nope` says there is no such target and lists the ones you have; exit code 1.
4. `QA_APPIUM_CAPS='{bad' node $QAS/dist/cli.js doctor` fails with "not valid JSON" and does not print what you typed.

## Part 5. Screen snapshots on an Android emulator (DEVICE)

1. Follow [docs/SANDBOX.md](SANDBOX.md) to get the Android emulator, Appium and the ShopLite app running.
2. In the config set `tests.mobile.explore: snapshot`. For deep links also `tests.mobile.deepLinkBase: "shoplite://"` (use the scheme the sample app really has; check its manifest).
3. Set `QA_APPIUM_URL`, `QA_APP` (or `QA_APP_PACKAGE`) in your shell.
4. **AI, about the price of one `generate` run (the 12-scenario benchmark cost $1.64 in total, one `generate` was not measured):** `generate` on the mobile story SHOP-109.
5. Look in the newest folder under `.qa-sentinel/runs/` for `screen-snapshots/`. Expect `launch.xml` or one `.xml` per screen, `.summary.txt`, `.png` and `README.md`. Open a `.summary.txt`: it should list ids like `place-order`. If a screen says an error, send me the line.
6. Unverified: this was only tested against a mock Appium server. The Android `mobile: deepLink` call with `url` and `package` is the part most likely to need a fix.

## Part 6. iOS (DEVICE: needs a Mac with Xcode, or an iOS farm)

1. On the Mac: Appium 2 with the XCUITest driver, a simulator. Set `QA_MOBILE_PLATFORM=ios`, `QA_BUNDLE_ID=<your app>` (or `QA_APP` to an .app).
2. `node $QAS/dist/cli.js doctor`. Expect "iOS runs are not proven yet" and the app check ok.
3. `npx wdio run wdio.conf.ts --spec tests/mobile/example/home.spec.ts`. Report what fails (this has never been run).
4. A test that calls `openDeepLink` must fail with "openDeepLink is not supported on iOS yet". That is on purpose.

## Part 7. A device farm (DEVICE)

1. Get a trial account at a farm that gives an Appium (WebDriver) URL. Copy from the farm's documentation the capabilities block they ask for.
2. `export QA_APPIUM_URL='https://USER:KEY@hub.example/wd/hub'` and `export QA_APPIUM_CAPS='{ ...the farm block... }'` and the app variable.
3. Add a target (replace `targets: {}`) with `passEnv: [QA_APPIUM_URL, QA_APPIUM_CAPS, QA_APP]` and run `mobile-run --target <name> --dry-run`, then without `--dry-run` on one spec.
4. Report what the farm needs that this does not do (an app upload step, for example). Those are not built.
