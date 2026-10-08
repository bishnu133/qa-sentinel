---
name: generate-api-tests
description: Add or update API tests for a service change and verify them, ending with a merge request summary. Use when asked to generate, update or write API tests for a change.
---

# Generate API tests for a change

## Steps
1. Read the run's `context.json`, `change.diff`, `story.md`, plus `qa-sentinel.config.yaml` and `test-map.yaml`.
2. **change-analyzer** sub-agent → change JSON. If `skipReason` is set, stop and report "no tests needed".
3. **test-mapper** sub-agent → coverage JSON. Work only on `partial`, `missing` and `outdated` items.
4. **test-data** sub-agent → precondition plan and any new setup helpers.
5. **api-test-author** sub-agent → test changes and `test-map.yaml` updates.
6. **test-executor** sub-agent → runs only the changed specs, fixes test bugs (max attempts in `context.json`).
7. Review the overall diff yourself (`git diff`): no secrets, no environment URLs, no removed assertions that are not reported, nothing outside the test folders, helpers, fixtures and `test-map.yaml`.

Keep scope tight: one merge request per service change. Do not refactor unrelated tests.

## Final answer: merge request summary (markdown)

```markdown
## QA agent: <service>@<sha>

**Source change:** <one line> · **Story:** <key or "none provided">

### What changed
| File | Change | Why |
| --- | --- | --- |
| tests/api/orders/create-order.spec.ts | +3 tests | deliverySlot required + future-date validation |

### Results
| Spec | Result | Note |
| --- | --- | --- |
| create-order.spec.ts | pass | |
| slots.spec.ts | possible-product-bug | AC max 3/day, API accepted 5 (marked fixme) |

### Needs human attention
- AC mismatch: ...
- Assertions changed: ... (or "none")

### Reviewer checklist
- [ ] Expected values match the acceptance criteria
- [ ] No duplicated coverage
- [ ] Test data is isolated and cleaned up
```
