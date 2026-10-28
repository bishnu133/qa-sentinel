# Security

qa-sentinel runs an AI agent against your code and test repositories, and it holds tokens for GitLab, Jira and an AI provider. Security reports are welcome.

## Reporting a vulnerability

Please do **not** open a public issue for a vulnerability. Use GitHub's private reporting: on the repository page, **Security → Report a vulnerability**. Include what you found, how to reproduce it, and which version (`qa-sentinel --version`). You will get a reply as soon as the maintainer can; this is a volunteer-run project, so please allow a few days.

## What counts

Examples that are in scope:

- A way for the agent, or text in a story, merge request, test or spec (prompt injection), to read a credential, write outside the paths its guardrails allow, or run a command it should not.
- A token or secret that ends up in a log, a report, a comment on GitLab or Jira, a commit or the story record.
- A path traversal, for example through a story key, branch name or file name.
- A change to a protected file (the expected-behaviour file, the lock) that the checks should have refused.

Out of scope: vulnerabilities in Claude Code, GitLab, Jira or your own services, and anything that needs an attacker who already controls your CI runner or your tokens.

## How qa-sentinel limits the damage (summary)

- Agents get a scrubbed environment: Jira, GitLab and other tokens are not passed to them (see "Guardrails" in the README).
- Generation can only write where the config allows; the run is rejected and nothing is committed when a guardrail fails.
- qa-sentinel never merges anything; a person reviews every merge request.
- Reports and Jira comments pass through secret masking before they are posted.

If you find a gap in any of these, that is exactly what to report.

## Using it safely

- Use tokens with the smallest scope that works (for GitLab, `api` is needed to comment and open merge requests; use a project or bot token, not a personal one).
- Keep Jira URLs, tokens and e-mail addresses in environment variables or CI secrets, never in the config file or in git.
- Check your organisation's rules before sending story text or code to an AI provider.

## Running generated tests and the agent more safely

Generated tests are code written by a model. qa-sentinel checks what the agent changed (write paths, hosts, secrets, assertions), but the tests then run on your runner. These are the small, honest tools it has. None of them is a guarantee, and none replaces a runner that can reach only what it must.

### `verification.wrapCommand`: where qa-sentinel's own test runs happen

Every test command qa-sentinel starts (verification after `generate` and in `verify`, `post-deploy`, `suite --run`, `feature --run`, the showcase recording) can be put inside a wrapper you choose:

```yaml
verification:
  wrapCommand: "docker run --rm --network qa-net -e QA_BASE_URL -e QA_WEB_BASE_URL -v $PWD:/w -w /w node:22 sh -c {cmd}"
```

`{cmd}` is replaced by the whole test command as one shell-quoted word (spaces and quotes in spec paths survive), so the wrapper starts a shell with `sh -c {cmd}` or similar. Rules and limits:

- `doctor` runs a command with spaces and quotes that prints something and exits 7 through the wrapper, and fails unless the output comes back whole and the exit code is 7 (so a wrapper that drops arguments or always exits 0 is caught). It does **not** prove that the wrapper isolates anything.
- What the wrapper isolates is the wrapper's job: with Docker, only the folder you mount is visible, and environment variables are **not** passed unless you add `-e NAME` for each one the tests need (`QA_BASE_URL`, the login roles). `firejail` and `bwrap` keep the environment. We have only tested the wrapper mechanism with `sh -c`; the Docker and `firejail` lines in this file are examples to adapt, not setups we have run.
- Lint and type-check (`tsc`) are not wrapped; they run no generated test code.
- The agent's own shell commands are not affected by this setting (see `agent.sandbox` below).

### Runner network allowlist (example)

The cheapest strong control is the network around the job, not a setting in qa-sentinel. The jobs need: GitLab (and your Jira, if used), the Anthropic API (analysis job only; or your Bedrock/Vertex endpoint), your package registry, and the QA environment. Nothing else.

- Docker: create a network for the tests, `docker network create qa-net`, and put the egress rules for it on the host (for example with your firewall tool, allow only those hosts from that network's subnet). Run the tests with `--network qa-net` as in the `wrapCommand` example.
- GitLab runners on Kubernetes: a `NetworkPolicy` for the namespace the runner starts jobs in, with egress rules for those hosts only.
- With the split CI jobs (README, "CI"), the publish job needs GitLab and Jira only; it needs neither the model nor the QA environment.

### `agent.sandbox`: Claude Code's built-in sandbox for the agent's Bash

```yaml
agent:
  sandbox: { enabled: true, allowedDomains: [qa.example.com], failIfUnavailable: true }
```

When enabled, qa-sentinel starts the agent with `--settings` carrying `sandbox.enabled: true`, `sandbox.failIfUnavailable`, `sandbox.allowUnsandboxedCommands: false` and `sandbox.network.allowedDomains`. These key names were read from Claude Code's sandboxing documentation (https://code.claude.com/docs/en/sandboxing) on 2026-10-22; check that page again if a Claude Code update changes them. What the documentation says, and what follows for you:

- It covers the agent's **shell commands** (Bash) and the processes they start. Claude's file tools (Read, Edit, Write), MCP servers and hooks run outside it. qa-sentinel's file-level rules (write paths, deny rules) still apply to the file tools.
- It runs on macOS, Linux and WSL2. On Linux and WSL2 it needs `bubblewrap` and `socat`; with `failIfUnavailable: true` the agent does not start when they are missing, instead of running unsandboxed. `doctor` reports them as a failure when `failIfUnavailable` is true (the agent would not start), and as a warning when it is false.
- Network access starts with no allowed domains: list the hosts the agent's test commands must reach (the QA environment's host). An agent that cannot run its tests there will say so in its notes. `allowedDomains` limits what the sandboxed shell commands can reach; it does **not** limit Claude's own web tools (WebFetch, WebSearch), which are not Bash.
- It matters only if Bash is one of the agent's tools. qa-sentinel gives the agent a short list of Bash commands (the test runner); an agent run with no Bash tool has nothing to sandbox.
- Inside some containers `bubblewrap` cannot start (the documentation has a section on this); then use `wrapCommand` or runner-level isolation instead.
- It is off by default and untested by us against a real Claude Code with `bubblewrap` in CI; the arguments qa-sentinel passes are unit-tested.

### Split CI jobs

`QA_SPLIT_JOBS` (README, "CI") is meant to keep the GitLab write token out of the job that holds the model key (which runs code a model wrote) and the model key out of the job that holds the write token. What is and is not true:

- **The run folder is untrusted.** `qa-sentinel publish` takes where it writes (project, merge request, target branch, remote) from its own configuration and CI variables, accepts only `qa-sentinel/...` branches, computes the base of its policy check from the server, treats every commit the target branch does not have as the agent's, checks the whole repository, refuses generated artifacts, symbolic links and submodule links, validates `publish.json` strictly, pushes with `--force-with-lease` on one branch, and keeps only labels of qa-sentinel's own shapes. A hand-made `publish.json` or `branch.bundle` can make the publish job refuse, or push a branch that passes the write policy; it cannot make it push another branch, write to another project or merge request, or skip the policy. **Symbolic links in the run folder itself** (not only in the pushed branch) are refused too: `publish` looks at `.qa-sentinel`, `.qa-sentinel/runs` and the run folder with `lstat` before it reads anything and stops if it finds a link, opens the files it reads and writes (`publish.json`, `published.json`, `jira-summary.md`, the manifest) without following links, and the GitLab publish jobs delete links from the copied folder first (`find ... -type l -delete`). A planted link can therefore make the publish job refuse; it cannot make it read or overwrite another file.
- **Not covered:** the verification status shown in the merge request and in Jira is the analysis job's claim (`publish` runs no tests; the `qa-agent-mr-checks` job is the independent gate). A secret added and removed again in an earlier commit of the bundle is only seen in the final files by the content check (the path rules look at every commit). The descriptions and Jira texts are what the analysis job wrote.
- **Variables and `after_script`.** GitLab lists every project variable to every job, and an `unset` in a job's `script` does not reach its `after_script` (a new shell). So every `after_script` that runs `qa-sentinel data sweep` (the shared `.qa-node` one and the analysis job's own) first unsets the secrets it knows by name (GitLab, Jira, model and cloud variables, and the GitLab job token under all its names: `CI_JOB_TOKEN`, `CI_JOB_JWT*`, `CI_REPOSITORY_URL`, `CI_REGISTRY_PASSWORD`, `CI_DEPENDENCY_PROXY_PASSWORD`, `CI_DEPLOY_PASSWORD`; the list is in the template), then reads the environment URL from `.qa-env.sh` **as text** (a whitelist `sed`, never sourced), in both modes. The sweep reads the config of the pipeline's own commit (`git show $CI_COMMIT_SHA:...` passed with `--config-from`), not the work tree's, which generated code may have changed. `data sweep` itself accepts only a `QA_CLEANUP_*` variable as `testData.sweepAuthEnv` (a name pattern; the config does not load with another name), and refuses a base URL whose host is not in `guardrails.allowedHosts`; a config read from the work tree in CI (no `--config-from`) can use only the default hosts. What this does not cover: a variable named `QA_CLEANUP_*` is sent to whatever host the config of the pipeline's commit allows (the default list includes `localhost`), and anything else that reads the work tree during the job. Still scope the write token, the Jira publishing login and the model key to environments (`qa-publish`, `qa-analysis`) or protected variables, and give the analysis job a read-only Jira login; without that, the split is a discipline, not a barrier.
- **GitLab quick actions.** GitLab runs a line that starts with `/` in a merge request description or note as a command (`/approve`, `/merge`, `/target_branch`, `/assign` ...). Text that qa-sentinel posts includes text from stories, code and test output, so every merge request description, note and comment it sends to GitLab has a zero-width space put in front of a leading `/` (also one right after a `>`, as in `<p>/approve</p>`): it still reads the same and runs nothing. The `/qa ready` override that a person writes is read with that character removed, so both forms work. This covers what qa-sentinel posts; it cannot stop a person from typing a quick action. Whether GitLab reads a command in any other place was not checked against a real GitLab.
- **Jira and the story record.** In split mode the analysis job writes no Jira object. It keeps its own copy of the story record in files (CI cache; spending, job keys and failure counts live there only) and, with `automation.record: jira`, also **reads** the Jira record with its read login and merges the two field by field: spending and jobs are the file's (the larger total, the union of jobs and ledger), written/held per AC, evidence, the conflict and the agent's merge request are Jira's. Budgets are therefore only as good as the CI cache: with a cold cache the analysis job does not know earlier spending, and nothing writes spending to Jira in this mode. It cannot read the Jira record when it has no Jira read login or Jira does not answer: it then uses the file alone. The Jira record is written only by `qa-sentinel publish`, from the `record` step the analysis job leaves. **Which story a step may write to does not come from the run folder**: `publish` (generate runs) accepts a step for a story only if the pipeline names it: `QA_STORY_KEY` / `QA_STORY_KEYS`, a Jira key in the service commit's title or message or branch (`QA_SERVICE_COMMIT_TITLE`, `QA_SERVICE_COMMIT_MESSAGE`, `QA_SERVICE_BRANCH`, which the service template passes), or in the title, description or branch of the service merge request of that commit (asked from GitLab). A story that is only in the run folder (a merge request, record, notice, bug or note step) is refused. A bug card is traced to its story through Jira by the publish job itself (its read of the bug's links), when the bug key is named by the pipeline: so a bug-fix merge request whose title has only the bug key still publishes to the story, without `QA_STORY_KEY`. Within that: a record step is for the story of the run's merge request; "written" entries with a merge request are applied only after that merge request was pushed by this publish; a run with no merge request (the existing tests were enough) may record its own story's written/held entries and evidence; a branch reset travels with the merge request step and is applied after the push; a conflict step holds nothing else and only the story's own branch. Gap-report runs are bound the same way: their `bugs` and `notify` steps are refused for a story the pipeline does not name, and a `mr-seen` step records nothing for it. A `report` step is different: the note always goes to the job's own merge request or pull request, so it is posted either way, but for a story the pipeline does not name the story key and the Jira comment are dropped. The pipeline names a story through the merge request or pull request the job runs on (title, description and branch; GitLab and GitHub), the service commit, or `QA_STORY_KEY`. Keys found in commit or merge request text count only if they match `requirements.projectKeys`; with `projectKeys` empty, only `QA_STORY_KEY` / `QA_STORY_KEYS` name a story (so `UTF-8` is never taken for one). The record is a cache, not a source of truth for the code. If your stories are named only in Jira links (not in the commit or merge request text), set `QA_STORY_KEY` for the pipeline.
- **What publish accepts.** Each publish job takes only its own kind of run (`publish --kind generate` or `--kind gap-report`, which the templates pass) and only the step types of that job. A branch other than the story's is accepted only as `qa-sentinel/<QA_SERVICE_NAME>-<first 8 of QA_SERVICE_SHA, lowercase>` of the publish job's own variables (no other `qa-sentinel/*` name, no other service's branch; backfill branches are not pushed by the split jobs). A service name must not start with the story branch prefix (`generation.branchPrefix`, default `qa-sentinel/story-`): such a branch would look like a story branch and is refused. A merge from an old main into the agent's branch is checked: a path whose final content differs from the target branch counts as the agent's, whichever commit brought it, and on a story branch also every path the merge request will newly show after the push (the merge-base can move).
