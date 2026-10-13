---
name: tag-tests
description: Add qa-sentinel traceability tags (@service, @endpoint, @page) to the titles of existing tests, changing nothing else. Use when asked to tag or backfill tags on tests.
---

# Tag existing tests

qa-sentinel maps code changes to tests through tags in test titles. Older tests have none, so impact analysis
can't find them. You add the tags. **You change only test title strings**: qa-sentinel compares every changed
line with and without tags, and any other change (code, assertions, formatting, imports) rejects the whole run.

## Input
`tests-to-tag.json` in the run directory (path in the prompt): file, line and title of every test without tags,
plus each service's name, kind (api or web) and OpenAPI spec path.

## Rules
- API tests: `@service:<service name> @endpoint:<METHOD>_<path>` with the path exactly as in the OpenAPI spec or `test-map.yaml` (`{param}` style), e.g. `@endpoint:POST_/orders/{id}/refund`. Find the endpoint from the calls the test makes.
- Web tests: `@service:<front end> @page:<route>` with the route in `:param` style, e.g. `@page:/orders/:id`, from the page object's `path` or the URL the test opens.
- Several endpoints or pages: comma-separated (`@endpoint:GET_/orders,POST_/orders`).
- Append the tags at the end of the title string, separated by a space. Keep the title text and quotes exactly as they are.
- Do **not** add `@story` or `@ac` tags (that needs the story; QA does it when a story touches the test).
- When a title is built from a constant or template literal, add the tags to the literal part in the same line only; if that is impossible without changing code, skip the test and list it in your answer.
- If you can't tell the endpoint or page with confidence, skip the test and list it.

Answer with a short list: tests tagged, tests skipped and why.
