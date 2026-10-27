import { test, expect } from "../../../src/fixtures";
import { freshSlot } from "../../../src/slots";

// SHOP-101, written by hand as the reference: what a good set of tests for the four acceptance criteria looks like.
// bench/mutations/SHOP-101/*.patch plants defects in the service; these tests should notice them.
const order = (deliverySlot?: string) => ({ item: "book", qty: 1, unitPrice: 10, ...(deliverySlot === undefined ? {} : { deliverySlot }) });

test.describe("delivery slot @story:SHOP-101", () => {
  test("AC-1 an order without a deliverySlot is rejected with 400 @service:orders-service @endpoint:POST_/orders @ac:AC-1", async ({ api }) => {
    const res = await api.post("/orders", order());
    expect(res.status()).toBe(400);
  });

  test("AC-1 an order with an invalid deliverySlot is rejected with 400 @service:orders-service @endpoint:POST_/orders @ac:AC-1", async ({ api }) => {
    const res = await api.post("/orders", order("next tuesday"));
    expect(res.status()).toBe(400);
  });

  test("AC-2 a deliverySlot in the past is rejected with 400 @service:orders-service @endpoint:POST_/orders @ac:AC-2", async ({ api }) => {
    const res = await api.post("/orders", order(new Date(Date.now() - 3_600_000).toISOString()));
    expect(res.status()).toBe(400);
  });

  test("AC-3 the 4th order for the same slot is rejected with 409 delivery slot is full @service:orders-service @endpoint:POST_/orders @ac:AC-3", async ({ api }) => {
    const slot = freshSlot();
    for (let i = 0; i < 3; i++) expect((await api.post("/orders", order(slot))).status()).toBe(201);
    const res = await api.post("/orders", order(slot));
    expect(res.status()).toBe(409);
    expect((await res.json()).error).toBe("delivery slot is full");
  });

  test("AC-4 the created order returns its deliverySlot @service:orders-service @endpoint:POST_/orders @ac:AC-4", async ({ api }) => {
    const slot = freshSlot();
    const res = await api.post("/orders", order(slot));
    expect(res.status()).toBe(201);
    expect((await res.json()).deliverySlot).toBe(slot);
  });
});
