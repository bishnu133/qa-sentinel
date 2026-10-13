# SHOP-108 – test evidence

All 3 acceptance criteria passed (2026-10-13 09:01 UTC).

| Acceptance criterion | Test | Result |
| --- | --- | --- |
| AC-1: After choosing an item, the order form shows its unit price, e.g. "SGD 12.50 each" for a book. | shows the unit price of a book in SGD (`tests/web/orders/new-order.spec.ts:25`) | passed |
| AC-2: The form shows the total for the chosen quantity, e.g. "Total: SGD 25.00" for 2 books, and updates when the item or quantity changes. | shows the total for 2 books (`tests/web/orders/new-order.spec.ts:32`) | passed |
| AC-2: The form shows the total for the chosen quantity, e.g. "Total: SGD 25.00" for 2 books, and updates when the item or quantity changes. | updates the total when quantity or item changes (`tests/web/orders/new-order.spec.ts:40`) | passed |
| AC-3: The price and total use the chosen currency code, e.g. "Total: EUR 3.00" for 1 pen in EUR. | shows price and total in the chosen currency code (`tests/web/orders/new-order.spec.ts:54`) | passed |
