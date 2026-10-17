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
- **Async behaviour** (jobs, queues, emails, anything that happens "later"): never wait a fixed time. Poll for the expected state with a bound: `pollUntil(read, done, { what })` from `src/api/async` (scaffolded projects) or the project's own helper, or Playwright's `expect.poll(...)`. Start what would happen later through a test hook from `tests.hooks` in `qa-sentinel.config.yaml` (run the job now, move the clock) instead of waiting for it. Check the side effect, not only the response: the record's new status, the message in the test inbox, the event. If there is no hook for it, don't fake it: mark the requirement `hook` in the plan (or note it in the MR) so the team can add one.
- **Feature toggles:** a test that needs a toggle in a given state says so in its title: `@toggle:new-checkout=on` (several: `@toggle:a=on,b=off`). Don't switch toggles inside the test: qa-sentinel sets them before the run and puts them back after. Keep tests that need a toggle on and off in separate files. The story's feature-toggle section says which toggles a feature sits behind.
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
- Changing `wdio.conf.ts` or `src/mobile/evidence.ts`; ask in the summary instead.
