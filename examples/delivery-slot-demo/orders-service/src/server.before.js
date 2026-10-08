const express = require("express");
const app = express();
app.use(express.json());
const orders = [];

app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.post("/orders", (req, res) => {
  const { item, qty } = req.body || {};
  if (typeof item !== "string" || !item) return res.status(400).json({ error: "item is required" });
  if (!Number.isInteger(qty) || qty < 1) return res.status(400).json({ error: "qty must be a positive integer" });
  const order = { id: String(orders.length + 1), item, qty };
  orders.push(order);
  res.status(201).json(order);
});

if (require.main === module) app.listen(process.env.PORT || 3000);
module.exports = app;
