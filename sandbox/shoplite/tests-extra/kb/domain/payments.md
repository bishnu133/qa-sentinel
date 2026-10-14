# Payments rules (ShopLite)

- Amounts are in the payment's currency with two decimals. Compare money with exact values, never "greater than 0".
- **Refunds:** the total of all refunds on a payment can never exceed the authorised amount. This holds across any number of partial refunds.
- A payment that is fully refunded has status `refunded`; it accepts no further refunds (422).
- A rejected refund (4xx) must leave the payment unchanged: same `refundedAmount`, same `status`.
