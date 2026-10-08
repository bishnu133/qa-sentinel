# Demo: delivery slots with an acceptance-criteria mismatch

A small Express `orders-service` gets a dev change (story **SHOP-42**): `POST /orders` now needs a future `deliverySlot`, and a slot is capped at `MAX_ORDERS_PER_SLOT = 5`. The story says the cap is **3**. The OpenAPI spec was not updated.

| File | What |
| --- | --- |
| `orders-service/src/server.before.js` → `server.after.js` | the dev change |
| `story-SHOP-42.md` | the acceptance criteria |
| `create-order.spec.before.ts` | the one existing API spec |
| `expected-output/gap-report.md` | real Phase 1 output |
| `expected-output/merge-request-summary.md`, `generated-tests.diff` | real Phase 2 output |

Run it yourself (needs Node 20+, git, Claude Code logged in or `ANTHROPIC_API_KEY`; costs well under $1):

```bash
npm run build
./examples/delivery-slot-demo/run-demo.sh
```

LLM output varies between runs. Expect the same findings, but worded differently and with slightly different scenarios.
