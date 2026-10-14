import { $ } from "@wdio/globals";
import { BaseScreen } from "./base-screen";

/** One order (shoplite://orders/<id>). */
export class OrderScreen extends BaseScreen {
  readonly screen = "orders/:id";

  get root() {
    return $("~order-heading");
  }

  get heading() {
    return $("~order-heading");
  }

  get line() {
    return $("~order-line");
  }

  get message() {
    return $("~order-message");
  }

  /** Open an order directly (deep link), e.g. one created through the API. */
  open(id: string): Promise<this> {
    return this.openDeepLink(`shoplite://orders/${encodeURIComponent(id)}`);
  }
}
