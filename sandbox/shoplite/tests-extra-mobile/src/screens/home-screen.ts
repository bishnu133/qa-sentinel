import { $ } from "@wdio/globals";
import { BaseScreen } from "./base-screen";

/** ShopLite app home: the way to a new order. */
export class HomeScreen extends BaseScreen {
  readonly screen = "home";

  get root() {
    return $("~home-title");
  }

  get newOrderButton() {
    return $("~new-order");
  }

  async startNewOrder(): Promise<void> {
    await this.ui.tap(this.newOrderButton, "New order button");
  }
}
