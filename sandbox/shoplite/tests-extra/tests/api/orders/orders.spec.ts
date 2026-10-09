import { z } from "zod";
import { test, expect } from "../../../src/fixtures";
import { expectSchema } from "../../../src/schemas";

const Order = z.object({
  id: z.string(),
  item: z.string(),
  qty: z.number(),
  unitPrice: z.number(),
  total: z.number(),
  currency: z.enum(["SGD", "USD"]),
  status: z.literal("confirmed"),
  paymentId: z.string(),
});

test.describe("POST /orders", () => {
  test("creates a confirmed, paid order @service:orders-service @endpoint:POST_/orders", async ({ api }) => {
    const res = await api.post("/orders", { item: "book", qty: 2, unitPrice: 12.5 });
    expect(res.status()).toBe(201);
    const order = expectSchema(await res.json(), Order);
    expect(order.total).toBe(25);
    expect(order.currency).toBe("SGD");
    expect(order.paymentId).toMatch(/^pay_/);
  });

  test("returns 400 when qty is 0 @service:orders-service @endpoint:POST_/orders", async ({ api }) => {
    const res = await api.post("/orders", { item: "book", qty: 0, unitPrice: 10 });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toContain("qty");
  });

  test("returns 400 when item is missing @service:orders-service @endpoint:POST_/orders", async ({ api }) => {
    const res = await api.post("/orders", { qty: 1, unitPrice: 10 });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toContain("item");
  });

  test("returns 402 when payment is declined (unsupported currency) @service:orders-service @endpoint:POST_/orders", async ({ api }) => {
    const res = await api.post("/orders", { item: "book", qty: 1, unitPrice: 10, currency: "EUR" });
    expect(res.status()).toBe(402);
  });
});

test.describe("GET /orders/{id}", () => {
  test("returns a created order @service:orders-service @endpoint:GET_/orders/{id}", async ({ api }) => {
    const created = await (await api.post("/orders", { item: "pen", qty: 1, unitPrice: 3 })).json();
    const res = await api.get(`/orders/${created.id}`);
    expect(res.status()).toBe(200);
    expect((await res.json()).id).toBe(created.id);
  });

  test("returns 404 for an unknown id @service:orders-service @endpoint:GET_/orders/{id}", async ({ api }) => {
    const res = await api.get("/orders/ord_does_not_exist");
    expect(res.status()).toBe(404);
  });
});
