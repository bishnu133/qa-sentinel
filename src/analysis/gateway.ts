import type { Config } from "../config.js";
import { normaliseEndpoint } from "../plan/risk.js";

/**
 * Gateways and BFFs. Tests often call a backend-for-frontend or an API gateway, not the service behind it, so a
 * change to `orders-service GET /orders/{id}` matters to tests of `bff GET /api/orders/{id}`. Two ways to say so:
 *
 * - prefix rules on the gateway service (config):  gateway: [{ path: /api/orders, service: orders-service, servicePath: /orders }]
 * - composite endpoints (test-map.yaml), for BFF endpoints that call several services:
 *     services: { bff: { upstream: { "GET /api/home": ["orders-service GET /orders", "catalog GET /items"] } } }
 */
export interface Exposure {
  /** The gateway or BFF service. */
  service: string;
  /** The endpoint there, normalised ("GET /api/orders/{}"). */
  endpoint: string;
  how: "route" | "composite";
}

type UpstreamMap = { services?: Record<string, { upstream?: Record<string, string[]> }> } | undefined;

const trim = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);

/** Where `endpoint` of `service` is reachable through gateways and BFFs (one hop, then through them again: chains). */
export function exposures(c: Config, service: string, endpoint: string, map?: UpstreamMap, depth = 0): Exposure[] {
  if (depth > 3) return [];
  const ep = normaliseEndpoint(endpoint);
  const [method, path] = [ep.split(" ")[0], ep.slice(ep.indexOf(" ") + 1)];
  const out: Exposure[] = [];
  for (const g of c.workspace.services) {
    for (const r of g.gateway ?? []) {
      if (r.service !== service || (r.methods?.length && !r.methods.map((m) => m.toUpperCase()).includes(method))) continue;
      const from = trim(normaliseEndpoint(`X ${r.servicePath ?? r.path}`).slice(2));
      if (path !== from && !path.startsWith(`${from}/`) && from !== "/") continue;
      const rest = from === "/" ? path : path.slice(from.length);
      const to = trim(normaliseEndpoint(`X ${r.path}`).slice(2));
      out.push({ service: g.name, endpoint: normaliseEndpoint(`${method} ${to === "/" ? rest || "/" : `${to}${rest}`}`), how: "route" });
    }
    for (const [bffEp, calls] of Object.entries(map?.services?.[g.name]?.upstream ?? {})) {
      const hit = (calls ?? []).some((call) => {
        const m = call.trim().match(/^(\S+)\s+(\S+\s+\S+)$/);
        return m && m[1] === service && normaliseEndpoint(m[2]) === ep;
      });
      if (hit) out.push({ service: g.name, endpoint: normaliseEndpoint(bffEp), how: "composite" });
    }
  }
  // A BFF in front of a gateway: follow the chain.
  const more = out.flatMap((x) => exposures(c, x.service, x.endpoint, map, depth + 1));
  const all = [...out, ...more];
  return all.filter((x, i) => all.findIndex((y) => y.service === x.service && y.endpoint === x.endpoint) === i);
}
