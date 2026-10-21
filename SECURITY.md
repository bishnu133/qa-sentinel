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
