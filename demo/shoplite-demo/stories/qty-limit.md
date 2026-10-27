As the shop owner I limit one order to 10 units of an item, so that one customer cannot buy all the stock.

## Acceptance criteria
1. An order with qty above 10 returns 400 and the error mentions "qty".
2. An order with qty from 1 to 10 is accepted as before (201).
3. The error text says "qty must be at most 10".
