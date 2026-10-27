const express = require("express");
const app = express();
app.use(express.json());

const CURRENCIES = ["SGD", "USD"];
const payments = new Map();

app.get("/payments/health", (_req, res) => res.json({ status: "ok", service: "payments" }));
// Which commit is running (qa-sentinel feature readiness reads this).
app.get("/payments/version", (_req, res) => res.json({ service: "payments-service", commit: process.env.GIT_SHA || "unknown" }));

// Authorise a payment for an order.
app.post("/payments/authorize", (req, res) => {
  const { orderId, amount, currency } = req.body || {};
  if (typeof orderId !== "string" || !orderId) return res.status(400).json({ error: "orderId is required" });
  if (typeof amount !== "number" || !(amount > 0)) return res.status(400).json({ error: "amount must be greater than 0" });
  if (!CURRENCIES.includes(currency)) return res.status(400).json({ error: `currency must be one of ${CURRENCIES.join(", ")}` });
  const payment = { id: `pay_${payments.size + 1}`, orderId, amount, currency, status: "authorized" };
  payments.set(payment.id, payment);
  res.status(201).json(payment);
});

app.get("/payments/:id", (req, res) => {
  const p = payments.get(req.params.id);
  if (!p) return res.status(404).json({ error: "payment not found" });
  res.json(p);
});

if (require.main === module) app.listen(process.env.PORT || 3002);
module.exports = app;
