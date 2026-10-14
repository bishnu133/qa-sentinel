import { expect } from "@wdio/globals";
import { useMobile } from "../../../src/fixtures/mobile";
import { HomeScreen } from "../../../src/screens/home-screen";
import { NewOrderScreen } from "../../../src/screens/new-order-screen";
import { OrderScreen } from "../../../src/screens/order-screen";

describe("New order (app)", () => {
  const t = useMobile();

  it("places an order and lands on its order screen @service:shoplite-app @screen:orders/new", async () => {
    await (await new HomeScreen(t.ui).waitForOpen()).startNewOrder();
    const form = await new NewOrderScreen(t.ui).waitForOpen();
    await form.placeOrder({ item: "book", itemName: "Book", qty: 2 });

    const order = await new OrderScreen(t.ui).waitForOpen();
    await expect(order.heading).toHaveText(/^Order ord_\d+$/);
    await expect(order.line).toHaveText("2 × book");
  });
});
