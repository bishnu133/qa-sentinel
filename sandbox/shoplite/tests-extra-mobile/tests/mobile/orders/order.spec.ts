import { expect } from "@wdio/globals";
import { useMobile } from "../../../src/fixtures/mobile";
import { OrderScreen } from "../../../src/screens/order-screen";

describe("Order screen (app)", () => {
  const t = useMobile();

  it("shows an order created through the API @service:shoplite-app @screen:orders/:id", async () => {
    // Test data through the API, never through the app.
    const created = await (await t.api.post("/orders", { item: "mug", qty: 3, unitPrice: 8 })).json();

    const order = await new OrderScreen(t.ui).open(created.id);
    await expect(order.heading).toHaveText(`Order ${created.id}`);
    await expect(order.line).toHaveText("3 × mug");
  });

  it("says when an order can't be loaded @service:shoplite-app @screen:orders/:id", async () => {
    const order = await new OrderScreen(t.ui).open("ord_missing");
    await expect(order.message).toHaveText("Could not load the order (404)");
  });
});
