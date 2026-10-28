# qa-sentinel on GitHub Actions

One file: `qa-gap-report.yml`. Copy it to `.github/workflows/qa-gap-report.yml` in each **service** repo.

| Job | Token | Has | Does |
| --- | --- | --- | --- |
| `analysis` | `contents: read`, `pull-requests: read` | the model key (`ANTHROPIC_API_KEY`), the Jira read login | runs `qa-sentinel gap-report --defer-publish`; writes nothing to GitHub or Jira; uploads the run folder as an artifact |
| `publish` | `contents: read`, `pull-requests: write` | no model key | runs `qa-sentinel publish --run all`: one comment on the pull request (edited in place on later pushes), and Jira if configured |

The run folder is untrusted. `publish` takes the repository (`GITHUB_REPOSITORY`) and the pull request number (the event payload) from its own job, never from the artifact. Pull requests from forks are skipped: GitHub gives them no secrets and a read-only token.

## Setup checklist
- [ ] Test repo: `qa-sentinel.config.yaml` has `ci.provider: github` (`qa-sentinel init --ci github` writes it) and the service name equals the service repo's name (or set `QA_SERVICE_NAME`).
- [ ] Each service repo, variable `QA_TESTS_REPOSITORY` = `owner/test-repo`.
- [ ] Each service repo, secret `ANTHROPIC_API_KEY`.
- [ ] Private test repo: secret `QA_TESTS_READ_TOKEN` (a token that can read it).
- [ ] Jira as the requirements source: secrets `JIRA_EMAIL` + `JIRA_API_TOKEN` (or `JIRA_PAT`), and for writing `QA_JIRA_PUBLISH_PAT` (or `QA_JIRA_PUBLISH_EMAIL` + `QA_JIRA_PUBLISH_API_TOKEN`).
- [ ] Optional: variable `QA_SENTINEL_PACKAGE` (default `qa-sentinel@0.8.0-beta.2`; `github:owner/repo#ref` is built in the job).
- [ ] GitHub Enterprise Server: `ci.githubApiUrl: https://ghe.example/api/v3` (Actions sets `GITHUB_API_URL` itself).
- [ ] Run `qa-sentinel doctor --online` locally with `QA_SENTINEL_GITHUB_TOKEN` first.

## Limits (see the main README, "GitHub")
- Actions are pinned by tag (`@v4`). For stricter supply-chain control replace each tag with the full commit SHA.
- Only the gap report is templated. Test generation, the agent-PR gate, stories and post-deploy have no GitHub workflow yet.
- Not yet run on a real GitHub repository.
