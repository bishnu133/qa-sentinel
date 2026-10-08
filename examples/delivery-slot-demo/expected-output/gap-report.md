### QA impact – orders-service

**Verdict:** 5 changes, 0 covered, 1 AC mismatch (high), 1 existing test broken. Fix the code or confirm the AC, then add tests before release.

**Run these tests**
- `tests/api/orders/create-order.spec.ts`
  - `creates an order` sends no `deliverySlot`, so it now gets 400 instead of 201 and fails.
  - `returns 400 when qty is 0` still passes, but only because the slot is missing. It no longer tests the qty rule.
  - The local `Order` zod schema strips unknown keys, so it can't catch a missing or wrong `deliverySlot` in the 201 response.

**Coverage gaps**
| Change | Status | Missing scenarios |
| --- | --- | --- |
| POST /orders – `deliverySlot` required (c1) | missing | no 400 for missing, unparseable, null or empty slot |
| POST /orders – past slot rejected (c2) | missing | no 400 for a past slot or a slot equal to now; no 201 for a slot just in the future |
| POST /orders – slot cap → 409 (c3, c4) | missing | no 409 test with body `delivery slot is full`; no 201 for the order just under the cap; no check that another slot still accepts orders |
| POST /orders – 201 echoes `deliverySlot` (c5) | missing | no echo assertion; `Order` zod schema lacks `deliverySlot` |

Test data: `src/data/builders.ts` has no order or slot builder. Capacity tests need a unique future slot per test.

**Acceptance criteria check**
- ⚠️ **High.** AC3 says a slot accepts at most 3 orders and the 4th gets 409. The code sets `MAX_ORDERS_PER_SLOT = 5` (`src/server.js`), so orders 4 and 5 return 201 and the 409 starts at order 6. Please confirm which is right. The tests should follow the AC.
- ⚠️ **Medium.** AC1 says the slot must be ISO 8601. The code uses `Date.parse`, which also accepts non-ISO strings such as `March 7, 2030 10:00`, so these return 201 instead of 400.
- ℹ️ The cap compares `deliverySlot` strings exactly. `...Z` and `...+00:00` for the same instant count as different slots. The AC doesn't say either way.

**Spec drift** (`openapi.yaml`)
- `deliverySlot` is missing from the POST /orders request schema and from `required`.
- The 409 response is not documented.
- The 201 response has no schema, so the echoed `deliverySlot` is undocumented.
- The 400 response doesn't describe the new slot cases.

<details><summary>Changes analysed (5)</summary>

- c1 validation-change POST /orders – `deliverySlot` required; missing, empty or unparseable gives 400 (`src/server.js`, `Date.parse` check)
- c2 validation-change POST /orders – slot at or before now gives 400 "must be in the future"
- c3 business-rule POST /orders – cap of 5 orders per slot (AC says 3); in-memory, exact string match
- c4 error-handling POST /orders – new 409 `{error: "delivery slot is full"}`
- c5 contract-change POST /orders – request accepts `deliverySlot`; 201 echoes it unchanged
</details>

<sub>qa-sentinel gap report · 11 turns · 67s · $0.27</sub>
