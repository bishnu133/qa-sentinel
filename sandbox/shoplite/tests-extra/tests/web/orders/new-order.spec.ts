import { test, expect } from "../../../src/fixtures/web";
import { NewOrderPage } from "../../../src/pages/new-order-page";
import { OrderPage } from "../../../src/pages/order-page";

test.describe("New order page", () => {
  test("places an order and lands on its order page @service:storefront @page:/orders/new", async ({ page, ui }) => {
    const form = new NewOrderPage(page, ui);
    await form.open();
    await form.placeOrder({ item: "Book", qty: 2 });

    const order = new OrderPage(page, ui);
    await expect(order.heading).toHaveText(/^Order ord_\d+$/);
    await expect(order.status).toHaveText("confirmed");
    await expect(order.quantity).toHaveText("2");
  });

  test("shows the payment error for an unsupported currency @service:storefront @page:/orders/new", async ({ page, ui }) => {
    const form = new NewOrderPage(page, ui);
    await form.open();
    await form.placeOrder({ item: "Pen", qty: 1, currency: "EUR" });
    await expect(form.error).toContainText("Payment declined");
    await expect(page).toHaveURL(/\/orders\/new$/);
  });
});
