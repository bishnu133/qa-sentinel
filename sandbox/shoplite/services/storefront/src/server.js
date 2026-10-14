// ShopLite storefront: a small web front end over the ShopLite APIs. No dependencies.
// Pages: /  ·  /orders/new  ·  /orders/:id. Browser calls go to /api/<service>/… and are proxied to the API gateway.
const http = require("node:http");
const pages = require("./pages");

const API_URL = (process.env.API_URL || "http://127.0.0.1:8080").replace(/\/$/, "");
const recent = []; // order ids placed through this storefront (for the home page)

function send(res, status, body, type = "text/html; charset=utf-8") {
  res.writeHead(status, { "content-type": type });
  res.end(body);
}

async function proxy(req, res, path) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  try {
    const up = await fetch(API_URL + path, { method: req.method, headers: { "content-type": "application/json" }, body });
    const text = await up.text();
    if (req.method === "POST" && path === "/orders" && up.status === 201) recent.unshift(JSON.parse(text).id);
    send(res, up.status, text, "application/json");
  } catch (e) {
    send(res, 502, JSON.stringify({ error: `API unavailable: ${e.message}` }), "application/json");
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://storefront");
  const p = url.pathname.replace(/\/+$/, "") || "/";
  if (p === "/health" || p === "/storefront/health") return send(res, 200, JSON.stringify({ status: "ok", service: "storefront" }), "application/json");
  // Which commit is running (qa-sentinel feature readiness reads this).
  if (p === "/version" || p === "/storefront/version") return send(res, 200, JSON.stringify({ service: "storefront", commit: process.env.GIT_SHA || "unknown" }), "application/json");
  if (p.startsWith("/api/")) return proxy(req, res, p.slice(4) + url.search);
  if (p === "/recent") return send(res, 200, JSON.stringify(recent.slice(0, 10)), "application/json");
  if (p === "/") return send(res, 200, pages.home());
  if (p === "/orders/new") return send(res, 200, pages.newOrder());
  const m = p.match(/^\/orders\/([^/]+)$/);
  if (m) return send(res, 200, pages.order(decodeURIComponent(m[1])));
  send(res, 404, "<!doctype html><title>Not found</title><h1>Page not found</h1>");
});

if (require.main === module) server.listen(process.env.PORT || 8081);
module.exports = server;
