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
- **Tags (required on every new or changed test, fixme tests included):** in the title, e.g.
  `test('rejects the 4th order in a slot @service:orders-service @endpoint:POST_/orders @story:SHOP-123 @ac:AC-3', …)`.
  `@ac:` lists the acceptance criteria the test proves (comma-separated, `@ac:AC-1,AC-2`), using the ids from the story.
  qa-sentinel builds the requirement → test matrix in the MR from these tags, so a test without them is invisible
  to traceability. Tags may come from a `const tags = "…"` in the same file. Use the endpoint exactly as in test-map.yaml
  (`METHOD_/path/{param}`).
- **Known product bug / AC mismatch:** `test.fixme(...)` with a comment `// QA-AGENT: <mismatch>`.
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
