---
name: learn-conventions
description: Learn the project's API test conventions and draft the service→endpoint→test traceability map. Use when asked to learn conventions, onboard the project, or (re)build test-map.yaml.
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

## 2. Traceability → `test-map.yaml`
For each service in the config: list its endpoints (from the OpenAPI spec if present, else from route definitions in its repo) and map each to the spec files that exercise it (match on paths, client methods, tags).
Keep `unmapped` for specs you could not tie to a service. Use endpoint keys like `"POST /orders"`. Leave `screens: {}` alone.

## 3. Readiness gaps → `.claude/qa-sentinel.md`
Replace the **Readiness gaps** section with a short list of what would most improve agent output, e.g. services without OpenAPI specs, endpoints with no tests, inconsistent tagging, missing data helpers.

## Rules
- Edit only those three files.
- Do not reformat other content in them.
