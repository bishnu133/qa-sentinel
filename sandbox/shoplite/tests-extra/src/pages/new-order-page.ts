import { BasePage } from "./base-page";

/** Storefront: the order form. */
export class NewOrderPage extends BasePage {
  readonly path = "/orders/new";

  get item() {
    return this.page.getByLabel("Item");
  }
  get quantity() {
    return this.page.getByLabel("Quantity");
  }
  get currency() {
    return this.page.getByLabel("Currency");
  }
  get placeOrderButton() {
    return this.page.getByRole("button", { name: "Place order" });
  }
  get error() {
    return this.page.getByRole("alert");
  }

  async placeOrder(o: { item: string; qty: number; currency?: string }): Promise<void> {
    await this.ui.select(this.item, o.item, "Item");
    await this.ui.fill(this.quantity, String(o.qty), "Quantity");
    if (o.currency) await this.ui.select(this.currency, o.currency, "Currency");
    await this.ui.click(this.placeOrderButton, "Place order button");
  }
}
