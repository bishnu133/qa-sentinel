## QA agent: payments-service@453d6e0e · ✅ VERIFIED · 🔴 Critical risk

**Requirements:** SHOP-102 from [story-file](<work>/stories/SHOP-102.md) @ sha256:ad1d9e7b3ce326c1 · 4 AC parsed · approval unverified

**Verification: ✅ VERIFIED** (run by qa-sentinel, not reported by the agent)

| Check | Result | Detail |
| --- | --- | --- |
| preflight | passed | 127.0.0.1:8080 answered 200 |
| typecheck | passed | tsc --noEmit clean |
| tests | passed | 10 passed, 1 skipped |

Tests: 10 passed · 0 failed · 1 skipped (of 11).

### Plan (validated by qa-sentinel)
1 requirement conflict (AC-2: cumulative refund cap not enforced), 1 outdated schema, 4 gaps on new refund endpoint – resolve AC-2 before release

| Change | Risk | Oracle | Coverage | Decision |
| --- | --- | --- | --- | --- |
| POST /payments/{id}/refund – New refund endpoint adds the amount to refundedAmount and returns 200 with the payment (AC-1) | 🔴 Critical | approved | missing | **create** |
| POST /payments/{id}/refund – Refund cap is checked per request against the authorised amount, not against the cumulative refunded total (AC-2) | 🔴 Critical | conflicting | missing | **review** |
| POST /payments/{id}/refund – Payment status becomes refunded once refundedAmount reaches the authorised amount (AC-3) | 🔴 Critical | approved | missing | **create** |
| POST /payments/{id}/refund – Refunding an unknown payment returns 404 (AC-4) | 🔴 Critical | approved | missing | **create** |
| POST /payments/{id}/refund – Missing, non-numeric, zero or negative refund amount returns 400; not covered by any AC or documented in openapi | 🔴 Critical | ambiguous | missing | **review** |
| GET /payments/{id} – Payment.status enum gains refunded and optional refundedAmount is added (also on POST /payments/authorize response schema) (AC-3) | 🔴 Critical | approved | outdated | **update** |

**Contract changes (computed from `openapi.yaml`, base → head):**

| Impact | Endpoint | Change | Where | Detail |
| --- | --- | --- | --- | --- |
| ⚠️ breaking | POST /payments/authorize | enum-values-added | `response.201.body.status` | +refunded |
| compatible | POST /payments/authorize | field-added | `response.201.body.refundedAmount` | optional |
| compatible | POST /payments/{}/refund | operation-added | `–` | new operation |
| ⚠️ breaking | GET /payments/{} | enum-values-added | `response.200.body.status` | +refunded |
| compatible | GET /payments/{} | field-added | `response.200.body.refundedAmount` | optional |

### ⚠️ Unresolved product discrepancies (1, not executed as passing tests)
These tests encode the requirement, but the product currently behaves differently. They are marked fixme/skip so they do not fail the build. **A human must decide: fix the product or change the requirement.**

| Test | File | Note |
| --- | --- | --- |
| returns 422 when cumulative partial refunds exceed the authorised amount | `tests/api/payments/payments.spec.ts` | AC-2 mismatch – service only compares the single request amount to the authorised amount (src/server.js:26), so 15 + 15 on a 25 payment is accepted. |

### Agent notes
_Written by the agent. Claims about test results here are superseded by the verification table above._

### What I changed
| Decision | Files | What |
| --- | --- | --- |
| c1 create | tests/api/payments/payments.spec.ts | Partial refund returns 200 with `refundedAmount`, status still `authorized` (AC-1) |
| c2 review | same | Single refund over the authorised amount returns 422 (active). The cumulative-refund 422 test is written to AC-2 and marked `test.fixme` with a `// QA-AGENT:` comment. |
| c3 create | same | Full refund sets `refunded`, confirmed by a follow-up GET. Partial refunds of 10 then 15 stay `authorized`, then become `refunded` (AC-3). |
| c4 create | same | Refunding an unknown payment returns 404 (AC-4) |
| c5 review | none | No tests written, as the plan says (see below) |
| c6 update | same | `Payment` schema now allows `status` of `authorized` or `refunded` plus optional `refundedAmount`. I added a GET test for a refunded payment after a full refund. Existing tests are untouched. |
| map | test-map.yaml | Added `POST /payments/{id}/refund` for payments-service |

I added a local `authorize()` setup helper in the spec. Every test authorises its own payment with a unique `orderId`.

### Needs human attention
- **Requirement conflict (AC-2):**
  - Expected: the total refunded can never exceed the authorised amount, otherwise 422.
  - Observed: `src/server.js:26` only compares the single request amount to `p.amount`, so 15 + 15 on a 25 payment is accepted.
  - The `fixme` test stays skipped until the service is fixed or the PO changes AC-2.
- **Ambiguous behaviour (c5):**
  - The code returns 400 for a missing, non-numeric, zero or negative refund amount. This is in neither the ACs nor `openapi.yaml`.
  - I wrote no tests for it. Someone needs to confirm 400 is intended and document it in the OpenAPI file, including `exclusiveMinimum: 0` on the amount.
- **Open question:** should a refund be rejected once the payment is already `refunded`? No test covers this.
- **Assertions changed:** the `Payment` schema's `status` went from `z.literal("authorized")` to `z.enum(["authorized", "refunded"])`. This is a widening the plan asked for. No assertions were removed.
- **Disagreement with the plan:** none.

### Reviewer checklist
- [ ] Expected values match the acceptance criteria
- [ ] No duplicated coverage
- [ ] Test data is isolated and cleaned up

---
Generated by qa-sentinel 0.2.0 (run `2026-10-09T13-45-28-293Z-gen-payments-service`, 30 turns · 116s · $0.34). A QA engineer must review before merge.
