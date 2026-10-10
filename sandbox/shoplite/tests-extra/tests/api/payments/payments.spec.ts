import { z } from "zod";
import { test, expect } from "../../../src/fixtures";
import { expectSchema } from "../../../src/schemas";

const Payment = z.object({ id: z.string(), orderId: z.string(), amount: z.number(), currency: z.enum(["SGD", "USD"]), status: z.literal("authorized") });

test.describe("POST /payments/authorize", () => {
  test("authorises a valid payment @service:payments-service @endpoint:POST_/payments/authorize", async ({ api, data }) => {
    const res = await api.post("/payments/authorize", { orderId: data.unique("ord"), amount: 25, currency: "SGD" });
    expect(res.status()).toBe(201);
    const p = expectSchema(await res.json(), Payment);
    expect(p.amount).toBe(25);
  });

  test("returns 400 when amount is 0 @service:payments-service @endpoint:POST_/payments/authorize", async ({ api, data }) => {
    const res = await api.post("/payments/authorize", { orderId: data.unique("ord"), amount: 0, currency: "SGD" });
    expect(res.status()).toBe(400);
  });

  test("returns 400 for an unsupported currency @service:payments-service @endpoint:POST_/payments/authorize", async ({ api, data }) => {
    const res = await api.post("/payments/authorize", { orderId: data.unique("ord"), amount: 5, currency: "EUR" });
    expect(res.status()).toBe(400);
  });
});

test.describe("GET /payments/{id}", () => {
  test("returns 404 for an unknown payment @service:payments-service @endpoint:GET_/payments/{id}", async ({ api }) => {
    const res = await api.get("/payments/pay_missing");
    expect(res.status()).toBe(404);
  });
});
