import { BasePage } from "./base-page";

/** Storefront: one order. */
export class OrderPage extends BasePage {
  readonly path = "/orders/:id";

  get heading() {
    return this.page.getByRole("heading", { level: 1 });
  }
  get status() {
    return this.page.locator("#status");
  }
  get item() {
    return this.page.locator("#item");
  }
  get quantity() {
    return this.page.locator("#qty");
  }
  get total() {
    return this.page.locator("#total");
  }
  get notFound() {
    return this.page.getByRole("alert");
  }
}
