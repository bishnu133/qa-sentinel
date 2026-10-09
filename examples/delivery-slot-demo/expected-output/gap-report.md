### QA impact – orders-service · 🟠 High risk

**Verdict:** 1 requirement conflict (AC-3), 1 existing test broken, 4 coverage gaps. Resolve AC-3 before release.

The story approval is unverified, so the ACs are treated as provisional.

**Recommended QA action:** Run `create-order.spec.ts` now. Its happy-path test will fail because it sends no `deliverySlot`. Update that test, then add the missing scenarios. Ask the story owner whether the slot limit is 3 or 5 before writing the capacity test.

| Change | Risk | Oracle | Coverage | Decision |
| --- | --- | --- | --- | --- |
| POST /orders – `deliverySlot` required, missing or invalid gives 400 | 🟠 high | AC-1 (unverified approval) | missing | update |
| POST /orders – past `deliverySlot` gives 400 | 🟡 medium | AC-2 | missing | create |
| POST /orders – slot capacity 5 (AC-3 says 3), 409 when full | 🟠 high | conflicting | missing | review |
| POST /orders – response echoes `deliverySlot` | 🟡 medium | AC-4 | missing | update |

**Run these existing tests**
- `tests/api/orders/create-order.spec.ts` – "creates an order" (line 8) posts without `deliverySlot` and expects 201. It now gets 400, so it fails and must be updated.
- `tests/api/orders/create-order.spec.ts` – "returns 400 when qty is 0" (line 15) also omits `deliverySlot`. It still returns 400, but only because `qty` is validated first. After the update it should send a valid slot, so it keeps testing `qty`.

**Missing scenarios**
- 400 when `deliverySlot` is missing (AC-1)
- 400 when `deliverySlot` is not an ISO date-time (AC-1)
- 400 when `deliverySlot` is in the past (AC-2)
- 201 with `deliverySlot` echoed in the body. Extend the `Order` schema at `create-order.spec.ts:5` (AC-4)
- 409 "delivery slot is full" on the 4th order for the same slot (AC-3), written to the AC and marked fixme
- Orders in a different slot are not blocked by a full slot (AC-3)

**Requirement conflicts – need a human decision**
- ⚠️ AC-3 says "at most 3 orders; the 4th → 409". The code sets `MAX_ORDERS_PER_SLOT = 5` (`src/server.js:5`), so the 4th and 5th orders return 201. The capacity test will be written to the AC and marked fixme until resolved.

**Spec drift**
- `openapi.yaml` does not list `deliverySlot` in the request schema or its `required` fields.
- `openapi.yaml` has no 409 response for POST /orders.

<details><summary>Evidence (4 changes)</summary>

- c1 validation-change POST /orders – `deliverySlot` is now required and must parse as a date – `src/server.js:13-14`. This breaks every existing client that omits it. `test-map.yaml` maps this endpoint to `create-order.spec.ts`, but no assertion covers the field. Risk: breaking contract change.
- c2 validation-change POST /orders – the slot must be after `Date.now()` – `src/server.js:15`. Risk: time-dependent, so tests need a relative future date.
- c3 behaviour-change POST /orders – 409 when a slot already holds `MAX_ORDERS_PER_SLOT` (5) orders – `src/server.js:5,16-18`. This conflicts with AC-3 (3). Capacity is compared by exact string match on `deliverySlot`, so equivalent timestamps in different formats (`Z` vs `+00:00`) count as different slots. The story does not say whether that is intended. Risk: conflicting oracle, and the counter is in-memory state shared across tests.
- c4 response-change POST /orders – the 201 body now includes `deliverySlot` – `src/server.js:19`. The existing `Order` zod schema does not check it.
- Coverage proof: `create-order.spec.ts` contains only two tests. Neither references `deliverySlot` or 409.
</details>

**Requirements:** SHOP-42 from [story-file](story-SHOP-42.md) @ sha256:591fcc21c1487cb6 · 4 AC parsed · approval unverified

<sub>qa-sentinel 0.1.1 gap report · orders-service@d8492a67 · 9 turns · 20s · $0.08</sub>
