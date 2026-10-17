import { describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { exposures } from "../src/analysis/gateway.js";
import { selectRegression } from "../src/analysis/regression.js";
import { endpointCoverage, specOperations } from "../src/analysis/coverage.js";
import { indexSource } from "../src/analysis/testIndex.js";

const c = ConfigSchema.parse({
  version: 1,
  mode: "existing",
  project: { name: "p" },
  tests: { api: { framework: "playwright", runCommand: "x" } },
  ci: { platform: "gitlab" },
  workspace: {
    services: [
      { name: "orders-service", path: "../o" },
      { name: "catalog", path: "../c" },
      { name: "bff", path: "../bff", gateway: [{ path: "/api/orders", service: "orders-service", servicePath: "/orders" }, { path: "/api/catalog", service: "catalog", servicePath: "/", methods: ["GET"] }] },
      { name: "edge", path: "../edge", gateway: [{ path: "/v1", service: "bff", servicePath: "/api" }] },
    ],
  },
});
const map = { services: { bff: { upstream: { "GET /api/home": ["orders-service GET /orders", "catalog GET /items"] } } } };

describe("gateway and BFF awareness (A2)", () => {
  it("finds where a service endpoint is exposed: prefix routes, composite BFF endpoints, chains", () => {
    expect(exposures(c, "orders-service", "GET /orders/{id}", map)).toEqual([
      { service: "bff", endpoint: "GET /api/orders/{}", how: "route" },
      { service: "edge", endpoint: "GET /v1/orders/{}", how: "route" },
    ]);
    expect(exposures(c, "orders-service", "GET /orders", map).map((x) => `${x.service} ${x.endpoint} ${x.how}`)).toEqual(["bff GET /api/orders route", "bff GET /api/home composite", "edge GET /v1/orders route", "edge GET /v1/home route"]);
    expect(exposures(c, "catalog", "POST /items", map)).toEqual([]); // GET only
    expect(exposures(c, "catalog", "GET /items/{id}", map)[0]).toEqual({ service: "bff", endpoint: "GET /api/catalog/items/{}", how: "route" });
  });

  it("selects tests that call the BFF for a service change, and counts them as coverage", () => {
    const index = [
      ...indexSource("tests/api/bff-orders.spec.ts", 'test("order via bff @service:bff @endpoint:GET_/api/orders/{id}", async () => { expect(1).toBe(1); });'),
      ...indexSource("tests/api/other.spec.ts", 'test("other @service:bff @endpoint:GET_/api/profile", async () => { expect(1).toBe(1); });'),
    ];
    const sel = selectRegression({ c, service: "orders-service", contract: { status: "compared", changes: [{ endpoint: "GET /orders/{}", kind: "field-added", location: "x", detail: "d", breaking: false }] }, index, map: undefined });
    expect(sel.tests.map((t) => [t.test.file, t.reasons])).toEqual([["tests/api/bff-orders.spec.ts", ["via-gateway"]]]);

    const ops = specOperations(JSON.stringify({ openapi: "3.0.0", paths: { "/orders/{id}": { get: { responses: { "200": { description: "ok" } } } } } }));
    const cov = endpointCoverage(c.workspace.services[0], ops, index, undefined, (op) => exposures(c, "orders-service", op.endpoint));
    expect(cov[0].status).toBe("tested");
  });
});
