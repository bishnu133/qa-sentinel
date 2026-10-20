# Try it: AC-first generation (phase 1)

A hands-on check of what phase 1 adds, on the ShopLite sandbox. Steps 1–3, 7 and 8 need no AI.
Steps 4–6 run the AI (Claude Code, on whatever account `doctor` shows); each run is capped by `agent.maxBudgetUsd`
(requirements pass: $1).

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

## 7. The lock (no AI)

Steps 7 and 8 happen in the test repo, `~/qa-try/shoplite-local/qa-tests`, on the branch step 6 created.

**7a. Find the agent branch.** Step 6 leaves the test repo on it. Check:
```bash
cd ~/qa-try/shoplite-local/qa-tests
git branch --show-current          # e.g. qa-sentinel/orders-service-1a2b3c4d
git log --oneline main..HEAD       # the commit(s) qa-sentinel made in step 6
```
If you're on `main`, list the branches with `git branch --list "qa-sentinel/*"` and check out the newest one:
`git checkout qa-sentinel/orders-service-…`.

**7b. You (QA) change an expected value: accepted, and listed.**
Open `expected/SHOP-101.md`. In the data block at the top (between the `---` lines), find a behaviour with
`state: ready` and a number under `expect:` (for SHOP-101, `maxOrdersPerSlot: 3`). Change it to `4`. Then:
```bash
git commit -am "QA: cap is 4 (agreed with PO)"
qa-sentinel verify --policy --base main
```
Look only at the table printed first (Level | Rule | File | Detail). Expect no violation and this warning:
- `expectation-override` … `QA override by <your name>: SHOP-101 AC-…/B…: values maxOrdersPerSlot 3 → maxOrdersPerSlot 4. Accepted.`

If you have not refreshed the readable table, you also get a second warning saying the data block changed and the
view below it is out of date. `qa-sentinel spec --story-file ../stories/SHOP-101.md` refreshes it without an AI run
(commit the result); it is not needed for this test.
Below it, verify also runs the changed tests. Without the sandbox environment running they fail; ignore that part
here.

**7c. The same change made by qa-sentinel: rejected.** Pretend to be qa-sentinel: a commit whose message has the line
`Generated by qa-sentinel` counts as an AI commit. Change the same number again (`4` → `6`):
```bash
git commit -am "AI change" -m "Generated by qa-sentinel (pretend)"
qa-sentinel verify --policy --base main
```
Expect: `violation | expectation-changed | expected/SHOP-101.md | qa-sentinel's commit <sha>: SHOP-101 AC-…/B…: values
maxOrdersPerSlot 3 → maxOrdersPerSlot 6. Blocked: …`, and `✗ 1 guardrail violation(s)`. That is the lock: the AI can't move a value the story gave; only a person can.

**7d. Undo both test commits** before step 8:
```bash
git reset --hard HEAD~2
```

## 8. Mark a known defect (no AI)

Still on the agent branch. Find the test qa-sentinel wrote for AC-3 (the 3-vs-5 catch) and marked as a discrepancy:
```bash
grep -rn -B2 "test.fixme(" tests/
```
You should see a `// QA-AGENT: SHOP-101/B…` note above a `test.fixme("…@ac:AC-3…`. (No `test.fixme`? Then the
product didn't disagree in your run; send me the run folder and skip this step.)

**8a. Before triage**, see how it is reported:
```bash
qa-sentinel trace --story-file ../stories/SHOP-101.md
```
In the "Traceability for SHOP-101" table, the AC-3 row says `⚠️ discrepancy` (one passing test, plus the `test.fixme`
tests in the last column). `⏸️ pending-only` appears only when an AC has no passing test at all.

**8b. You confirm it's a product defect.** In that file, change `test.fixme(` to `test.fail(` on that test, and add
this line just above it (under the QA-AGENT note): `// QA-BUG: https://example.atlassian.net/browse/SHOP-140`.
Run `trace` again. Expect the AC-3 row to end with `(known defect: https://example.atlassian.net/browse/SHOP-140)`.

**8c. Without the link:** delete the `// QA-BUG:` line, run `trace` again. Expect `(known defect, no bug link)`.
Then undo your edits: `git checkout -- tests/`.

(`verify --policy` would reject `test.fail` if a qa-sentinel commit added it; yours is a person's change, so it's
allowed.)

## 9. Feature issue types (Jira only: skip it in this sandbox)

This needs stories in Jira, so it can't run on the local story files. On a project with Jira: set
`requirements.jira.featureIssueTypes: [Story]` in `qa-sentinel.config.yaml`, then
`qa-sentinel spec --story <the key of a Bug>`. Expect it to refuse ("expected behaviour is written for features
only"). The same command with a Story key works.

## What to send back

The run folder of step 6 (`.qa-sentinel/runs/<latest>/`) and `expected/SHOP-101.md`, or anything that surprised you.
Don't use client stories for this until the client data policy allows it.
