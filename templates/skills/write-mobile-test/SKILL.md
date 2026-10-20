---
name: write-mobile-test
description: How mobile app tests are written in {{projectName}} – WebdriverIO + Appium, screen objects first, the ui helper, data through the API, tags, evidence. Read before creating or editing any mobile test or screen object.
---

# Writing mobile tests in {{projectName}}

Tests: `{{mobileDir}}` · Screen objects: `{{screensDir}}` · Run: `{{mobileRunCommand}} --spec <file>` (WebdriverIO + Appium, Mocha)
The device and app come from the environment (`QA_APPIUM_URL`, `QA_MOBILE_PLATFORM`, `QA_APP` …, see `wdio.conf.ts`); API calls for test data use `process.env.{{baseUrlEnv}}`. Never hard-code devices, app paths or environments.

## Order of work for a changed screen
1. **Find the screen's elements in the app code first.** Look for the accessibility ids the app sets (React Native `testID` / `accessibilityLabel`, Android `contentDescription` / resource ids, iOS `accessibilityIdentifier`, Flutter `Semantics`/`Key`). If the element has none, say so in the summary (ask the developers to add one) and use the most stable alternative.
2. **Screen objects before specs.** Every selector lives in a screen object in `{{screensDir}}` (one class per screen, `extends BaseScreen`, `screen = "orders/new"`, a `root` element only that screen shows). Update the screen object first, then the specs. Specs never call `$()` or `driver.*` directly for app actions.
3. **Specs** use the screen objects and assert with `expect` from `@wdio/globals`.

## Screen objects
- Selectors as getters, in this order of preference: accessibility id `$("~place-order")`, then platform ids (`$("id=com.shop:id/total")` on Android, `-ios predicate string:name == "total"` on iOS), then text for static copy. Never XPath by position or index.
- Actions go through the ui helper with the name a person would use: `await this.ui.tap(this.placeOrder, "Place order button")`, `this.ui.type(this.quantity, "2", "Quantity")`, `this.ui.scrollTo(…, "Delivery options")`, `this.ui.back()`.
- Methods name user actions (`placeOrder(item, qty)`), not taps. No assertions in screen objects; return elements or values.
- Prefer `openDeepLink("myapp://orders/123")` to tapping through several screens to reach the one under test, when the app has deep links.

## Specs
- One `describe` per screen or flow; call `const t = useMobile()` inside it (from `src/fixtures/mobile`: `t.ui`, and `t.api` / `t.data` for setup).
- **Test data through the API, never through app steps.** Follow the scenario's `setup` steps from the validated plan in their `dependsOn` order, using `t.api` and `t.data` (the same helpers as the API tests). Only a step with `"via": "ui"` (and a `why`) may use the app for setup.
- One behaviour per test: open the screen, do the user action, assert what the user sees (text, state, the next screen) and, when the story says so, the resulting data through `t.api`.
- **Logging in:** reuse the project's login helpers (`tests.auth.helpers` in `qa-sentinel.config.yaml`; scaffolded projects: `tokenFor(request, "<role>")` in `src/api/auth`). Never write a new login flow, never put a username, password, OTP seed or token in a test: ask for a role from `tests.auth.roles` and let the helper read its credentials from the environment. One-time codes come from the helper (`totp(seed)`) or a test hook; DPoP-bound APIs get a proof per request from the helper (`dpopProof`). Singpass/Corppass logins run against MockPass in test environments, with its test identities. If a role the scenario needs doesn't exist, say so in your notes instead of inventing one. `tests.auth.notes` describes how login works in this project.
- **Async behaviour** (jobs, queues, emails, anything that happens "later"): never wait a fixed time. Poll for the expected state with a bound: `pollUntil(read, done, { what })` from `src/api/async` (scaffolded projects) or the project's own helper, or Playwright's `expect.poll(...)`. Start what would happen later through a test hook from `tests.hooks` in `qa-sentinel.config.yaml` (run the job now, move the clock) instead of waiting for it. Check the side effect, not only the response: the record's new status, the message in the test inbox, the event. If there is no hook for it, don't fake it: mark the requirement `hook` in the plan (or note it in the MR) so the team can add one.
- **Feature toggles:** a test that needs a toggle in a given state says so in its title: `@toggle:new-checkout=on` (several: `@toggle:a=on,b=off`). Don't switch toggles inside the test: qa-sentinel sets them before the run and puts them back after. Keep tests that need a toggle on and off in separate files. The story's feature-toggle section says which toggles a feature sits behind.
  While you write tests, your own runs happen with toggles as they are in the environment: a `@toggle` test may fail there only because the feature is off. Don't change the test for that; say so in your notes (qa-sentinel's verification sets the toggles).
- **Tags in the title (required):** `@service:<app> @screen:orders/new @story:SHOP-123 @ac:AC-2`. Use the same value as the screen object's `screen`. `@ac:none` for tests beyond the ACs.
- Waits: `await el.waitForDisplayed()` and `expect(el).toHaveText(…)` (they retry). No `driver.pause()` for waiting.
- Known product bug / AC mismatch: `it.skip(...)` with `// QA-AGENT: <mismatch>` above it, written to the requirement.
- Evidence is automatic (screen recording, final screenshot and the API setup calls, by `src/mobile/evidence.ts`); don't add your own.
- **Example:** `{{mobileDir}}/example/home.spec.ts` and `{{screensDir}}/home-screen.ts`.

## Running
- qa-sentinel runs your specs against the configured device. If no device or Appium server is reachable, the run is reported as blocked (not failed): still make sure the files type-check (`npx tsc --noEmit`), and say in the summary that the tests were not run on a device.

## Never
- Selectors in specs, index-based XPath, `driver.pause` as a wait, device names or app paths in code, credentials in code.
- Weakening or deleting an assertion to make a test pass; say so in the summary instead.
- Asserting what the product shows instead of the expected behaviour's value (`expected/<STORY>.md`). A mismatch
  is a defect to report, not a test to adjust.
- Changing `wdio.conf.ts` or `src/mobile/evidence.ts`; ask in the summary instead.
