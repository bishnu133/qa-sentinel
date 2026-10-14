// Tiny API gateway for the ShopLite QA environment: one base URL, routed by the first path segment.
const http = require("node:http");
const routes = { orders: 3001, payments: 3002, notifications: 3003 };
const port = Number(process.env.GATEWAY_PORT || 8080);

http
  .createServer((req, res) => {
    const segment = (req.url || "/").split("/")[1].split("?")[0];
    const target = routes[segment];
    if (!target) {
      res.writeHead(segment === "" ? 200 : 404, { "content-type": "application/json" });
      return res.end(JSON.stringify(segment === "" ? { gateway: "shoplite", routes } : { error: "no such service" }));
    }
    const upstream = http.request({ host: "127.0.0.1", port: target, path: req.url, method: req.method, headers: req.headers }, (up) => {
      res.writeHead(up.statusCode || 502, up.headers);
      up.pipe(res);
    });
    upstream.on("error", (e) => {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `upstream ${segment} unavailable: ${e.message}` }));
    });
    req.pipe(upstream);
  })
  .listen(port, () => console.log(`gateway on :${port}`));
