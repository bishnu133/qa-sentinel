import { $ } from "@wdio/globals";
import { BaseScreen } from "./base-screen";

/** New order: item (book, pen, mug), quantity, currency, Place order. */
export class NewOrderScreen extends BaseScreen {
  readonly screen = "orders/new";

  get root() {
    return $("~new-order-title");
  }

  item(id: string) {
    return $(`~item-${id}`);
  }

  currency(code: string) {
    return $(`~currency-${code.toLowerCase()}`);
  }

  get quantity() {
    return $("~quantity");
  }

  get placeOrderButton() {
    return $("~place-order");
  }

  get error() {
    return $("~order-error");
  }

  async placeOrder(o: { item: string; itemName: string; qty: number; currency?: string }): Promise<void> {
    await this.ui.tap(this.item(o.item), `${o.itemName} option`);
    await this.ui.type(this.quantity, String(o.qty), "Quantity");
    if (o.currency) await this.ui.tap(this.currency(o.currency), `${o.currency} option`);
    await this.ui.hideKeyboard();
    await this.ui.tap(this.placeOrderButton, "Place order button");
  }
}
