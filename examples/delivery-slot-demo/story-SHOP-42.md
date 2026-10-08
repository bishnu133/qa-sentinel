# SHOP-42 Choose a delivery slot when ordering
As a customer I choose a delivery slot when I place an order.
Acceptance criteria:
1. deliverySlot is required on POST /orders (ISO 8601 date-time); missing or invalid -> 400.
2. deliverySlot in the past -> 400.
3. A slot accepts at most 3 orders; the 4th order for the same slot -> 409 "delivery slot is full".
4. The created order echoes deliverySlot.
