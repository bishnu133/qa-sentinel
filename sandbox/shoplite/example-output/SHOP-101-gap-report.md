### QA impact – orders-service · 🟠 High risk

**Verdict:** 1 requirement conflict (AC-3: cap is 5 in code, 3 in story), existing orders.spec.ts broken by required deliverySlot, 3 gaps – resolve AC-3 before release

**Recommended QA action:** Update orders.spec.ts to send a valid future deliverySlot in all order-creating tests, add missing/invalid/past/response scenarios, write the slot-full test to AC-3 (3 orders) as fixme, and ask the PO whether the cap is 3 or 5. Add deliverySlot to orders-service openapi.yaml.

| Change | Risk | Oracle | Coverage | Decision |
| --- | --- | --- | --- | --- |
| POST /orders – deliverySlot is now required and must be a parseable ISO date-time; missing or invalid returns 400 (breaking for existing clients) (AC-1) | 🟠 High | approved | outdated | **update** |
| POST /orders – deliverySlot in the past (or now) is rejected with 400 (AC-2) | 🟡 Medium | approved | missing | **update** |
| POST /orders – A delivery slot is capped; once full, further orders for the same slot return 409 "delivery slot is full". Code cap is 5, story says 3. (AC-3) | 🟠 High | conflicting | missing | **review** |
| POST /orders – Created order response now includes deliverySlot (echoed as sent) (AC-4) | 🟡 Medium | approved | missing | **update** |

**Run these existing tests**
- `tests/api/orders/orders.spec.ts` – happy path, 402 and GET /orders/{id} setup post orders without deliverySlot and now receive 400 ⚠️ will fail or no longer proves the behaviour

**Missing or outdated scenarios**
- returns 400 when deliverySlot is missing (AC-1) – update
- returns 400 when deliverySlot is not an ISO date-time (AC-1) – update
- happy path sends a valid future deliverySlot and gets 201 (AC-1) – update
- returns 400 when deliverySlot is in the past (AC-2) – update
- returns 409 'delivery slot is full' for the 4th order on the same slot (written to AC-3, fixme until cap is confirmed) (AC-3) – review
- created order echoes deliverySlot (AC-4) – update

**Requirement conflicts – need a human decision**
- ⚠️ AC-3: requirement says "a slot accepts at most 3 orders; the 4th is rejected with 409"; observed: MAX_ORDERS_PER_SLOT = 5; the 4th and 5th orders succeed, the 6th gets 409 (`src/server.js:8` – const MAX_ORDERS_PER_SLOT = 5)

**Contract changes (computed from `openapi.yaml`, base → head):** the spec is unchanged in this diff.

**Spec drift** (code vs spec)
- deliverySlot is required in code (POST /orders request) and returned in the response but absent from orders-service openapi.yaml (spec unchanged in this diff)
- 409 'delivery slot is full' response is not documented in openapi.yaml

**Open questions**
- Is the per-slot cap 3 (AC-3) or 5 (code)?
- Slot matching is by exact string, so equivalent instants in different formats count as different slots; is that intended?
- Story approval is marked unverified.

<details><summary>Evidence (4 changes)</summary>

- **c1** validation-change POST /orders – deliverySlot is now required and must be a parseable ISO date-time; missing or invalid returns 400 (breaking for existing clients)
  - risk high from: validation, breaking-contract
  - source-code: `src/server.js:25` – if (!deliverySlot || Number.isNaN(slot)) return res.status(400).json({ error: "deliverySlot must be an ISO date-time" })
  - requirement: AC-1: deliverySlot is required on POST /orders (ISO 8601 date-time); missing or invalid -> 400
- **c2** validation-change POST /orders – deliverySlot in the past (or now) is rejected with 400
  - risk medium from: validation
  - source-code: `src/server.js:26` – if (slot <= Date.now()) return res.status(400).json({ error: "deliverySlot must be in the future" })
  - requirement: AC-2: a deliverySlot in the past -> 400
- **c3** business-rule POST /orders – A delivery slot is capped; once full, further orders for the same slot return 409 "delivery slot is full". Code cap is 5, story says 3.
  - risk high from: business-rule, conflicting-oracle
  - source-code: `src/server.js:8` – const MAX_ORDERS_PER_SLOT = 5
  - source-code: `src/server.js:27` – >= MAX_ORDERS_PER_SLOT -> 409 "delivery slot is full"
  - requirement: AC-3: a slot accepts at most 3 orders; the 4th order for the same slot -> 409
- **c4** contract-change POST /orders – Created order response now includes deliverySlot (echoed as sent)
  - risk medium from: non-breaking-contract
  - source-code: `src/server.js:36` – const order = { ..., paymentId: payment.body.id, deliverySlot }
  - requirement: AC-4: the created order returns deliverySlot
  - contract-diff: openapi.yaml unchanged in this diff
- decision c1: update – existing POST /orders spec has no deliverySlot, so its happy path, 402 test and GET setup now get 400; no test covers AC-1
  - existing-test: `tests/api/orders/orders.spec.ts:18` – posts { item, qty, unitPrice } without deliverySlot and expects 201
- decision c2: update – same spec covers POST /orders; add past-slot scenario there
  - existing-test: `tests/api/orders/orders.spec.ts:16` – POST /orders describe block has no deliverySlot or past-date test
- decision c3: review – oracle conflict: story says 3, code allows 5; human must decide the intended cap. Test follows the requirement, not code.
  - source-code: `src/server.js:8` – MAX_ORDERS_PER_SLOT = 5 vs AC-3 limit of 3
- decision c4: update – response schema in the spec does not include deliverySlot
  - existing-test: `tests/api/orders/orders.spec.ts:5` – Order zod schema has no deliverySlot field

</details>

**Requirements:** SHOP-101 from [story-file](<work>/stories/SHOP-101.md) @ sha256:b1da54b22f418d46 · 4 AC parsed · approval unverified

<sub>qa-sentinel 0.2.0 gap report · orders-service@f0bbe027 · 11 turns · 40s · $0.16</sub>
