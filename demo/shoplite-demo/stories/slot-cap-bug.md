Found in the demo environment: the delivery slot accepts 5 orders. The story says a slot accepts at most 3.

## Steps to reproduce
1. Create 4 orders with the same deliverySlot (a time in the future).
2. Look at the answer of the 4th order.

## Expected
The 4th order returns 409 "delivery slot is full".

## Actual
The 4th order returns 201. The slot is only full after 5 orders.
