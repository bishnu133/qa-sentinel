---
name: qa-gap-report
description: Produce a read-only QA impact and gap report for a service change (impacted tests, missing coverage, acceptance-criteria mismatches). Use when asked for a gap report or QA impact on a merge request.
---

# QA gap report

Read-only. Do not create, edit or delete any file.

## Steps
1. Read the run's `context.json`, `change.diff` and `story.md`, plus `qa-sentinel.config.yaml` and `test-map.yaml`.
2. Delegate to the **change-analyzer** sub-agent with those paths. Wait for its JSON.
3. If it returns a `skipReason`, write the short "nothing to test" report below and stop.
4. Delegate to the **test-mapper** sub-agent with the analyzer JSON. Wait for its JSON.
5. Write the report in exactly this format. Keep it under ~40 lines; reviewers skim.

```markdown
### QA impact – <service>

**Verdict:** <one line: e.g. "2 gaps, 1 AC mismatch – tests needed before release">

**Run these tests**
- `path/to/spec.ts` – why it is impacted

**Coverage gaps**
| Change | Status | Missing scenarios |
| --- | --- | --- |
| POST /orders – deliverySlot required | partial | no 400 test without slot; no past-date test |

**Acceptance criteria check**
- ⚠️ AC says "max 3 slots per day"; code allows 5 (`src/slots/rules.ts:10`). Please confirm.

**Spec drift**
- `deliverySlot` added in code but not in `openapi.yaml`.

<details><summary>Changes analysed (n)</summary>

- c1 validation-change POST /orders – summary (evidence)
</details>
```

Omit any section that has nothing in it, except **Verdict**.
If there was no story/AC, say so in one line under the verdict: tests can only be checked against code.

"Nothing to test" report:

```markdown
### QA impact – <service>
**Verdict:** no observable behaviour change (<skipReason>). No tests needed.
```
