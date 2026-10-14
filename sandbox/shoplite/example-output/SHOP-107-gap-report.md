### QA impact – storefront · 🔴 Critical risk

**Verdict:** 1 requirement conflict (AC-3: order page total shows the unit price), 1 broken test pair (button rename), 1 gap (payment status) – fix AC-3 before release

**Recommended QA action:** Fix the order page total to show the order total (qty x unit price, e.g. SGD 25.00). Update the new-order page object and spec for the Checkout button, and add payment-status and total scenarios for /orders/:id.

| Change | Risk | Oracle | Coverage | Decision |
| --- | --- | --- | --- | --- |
| page /orders/new – Order form submit button renamed from "Place order" to "Checkout" (AC-1) | 🟠 High | approved | outdated | **update** |
| page /orders/:id – Order page now fetches the payment and shows "Payment: authorised (pay_…)" when it is authorized, otherwise "Payment: pending" (AC-2) | 🔴 Critical | approved | missing | **create** |
| page /orders/:id – Order page Total now renders money(o.unitPrice, o.currency) instead of o.total, so a multi-quantity order shows the unit price (AC-3) | 🔴 Critical | conflicting | missing | **review** |

**Run these existing tests**
- `tests/web/orders/new-order.spec.ts` – both tests click "Place order" via the page object; the button is now "Checkout" ⚠️ will fail or no longer proves the behaviour
- `tests/web/orders/order-page.spec.ts` – asserts heading, item and quantity only, which are unchanged; no payment or total assertions

**Regression selection** (computed by qa-sentinel): 4 existing test(s) in 2 file(s)

<details><summary>Selected tests and why</summary>

| Test | Why |
| --- | --- |
| `tests/web/orders/new-order.spec.ts:6` places an order and lands on its order page | named by the plan, changed page: both tests click "Place order" via the page object; the button is now "Checkout"; c1: update; /orders/new |
| `tests/web/orders/new-order.spec.ts:17` shows the payment error for an unsupported currency | named by the plan, changed page: both tests click "Place order" via the page object; the button is now "Checkout"; c1: update; /orders/new |
| `tests/web/orders/order-page.spec.ts:5` shows an order created through the API | named by the plan, changed page: asserts heading, item and quantity only, which are unchanged; no payment or total asser…; /orders/:id |
| `tests/web/orders/order-page.spec.ts:16` says an unknown order is not found | named by the plan, changed page: asserts heading, item and quantity only, which are unchanged; no payment or total asser…; /orders/:id |

```
npx playwright test --project=web tests/web/orders/new-order.spec.ts:6 tests/web/orders/new-order.spec.ts:17 tests/web/orders/order-page.spec.ts:5 tests/web/orders/order-page.spec.ts:16
```

</details>

**Missing or outdated scenarios**
- 🖥️ order form submit button is labelled Checkout and leads to the order page (AC-1) – update
  - flow: **web** `/orders/new`
- 🖥️ order page shows the authorised payment with its reference (AC-2) – create
  - flow: create an order for 2 books at 12.50 SGD (payment is authorised on creation) _(api: api.post('/orders'))_ → read the order to get its paymentId _(api: api.get('/orders/{id}'))_ → **web** `/orders/:id`
- 🖥️ order page shows payment pending when the order has no authorised payment (AC-2) – create
  - flow: create an order that has no paymentId or an unauthorised payment (confirm with the team how to produce one) _(api: api.post('/orders'))_ → **web** `/orders/:id`
- 🖥️ order page total is quantity times unit price with currency and two decimals (AC-3) – review
  - flow: create an order for 2 books at 12.50 SGD _(api: api.post('/orders'))_ → **web** `/orders/:id`

**Requirement conflicts – need a human decision**
- ⚠️ AC-3: requirement says "The order page shows the order total, e.g. "SGD 25.00" for 2 books at 12.50"; observed: The Total field renders the unit price (SGD 12.50 for the same order) (`src/pages.js:91` – money(o.unitPrice, o.currency))

**Contract changes (computed from `OpenAPI spec`, base → head):** no OpenAPI spec configured for this service.

**Open questions**
- How can a test create an order whose payment is not authorised, to cover the "Payment: pending" state?
- Story approval is unverified; confirm AC-1 to AC-3 are approved before treating them as final.

<details><summary>Evidence (3 changes)</summary>

- **c1** ui-change page /orders/new – Order form submit button renamed from "Place order" to "Checkout"
  - risk high from: user-journey, ui-visible
  - source-code: `src/pages.js:59` – <button type="submit">Checkout</button>
  - requirement: AC-1: the order form's button says "Checkout"; after checkout the customer lands on the order page
- **c2** ui-change page /orders/:id – Order page now fetches the payment and shows "Payment: authorised (pay_…)" when it is authorized, otherwise "Payment: pending"
  - risk critical from: user-journey, money, cross-service
  - source-code: `src/pages.js:84` – fetch("/api/payments/" + o.paymentId) ... pay.status === "authorized" ? "Payment: authorised (" + pay.id + ")" : "Payment: pending"
  - requirement: AC-2: the order page shows "Payment: authorised" with the payment reference (pay_…) for a paid order
- **c3** ui-change page /orders/:id – Order page Total now renders money(o.unitPrice, o.currency) instead of o.total, so a multi-quantity order shows the unit price
  - risk critical from: money, conflicting-oracle, user-journey
  - source-code: `src/pages.js:91` – <dd id="total"> + money(o.unitPrice, o.currency)
  - requirement: AC-3: the order total with currency and two decimals, e.g. "SGD 25.00" for 2 books at 12.50
  - domain-rule: `kb/domain/payments.md` – Amounts are in the payment's currency with two decimals. Compare money with exact values
- decision c1: update – Both specs in new-order.spec.ts click the button through the page object, which still looks for "Place order", so they now fail. Update the page object locator and add an explicit label check. _(rule: approved, coverage outdated → update tests)_
  - existing-test: `src/pages/new-order-page.ts:17` – getByRole("button", { name: "Place order" }) – locator used by both tests in new-order.spec.ts
- decision c2: create – No test covers the new payment line. Add scenarios to the existing order-page spec. _(rule: approved, no coverage → create tests)_
  - existing-test: `tests/web/orders/order-page.spec.ts:5` – only asserts heading, item and quantity; no payment assertion
  - domain-rule: `kb/review-feedback.md` – Don't assert on generated ids (pay_…, ord_…) beyond their prefix
- decision c3: review – Code contradicts AC-3: the page would show SGD 12.50. Report the conflict; the test is written to the requirement and marked fixme until the page is fixed. Not encoded from code. _(rule: requirement and code disagree → human review)_
  - source-code: `src/pages.js:91` – money(o.unitPrice, o.currency) renders SGD 12.50 for the 2-book example
  - requirement: AC-3 expects SGD 25.00 for 2 books at 12.50

</details>

**Requirements:** SHOP-107 from [story-file](<work>/stories/SHOP-107.md) @ sha256:375cd324e6b76bb0 · 3 AC parsed · approval unverified

<sub>qa-sentinel 0.4.0 gap report · storefront@aa354597 · 16 turns · 39s · $0.15</sub>
