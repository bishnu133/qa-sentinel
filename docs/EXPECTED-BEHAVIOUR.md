# Expected behaviour and the expectation lock

qa-sentinel's tests check the product against what the story asked for, never against what the code happens to do.
Two things make that hold over time: one file per story that says what each acceptance criterion means in testable
terms, and a lock that stops an AI run from moving those values toward the code.

## The file: `expected/<STORY>.md`

One file per story, in the test repository (folder: `tests.expectedDir`, default `expected`). It has two parts:

1. **The data block** at the top, between `---` lines (YAML). Tests assert what is in it. **This is the part you edit.**
2. **A readable view** below it, generated from the data. Edits to the view do nothing and are flagged.

```yaml
---
version: 1
story: SHOP-101
acs:
  - id: AC-1
    hash: 3f2a9c1e5b7d            # written by qa-sentinel: don't edit
    text: A slot takes at most 3 orders.   # copy of the story: change the story in Jira
    services: [orders-service]
    behaviours:
      - id: B1
        kind: boundary            # main | edge | boundary | negative
        statement: A fourth order for a full slot is rejected
        expect: { maxOrdersPerSlot: 3, status: 409 }
        state: ready
        source: ac
---
```

| State | Meaning |
| --- | --- |
| `ready` | Tests assert it. |
| `needs-review` | The AC changed (or was removed) after this was written. Check it, then set `ready`. |
| `unspecified` | The story doesn't say (\"orders are capped\" without a number). No value is invented; `question` asks the PO. Not tested until answered. |

**Approval.** Merging the test merge request approves every `ready` row in it. `unspecified` and `needs-review` rows
are not tested until someone resolves them in a later merge request.

**A clarification agreed outside Jira** (a call, a chat): fill in `expect`, set `state: ready`, delete `question`, and add
`source: { clarification: { by: <name>, date: <yyyy-mm-dd>, link: <chat or mail> } }`. It wins until the AC itself
changes in Jira; the Jira report asks the PO to update the story so the two agree.

**Behaviour ids** (B1, B2, …) are stable within the story and never reused, so tests and reports can point at
`SHOP-101/B3` while ACs are renumbered or reworded.

**When the story changes,** qa-sentinel compares each AC's text with the `hash` stored for it. Formatting, numbering,
case, spacing and closing punctuation don't count; words and numbers do. Only an AC whose text really changed is
re-proposed (as a reviewed change in the next test merge request); the others stay exactly as they are, including
your edits. An AC that is no longer in the story is never deleted or retired by qa-sentinel (it may be a parsing
gap): its expectations stay, still tested, and the run lists it so a QA engineer can set `removed: true` on it.

## The lock

For an AC whose stored text is still in the story, an AI run may not:

- change, move or remove its behaviours in `expected/<STORY>.md`, or add cases to it (unless the entry is still empty);
- change a value or an assertion in a test tagged with that AC (`@ac:AC-1`, on the test or its `describe`), or a
  top-level constant such a test uses, or a row of its `test.each` table;
- add an early `return`, a condition, a `try` or a skip around its checks; switch it to skip/fixme/fail; re-tag it
  to another AC; or delete it.

Such a run is rejected and nothing is committed. When the product does something other than the expectation, that
is a defect to report (the test is written to the requirement), never a test to change.

The lock opens for one AC only when its stored text is gone from the story. qa-sentinel checks that against Jira, the
story file, or the AC hashes it recorded in its own commit (`QA-Sentinel-ACs:` line), whichever applies.

**Stories without a stored file** (tests written before this existed) get warnings, not rejections: nothing reviewed
says what they should assert yet. Once the story has an expected file, its tests are locked.

**People are not locked.** A QA engineer correcting a value in the merge request is the review this design relies
on. `verify --policy` on an agent merge request checks the branch's net change: a change made by one of qa-sentinel's
commits is rejected; a change made by a person is accepted and listed as a *QA override*, so reviewers see it.
Make expectation changes in your own commit; don't amend or reword qa-sentinel's commits. An expected file that
can't be read is an error whoever wrote it.

## Limits (know what the lock can't see)

The lock reads code; it doesn't run it. It is a strong net, not a proof, and three things stay with people:

- **Shared helpers in other files** (support modules, page objects): a changed value or assertion there is a
  *warning*, because qa-sentinel can't tell which requirement tests use it. Reviewers look at those warnings.
- **An AC missing from the story's current list stays locked** (it may be a parsing gap rather than a removal). To
  retire its expectations, a person removes or edits them.
- **The `QA-Sentinel-ACs:` line** in qa-sentinel's commits is trusted for stories that don't come from Jira. Anyone
  who can push to the branch can write it; with Jira as the source, `verify --policy` asks Jira instead.

The independent test review (a second AI that checks each new test against the ACs) and QA's review of the merge
request remain the other two layers.
