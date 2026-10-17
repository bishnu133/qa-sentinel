#!/usr/bin/env bash
# Runtime healing with the real Bubblegum engine (E3): a page object whose locator is stale after a UI change.
# Healing off: the test fails. QA_HEALING=bubblegum: Bubblegum finds the button from the step's intent, the test
# passes, and `qa-sentinel healed` lists the page-object fix. Needs Node 20+, Python 3.10+, network for npm/pip.
#
#   bash sandbox/bubblegum/e2e.sh [work dir]
set -euo pipefail
HERE="$(cd "$(dirname "$0")/../.." && pwd)"
CLI="$HERE/dist/cli.js"
W="${1:-$(mktemp -d)}"
# Never delete what isn't ours: the work dir must be new or empty.
if [ -e "$W" ] && [ -n "$(ls -A "$W" 2>/dev/null)" ]; then echo "$W is not empty; pass a new folder"; exit 2; fi
mkdir -p "$W" && cd "$W"
git init -q
node "$CLI" init --yes --mode scratch --web --ci gitlab --name healing-demo >/dev/null
npm install --no-audit --no-fund --loglevel=error
npm i -D --no-audit --no-fund --loglevel=error @bubblegum-ai/node
python3 -m pip install --quiet "bubblegum-ai[web]" 2>/dev/null || python3 -m pip install --quiet --break-system-packages "bubblegum-ai[web]"
[ -n "${QA_BROWSER_PATH:-}" ] || npx playwright install chromium

cat > site.mjs <<'JS'
import http from "node:http";
http.createServer((req, res) => {
  res.setHeader("content-type", "text/html");
  if (req.url.startsWith("/done")) return res.end("<h1>Order placed</h1>");
  // The developer renamed the button: "#place-order / Place order" is now "#confirm-btn / Confirm order".
  res.end(`<html><body><h1>Checkout</h1><form action="/done"><button id="confirm-btn" type="submit">Confirm order</button></form></body></html>`);
}).listen(Number(process.env.PORT ?? 8899));
JS
cat > src/pages/checkout-page.ts <<'TS'
import { BasePage } from "./base-page";
export class CheckoutPage extends BasePage {
  readonly path = "/";
  // Stale: the button used to be #place-order "Place order".
  get placeOrder() {
    return this.page.locator("#place-order");
  }
  async submit() {
    await this.ui.click(this.placeOrder, "Place order button");
  }
}
TS
mkdir -p tests/web/checkout
cat > tests/web/checkout/checkout.spec.ts <<'TS'
import { test, expect } from "../../../src/fixtures/web";
import { CheckoutPage } from "../../../src/pages/checkout-page";
test("places an order @service:shop @page:/", async ({ page, ui }) => {
  const p = new CheckoutPage(page, ui);
  await p.open();
  await p.submit();
  await expect(page.getByRole("heading", { name: "Order placed" })).toBeVisible();
});
TS

node site.mjs & SITE=$!
trap 'kill $SITE 2>/dev/null || true' EXIT
sleep 1
export QA_WEB_URL=http://127.0.0.1:${PORT:-8899}/ QA_VIDEO=off
echo "› healing off: the stale locator fails the test"
if QA_HEALING=off npx playwright test --project=web tests/web/checkout --reporter=line --timeout=15000; then echo "expected a failure"; exit 1; fi
echo "› healing on: Bubblegum finds the button from the intent"
QA_HEALING=bubblegum QA_ACTION_TIMEOUT=3000 npx playwright test --project=web tests/web/checkout
node "$CLI" healed || true
grep -q "Confirm order" qa-healed.md
echo "✓ healed: $(grep -c '|' qa-healed.md) line(s) in qa-healed.md"
