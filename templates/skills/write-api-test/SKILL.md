---
name: write-api-test
description: How API tests are written in {{projectName}} – folder layout, naming, helpers, assertions, tags and data rules. Read before creating or editing any API test.
---

# Writing API tests in {{projectName}}

Framework: **{{apiFramework}}** · Tests: `{{apiDir}}` · Helpers: `{{helpersDir}}` · Run: `{{runCommand}}`
Base URL comes from `process.env.{{baseUrlEnv}}`; never hard-code environments.

## Project conventions
{{#if isScratch}}
These conventions ship with the qa-sentinel Playwright scaffold. Change them here when the team agrees on something different.

- **Layout:** one folder per service, one spec file per resource: `{{apiDir}}/<service>/<resource>.spec.ts`.
- **Client:** call the API through the typed client in `{{helpersDir}}/client.ts` (`api.get/post/put/patch/delete`), never raw `fetch`.
- **Fixtures:** import `test` and `expect` from `src/fixtures` (not from `@playwright/test`), which provides `api` and `data` fixtures.
- **Setup data:** use builders in `src/data/` and setup helpers in `{{helpersDir}}`; every test creates the data it needs.
- **Structure:** `test.describe('<METHOD> <path>')` per endpoint; test titles state the behaviour: `returns 400 when deliverySlot is missing`.
- **Assertions:** status first, then schema (`expectSchema(body, schema)` from `src/schemas`), then the specific values the test is about.
- **Logging in:** reuse the project's login helpers (`tests.auth.helpers` in `qa-sentinel.config.yaml`; scaffolded projects: `tokenFor(request, "<role>")` in `src/api/auth`). Never write a new login flow, never put a username, password, OTP seed or token in a test: ask for a role from `tests.auth.roles` and let the helper read its credentials from the environment. One-time codes come from the helper (`totp(seed)`) or a test hook; DPoP-bound APIs get a proof per request from the helper (`dpopProof`). Singpass/Corppass logins run against MockPass in test environments, with its test identities. If a role the scenario needs doesn't exist, say so in your notes instead of inventing one. `tests.auth.notes` describes how login works in this project.
- **Async behaviour** (jobs, queues, emails, anything that happens "later"): never wait a fixed time. Poll for the expected state with a bound: `pollUntil(read, done, { what })` from `src/api/async` (scaffolded projects) or the project's own helper, or Playwright's `expect.poll(...)`. Start what would happen later through a test hook from `tests.hooks` in `qa-sentinel.config.yaml` (run the job now, move the clock) instead of waiting for it. Check the side effect, not only the response: the record's new status, the message in the test inbox, the event. If there is no hook for it, don't fake it: mark the requirement `hook` in the plan (or note it in the MR) so the team can add one.
- **Feature toggles:** a test that needs a toggle in a given state says so in its title: `@toggle:new-checkout=on` (several: `@toggle:a=on,b=off`). Don't switch toggles inside the test: qa-sentinel sets them before the run and puts them back after. Keep tests that need a toggle on and off in separate files. The story's feature-toggle section says which toggles a feature sits behind.
  While you write tests, your own runs happen with toggles as they are in the environment: a `@toggle` test may fail there only because the feature is off. Don't change the test for that; say so in your notes (qa-sentinel's verification sets the toggles).
- **Tags (required on every new or changed test, fixme tests included):** in the title, e.g.
  `test('rejects the 4th order in a slot @service:orders-service @endpoint:POST_/orders @story:SHOP-123 @ac:AC-3', …)`.
  `@ac:` lists the acceptance criteria the test proves (comma-separated, `@ac:AC-1,AC-2`), using the ids from the story.
  Use `@ac:none` for a test that deliberately goes beyond the ACs (e.g. contract-only behaviour). Only tag ACs the
  test really proves: an unrelated setup call doesn't count (an independent reviewer checks this).
  qa-sentinel builds the requirement → test matrix in the MR from these tags, so a test without them is invisible
  to traceability. qa-sentinel reads tags statically: write them as literal text, a string constant (`const tags = "…"`),
  or a one-line helper (`const tags = (ac: string) => \`… @ac:${ac}\``) in the same file, nothing more dynamic. Use the endpoint exactly as in test-map.yaml
  (`METHOD_/path/{param}`).
- **Product disagrees with the requirement (discrepancy):** `test.fixme(...)` with a comment `// QA-AGENT: <mismatch>` (name the behaviour id
  when there is one: `// QA-AGENT: SHOP-101/B2: expected 409, got 201`). Never `test.fail`: only QA marks a confirmed
  defect, with the bug link.
- **Example:** `{{apiDir}}/example/health.spec.ts`.
{{/if}}
{{#unless isScratch}}
<!-- conventions:pending -->
_Not learned yet. Run `qa-sentinel learn`; the agent fills this section from your existing tests, then a human reviews it._

Until then, mirror the closest existing spec in `{{apiDir}}` exactly: imports, client/helper usage, describe/test naming, assertion style, tags.
{{/unless}}

## Always
- Positive case plus each boundary of every new/changed validation, plus error responses.
- Independent tests: no ordering, no shared mutable records.
- Clear failure messages; no `console.log` left behind.

## Never
- Sleeps or fixed waits, secrets in code, production URLs, disabling TLS checks.
- Removing or loosening assertions without saying so in the summary.
- Asserting the value the code returns instead of the expected behaviour's value (`expected/<STORY>.md`). A mismatch
  is a defect to report, not a test to adjust.
