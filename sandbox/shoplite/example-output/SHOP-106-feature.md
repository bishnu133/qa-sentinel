### Feature SHOP-106 · LOCAL

**Status:** ✅ Every service change is deployed: ready for the feature's end-to-end tests

| Service | Change | Merged | Deployed on local |
| --- | --- | --- | --- |
| orders-service | feature/SHOP-106-ship-order @ `701b8de6` | ✅ | ✅ `8cd23c94` |
| notifications-service | feature/SHOP-106-shipping-notice @ `cda1e531` | ✅ | ✅ `9db6ad2c` |

**Feature tests:** 2 tagged @story:SHOP-106, across 1 service(s).

#### Requirement traceability (SHOP-106)
_Built from test tags (`@story`, `@ac`), not from the agent's claims._

| AC | Status | Passing tests | Pending (fixme/skip) |
| --- | --- | --- | --- |
| AC-1 | ⬜ not-traced | – | – |
| AC-2 | ⬜ not-traced | – | – |
| AC-3 | ✅ covered | `tests/api/orders/orders.spec.ts:61` marks the order shipped and stores the tracking number<br>`tests/api/orders/orders.spec.ts:79` sends exactly one order-shipped notification | – |
