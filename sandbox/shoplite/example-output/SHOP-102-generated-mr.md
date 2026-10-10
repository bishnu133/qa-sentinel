## QA agent: payments-service@06cc0c5b · ✅ VERIFIED · 🔴 Critical risk

**Requirements:** SHOP-102 from [story-file](<work>/stories/SHOP-102.md) @ sha256:ad1d9e7b3ce326c1 · 4 AC parsed · approval unverified

**Verification: ✅ VERIFIED** (run by qa-sentinel, not reported by the agent)

| Check | Result | Detail |
| --- | --- | --- |
| preflight | passed | 127.0.0.1:8080 answered 200 |
| typecheck | passed | tsc --noEmit clean |
| tests | passed | 10 passed, 2 skipped |

Tests: 10 passed · 0 failed · 2 skipped (of 12).

### Plan (validated by qa-sentinel)
1 requirement conflict (AC-2: cumulative refund cap not enforced), 1 undocumented validation, 4 gaps for the new refund endpoint – resolve AC-2 before release

| Change | Risk | Oracle | Coverage | Decision |
| --- | --- | --- | --- | --- |
| POST /payments/{id}/refund – New endpoint refunds a given amount of an authorised payment and returns 200 with the payment including refundedAmount (AC-1) | 🔴 Critical | approved | missing | **create** |
| POST /payments/{id}/refund – Refund cap: code only rejects a single refund larger than the authorised amount; the cumulative total across partial refunds is not checked, and a fully refunded payment still accepts refunds (AC-2) | 🔴 Critical | conflicting | missing | **review** |
| POST /payments/{id}/refund – Payment status becomes "refunded" once the refunded total reaches the authorised amount (AC-3) | 🔴 Critical | approved | missing | **create** |
| POST /payments/{id}/refund – Refunding an unknown payment returns 404 (AC-4) | 🔴 Critical | approved | missing | **create** |
| POST /payments/{id}/refund – Non-numeric or non-positive refund amount returns 400; not in any AC and not declared in openapi.yaml | 🔴 Critical | missing | missing | **review** |
| GET /payments/{id} – Response status enum gains "refunded" and an optional refundedAmount field, so a refunded payment must be readable via GET (AC-3) | 🔴 Critical | approved | partial | **update** |
| POST /payments/authorize – Shared Payment schema widened (status +refunded, refundedAmount); authorize itself still always returns "authorized" | 🟢 Low | approved | covered | **skip** |

**Contract changes (computed from `openapi.yaml`, base → head):**

| Impact | Endpoint | Change | Where | Detail |
| --- | --- | --- | --- | --- |
| ⚠️ breaking | POST /payments/authorize | enum-values-added | `response.201.body.status` | +refunded |
| compatible | POST /payments/authorize | field-added | `response.201.body.refundedAmount` | optional |
| compatible | POST /payments/{}/refund | operation-added | `–` | new operation |
| ⚠️ breaking | GET /payments/{} | enum-values-added | `response.200.body.status` | +refunded |
| compatible | GET /payments/{} | field-added | `response.200.body.refundedAmount` | optional |

### ⚠️ Unresolved product discrepancies (2, not executed as passing tests)
These tests encode the requirement, but the product currently behaves differently. They are marked fixme/skip so they do not fail the build. **A human must decide: fix the product or change the requirement.**

| Test | File | Note |
| --- | --- | --- |
| rejects a second partial refund that would push the total above the authorised amount | `tests/api/payments/refunds.spec.ts` | AC-2 / kb payments rule: total refunds may never exceed the authorised amount. Expected 422 on the second refund (20 + 10 > 25); observed: service only compares each request to p.amount (src/server.js:26) and accepts it. |
| rejects further refunds on a fully refunded payment | `tests/api/payments/refunds.spec.ts` | kb payments rule (AC-2): a fully refunded payment accepts no further refunds (422). Observed: service returns 200 and accumulates refundedAmount past the authorised amount. |

### Requirement traceability (SHOP-102)
_Built from test tags (`@story`, `@ac`), not from the agent's claims._

| AC | Status | Passing tests | Pending (fixme/skip) |
| --- | --- | --- | --- |
| AC-1 | ✅ covered | `tests/api/payments/refunds.spec.ts:32` partial refund returns the refunded amount and keeps the payment authorized | – |
| AC-2 | ⚠️ discrepancy | `tests/api/payments/refunds.spec.ts:61` rejects a single refund larger than the authorised amount and leaves the payment unchanged | `tests/api/payments/refunds.spec.ts:70` rejects a second partial refund that would push the total above the authorised amount<br>`tests/api/payments/refunds.spec.ts:82` rejects further refunds on a fully refunded payment |
| AC-3 | ✅ covered | `tests/api/payments/payments.spec.ts:33` returns refunded status and refundedAmount after a full refund<br>`tests/api/payments/refunds.spec.ts:42` refunding the full amount in two partial refunds sets status to refunded | – |
| AC-4 | ✅ covered | `tests/api/payments/refunds.spec.ts:55` returns 404 when refunding an unknown payment | – |

1 test(s) are tagged with the story but no AC: `tests/api/payments/refunds.spec.ts:94`.

### Independent test review
_A separate read-only agent checked each changed test against the acceptance criteria. Advisory: it doesn't change the verification result._

🟢 7 strong · 🟡 4 adequate · 🔴 1 wrong-oracle — The refund tests cover AC-1 to AC-4 with exact values and read-back of state after rejections, but the 400-on-zero-amount test encodes code-only behaviour as an active test and the pre-existing authorize/GET tests are thin.

| Test | Verdict | Issues | Suggestion |
| --- | --- | --- | --- |
| `tests/api/payments/refunds.spec.ts:94` returns 400 when refund amount is 0 and leaves the payment unchanged | 🔴 wrong-oracle | Asserts 400 for a zero refund amount, which comes only from the code (src/server.js:25); no AC, domain rule or openapi.yaml entry supports it.; It is an active test, not fixme or a flagged discrepancy, so it silently encodes code behaviour as the expected result. | Confirm the expected status with the PO and add it to the AC or contract, or mark the test fixme until then. |

**Scenarios the reviewer thinks are still missing**
- AC-1: after a partial refund, GET /payments/{id} returns the same refundedAmount (the refund is persisted)
- AC-2: a refund that brings the total exactly to the authorised amount is accepted (200), while one cent more is rejected (422)
- AC-4: refunding an unknown payment creates no payment (GET still returns 404)

### Agent notes
_Written by the agent. Claims about test results here are superseded by the verification table above._

### What I changed
| Decision | Files | What |
| --- | --- | --- |
| c1 create | tests/api/payments/refunds.spec.ts | Partial refund returns 200 with `refundedAmount` 10 exactly, status stays `authorized`, `pay_` id prefix (AC-1) |
| c3 create | same | Two partial refunds (10, then 15) set status to `refunded`, `refundedAmount` 25 (AC-3) |
| c4 create | same | Refund on an unknown payment returns 404 with "payment not found" (AC-4) |
| c2 review | same | A single refund of 25.01 returns 422 and a read-back shows the payment unchanged (AC-2). This one is a live test. |
| c2 review | same | Two scenarios written to AC-2 as `test.fixme` with `// QA-AGENT:` comments: the cumulative cap (20 then 10) and further refunds on a fully refunded payment. Both expect 422 plus an unchanged read-back. |
| c5 review | same | A refund amount of 0 returns 400 and a read-back shows the payment unchanged. Live test, no `@ac` tag. |
| c6 update | tests/api/payments/payments.spec.ts | +1 GET scenario: after a full refund of 25, GET returns `refunded` and `refundedAmount` 25 (AC-3). Added a `PaymentWithRefund` schema, because the existing `Payment` literal `"authorized"` can't be reused. |
| map | test-map.yaml | Added `POST /payments/{id}/refund` → `refunds.spec.ts` |

I left c7 (skip) alone. The new tests carry `@service`, `@endpoint` and `@story:SHOP-102` tags, and `@ac` where the plan lists requirement ids.

I ran `npx tsc --noEmit` and the two payments specs once. Type-check was clean. 10 tests passed and the 2 `fixme` tests were skipped. qa-sentinel's own re-run is the one that counts.

### Needs human attention
- **Requirement conflict, AC-2:** the total refunded can never exceed the authorised amount (422), and a fully refunded payment takes no further refunds.
  - **Expected:** a second refund of 10 after 20 on a 25 payment returns 422, and a refund of 1 on a fully refunded payment returns 422.
  - **Observed:** `src/server.js:26` only compares each request's amount to `p.amount`. `refundedAmount` keeps accumulating, and refunds on a `refunded` payment return 200.
  - The two `fixme` tests unskip once the service is fixed.
- **Unconfirmed 400 (c5):** the 400 for a zero or non-numeric amount exists only in code (`src/server.js:25`). There is no AC for it and openapi.yaml doesn't declare it. I wrote the test to current behaviour and it passes, so please confirm with the PO whether it's intended. If it is, document it in openapi.yaml; if not, remove the test.
- **Spec drift:** the refund `amount` in openapi.yaml has no `exclusiveMinimum`, unlike authorize.
- **Disagreement with a plan decision:** none. I did not use the sub-agents because the change was small enough to do directly.
- **Assertions changed:** none. The existing tests are untouched; I only added to `payments.spec.ts`.

### Reviewer checklist
- [ ] Expected values match the acceptance criteria
- [ ] No duplicated coverage
- [ ] Test data is isolated and cleaned up (each test authorizes its own payment with a unique order id; the service is in-memory, so there is nothing to clean up)

---
Generated by qa-sentinel 0.2.0 (run `2026-10-10T13-22-42-887Z-gen-payments-service`, 42 turns · 120s · $0.45). A QA engineer must review before merge.