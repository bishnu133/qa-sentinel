Production problem: an order whose item is only spaces is accepted. It then shows as an empty line in the warehouse list.

## Expected
POST /orders with item "   " (spaces only) returns 400 and the error mentions "item".

## Actual
The order is created (201).

This is fixed on the release branch first (hotfix), then copied to the main branch.
