### QA impact – payments-service · 🔴 Critical risk

**Verdict:** 1 requirement conflict (AC-2: cumulative refund cap not enforced), 5 gaps on the new refund endpoint, 1 undocumented 400 – resolve AC-2 before release

**Recommended QA action:** Fix the refund cap to use cumulative refundedAmount (AC-2), then add refund scenarios to payments.spec.ts, widen the Payment schema to allow 'refunded', and document the 400 response in openapi.yaml.

| Change | Risk | Oracle | Coverage | Decision |
| --- | --- | --- | --- | --- |
| POST /payments/{id}/refund – New refund endpoint: a valid amount is added to refundedAmount and the payment is returned with 200 (AC-1) | 🔴 Critical | approved | missing | **create** |
| POST /payments/{id}/refund – Refund cap only compares the single request amount with the authorised amount; the cumulative total is not checked, so several partial refunds can exceed the authorised amount (AC-2) | 🔴 Critical | conflicting | missing | **review** |
| POST /payments/{id}/refund – Payment status becomes 'refunded' once refundedAmount reaches the authorised amount; stays 'authorized' for partial refunds (AC-3) | 🔴 Critical | approved | missing | **create** |
| POST /payments/{id}/refund – Refunding an unknown payment returns 404 (AC-4) | 🔴 Critical | approved | missing | **create** |
| GET /payments/{id} – Payment.status enum gains 'refunded' and optional refundedAmount is added; also affects POST /payments/authorize response schema (AC-1, AC-3) | 🔴 Critical | approved | outdated | **update** |
| POST /payments/{id}/refund – Non-numeric, zero or negative refund amount returns 400; this response is not in openapi.yaml and no acceptance criterion covers it | 🔴 Critical | missing | missing | **review** |

**Run these existing tests**
- `tests/api/payments/payments.spec.ts` – Payment zod schema uses z.literal("authorized") and will reject refunded payments; existing authorize and 404 tests remain valid

**Missing or outdated scenarios**
- refunds part of an authorised payment and returns refundedAmount (AC-1) – create
- accepts several partial refunds within the authorised amount (AC-1, AC-2) – create
- returns 422 when cumulative partial refunds exceed the authorised amount (fixme until code is fixed) (AC-2) – review
- returns 422 when a single refund exceeds the authorised amount (AC-2) – review
- sets status to refunded when the full amount is refunded (AC-3) – create
- sets status to refunded when partial refunds add up to the full amount (AC-3) – create
- returns 404 when refunding an unknown payment (AC-4) – create
- GET /payments/{id} reflects status refunded and refundedAmount after a full refund (AC-1, AC-3) – update
- returns 400 for a zero, negative or non-numeric refund amount – review

**Requirement conflicts – need a human decision**
- ⚠️ AC-2: requirement says "Several partial refunds are allowed, but the total refunded can never exceed the authorised amount -> 422"; observed: Only the single request amount is compared with the authorised amount, so refunds of 60 and 60 on a 100 payment both return 200 and refundedAmount becomes 120 (`src/server.js:26` – if (amount > p.amount) return res.status(422); `src/server.js:27` – p.refundedAmount = (p.refundedAmount || 0) + amount;)

**Contract changes (computed from `openapi.yaml`, base → head):**

| Impact | Endpoint | Change | Where | Detail |
| --- | --- | --- | --- | --- |
| ⚠️ breaking | POST /payments/authorize | enum-values-added | `response.201.body.status` | +refunded |
| compatible | POST /payments/authorize | field-added | `response.201.body.refundedAmount` | optional |
| compatible | POST /payments/{}/refund | operation-added | `–` | new operation |
| ⚠️ breaking | GET /payments/{} | enum-values-added | `response.200.body.status` | +refunded |
| compatible | GET /payments/{} | field-added | `response.200.body.refundedAmount` | optional |

**Spec drift** (code vs spec)
- 400 for an invalid refund amount is returned by code but absent from openapi.yaml
- The refund request body amount has no exclusiveMinimum in openapi.yaml, unlike authorize

**Open questions**
- Story approval is unverified: confirm AC-1..AC-4 are approved.
- Should a refund on an already fully refunded payment return 422 (per AC-2)?

<details><summary>Evidence (6 changes)</summary>

- **c1** new-endpoint POST /payments/{id}/refund – New refund endpoint: a valid amount is added to refundedAmount and the payment is returned with 200
  - risk critical from: money, new-endpoint, write-path-error-handling
  - source-code: `src/server.js:27` – p.refundedAmount = (p.refundedAmount || 0) + amount;
  - contract-diff: compatible POST /payments/{}/refund operation-added
  - requirement: AC-1: refunds that amount and returns 200 with refundedAmount
- **c2** business-rule POST /payments/{id}/refund – Refund cap only compares the single request amount with the authorised amount; the cumulative total is not checked, so several partial refunds can exceed the authorised amount
  - risk critical from: money, business-rule, conflicting-oracle, write-path-error-handling
  - source-code: `src/server.js:26` – if (amount > p.amount) return res.status(422)... (ignores existing refundedAmount)
  - source-code: `src/server.js:27` – p.refundedAmount = (p.refundedAmount || 0) + amount;
  - requirement: AC-2: total refunded can never exceed the authorised amount -> 422
- **c3** business-rule POST /payments/{id}/refund – Payment status becomes 'refunded' once refundedAmount reaches the authorised amount; stays 'authorized' for partial refunds
  - risk critical from: money, business-rule
  - source-code: `src/server.js:28` – if (p.refundedAmount >= p.amount) p.status = "refunded";
  - requirement: AC-3: when the full amount has been refunded the status becomes "refunded"
- **c4** error-handling POST /payments/{id}/refund – Refunding an unknown payment returns 404
  - risk critical from: money, write-path-error-handling
  - source-code: `src/server.js:23` – if (!p) return res.status(404).json({ error: "payment not found" });
  - openapi: `openapi.yaml` – POST /payments/{id}/refund responses 404: not found
  - requirement: AC-4: refunding an unknown payment -> 404
- **c5** contract-change GET /payments/{id} – Payment.status enum gains 'refunded' and optional refundedAmount is added; also affects POST /payments/authorize response schema
  - risk critical from: money, breaking-contract, cross-service
  - contract-diff: breaking GET /payments/{} enum-values-added response.200.body.status +refunded
  - contract-diff: breaking POST /payments/authorize enum-values-added response.201.body.status +refunded
  - existing-test: `tests/api/payments/payments.spec.ts:5` – Payment schema uses status: z.literal("authorized")
- **c6** validation-change POST /payments/{id}/refund – Non-numeric, zero or negative refund amount returns 400; this response is not in openapi.yaml and no acceptance criterion covers it
  - risk critical from: money, validation
  - source-code: `src/server.js:25` – if (typeof amount !== "number" || !(amount > 0)) return res.status(400)
  - openapi: `openapi.yaml` – refund responses list only 200, 404, 422
- decision c1: create – new endpoint with no coverage; test-map.yaml has no entry for it
  - existing-test: `tests/api/payments/payments.spec.ts` – no test references /payments/{id}/refund
- decision c2: review – code contradicts AC-2 for cumulative refunds; test is written to the requirement as fixme and a human must confirm/fix
  - source-code: `src/server.js:26` – cap check ignores p.refundedAmount
  - requirement: AC-2: total refunded can never exceed the authorised amount
- decision c3: create – status transition is untested
  - existing-test: `tests/api/payments/payments.spec.ts` – no assertion on status 'refunded'
- decision c4: create – refund 404 is not covered
  - existing-test: `tests/api/payments/payments.spec.ts:27` – 404 test exists only for GET /payments/{id}
- decision c5: update – shared Payment schema in the spec is narrower than the new contract; GET happy path is not tested
  - existing-test: `tests/api/payments/payments.spec.ts:5` – Payment schema only allows status literal "authorized"; must accept refunded and optional refundedAmount
- decision c6: review – behaviour has no requirement or contract; a human should confirm the intended status code before a test encodes it
  - source-code: `src/server.js:25` – 400 branch not documented in openapi.yaml and no AC

</details>

**Requirements:** SHOP-102 from [story-file](<work>/stories/SHOP-102.md) @ sha256:ad1d9e7b3ce326c1 · 4 AC parsed · approval unverified

<sub>qa-sentinel 0.2.0 gap report · payments-service@453d6e0e · 12 turns · 47s · $0.15</sub>
