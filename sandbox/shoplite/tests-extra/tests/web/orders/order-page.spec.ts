import { test, expect } from "../../../src/fixtures/web";
import { OrderPage } from "../../../src/pages/order-page";

test.describe("Order page", () => {
  test("shows an order created through the API @service:storefront @page:/orders/:id", async ({ page, ui, api }) => {
    // Test data through the API, never through the UI.
    const created = await (await api.post("/orders", { item: "mug", qty: 3, unitPrice: 8 })).json();

    const order = new OrderPage(page, ui);
    await order.open({ id: created.id });
    await expect(order.heading).toHaveText(`Order ${created.id}`);
    await expect(order.item).toHaveText("mug");
    await expect(order.quantity).toHaveText("3");
  });

  test("says an unknown order is not found @service:storefront @page:/orders/:id", async ({ page, ui }) => {
    const order = new OrderPage(page, ui);
    await order.open({ id: "ord_missing" });
    await expect(order.notFound).toHaveText("Order not found");
  });
});
