# Try it: AC-first generation (phase 1)

A hands-on check of what phase 1 adds, on the ShopLite sandbox. Steps 1–3 need no AI. Steps 4–8 run the AI
(Claude Code, on whatever account `doctor` shows); each run is capped by `agent.maxBudgetUsd` (requirements pass: $1).

## 0. Get the branch

Set once, in every terminal you use for this guide (your qa-sentinel folder):
```bash
export QAS=~/Documents/qa-sentinel
```

```bash
git fetch origin && git checkout phase1-ac-first
npm ci && npm run build
npm test                      # all green
```

## 1. Sandbox (no AI)

Use a new, empty folder (not one from an earlier sandbox run):
```bash
mkdir -p ~/qa-try && cd ~/qa-try
node $QAS/sandbox/shoplite/local.mjs setup --level maintenance
cd shoplite-local/qa-tests
alias qa-sentinel="node $QAS/dist/cli.js"   # the sandbox doesn't install it as a package
```

## 2. The requirements pass, dry run (no AI)

```bash
qa-sentinel spec --story-file ../stories/SHOP-101.md --dry-run
```
Expect: `expected behaviour: SHOP-101 (4 AC …)` and the list of files the AI would see: `story.md`, `acs.json`,
`knowledge.md`, the skill. **No code and no tests**: that is the code-blind part.

## 3. The plan rules (no AI)

```bash
cd $QAS && npx vitest run test/spec.test.ts test/acFirstPlan.test.ts test/knownDefect.test.ts test/taxonomy.test.ts
```

## 4. Write the expected behaviour (AI, small)

```bash
cd ~/qa-try/shoplite-local/qa-tests
qa-sentinel spec --story-file ../stories/SHOP-101.md
```
Open `expected/SHOP-101.md`. Check:
- Every AC has behaviours (or an `untestable` reason).
- Every value (3 orders per slot, status codes, messages) is in the story or `kb/`. Each `ready` behaviour has a
  `basis` that quotes the words it came from.
- What the story doesn't say is `unspecified` with a question for the PO, and printed at the end of the run.

Run it again: `… is up to date (no AI run needed)`.

## 5. Change one AC (AI, small)

Edit `../stories/SHOP-101.md`: change the wording of one AC (not just punctuation). Run `spec` again.
Expect: only that AC is sent to the AI; the others stay exactly as they were, including anything you edited by hand.
Remove an AC instead: the run says it isn't in the story's current list and **keeps** its expectations (a person sets
`removed: true`).

Before step 6:
- **Put the story back** as it was (undo your AC edit), so step 6 shows the 3-vs-5 catch.
- Run `spec` once more, then **commit** the file on `main`: `git add expected && git commit -m "SHOP-101 expected behaviour"`.
  Step 6 resets the test repo to `main` and stashes anything uncommitted, so an uncommitted expected file would
  disappear from view (`git stash list` in qa-tests gets it back).

## 6. Generate tests from it (AI, the full run)

```bash
cd ~/qa-try && node $QAS/sandbox/shoplite/local.mjs run SHOP-101 --generate
```
SHOP-101's catch: the story says 3 orders per slot, the code allows 5. Expect:
- Since you committed `expected/SHOP-101.md` in step 5, the requirements pass says it is up to date (no AI run).
  (Skip steps 4–5 instead and the agent branch starts with a separate commit
  `test(expected): expected behaviour for SHOP-101`.)
- In the run folder (`qa-tests/.qa-sentinel/runs/<latest>/test-plan.validated.json`): scenarios cite `behaviourIds`,
  and every AC has a scenario or a reason.
- Each new test carries `@b:B…` tags next to `@ac:`; qa-sentinel rejects the run if a test doesn't contain the
  expected values of the behaviours it names.
- The AC-3 test asserts **3** (the story), not 5 (the code). It fails, so it is written as `test.fixme` with a
  `// QA-AGENT: SHOP-101/B…: …` note, and the MR notes list it as a discrepancy.
- Failures in the verification summary are labelled, e.g. `❓ unclassified – needs triage` (see docs/GLOSSARY.md).

## 7. The lock

On the agent branch, as yourself:
```bash
git checkout qa-sentinel/<branch>
# change a value of a ready behaviour in expected/SHOP-101.md, commit it
qa-sentinel verify --policy --base main
```
Expect: your change is accepted and listed as a **QA override**. (An AI run making the same change is rejected.)

## 8. Mark a known defect (QA triage)

In the AC-3 test: change `test.fixme(` to `test.fail(` and add above it
`// QA-BUG: https://your-jira/browse/SHOP-140`. Then:
```bash
qa-sentinel trace --story-file ../stories/SHOP-101.md
```
Expect: the test shows as a **known defect** with its link. Without the `QA-BUG` line it says "no bug link".

## 9. Jira only: feature issue types

In `qa-sentinel.config.yaml`: `requirements.jira.featureIssueTypes: [Story]`. Run `spec --story <a Bug key>`:
it refuses (expected behaviour is for features). `generate` on a Bug works as before, without the expected file.

## What to send back

The run folder of step 6 (`.qa-sentinel/runs/<latest>/`) and `expected/SHOP-101.md`, or anything that surprised you.
Don't use client stories for this until the client data policy allows it.
