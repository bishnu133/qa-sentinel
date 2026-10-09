### QA impact – orders-service · 🟢 Low risk

**Verdict:** 1 internal refactor, no behaviour change, no gaps – nothing to do for release

**Recommended QA action:** No test changes needed. Optionally add a rounding scenario (e.g. qty 3 × unitPrice 0.335) to orders.spec.ts later, since the existing total assertion uses an exact value (25) that does not exercise cent rounding.

| Change | Risk | Oracle | Coverage | Decision |
| --- | --- | --- | --- | --- |
| POST /orders – Order total calculation extracted into orderTotal(qty, unitPrice) helper; formula Math.round(qty * unitPrice * 100) / 100 is identical (AC-1) | 🟢 Low | approved | covered | **skip** |

**Run these existing tests**
- `tests/api/orders/orders.spec.ts` – POST /orders happy path asserts total; behaviour unchanged so it remains valid

**Contract changes (computed from `openapi.yaml`, base → head):** the spec is unchanged in this diff.

<details><summary>Evidence (1 change)</summary>

- **c1** internal POST /orders – Order total calculation extracted into orderTotal(qty, unitPrice) helper; formula Math.round(qty * unitPrice * 100) / 100 is identical
  - risk low from: internal
  - source-code: `src/server.js:11` – function orderTotal(qty, unitPrice) { return Math.round(qty * unitPrice * 100) / 100; }
  - source-code: `src/server.js:27` – const total = orderTotal(qty, unitPrice);
  - requirement: AC-1: Order totals are unchanged (qty × unitPrice, rounded to cents)
  - contract-diff: the spec is unchanged in this diff
- decision c1: skip – Pure extract-function refactor with identical formula and no contract change (SHOP-104, AC-1: no behaviour change); not observable through the API, and POST /orders total is already asserted in orders.spec.ts
  - source-code: `src/server.js:26` – removed line: const total = Math.round(qty * unitPrice * 100) / 100; – same expression moved into orderTotal
  - contract-diff: the spec is unchanged in this diff
  - existing-test: `tests/api/orders/orders.spec.ts:21` – expect(order.total).toBe(25);

</details>

**Requirements:** SHOP-104 from [story-file](<work>/stories/SHOP-104.md) @ sha256:e2e44d42fab508bd · 1 AC parsed · approval unverified

<sub>qa-sentinel 0.2.0 gap report · orders-service@9fe8d950 · 13 turns · 27s · $0.10</sub>
