# Try it: re-review fixes (PR 11)

All steps are FREE (no AI, no Jira, no GitLab): the tests use temporary folders and mock servers.

1. `export QAS=~/Documents/qa-sentinel && cd $QAS && git fetch origin && git checkout pr11-review-fixes && npm ci && npm run build`
2. `npx vitest run test/bundleAttack.test.ts test/publish.test.ts test/splitJobs.test.ts test/jiraMode.test.ts test/overrides.test.ts test/notify.test.ts`

Expect 6 files, all passing. They need no internet and no git name or e-mail.

What they prove:
- `bundleAttack`: a merge that takes back an old file, deletes a file main added later or brings an old symlink is flagged; a clean merge of the current main is not.
- `publish`: `--kind` and the exact per-merge branch name; the `record` step; a failed notice is retried; a stale lock is taken over.
- `splitJobs`: the `after_script` blocks read `.qa-env.sh` as text in both modes.
- `jiraMode`: an old comment that does not fit is left as it is.

Not tried on a real GitLab or Jira. With a real project: set `QA_SPLIT_JOBS: "true"`, run a merge request, and check that the story record in Jira shows the written ACs after `qa-generate-publish` and not before.
