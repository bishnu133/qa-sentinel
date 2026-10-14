const express = require("express");
const app = express();
app.use(express.json());

const PAYMENTS_URL = process.env.PAYMENTS_URL || "http://localhost:3002";
const NOTIFICATIONS_URL = process.env.NOTIFICATIONS_URL || "http://localhost:3003";
const orders = new Map();

app.get("/orders/health", (_req, res) => res.json({ status: "ok", service: "orders" }));

async function post(url, body) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

// Create an order: validate, authorise payment, then notify the customer (best effort).
app.post("/orders", async (req, res) => {
  const { item, qty, unitPrice, currency = "SGD", email } = req.body || {};
  if (typeof item !== "string" || !item) return res.status(400).json({ error: "item is required" });
  if (!Number.isInteger(qty) || qty < 1) return res.status(400).json({ error: "qty must be a positive integer" });
  if (typeof unitPrice !== "number" || !(unitPrice > 0)) return res.status(400).json({ error: "unitPrice must be greater than 0" });

  const id = `ord_${orders.size + 1}`;
  const total = Math.round(qty * unitPrice * 100) / 100;
  const payment = await post(`${PAYMENTS_URL}/payments/authorize`, { orderId: id, amount: total, currency });
  if (payment.status !== 201) return res.status(402).json({ error: "payment declined", reason: payment.body.error });

  const order = { id, item, qty, unitPrice, total, currency, status: "confirmed", paymentId: payment.body.id };
  orders.set(id, order);
  if (email) await post(`${NOTIFICATIONS_URL}/notifications`, { orderId: id, channel: "email", message: `Order ${id} confirmed` }).catch(() => {});
  res.status(201).json(order);
});

app.get("/orders/:id", (req, res) => {
  const order = orders.get(req.params.id);
  if (!order) return res.status(404).json({ error: "order not found" });
  res.json(order);
});

if (require.main === module) app.listen(process.env.PORT || 3001);
module.exports = app;
