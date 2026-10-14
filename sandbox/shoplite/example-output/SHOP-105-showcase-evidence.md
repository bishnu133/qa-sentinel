# SHOP-105 – test evidence

All 2 acceptance criteria passed (2026-10-10 14:17 UTC).

| Acceptance criterion | Test | Result |
| --- | --- | --- |
| AC-1: GET /payments?orderId=X returns the payments of order X (200, array). | lists the payments of an order (`tests/api/payments/payments.spec.ts:29`) | passed |
| AC-1: GET /payments?orderId=X returns the payments of order X (200, array). | returns only the payments of the requested order (`tests/api/payments/payments.spec.ts:44`) | passed |
| AC-1: GET /payments?orderId=X returns the payments of order X (200, array). | returns an empty list for an order without payments (`tests/api/payments/payments.spec.ts:61`) | passed |
| AC-2: Without orderId -> 400. | returns 400 when orderId is missing (`tests/api/payments/payments.spec.ts:67`) | passed |
| AC-2: Without orderId -> 400. | returns 400 when orderId is empty (`tests/api/payments/payments.spec.ts:74`) | passed |

## AC-1 · lists the payments of an order

**POST /payments/authorize** → 201 (6 ms)

```json
{
  "orderId": "ord-0-1791641836676-1",
  "amount": 25,
  "currency": "SGD"
}
```

```json
{
  "id": "pay_4",
  "orderId": "ord-0-1791641836676-1",
  "amount": 25,
  "currency": "SGD",
  "status": "authorized"
}
```

**GET /payments?orderId=ord-0-1791641836676-1** → 200 (7 ms)

```json
[
  {
    "id": "pay_4",
    "orderId": "ord-0-1791641836676-1",
    "amount": 25,
    "currency": "SGD",
    "status": "authorized"
  }
]
```


## AC-1 · returns only the payments of the requested order

**POST /payments/authorize** → 201 (6 ms)

```json
{
  "orderId": "ord-0-1791641836708-1",
  "amount": 10,
  "currency": "SGD"
}
```

```json
{
  "id": "pay_5",
  "orderId": "ord-0-1791641836708-1",
  "amount": 10,
  "currency": "SGD",
  "status": "authorized"
}
```

**POST /payments/authorize** → 201 (7 ms)

```json
{
  "orderId": "ord-0-1791641836708-2",
  "amount": 20,
  "currency": "USD"
}
```

```json
{
  "id": "pay_6",
  "orderId": "ord-0-1791641836708-2",
  "amount": 20,
  "currency": "USD",
  "status": "authorized"
}
```

**GET /payments?orderId=ord-0-1791641836708-1** → 200 (7 ms)

```json
[
  {
    "id": "pay_5",
    "orderId": "ord-0-1791641836708-1",
    "amount": 10,
    "currency": "SGD",
    "status": "authorized"
  }
]
```


## AC-1 · returns an empty list for an order without payments

**GET /payments?orderId=ord-0-1791641836757-1** → 200 (6 ms)

```json
[]
```


## AC-2 · returns 400 when orderId is missing

**GET /payments** → 400 (6 ms)

```json
{
  "error": "orderId is required"
}
```


## AC-2 · returns 400 when orderId is empty

**GET /payments?orderId=** → 400 (6 ms)

```json
{
  "error": "orderId is required"
}
```

