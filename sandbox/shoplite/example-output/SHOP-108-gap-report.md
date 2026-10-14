### QA impact – storefront · 🔴 Critical risk

**Verdict:** 1 new UI change (price preview on /orders/new) matches AC-1..AC-3 but has no test coverage – 3 gaps

**Recommended QA action:** Extend tests/web/orders/new-order.spec.ts with unit price, total/update and currency-code scenarios. Ask the PO what the total should show when quantity is empty or 0.

| Change | Risk | Oracle | Coverage | Decision |
| --- | --- | --- | --- | --- |
| page /orders/new – New order form shows a live unit price ("<CUR> 12.50 each") and total ("Total: <CUR> 25.00") for the chosen item, quantity and currency, updating on input (AC-1, AC-2, AC-3) | 🔴 Critical | approved | missing | **update** |

**Run these existing tests**
- `tests/web/orders/new-order.spec.ts` – form flow still works; the added preview paragraphs do not change existing locators or assertions

**Regression selection** (computed by qa-sentinel): 2 existing test(s) in 1 file(s)

<details><summary>Selected tests and why</summary>

| Test | Why |
| --- | --- |
| `tests/web/orders/new-order.spec.ts:6` places an order and lands on its order page | named by the plan, changed page: form flow still works; the added preview paragraphs do not change existing locators or …; c1: update; /orders/new |
| `tests/web/orders/new-order.spec.ts:17` shows the payment error for an unsupported currency | named by the plan, changed page: form flow still works; the added preview paragraphs do not change existing locators or …; c1: update; /orders/new |

```
npx playwright test --project=web tests/web/orders/new-order.spec.ts:6 tests/web/orders/new-order.spec.ts:17
```

</details>

**Missing or outdated scenarios**
- 🖥️ shows the unit price of the chosen item (AC-1) – update
  - flow: **web** `/orders/new`
- 🖥️ shows the total for the chosen quantity and updates it on change (AC-2) – update
  - flow: **web** `/orders/new`
- 🖥️ shows price and total in the chosen currency code (AC-3) – update
  - flow: **web** `/orders/new`

**Contract changes (computed from `OpenAPI spec`, base → head):** no OpenAPI spec configured for this service.

**Open questions**
- What should the total show when quantity is empty or 0? Code shows "Total: <CUR> 0.00" (qty falls back to 0); no AC covers it.
- Story approval is marked unverified in story.md; confirm SHOP-108 is approved.

<details><summary>Evidence (1 change)</summary>

- **c1** ui-change page /orders/new – New order form shows a live unit price ("<CUR> 12.50 each") and total ("Total: <CUR> 25.00") for the chosen item, quantity and currency, updating on input
  - risk critical from: money, ui-visible
  - source-code: `src/pages.js:70` – unit-price textContent = money(item.unitPrice, currency) + " each"
  - source-code: `src/pages.js:71` – total-preview textContent = "Total: " + money(item.unitPrice * qty, currency)
  - source-code: `src/pages.js:73` – item, qty and currency inputs re-run preview() on input
  - requirement: AC-1: order form shows unit price, e.g. "SGD 12.50 each" for a book
  - requirement: AC-2: form shows total for chosen quantity and updates when item or quantity changes
  - requirement: AC-3: price and total use the chosen currency code, e.g. "Total: EUR 3.00" for 1 pen in EUR
- decision c1: update – spec for /orders/new exists (test-map.yaml) but never asserts the new preview; add scenarios to it _(rule: approved, no coverage → create tests)_
  - existing-test: `tests/web/orders/new-order.spec.ts:6` – only places an order and checks the order page; no assertion on unit price or total preview
  - existing-test: `tests/web/orders/new-order.spec.ts:17` – only checks the payment-declined error for EUR

</details>

**Requirements:** SHOP-108 from [story-file](<work>/stories/SHOP-108.md) @ sha256:68de9b61a773c51b · 3 AC parsed · approval unverified

<sub>qa-sentinel 0.4.0 gap report · storefront@a6bd5d6a · 14 turns · 29s · $0.15</sub>
