import { z } from "zod";
import { test, expect } from "../../../src/fixtures";
import { expectSchema } from "../../../src/schemas";

const Order = z.object({ id: z.string(), item: z.string(), qty: z.number() });

test.describe("POST /orders", () => {
  test("creates an order @service:orders-service @endpoint:POST_/orders", async ({ api }) => {
    const res = await api.post("/orders", { item: "book", qty: 2 });
    expect(res.status()).toBe(201);
    const order = expectSchema(await res.json(), Order);
    expect(order.qty).toBe(2);
  });

  test("returns 400 when qty is 0 @service:orders-service @endpoint:POST_/orders", async ({ api }) => {
    const res = await api.post("/orders", { item: "book", qty: 0 });
    expect(res.status()).toBe(400);
  });
});
