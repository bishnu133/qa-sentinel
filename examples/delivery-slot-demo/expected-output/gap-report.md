### QA impact – orders-service · 🟠 High risk

**Verdict:** 1 requirement conflict (AC-3: cap is 5 in code, 3 in story), 1 broken test, 4 missing scenario groups, openapi.yaml not updated

**Recommended QA action:** Update create-order.spec.ts happy path to send a future deliverySlot, add scenarios for missing/invalid/past/echo, write the AC-3 slot-full test to the requirement (cap 3, fixme) and have the PO/dev confirm the cap; add deliverySlot to openapi.yaml.

| Change | Risk | Oracle | Coverage | Decision |
| --- | --- | --- | --- | --- |
| POST /orders – deliverySlot is now required and must be a parseable ISO date-time; missing or invalid returns 400 (AC-1) | 🟠 High | approved | outdated | **update** |
| POST /orders – deliverySlot in the past (or now) is rejected with 400 (AC-2) | 🟡 Medium | approved | missing | **update** |
| POST /orders – Per-slot capacity limit returns 409 "delivery slot is full", but code allows 5 orders per slot while the story says 3 (AC-3) | 🟠 High | conflicting | missing | **review** |
| POST /orders – Created order response now includes deliverySlot (echoed from the request) (AC-4) | 🟡 Medium | approved | missing | **update** |

**Run these existing tests**
- `tests/api/orders/create-order.spec.ts` – happy path sends no deliverySlot and would now receive 400; the qty=0 test still returns 400 because qty is validated first ⚠️ will fail or no longer proves the behaviour

**Missing or outdated scenarios**
- returns 400 when deliverySlot is missing (AC-1) – update
- returns 400 when deliverySlot is not an ISO date-time (AC-1) – update
- creates an order when a valid future deliverySlot is sent (fix happy path) (AC-1) – update
- returns 400 when deliverySlot is in the past (AC-2) – update
- returns 409 "delivery slot is full" for the 4th order in the same slot (written to AC-3, fixme until cap is confirmed) (AC-3) – review
- created order echoes deliverySlot (AC-4) – update

**Requirement conflicts – need a human decision**
- ⚠️ AC-3: requirement says "a slot accepts at most 3 orders; the 4th order -> 409"; observed: MAX_ORDERS_PER_SLOT = 5, so the 4th and 5th orders are accepted (`src/server.js:5` – const MAX_ORDERS_PER_SLOT = 5;)

**Contract changes (computed from `openapi.yaml`, base → head):** the spec is unchanged in this diff.

**Spec drift** (code vs spec)
- deliverySlot is required on POST /orders in code but absent from openapi.yaml (request and response)
- 409 "delivery slot is full" response on POST /orders is not documented in openapi.yaml

**Open questions**
- Is the per-slot cap 3 (AC-3) or 5 (code)?
- Story approval is unverified; confirm SHOP-42 acceptance criteria are approved.
- Slot capacity compares the raw deliverySlot string, so equivalent instants in different formats count as different slots; is that intended?

<details><summary>Evidence (4 changes)</summary>

- **c1** validation-change POST /orders – deliverySlot is now required and must be a parseable ISO date-time; missing or invalid returns 400
  - risk high from: validation, breaking-contract
  - source-code: `src/server.js:13` – const slot = Date.parse(deliverySlot);
  - source-code: `src/server.js:14` – if (!deliverySlot || Number.isNaN(slot)) return res.status(400)
  - requirement: AC-1: deliverySlot is required on POST /orders (ISO 8601 date-time); missing or invalid -> 400
- **c2** validation-change POST /orders – deliverySlot in the past (or now) is rejected with 400
  - risk medium from: validation
  - source-code: `src/server.js:15` – if (slot <= Date.now()) return res.status(400).json({ error: "deliverySlot must be in the future" })
  - requirement: AC-2: deliverySlot in the past -> 400
- **c3** business-rule POST /orders – Per-slot capacity limit returns 409 "delivery slot is full", but code allows 5 orders per slot while the story says 3
  - risk high from: business-rule, conflicting-oracle, write-path-error-handling
  - source-code: `src/server.js:5` – const MAX_ORDERS_PER_SLOT = 5;
  - source-code: `src/server.js:16` – if (orders.filter((o) => o.deliverySlot === deliverySlot).length >= MAX_ORDERS_PER_SLOT) return 409
  - requirement: AC-3: a slot accepts at most 3 orders; the 4th order for the same slot -> 409 "delivery slot is full"
- **c4** contract-change POST /orders – Created order response now includes deliverySlot (echoed from the request)
  - risk medium from: non-breaking-contract
  - source-code: `src/server.js:19` – const order = { id: String(orders.length + 1), item, qty, deliverySlot };
  - requirement: AC-4: the created order echoes deliverySlot
  - contract-diff: spec is unchanged in this diff, so deliverySlot is not documented
- decision c1: update – existing happy path sends no deliverySlot and now gets 400; no tests cover missing/invalid slot
  - existing-test: `tests/api/orders/create-order.spec.ts:9` – posts { item, qty } without deliverySlot and expects 201
- decision c2: update – POST /orders spec exists but has no past-slot scenario
  - existing-test: `tests/api/orders/create-order.spec.ts:15` – only qty=0 validation is tested; no deliverySlot assertions
- decision c3: review – code cap (5) conflicts with AC-3 (3); human must confirm the intended limit before encoding it
  - source-code: `src/server.js:5` – const MAX_ORDERS_PER_SLOT = 5;
  - requirement: AC-3: at most 3 orders per slot
- decision c4: update – response schema in the existing spec does not include deliverySlot
  - existing-test: `tests/api/orders/create-order.spec.ts:5` – Order schema has only id, item, qty

</details>

**Requirements:** SHOP-42 from [story-file](story-SHOP-42.md) @ sha256:591fcc21c1487cb6 · 4 AC parsed · approval unverified

<sub>qa-sentinel 0.2.0 gap report · orders-service@e2a3d9b4 · 12 turns · 47s · $0.13</sub>
