# qa-sentinel demo kit

Run a full qa-sentinel demo on **your own** Jira test project and **your own** GitLab test group, then put everything back and run it again.

You play the developer with two small scripts. A merge request is opened, merged, and you watch qa-sentinel react: the gap report, the generated tests, the Jira comments. Then `reset.mjs` undoes it.

Every step below has a tag:

| Tag | Meaning |
| --- | --- |
| **FREE** | Costs nothing and writes nothing outside your computer. |
| **JIRA WRITE** | Creates or changes things in your Jira test project. |
| **GITLAB WRITE** | Creates or changes things in your GitLab test projects. |
| **AI $** | Starts a pipeline that calls Claude. This costs money (see "Cost"). |

## 1. What is NOT proven (read this first)

The person who built this kit **never ran it against a real Jira or a real GitLab**. It has no access to them.

- **Tested:** the scripts run against a small fake Jira and a small fake GitLab (`test/demoKit.test.ts`). Seed, merge, bug fix and reset all pass there, including "run reset twice" and "reset touches only what it recorded".
- **Not tested on real systems:** every call to real Jira and real GitLab. Differences between the fakes and the real servers are possible. Examples: how your GitLab answers a revert of a merge commit, your Jira workflow names, permissions to delete comments, the merge settings of your project.
- **Not run:** the real qa-sentinel pipelines on this demo project (gap report, generation, the agent merge request, the showcase), and no real AI run. The "what to watch for" lines come from the shipped docs and templates (`docs/SANDBOX.md`, `templates/ci/gitlab/`), not from watching this demo run.
- **Claimed proven elsewhere (README of qa-sentinel):** GitLab end to end on gitlab.com with the ShopLite sandbox. This demo uses the same ShopLite service, in a smaller layout. Jira Data Center, a self-hosted GitLab and Jenkins are not proven.
- **Unknown until you try:** how long your pipelines take, and the exact AI cost. Numbers on this page are from the docs and are marked "(docs)".
- **Not covered by the demo template:** the "after deploy" trigger (`qa-trigger-post-deploy`) is not set up, so "a bug fix re-runs the story's tests after deploy" is not shown. The demo shows what happens at merge time.

Do a **full rehearsal** at least once, the day before (see `CHECKLIST.md`). If something differs from this page, trust what you see and tell the builder.

## 2. What you need

- A computer with Node 20 or newer and git. This repository, built: `npm ci && npm run build` (**FREE**).
- A Jira (Cloud, or Server/Data Center) **test project** that you may write to. Statuses "To Do" and "In Progress" must exist, and the link type "Relates".
- A GitLab group for tests, with **empty** projects:
  - `shoplite-tests` (the test repo)
  - `shoplite-orders` (the service repo)
  - `shoplite-payments` (optional; only the cross-service card needs it)
  In each project: merge requests may be **squashed** (Settings > Merge requests > Squash: Allow or Encourage), approvals are not required, and "Pipelines must succeed" is off (or you wait for the pipeline).
- **Use bot identities, not your own.** The pipelines hold these secrets, and anyone who can push a branch in the group can make a job print them (masking does not stop that).
  - GitLab: a **group access token** (a bot user limited to the demo group), scopes `api` and `write_repository`, role Maintainer. Use the same bot token for the scripts (`GITLAB_TOKEN`) and for CI (`QA_SENTINEL_GITLAB_TOKEN`). Reset only deletes comments written by the token's user, so the same user has to do both.
  - Jira: a **bot account that can see only the TEST project** (project role with Browse, Create, Edit, Transition, Add comments, Delete own comments, Link, Create/Delete own attachments). Cloud: its e-mail and an API token (`JIRA_EMAIL`, `JIRA_API_TOKEN`). Server/Data Center: its personal access token (`JIRA_PAT`, and `"auth": "pat"` in the config). Same rule as `requirements.jira.auth`.
  - Do not use your personal tokens. A token that reaches all of your GitLab and Jira turns a mistake or a malicious branch into a big problem.
- A Claude key for the pipelines (`ANTHROPIC_API_KEY`), or Bedrock/Vertex (see `templates/ci/gitlab/README.md`).
- GitLab runners that can use Docker (the templates use `node:22`) and reach GitLab, the Anthropic API and the npm registry.

## 3. One-time setup

Run everything from the qa-sentinel folder.

1. **Make the config. FREE.** `cp demo/demo.config.example.json demo/demo.config.json`, then replace every `<placeholder>`. The file is git-ignored. No secret goes in it.
2. **Set your logins in the terminal. FREE.** Nothing is written to disk.
   ```
   export GITLAB_TOKEN=...            # api + write_repository
   export JIRA_EMAIL=... JIRA_API_TOKEN=...      # Cloud   (or: export JIRA_PAT=...  for Server/DC)
   export DEMO_JIRA_PROJECT=<your test project key>   # must equal jira.project in the config
   ```
3. **Create the Jira cards. JIRA WRITE.**
   ```
   node demo/scripts/seed-jira.mjs                                      # dry run: lists the 5 cards
   node demo/scripts/seed-jira.mjs --yes --i-know-this-is-a-test-project <KEY>      # the flag carries your project key
   ```
   It refuses to run when `DEMO_JIRA_PROJECT` is missing, differs from the config, or the flag does not carry the project key. It also stops when the project already holds issues that are not demo cards (use an empty test project; `--allow-existing-issues` overrides). It makes 5 cards: 2 stories with acceptance criteria, 1 bug linked to story 1, 1 cross-service story, 1 hotfix bug. Stories are moved to "In Progress" (qa-sentinel treats that as approved). The keys go to `demo/.demo-state.json` (git-ignored; never commit it).
4. **Push the template to GitLab. GITLAB WRITE.**
   ```
   node demo/scripts/setup-gitlab.mjs                 # dry run
   node demo/scripts/setup-gitlab.mjs --yes
   ```
   It only fills **empty** projects. It builds three folders in `demo/.work/` (the test repo comes from `qa-sentinel init`, so the shipped CI templates are used; `npm install` runs with `--ignore-scripts` and without your tokens), pushes them without starting pipelines, tags every project `demo-baseline`, and cuts the branch `release/demo` in the orders project. If `npm install` leaves addresses of a private npm mirror in the lockfile, setup stops and tells you.
5. **Add CI/CD variables in GitLab** (group level; secrets **Masked** and **Protected**). The kit never writes them to a file.
   | Variable | Value | Notes |
   | --- | --- | --- |
   | `ANTHROPIC_API_KEY` | your key, with a spend limit | Protected, Masked. For the split setup below: environment scope `qa-analysis`. |
   | `QA_SENTINEL_GITLAB_TOKEN` | the bot token | Protected, Masked. |
   | `JIRA_EMAIL`, `JIRA_API_TOKEN` | the Jira bot (Cloud); or `JIRA_PAT` (Server/DC) | Protected, Masked. |
   | `QA_SENTINEL_PACKAGE` | where to install qa-sentinel from, for example `github:bishnu133/qa-sentinel#<branch>` | Not a secret. Use a version that has the features you want to show. |
   **Protected** variables are given only to pipelines of protected branches. Setup protects the patterns `demo/*` and `hotfix/*` in the orders project (and `main` is protected by default), so the merge request pipelines of the demo get them. Check Settings > Repository > Protected branches if a job says a variable is empty.

   **Safer setup (recommended, opt-in): split jobs.** Set `QA_SPLIT_JOBS` to `true` as a CI/CD variable. Then the job that holds the model key cannot write, and the job that writes holds no model key (templates/ci/gitlab/README.md, "Split jobs"):
   | Variable | Environment scope |
   | --- | --- |
   | `ANTHROPIC_API_KEY`, `QA_SENTINEL_GITLAB_READ_TOKEN` (bot, `read_api` + `read_repository`), Jira login for reading (`JIRA_*`) | `qa-analysis` |
   | `QA_SENTINEL_GITLAB_WRITE_TOKEN` (bot, `api` + `write_repository`), `QA_JIRA_PUBLISH_EMAIL` + `QA_JIRA_PUBLISH_API_TOKEN` (or `QA_JIRA_PUBLISH_PAT`) | `qa-publish` |
   The split jobs were **not run on a real GitLab** by the kit's author (docs/TRY-PR5.md says the same). Rehearse with them on if you want to show them. The reset script and the write token must still be the same user as the one that writes comments, or the comments are not recognised as qa-sentinel's.
6. **Check the setup. FREE, except `--online` makes one tiny Claude call (AI $, one tiny call; docs/AUTOMATION.md):**
   ```
   cd demo/.work/shoplite-tests
   npx qa-sentinel doctor --online      # or: node ../../../dist/cli.js doctor --online
   ```
   Fix every red line. Then in GitLab, open `shoplite-tests` > Build > Pipelines > Run pipeline on `main`: the `api-tests` job should pass (the baseline). **GITLAB WRITE** (it creates a pipeline; no AI).
7. Write down the three links you will click in the demo: the Jira board, the service merge requests, the test repo merge requests.

## 4. The demo (short form; the talk track is in `DEMO-SCRIPT.md`)

Each command is a dry run until you add `--yes`. The dry run reads GitLab and checks that the change fits.

| # | Command | Tags | What to watch (docs, not observed) |
| --- | --- | --- | --- |
| 1 | `node demo/scripts/demo-merge.mjs --card delivery-slot --yes` | GITLAB WRITE, **AI $** (gap report) | Job `qa-gap-report` in the service merge request. One comment on the MR and one on the Jira card. Expect a finding that the code allows 5 orders per slot while the card says 3. |
| 2 | `node demo/scripts/demo-merge.mjs --card delivery-slot --yes --merge` | GITLAB WRITE, **AI $** (generation) | After the merge: job `qa-trigger-generation`, then in the test repo job `qa-generate`. A new merge request with labels `qa-agent` and `qa-sentinel::<status>`, branch `qa-sentinel/story-<KEY>`. The job `qa-agent-mr-checks` is the gate. |
| 3 | `node demo/scripts/demo-bugfix.mjs --card slot-cap-bug --yes --merge` | GITLAB WRITE, **AI $** | The fix (cap 5 to 3) is merged. The bug is linked to story 1 in Jira with "Relates". |
| 4 | `node demo/scripts/demo-merge.mjs --card qty-limit --yes --merge` | GITLAB WRITE, **AI $** | A change that matches its card. Expect (not observed) no requirement conflict, and a test merge request. |
| 5 | `node demo/scripts/demo-merge.mjs --card cancel-refund --part payments-service --yes --merge`, then `--part orders-service` | GITLAB WRITE, **AI $**; needs `shoplite-payments` | **Not proven.** By the docs, the criterion that needs both services waits until both are merged, then (setup sets `generation.crossService: when-ac-complete`, because the demo cards stay "In Progress") it is written. Whether this works end to end on a real project has not been observed. |
| 6 | `node demo/scripts/demo-bugfix.mjs --card blank-item-hotfix --yes --merge`, later `--cherry-pick` | GITLAB WRITE, **AI $** (after the cherry-pick) | Merged into `release/demo` first: qa-sentinel makes no tests for it. `--cherry-pick` copies it to `main`. |

Cards 1 to 4 need only `shoplite-tests` and `shoplite-orders`. Card 3 needs card 1 merged first (the script says so if it does not fit).

Press **Merge** in GitLab yourself instead of `--merge` if you prefer: the script remembers the merge request, and `reset` asks GitLab about every merge request it recorded, so it finds the merge commit even though the script did not make it. (A merge request that the script did not open is not known to reset.)

`--merge` waits up to 60 seconds (`--merge-wait <seconds>`) until GitLab says the merge request is mergeable. Note: if you open and merge in one go, the `qa-gap-report` job runs on an already merged merge request (and costs money). To show the gap report first, open without `--merge`, wait for the comment, then merge.

### Cost
From `docs/SANDBOX.md` (docs; measured on the sandbox, not on this demo): a gap report about $0.10 to $0.40, a generation about $0.50 to $2. A full run of steps 1 to 6 is therefore roughly $3 to $15. Your numbers will differ. The config caps each command (`agent.maxBudgetUsd`) and `automation.budgets` caps each story, day and month; set the spend limit of your key as the backstop. **Reset costs nothing and cannot give the money back.**
Pipeline time from the same doc: a gap-report job about 2 to 4 minutes, generation about 5 to 10 minutes (docs, gitlab.com shared runners).

## 5. Reset (to run the demo again)

```
node demo/scripts/reset.mjs --tests-dir demo/.work/shoplite-tests          # DRY RUN: prints exactly what it would do
node demo/scripts/reset.mjs --tests-dir demo/.work/shoplite-tests --yes --i-know-this-is-a-test-project <KEY>
```
**JIRA WRITE, GITLAB WRITE, FREE of AI.** It works only on the projects and cards in `demo/.demo-state.json`.

What it does, in this order:
1. **First it checks.** Every project in the state file must be in `demo.config.json`, and its tag `demo-baseline` must still point to the commit that setup recorded. Every Jira card must have the key shape `<KEY>-<number>`, the label `qa-sentinel-demo` and the summary from `cards.json`. Anything else is refused or skipped, with the reason. The state file is checked for odd values before anything is sent.
   **GitLab.** Closes the demo merge requests and the open ones from branches named `qa-sentinel/*`. Deletes the demo comments that carry the `qa-sentinel:` marker **and** were written by the token's user (a comment from another person that quotes the marker is left alone). **Reverts** the demo merges with new revert commits (it never rewrites history), then deletes the demo branches and the `qa-sentinel/*` branches. If the files on a branch already equal the tag `demo-baseline`, it does not revert anything. At the end it checks each branch against `demo-baseline` and prints the result.
2. **Jira.** Deletes comments with the marker written by the login's user, removes the issue properties `qa-sentinel.record`, `.showcase` and `.bugs` (and the attachments the showcase record lists), moves each card back to the status it had after seeding. If Jira cannot say who the login is, it deletes **no** comments.
3. **Your test repo folder** (`--tests-dir`). Removes `.qa-sentinel/`, `qa-stories.md` and the other generated files (they can hold Jira text), then runs `qa-sentinel doctor`.

Safe to repeat: it looks at what is there now. Records are forgotten per project, only for a project whose steps worked and whose files equal `demo-baseline` again. If a branch still differs, reset says `NOT FINISHED`, exits with 1 and keeps the records. A second run finishes the job.

After reset, **by hand**: in the test repo, Build > Pipelines > **Clear runner caches** (the story records live in a cache and would bring old job keys and spend counts back), and wait until the runners are idle: each revert is a push to the default branch and starts pipelines. `--cancel-pipelines` cancels the ones that are running or waiting.

Why revert and not reset the branch to the tag? A revert is a normal commit, so nothing is lost and it needs no force-push on a protected branch. The tag `demo-baseline` is still there as the check, and as the manual fallback.

**Manual fallback** if GitLab refuses a revert (reset prints a line starting with `MANUAL`): in a clone, `git revert -m 1 <sha>` (or without `-m 1` for a squash commit) and push; or, if force-push is allowed on that branch, `git push --force-with-lease origin demo-baseline:main`.

### What reset cannot undo
- Jira keeps its history. The History tab still shows the deleted comments and the status changes.
- AI money already spent.
- E-mails and notifications already sent.
- GitLab pipelines, logs and artifacts (they expire). Closed merge requests stay as closed. `--delete-mrs` tries to delete them; GitLab allows that only for owners.
- Bug cards that qa-sentinel itself created stay in Jira unless you add `--delete-bugs` (only those in the demo project, with the `qa-sentinel` label, created by your login). Their keys are remembered in the state file.
- The runner cache of the test repo (see above), people's comments (reset lists comments that say `/qa ready`: delete them by hand), and a Jira Resolution that stays set after moving a card back from Done.

## 6. If something goes wrong

| Symptom | What to do |
| --- | --- |
| The script says `STOP: ...` | The message says what is wrong. No half-done change is hidden: look at `demo/.demo-state.json` and run `reset.mjs` (dry run first). |
| `Refusing: ... is not one of the demo projects listed` | The project is not in the state file. Run `setup-gitlab.mjs --yes` first, or check `demo.config.json`. |
| `The change does not fit ...` | The earlier card is not merged (card 3 needs card 1), or the branch has other edits. Run `reset.mjs --yes` and start again. |
| `... is not mergeable yet` / `GitLab would not merge` | A pipeline is running, an approval or a discussion is open, or the project allows only fast-forward merges (rebase the merge request in GitLab first). Wait, then run the same command again; or merge in the GitLab page. |
| `setup-gitlab` says the project already has commits | Setup never overwrites. Use `reset.mjs`, or create a new empty project. |
| Pipelines stay pending | Runners are not available (on gitlab.com the account must be verified). |
| `qa-gap-report` cannot clone the test repo (403) | Job-token allowlist. Settings > CI/CD > Job token permissions in each project. Setup tries to set it and prints a WARNING if it could not. |
| `qa-trigger-generation` fails in seconds | The test repo does not accept pipeline variables. Settings > CI/CD > Variables > Minimum role to use pipeline variables: Developer. |
| No comment on the merge request or the card | Look at the job log for 401/403. Check `QA_SENTINEL_GITLAB_TOKEN`, `JIRA_*` and that `reporting.targets` has `gitlab-mr` and `jira`. |
| Reset leaves qa-sentinel's comments | The comments were written by another user than the token you run reset with. Use the same user. |
| `CERT` / `fetch failed` errors | Your network inspects HTTPS. Try `NODE_OPTIONS=--use-system-ca` in front of the command (Node 22.15 or newer). |
| Live systems are down on demo day | `FALLBACK.md`. |

## 7. What is in this folder

| Path | What |
| --- | --- |
| `README.md`, `DEMO-SCRIPT.md`, `CHECKLIST.md`, `FALLBACK.md` | This page; the 25 to 30 minute talk track; the day-before and 30-minute checklists; the plan B. |
| `demo.config.example.json` | The config with placeholders. Copy to `demo.config.json`. |
| `jira/cards.json` | The 5 cards. The story text is in `shoplite-demo/stories/*.md`. |
| `shoplite-demo/service-orders`, `service-payments` | The two small services (ShopLite, from `sandbox/shoplite`). The orders service answers for payments itself when `PAYMENTS_URL` is not set, so one repo is enough for cards 1 to 4. |
| `shoplite-demo/tests` | What is added to the test repo on top of `qa-sentinel init`: `.gitlab-ci.yml` (uses the shipped template), `qa-env/` (starts the services), baseline tests. `shoplite-demo/qa-sentinel.config.sample.yaml` is a sample of the settings setup adds (placeholders only; not copied anywhere). |
| `shoplite-demo/changes/*.json` | The developer's change for each card, as search-and-replace edits. A test checks that each one fits the template. |
| `scripts/` | `seed-jira`, `setup-gitlab`, `demo-merge`, `demo-bugfix`, `reset`. They export functions; the tests call them. |
| `.demo-state.json`, `demo.config.json`, `.work/` | Made on your computer, git-ignored. Never commit anything that comes from Jira. |

Rules the scripts follow: tokens are read from the environment and never printed; nothing is written without `--yes`; seed and reset also need `--i-know-this-is-a-test-project <your project key>` (the bare flag is refused); `--yes` must be bare; a script refuses to touch a GitLab project or a Jira card that is not in the state file.
