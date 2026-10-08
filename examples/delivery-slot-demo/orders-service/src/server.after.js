const express = require("express");
const app = express();
app.use(express.json());
const orders = [];
const MAX_ORDERS_PER_SLOT = 5;

app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.post("/orders", (req, res) => {
  const { item, qty, deliverySlot } = req.body || {};
  if (typeof item !== "string" || !item) return res.status(400).json({ error: "item is required" });
  if (!Number.isInteger(qty) || qty < 1) return res.status(400).json({ error: "qty must be a positive integer" });
  const slot = Date.parse(deliverySlot);
  if (!deliverySlot || Number.isNaN(slot)) return res.status(400).json({ error: "deliverySlot must be an ISO date-time" });
  if (slot <= Date.now()) return res.status(400).json({ error: "deliverySlot must be in the future" });
  if (orders.filter((o) => o.deliverySlot === deliverySlot).length >= MAX_ORDERS_PER_SLOT) {
    return res.status(409).json({ error: "delivery slot is full" });
  }
  const order = { id: String(orders.length + 1), item, qty, deliverySlot };
  orders.push(order);
  res.status(201).json(order);
});

if (require.main === module) app.listen(process.env.PORT || 3000);
module.exports = app;
