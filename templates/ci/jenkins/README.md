# qa-sentinel on Jenkins

| Jenkinsfile | Job | Trigger |
| --- | --- | --- |
| `Jenkinsfile.gap-report` | one per service repo (or a multibranch job) | GitLab plugin: merge request opened/updated |
| `Jenkinsfile.generate` | `qa-sentinel-generate` in the test repo | `build job:` step at the end of each service's main-branch pipeline |
| `Jenkinsfile.tests` | `qa-api-tests` in the test repo | agent MRs (`CHANGED_ONLY=true`), nightly cron, post-deploy |

## Credentials
- `anthropic-api-key` – secret text
- `qa-sentinel-gitlab-token` – secret text, GitLab token with `api` scope (MR comments, opening MRs)
- `gitlab-checkout` – username/password for cloning and pushing
- `qa-base-url` – secret text with the QA environment URL

## Notes
- MR comments use the GitLab API, so repos hosted on GitLab get the same experience as GitLab CI. The gap-report job maps the GitLab plugin's `gitlabMergeRequestIid` / `gitlabMergeRequestTargetProjectId` to what qa-sentinel expects.
- The gap report marks the build UNSTABLE, never FAILED, so it does not block developers.
- Docker agents need the Docker Pipeline plugin; swap `agent { docker … }` for a labelled node with Node 20+ if you don't use Docker.
- Run `qa-sentinel doctor` locally first.
