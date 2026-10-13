## QA agent: storefront@aa354597 · ✅ VERIFIED · 🔴 Critical risk

**Requirements:** SHOP-107 from [story-file](<work>/stories/SHOP-107.md) @ sha256:375cd324e6b76bb0 · 3 AC parsed · approval unverified

**Verification: ✅ VERIFIED** (run by qa-sentinel, not reported by the agent)

| Check | Result | Detail |
| --- | --- | --- |
| preflight (web) | passed | 127.0.0.1:8081 answered 200 |
| typecheck | passed | tsc --noEmit clean |
| tests (web) | passed | 5 passed, 2 skipped |

Tests: 5 passed · 0 failed · 2 skipped (of 7).

### Plan (validated by qa-sentinel)
1 requirement conflict (AC-3: total shows unit price), 1 broken test (button label), 1 gap (payment status) – resolve AC-3 before release

| Change | Risk | Oracle | Coverage | Decision |
| --- | --- | --- | --- | --- |
| page /orders/new – Order form submit button label changed from 'Place order' to 'Checkout'; submit still redirects to /orders/:id on 201 (AC-1) | 🟠 High | approved | outdated | **update** |
| page /orders/:id – Order page now fetches the payment and shows 'Payment: authorised (pay_…)' when status is authorized, otherwise 'Payment: pending' (AC-2) | 🔴 Critical | approved | missing | **update** |
| page /orders/:id – Order page 'Total' now renders money(o.unitPrice, o.currency) instead of o.total, so 2 books at 12.50 shows 'SGD 12.50' instead of 'SGD 25.00' (AC-3) | 🔴 Critical | conflicting | missing | **review** |

**Contract changes (computed from `OpenAPI spec`, base → head):** no OpenAPI spec configured for this service.

### ⚠️ Unresolved product discrepancies (2, not executed as passing tests)
These tests encode the requirement, but the product currently behaves differently. They are marked fixme/skip so they do not fail the build. **A human must decide: fix the product or change the requirement.**

| Test | File | Note |
| --- | --- | --- |
| order page shows payment pending when the order has no authorised payment | `tests/web/orders/order-page.spec.ts` | the API cannot create an order without an authorised payment (unsupported currency returns 402 and creates no order), so "Payment: pending" cannot be reached with API-created data. Needs a human decision on how to produce it. |
| order page total is quantity times unit price with currency and two decimals | `tests/web/orders/order-page.spec.ts` | AC-3 expects "SGD 25.00" for 2 books at 12.50; the storefront renders money(o.unitPrice, o.currency) and shows "SGD 12.50" (src/pages.js:91). |

### Requirement traceability (SHOP-107)
_Built from test tags (`@story`, `@ac`), not from the agent's claims; 🟠 = judged weak or wrong-oracle by the independent review._

| AC | Status | Passing tests | Pending (fixme/skip) |
| --- | --- | --- | --- |
| AC-1 | ✅ covered | `tests/web/orders/new-order.spec.ts:6` places an order with the Checkout button and lands on its order page | – |
| AC-2 | ⚠️ discrepancy | `tests/web/orders/order-page.spec.ts:16` order page shows the authorised payment for a paid order | `tests/web/orders/order-page.spec.ts:28` order page shows payment pending when the order has no authorised payment 🟠 _wrong-oracle_ |
| AC-3 | ⏸️ pending-only | – | `tests/web/orders/order-page.spec.ts:36` order page total is quantity times unit price with currency and two decimals |

Outside the story's ACs on purpose (`@ac:none`): `tests/web/orders/new-order.spec.ts:20` shows the payment error for an unsupported currency.

### Independent test review
_A separate read-only agent checked each changed test against the acceptance criteria. Advisory: it doesn't change the verification result._

🟢 3 strong · 🟡 3 adequate · 🔴 1 wrong-oracle — AC-1, AC-2 (paid) and AC-3 are covered with meaningful assertions, but the 'Payment: pending' fixme asserts behaviour no AC defines against an order id that does not exist.

| Test | Verdict | Issues | Suggestion |
| --- | --- | --- | --- |
| `tests/web/orders/order-page.spec.ts:28` order page shows payment pending when the order has no authorised payment | 🔴 wrong-oracle | AC-2 only defines the display for a paid order; the text 'Payment: pending' is not supported by any acceptance criterion or domain rule.; It opens the hardcoded id 'ord_without_authorised_payment', which does not exist, so if run it would hit the not-found page rather than assert payment status.; The fixme reason is that the state is unreachable, not a documented product discrepancy, so the unsupported expectation is not recorded as a requirement conflict. | Remove or get the 'pending' wording confirmed in the story, then build the order through a real route and assert the payment line from that order. |

**Scenarios the reviewer thinks are still missing**
- AC-3: a unit price with no fractional part (e.g. 2 books at 10) renders the total with two decimals, 'SGD 20.00'
- AC-3: the total is shown in the order's own currency when it is not SGD (if another currency is supported)
- AC-2: the payment reference shown on the order page matches the paymentId of the order read back from the API

### Agent notes
_Written by the agent. Claims about test results here are superseded by the verification table above._

### What I changed
| Decision | Files | What |
| --- | --- | --- |
| c1 update | `src/pages/new-order-page.ts`, `tests/web/orders/new-order.spec.ts` | The page object now has `checkoutButton` and `placeOrder` clicks it. The spec asserts "Checkout" is visible, "Place order" is absent, the URL is `/orders/ord_…`, and the heading matches `Order ord_<digits>`. Tagged `@story:SHOP-107 @ac:AC-1`. |
| c2 update | `src/pages/order-page.ts`, `tests/web/orders/order-page.spec.ts` | Added a `payment` locator. New test for a paid order: the order is created and read back through the API, and the page shows "Payment: authorised" with a `pay_` prefix (`@ac:AC-2`). |
| c2 update (pending) | same | "Payment: pending" scenario written as `test.fixme` (see below). |
| c3 review | same | AC-3 test written to the requirement (total is exactly `SGD 25.00`) and marked `test.fixme`. |
| mapping | `test-map.yaml` | Added an AC-1 annotation to `/orders/new`. Both screens were already mapped. |

I also added `@story:SHOP-107 @ac:none` to the existing unsupported-currency test. I did not add tags to the other two existing tests: "shows an order created through the API" and "says an unknown order is not found".

### Needs human attention
- **Requirement conflict (AC-3):** expected `SGD 25.00` for 2 books at 12.50. The storefront renders `money(o.unitPrice, o.currency)`, so it shows `SGD 12.50` (`storefront/src/pages.js:91`). The test is `fixme` and follows the requirement. Please decide whether the code or the AC is wrong.
- **Pending payment scenario can't be built (open question from the plan):** the orders API only creates orders with an authorised payment. An unsupported currency returns 402 and creates no order. I could not produce an order with a pending payment as test data. The test is `fixme`, and it uses a placeholder order id that will not work until a real setup path exists. It needs a decision, such as a test-only order seed or mocking the payment response.
- **Snapshot gap:** `page-snapshots/orders_id.aria.yaml` actually contains the "New order" form, not an order page. So I took the `#payment` and `#total` locators from `storefront/src/pages.js`. They are id-based because the markup has no roles or test ids for them.
- **Page object:** I kept a `legacyPlaceOrderButton` locator only so the spec can assert the old label is gone.
- **Assertions changed:** none were removed or weakened.
- **Not run:** I ran the web specs and `npx tsc --noEmit`, which gave 5 passed and 2 skipped (the `fixme` tests) with no type errors. I did not run the API project, since no API tests changed.

### Reviewer checklist
- [ ] Expected values match the acceptance criteria
- [ ] No duplicated coverage
- [ ] Test data is isolated and cleaned up (orders are created through the API; no cleanup helper exists)

---
Generated by qa-sentinel 0.4.0 (run `2026-10-13T09-03-29-678Z-gen-storefront`, 50 turns · 116s · $0.42). A QA engineer must review before merge.