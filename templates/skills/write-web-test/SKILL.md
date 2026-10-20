---
name: write-web-test
description: How web (Playwright UI) tests are written in {{projectName}} – page objects first, the ui helper, data through the API, tags, evidence. Read before creating or editing any web test or page object.
---

# Writing web tests in {{projectName}}

Tests: `{{webDir}}` · Page objects: `{{pagesDir}}` · Run: `{{webRunCommand}}`
The site's base URL comes from `process.env.{{webBaseUrlEnv}}`; API calls for test data use `process.env.{{baseUrlEnv}}`. Never hard-code environments.

## Order of work for a changed page
1. **Look at the page first.** qa-sentinel saved what each affected page shows in `page-snapshots/` in the run directory (path in the prompt): an accessibility tree (`<page>.aria.yaml`, the roles and names you can use in locators) and a screenshot. Read them before writing a locator. If a page you need is missing, run the spec and read Playwright's `error-context.md` for it.
2. **Page objects before specs.** Every locator lives in a page object in `{{pagesDir}}` (one class per page, `extends BasePage`, `path = "/orders/:id"`). Update the page object for the change first, then the specs. Specs never call `page.locator()`, `getByRole()` or `page.click()` directly.
3. **Specs** use the page objects and assert with `expect`.

## Page objects
- Locators as getters, in this order of preference: `getByRole(role, { name })`, `getByLabel`, `getByTestId`, `getByText` for static copy. Never CSS chains or `nth()`.
- Actions go through the ui helper with the name a person would use; it is what optional healing uses to find the element again:
  `await this.ui.click(this.checkoutButton, "Checkout button")`, `await this.ui.fill(this.quantity, "2", "Quantity")`, `this.ui.select(…, "SGD", "Currency")`, `this.ui.check(…, "Express delivery")`.
- Methods name user actions (`placeOrder(item, qty)`), not clicks. No assertions in page objects; return locators or values.

## Specs
- Import `test` and `expect` from `src/fixtures/web` (fixtures: `page`, `ui`, `api`, `data`).
- **Test data through the API, never through UI steps.** Follow the scenario's `setup` steps from the validated plan in their `dependsOn` order, using `api` and `data` (the same helpers as the API tests). Only a step with `"via": "ui"` (and a `why`) may use the browser for setup.
- One behaviour per test, through the browser: open the page, do the user action, assert what the user sees (text, state, navigation) and, when the story says so, the resulting data through `api`.
- **Logging in:** reuse the project's login helpers (`tests.auth.helpers` in `qa-sentinel.config.yaml`; scaffolded projects: `tokenFor(request, "<role>")` in `src/api/auth`). Never write a new login flow, never put a username, password, OTP seed or token in a test: ask for a role from `tests.auth.roles` and let the helper read its credentials from the environment. One-time codes come from the helper (`totp(seed)`) or a test hook; DPoP-bound APIs get a proof per request from the helper (`dpopProof`). Singpass/Corppass logins run against MockPass in test environments, with its test identities. If a role the scenario needs doesn't exist, say so in your notes instead of inventing one. `tests.auth.notes` describes how login works in this project.
- **Async behaviour** (jobs, queues, emails, anything that happens "later"): never wait a fixed time. Poll for the expected state with a bound: `pollUntil(read, done, { what })` from `src/api/async` (scaffolded projects) or the project's own helper, or Playwright's `expect.poll(...)`. Start what would happen later through a test hook from `tests.hooks` in `qa-sentinel.config.yaml` (run the job now, move the clock) instead of waiting for it. Check the side effect, not only the response: the record's new status, the message in the test inbox, the event. If there is no hook for it, don't fake it: mark the requirement `hook` in the plan (or note it in the MR) so the team can add one.
- **Feature toggles:** a test that needs a toggle in a given state says so in its title: `@toggle:new-checkout=on` (several: `@toggle:a=on,b=off`). Don't switch toggles inside the test: qa-sentinel sets them before the run and puts them back after. Keep tests that need a toggle on and off in separate files. The story's feature-toggle section says which toggles a feature sits behind.
  While you write tests, your own runs happen with toggles as they are in the environment: a `@toggle` test may fail there only because the feature is off. Don't change the test for that; say so in your notes (qa-sentinel's verification sets the toggles).
- **Tags in the title (required):** `@service:<front end> @page:/orders/:id @story:SHOP-123 @ac:AC-2`. Use the route as in the page object (`:param` style). `@ac:none` for tests beyond the ACs.
- Waits: rely on Playwright's auto-waiting and web-first assertions (`await expect(locator).toHaveText(…)`). No `waitForTimeout`, no sleeps.
- Product disagrees with the requirement (discrepancy): `test.fixme(...)` with `// QA-AGENT: <mismatch>` above it (with the behaviour id, e.g.
  `SHOP-101/B2`), written to the requirement. Never `test.fail`: only QA marks a confirmed defect, with the bug link.
{{#if a11y}}
- **Accessibility:** for a new page, or a page whose form or controls changed, add one test that opens it in the state the user sees and asserts `expect(await checkAccessibility(page, testInfo)).toEqual([])` (import from `src/web/a11y`; WCAG 2 AA, critical and serious issues). Title it `has no serious accessibility issues @service:… @page:… @a11y` (plus `@story`, and `@ac:none` unless an AC asks for accessibility).
{{/if}}
- Evidence is automatic (video, screenshots and the API setup calls are recorded by the web project); don't add your own.
- **Example:** `{{webDir}}/example/home.spec.ts` and `{{pagesDir}}/home-page.ts`.

## Never
- Locators in specs, positional selectors, sleeps, production URLs, credentials in code.
- Weakening or deleting an assertion to make a test pass; say so in the summary instead.
- Asserting what the product shows instead of the expected behaviour's value (`expected/<STORY>.md`). A mismatch
  is a defect to report, not a test to adjust.
- Setting `QA_HEALING`: qa-sentinel verifies your tests with healing off, so a locator must work on its own.
