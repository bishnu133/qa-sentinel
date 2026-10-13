// Server-rendered shells; the browser script fills them from the ShopLite APIs (through /api on this server).
const catalog = require("./catalog");

const layout = (title, body, script = "") => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · ShopLite</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 0; color: #1d1d1f; background: #fafafa; }
  header { background: #2f6f4f; color: #fff; padding: 12px 24px; display: flex; gap: 24px; align-items: center; }
  header a { color: #fff; text-decoration: none; }
  main { max-width: 640px; margin: 32px auto; padding: 0 16px; }
  label { display: block; margin: 12px 0 4px; font-weight: 600; }
  input, select { font-size: 16px; padding: 6px 8px; width: 200px; }
  button { margin-top: 16px; font-size: 16px; padding: 8px 18px; background: #2f6f4f; color: #fff; border: 0; border-radius: 6px; cursor: pointer; }
  [role=alert] { color: #b00020; margin-top: 12px; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 6px 16px; }
  dt { font-weight: 600; }
</style>
</head>
<body>
<header><strong>ShopLite</strong><nav><a href="/">Home</a> · <a href="/orders/new">New order</a></nav></header>
<main>
${body}
</main>
<script>
const money = (amount, currency) => currency + " " + Number(amount).toFixed(2);
${script}
</script>
</body>
</html>`;

exports.home = () =>
  layout(
    "Home",
    `<h1>Welcome to ShopLite</h1>
<p>Order books, pens and mugs. <a href="/orders/new">Place a new order</a>.</p>
<h2>Orders placed here</h2>
<ul id="recent"></ul>`,
    `fetch("/recent").then((r) => r.json()).then((ids) => {
  const ul = document.getElementById("recent");
  ul.innerHTML = ids.length ? ids.map((id) => '<li><a href="/orders/' + id + '">Order ' + id + '</a></li>').join("") : "<li>No orders yet</li>";
});`,
  );

exports.newOrder = () =>
  layout(
    "New order",
    `<h1>New order</h1>
<form id="order-form">
  <label for="item">Item</label>
  <select id="item" name="item">${catalog.map((i) => `<option value="${i.id}">${i.name}</option>`).join("")}</select>
  <label for="qty">Quantity</label>
  <input id="qty" name="qty" type="number" min="1" value="1">
  <label for="currency">Currency</label>
  <select id="currency" name="currency"><option>SGD</option><option>EUR</option></select>
  <div><button type="submit">Place order</button></div>
  <p id="error" role="alert"></p>
</form>`,
    `const catalog = ${JSON.stringify(catalog)};
document.getElementById("order-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const item = catalog.find((i) => i.id === document.getElementById("item").value);
  const body = { item: item.id, qty: Number(document.getElementById("qty").value), unitPrice: item.unitPrice, currency: document.getElementById("currency").value };
  const res = await fetch("/api/orders", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (res.status === 201) { location.href = "/orders/" + data.id; return; }
  document.getElementById("error").textContent = res.status === 402 ? "Payment declined: " + (data.reason || "try another currency") : "Could not place the order: " + (data.error || res.status);
});`,
  );

exports.order = (id) =>
  layout(
    `Order ${id}`,
    `<h1>Order ${id}</h1>
<div id="order"><p>Loading…</p></div>`,
    `(async () => {
  const el = document.getElementById("order");
  const res = await fetch("/api/orders/${encodeURIComponent(id)}");
  if (res.status === 404) { el.innerHTML = '<p role="alert">Order not found</p>'; return; }
  const o = await res.json();
  el.innerHTML =
    '<dl>' +
    '<dt>Status</dt><dd id="status">' + o.status + '</dd>' +
    '<dt>Item</dt><dd id="item">' + o.item + '</dd>' +
    '<dt>Quantity</dt><dd id="qty">' + o.qty + '</dd>' +
    '<dt>Total</dt><dd id="total">' + money(o.total, o.currency) + '</dd>' +
    '</dl>';
})();`,
  );
