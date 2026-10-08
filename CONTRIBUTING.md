# Contributing to qa-sentinel

Thanks for helping. qa-sentinel is two things:

1. **A small TypeScript CLI** (`src/`): detection, config, git/diff handling, the Claude Code runner, GitLab API calls.
2. **Agent content** (`templates/`): sub-agents, skills, CI pipelines and scaffolds. This is where most of the quality comes from.

## Setup

```bash
npm install
npm run build
npm test
node dist/cli.js --help
```

To try changes end to end, run `examples/delivery-slot-demo/run-demo.sh`. It needs Claude Code and costs well under $1.

## Layout

```
src/
  cli.ts              commands and flags
  config.ts           zod schema for qa-sentinel.config.yaml
  detect.ts           framework, test and service discovery
  claude.ts           headless Claude Code runner
  commands/           init, learn, doctor, gap-report, generate
  scm/gitlab.ts       MR notes and MR creation
templates/
  agents/             change-analyzer, test-mapper, test-data, api-test-author, test-executor
  skills/             qa-gap-report, generate-api-tests, write-api-test, learn-conventions
  claude/             CLAUDE.md fragment
  ci/gitlab|jenkins/  pipelines
  scaffold/           from-scratch frameworks (*.tmpl files are rendered)
```

Templates use `{{var}}`, `{{#if var}}…{{/if}}` and `{{#unless var}}…{{/unless}}`. The test suite fails if a template is left with an unknown placeholder.

## Changing agent behaviour

- Keep agents single-purpose with structured (JSON) handoffs.
- Every rule you add should have a reason a reviewer would agree with. Prefer "never X" lines for safety rules.
- When you change a prompt, rerun the demo and include the before and after outputs in the PR.

## Adding a framework adapter

1. Add the framework to `API_FRAMEWORKS` and `defaultRunCommand` (or the Web/Mobile equivalents).
2. Add detection in `detect.ts`.
3. Add a scaffold under `templates/scaffold/<name>/` if it supports `--mode scratch`.
4. Extend the `write-api-test` skill (or add `write-<layer>-test`) with that framework's conventions.

## Commit and release

Conventional commits (`feat:`, `fix:`, `docs:`). Releases are tagged `vX.Y.Z` and published to npm.
