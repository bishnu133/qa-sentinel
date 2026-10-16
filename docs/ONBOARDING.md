# Onboarding a project to qa-sentinel

This guide is for a team adding qa-sentinel to its own project. Nothing in qa-sentinel is specific to one project: everything a team differs on is in `qa-sentinel.config.yaml` in the team's **test repo**. Budget half a day for the first setup and two weeks of read-only use before turning on test generation.

## 0. Before you start

| You need | Notes |
| --- | --- |
| Approval to send code and stories to the model provider | qa-sentinel runs Claude Code: diffs, test code and story text are sent to Anthropic's API. Use your organisation's approved account and key, never a personal one, for client or company code. |
| A test repo | Where the tests live (or will live). qa-sentinel writes only there, through reviewed merge requests. |
| The service repos | Cloned next to the test repo (`../orders-service`, …), locally and in CI. They are read, never changed. |
| Node 20+, Claude Code CLI | `npm install -g @anthropic-ai/claude-code` |
| qa-sentinel | Not on npm yet: `npm install -D github:bishnu133/qa-sentinel#v0.6` in the test repo (CI installs it from `QA_SENTINEL_PACKAGE`). |
| Tokens (as masked CI variables, never in files) | `ANTHROPIC_API_KEY`; `QA_SENTINEL_GITLAB_TOKEN` (api + write_repository on the test repo, read on the services); for Jira: `JIRA_EMAIL` + `JIRA_API_TOKEN` (Cloud) or `JIRA_PAT` (Server/DC) |

Locally, keep tokens out of shell history: `read -s ANTHROPIC_API_KEY && export ANTHROPIC_API_KEY` (or your OS keychain).

## 1. Initialise the test repo

```bash
cd your-test-repo
npx qa-sentinel init          # asks: existing or scratch, framework, services found, level, CI, layers, Jira, GitLab
```

The same without questions (e.g. in a script):

```bash
npx qa-sentinel init -y --mode existing --level intelligence --ci gitlab \
  --jira-url https://yourco.atlassian.net --jira-projects PAY,CARD \
  --gitlab-url https://gitlab.yourco.com --test-repo-project qa/payments-tests \
  --web            # and/or --mobile
```

`init` writes `qa-sentinel.config.yaml` with **every** setting spelled out, the agents and skills under `.claude/`, CI templates in `ci/qa-sentinel/`, and `test-map.yaml`. It never overwrites your `CLAUDE.md` (it adds one import line).

## 2. Describe your services

In `workspace.services`, one entry per repo the tests cover:

```yaml
workspace:
  services:
    - name: payments-service          # the repo / CI project name
      path: ../payments-service
      openapi: api/openapi.yaml       # strongly recommended
      gitlabProject: pay/payments-service
      dependsOn: [ledger-service]
      version: { path: /actuator/info, field: git.commit.id }   # optional: deployed commit, for `feature`
    - name: ledger-service
      path: ../ledger-service
      openapi: build/swagger.yaml     # not committed: generated at build time…
      openapiCommand: npx tsoa spec   # …so qa-sentinel runs this at the MR's base and head commits
    - name: payments-portal
      path: ../payments-portal
      kind: web                       # tested through the UI (page objects); data set up via the API
      routes: [/payments, /payments/:id]
    - name: payments-app
      path: ../payments-app
      kind: mobile                    # tested through WebdriverIO + Appium (screen objects)
```

**Specs generated at build time** (tsoa, swagger-jsdoc, springdoc, NestJS…): set `openapiCommand` to the command that writes the spec to `openapi`. qa-sentinel checks each commit out in a throwaway worktree (sharing the service's `node_modules`, so install its dependencies first), runs the command with the test environment (no publishing credentials), and diffs the two results. The default time limit is 180 seconds (`openapiCommandTimeoutSeconds`). The command must work offline, without a database or secrets; if it fails, the report simply has no contract diff. Committing the spec is still the cheapest option.

Stories often name services in their tech notes; qa-sentinel recognises a service by its `name`, the last part of its `path` or of its `gitlabProject`.

## 3. Teach it how your stories are written

Every team writes stories differently: ACs as a numbered list, as Gherkin, or as a Given / When / Then table; scope under "In-scope" or "Tech scope"; an "Out of scope" list; implementation notes per service; a checklist. qa-sentinel reads them with a **story template** you control.

**3a. Look at a real story:**

```bash
npx qa-sentinel story-check --story PAY-123 --fields
```

`story-check` makes no AI call; it only reads the story from Jira and shows (in `qa-story-check.md`):

- every heading and what it was read as;
- the acceptance criteria it found (and from which format);
- scope items (`IS-1` in scope, `TS-1` tech notes, `ER-1` expected results), with the service a note belongs to;
- what is out of scope, the context sections, the showcase approach, the services named;
- **what to change** when something wasn't recognised;
- with `--fields`, every field of the issue with its id.

**3b. ACs in their own Jira field?** Take its id from the `--fields` list:

```yaml
requirements:
  jira:
    acceptanceCriteriaField: customfield_10045
    scopeFields: [{ field: customfield_10050, name: Tech scope, prefix: TS }]   # optional, same idea
```

**3c. Adjust the template** in `requirements.template` (written out in full by `init`; headings match ignoring case, punctuation and markup, so "In-scope:" = "in scope"):

| Role | What qa-sentinel does with it |
| --- | --- |
| `acceptance-criteria` | ACs: AC-1, AC-2 … (or the story's own numbers). Lists, Gherkin and Given/When/Then tables are understood. |
| `scope` (needs a `prefix`) | Items checked for "is it built?" and traced like ACs; listed for the PO when no AC covers them. |
| `out-of-scope` | Never planned as tests, never reported as missing or raised as bugs. |
| `context` | Given to the agents (assumptions, questions, feature toggles, business context). |
| `showcase` | Shown in the showcase PDF. |
| `ignore` | Dropped (checklists, definition of ready). |

Examples:

```yaml
requirements:
  template:
    # … the defaults init wrote stay; add to them:
    - { role: acceptance-criteria, name: Acceptance criteria, headings: [acceptance criteria, definition of done, done when] }
    - { role: scope, name: Business rules, prefix: BR, headings: [business rules] }
    - { role: ignore, name: Release, headings: [release notes, deployment] }
```

Run `story-check` on **five stories from different authors** until each reads as intended. Fix the template, not the stories; if a story is genuinely unclear, that's what `review-story` is for.

**3d. Number the ACs in the story.** Tests are tagged `@ac:AC-3`, and the traceability table, the showcase and the "is the story built?" check all follow those tags. When a story numbers its own ACs (`AC-1: …` list items, or a number column in a Given / When / Then table), the ids stay the same when someone edits the story. When it doesn't, qa-sentinel numbers them by position. Inserting or reordering an AC then shifts every id after it, and existing tests silently point at the wrong criterion. `story-check` flags unnumbered ACs. Agree with the POs to number them, and never to reuse a number for a different AC.

**3e. Story keys:** `requirements.jira.projectKeys` and `requirements.storyKeyPattern` decide which keys are found in branch names, MR titles and commit messages. Ask developers to put the key in the branch name (`feature/PAY-123-…`) or the MR title.

## 4. Learn the conventions and check readiness

```bash
npx qa-sentinel learn      # an agent reads your tests: conventions into the write-*-test skills, draft test-map.yaml
git diff                   # review what it learned; fix anything wrong; commit
npx qa-sentinel doctor     # keys, access, services, specs, story template, layers; --online checks GitLab access
```

## 5. CI

`ci/qa-sentinel/README.md` has the checklist for your platform. In short:

| Variable | Where | For |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | test repo + services (masked) | every agent run |
| `QA_SENTINEL_GITLAB_TOKEN` | test repo + services (masked) | MR comments, test MRs |
| `JIRA_EMAIL` + `JIRA_API_TOKEN` / `JIRA_PAT` | test repo + services (masked) | stories, comments, showcase, bugs |
| `QA_BASE_URL` (+ `QA_WEB_URL`, `QA_APPIUM_URL`, `QA_APP`) | test repo | the environment the tests run against |
| `QA_SENTINEL_PACKAGE` | group | the qa-sentinel version to install |

Include `ci/qa-sentinel/service.gitlab-ci.yml` from each service repo and `ci/qa-sentinel/tests.gitlab-ci.yml` from the test repo (Jenkins: one job per `Jenkinsfile.*`).

## 6. Roll out in steps

1. **Level 1 (two weeks):** `level: intelligence`. Gap reports on every service MR; nothing is written. Developers and QA read them; note where they are wrong.
2. **Story review:** run `review-story --story KEY --post` when stories are refined.
3. **Level 2:** `level: maintenance` once the reports are trusted. Generated tests arrive as MRs a QA engineer reviews.
4. **Measure and learn:** `npx qa-sentinel metrics --since 30d` (verification rate, merged-without-edits rate by month, cost). Expect most agent MRs to need small edits at first. Run `npx qa-sentinel lessons --push` weekly (or the `qa-lessons` CI schedule): it turns what reviewers changed into rules in `kb/review-lessons.md` that every agent reads, so the edits get smaller.
5. **Opt in** when ready: `showcase` (`QA_SHOWCASE=true`, `showcase.environments`, `showcase.notify`), bug cards (`bugs.mode: suggest`, later `create`), web/mobile layers (`add-web`, `add-mobile`).

## What teams usually change

| Setting | Why |
| --- | --- |
| `workspace.services` | your repos, their kind, specs, dependencies |
| `tests.api.runCommand`, `tests.*.dir` | your runner and layout |
| `requirements.jira.*`, `requirements.storyKeyPattern` | your Jira site, projects, AC field |
| `requirements.template` | how your stories are written |
| `environments` | your dev / sit / uat URLs (`generate --env sit`) |
| `guardrails.allowedHosts`, `guardrails.passEnv` | hosts your tests may call; extra env vars your tests need |
| `agent.maxBudgetUsd`, `agent.model` | cost limits and model |
| `reporting.targets`, `reporting.jira.visibility` | where reports go, who can see Jira comments |
| `showcase.*`, `bugs.*` | the showcase pack and bug cards |

Upgrading later: update the package, then `npx qa-sentinel upgrade` (refreshes qa-sentinel's own files, keeps your learned conventions) and review the diff.
