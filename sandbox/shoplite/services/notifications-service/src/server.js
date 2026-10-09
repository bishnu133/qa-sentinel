const express = require("express");
const app = express();
app.use(express.json());

const CHANNELS = ["email", "sms"];
const notifications = [];

app.get("/notifications/health", (_req, res) => res.json({ status: "ok", service: "notifications" }));

// Queue a notification about an order.
app.post("/notifications", (req, res) => {
  const { orderId, channel, message } = req.body || {};
  if (typeof orderId !== "string" || !orderId) return res.status(400).json({ error: "orderId is required" });
  if (!CHANNELS.includes(channel)) return res.status(400).json({ error: `channel must be one of ${CHANNELS.join(", ")}` });
  if (typeof message !== "string" || !message) return res.status(400).json({ error: "message is required" });
  const n = { id: `ntf_${notifications.length + 1}`, orderId, channel, message, status: "queued" };
  notifications.push(n);
  res.status(202).json(n);
});

app.get("/notifications", (req, res) => {
  const { orderId } = req.query;
  res.json(orderId ? notifications.filter((n) => n.orderId === orderId) : notifications);
});

if (require.main === module) app.listen(process.env.PORT || 3003);
module.exports = app;
