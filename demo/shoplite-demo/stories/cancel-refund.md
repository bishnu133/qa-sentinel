As a customer I cancel an order that I no longer want, and my payment is refunded.

This story needs two services: orders-service (the cancel call) and payments-service (the refund).

## Acceptance criteria
1. POST /orders/{id}/cancel on a confirmed order returns 200 and the order status is "cancelled".
2. The payment of the cancelled order is refunded: GET /payments/{paymentId} shows status "refunded".
3. Cancelling an unknown order returns 404.
4. Cancelling an order that is already cancelled returns 409.
