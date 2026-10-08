# QA agents (qa-sentinel)

This test repo is set up for qa-sentinel. Configuration lives in `qa-sentinel.config.yaml`; agents and skills are in `.claude/`.

## Project
- Name: {{projectName}} (mode: {{mode}})
- API tests: {{apiFramework}} in `{{apiDir}}`, helpers in `{{helpersDir}}`
- Run API tests: `{{runCommand}} <spec paths>`
- Base URL env var: `{{baseUrlEnv}}`
- CI: {{ciPlatform}}

## Services under test
{{serviceList}}

## How agents work here
- Pipeline: change-analyzer → test-mapper → test-data → api-test-author → test-executor.
- Gap reports are read-only. Generation commits to a `qa-sentinel/*` branch and opens a merge request; humans merge.
- Acceptance criteria outrank current code behaviour. Mismatches are reported, never silently encoded into tests.
- `test-map.yaml` is the source of truth for which tests cover which endpoints. Keep it updated.

## Readiness gaps
_Filled in by `qa-sentinel learn`._
