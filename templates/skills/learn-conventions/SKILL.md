---
name: learn-conventions
description: Learn the project's API (and web) test conventions and draft the service→endpoint→test traceability map. Use when asked to learn conventions, onboard the project, or (re)build test-map.yaml.
---

# Learn conventions and build the test map

You are making this repo "agent-ready". A human will review your diff, so be accurate and cite examples.

## 1. Conventions → `.claude/skills/write-api-test/SKILL.md`
Read `qa-sentinel.config.yaml`, then sample at least 8 API specs across different services in the configured test dir, plus the helper folder.
Replace the content of the **Project conventions** section (including the `<!-- conventions:pending -->` marker) with concise bullets covering:

- folder layout and file naming
- imports and the client/request helper used (name the file)
- fixtures, setup and teardown patterns; how test data is created
- describe/test naming style
- assertion style and schema validation (name the helper)
- tags or annotations used (service, endpoint, story)
- how known bugs are marked (skip/fixme/todo)
- 2 example specs worth copying (paths)

Describe what the project **does**, not best practice. Where specs disagree, describe the majority and note the variation.

## 1b. Web conventions → `.claude/skills/write-web-test/SKILL.md` (only when the web layer is on)
Sample at least 5 web specs and their page objects. Add a **Project conventions** section right after the title with concise bullets: page-object layout and naming, how locators are written (roles, labels, test ids), how actions and waits are done, how test data is set up (API helpers? fixtures?), naming and tags, and 2 example specs with their page objects worth copying. Keep the rest of that skill as it is; where the project differs from it, say so in your summary for a human to decide.

## 1c. Mobile conventions → `.claude/skills/write-mobile-test/SKILL.md` (only when the mobile layer is on)
The same for mobile: sample at least 5 mobile specs and their screen objects and add a **Project conventions** section: screen-object layout and naming, how selectors are written (accessibility ids, platform ids), how navigation is done (deep links?), how test data is set up, Android/iOS differences handled in code, naming and tags, and 2 examples worth copying.

## 2. Traceability → `test-map.yaml`
For each service in the config: list its endpoints (from the OpenAPI spec if present, else from route definitions in its repo) and map each to the spec files that exercise it (match on paths, client methods, tags).
Keep `unmapped` for specs you could not tie to a service. Use endpoint keys like `"POST /orders"`. For web front ends (`kind: web`), fill `screens` instead: route (`/orders/:id`) → web spec files; for apps (`kind: mobile`), screen name or deep-link route (`orders/new`) → mobile spec files.

## 3. Readiness gaps → `.claude/qa-sentinel.md`
Replace the **Readiness gaps** section with a short list of what would most improve agent output, e.g. services without OpenAPI specs, endpoints with no tests, inconsistent tagging, missing data helpers.

## Rules
- Edit only those files (three, plus the web and mobile skills when those layers are on).
- Do not reformat other content in them.
