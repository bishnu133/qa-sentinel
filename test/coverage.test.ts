import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import YAML from "yaml";

const prompts: { kind: string; prompt: string; cwd: string }[] = [];
vi.mock("../src/engines/ClaudeCodeEngine.js", () => ({
  engineFor: () => ({
    run: async (r: { kind: string; prompt: string; cwd: string }) => {
      prompts.push(r);
      return { ok: true, status: "success", result: "done", usage: {} };
    },
  }),
}));

import { endpointFactors, rankGaps, specOperations, endpointCoverage, coverageMarkdown } from "../src/analysis/coverage.js";
import { indexSource } from "../src/analysis/testIndex.js";
import { coverageCommand } from "../src/commands/coverage.js";
import { backfillCommand } from "../src/commands/backfill.js";

const sh = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();

const spec = {
  openapi: "3.0.0",
  info: { title: "shop", version: "1" },
  paths: {
    "/health": { get: { summary: "Health", responses: { "200": { description: "ok" } } } },
    "/orders": {
      get: { summary: "List orders", responses: { "200": { description: "ok" } } },
      post: {
        summary: "Place an order",
        requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/NewOrder" } } } },
        responses: { "201": { description: "created" }, "409": { description: "slot full" } },
      },
    },
    "/orders/{id}/refund": { post: { summary: "Refund", requestBody: { content: { "application/json": { schema: { type: "object", properties: { reason: { type: "string" } } } } } }, responses: { "200": { description: "ok" } } } },
    "/auth/login": { post: { summary: "Sign in", responses: { "200": { description: "ok" } } } },
    "/customers/{id}": { get: { responses: { "200": { content: { "application/json": { schema: { type: "object", properties: { email: { type: "string" } } } } } } } } },
    "/legacy": { get: { deprecated: true, responses: { "200": { description: "ok" } } } },
  },
  components: { schemas: { NewOrder: { type: "object", properties: { slotId: { type: "string" }, unitPrice: { type: "number" } } } } },
};

const tests = `
import { test, expect } from "../../src/fixtures";
test("lists orders @service:orders @endpoint:GET_/orders", async ({ api }) => {
  const res = await api.get("/orders");
  expect(res.status()).toBe(200);
});
test("health @endpoint:GET_/health", async ({ api }) => {
  const res = await api.get("/health");
  expect(res.status()).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
});
test.fixme("refund over the amount @endpoint:POST_/orders/{id}/refund", async ({ api }) => {
  expect((await api.post("/orders/1/refund", {})).status()).toBe(422);
});
`;

describe("coverage and backfill", () => {
  it("lists every operation and reads its risk from what the spec says (money in a $ref'd body, auth, personal data)", () => {
    const ops = specOperations(JSON.stringify(spec));
    expect(ops.map((o) => o.endpoint)).toEqual(["GET /health", "GET /orders", "POST /orders", "POST /orders/{}/refund", "POST /auth/login", "GET /customers/{}", "GET /legacy"]);
    const f = (ep: string) => endpointFactors(ops.find((o) => o.endpoint === ep)!);
    expect(f("POST /orders")).toEqual(expect.arrayContaining(["money", "validation", "write-path-error-handling"])); // unitPrice, body, 409
    expect(f("POST /orders/{}/refund")).toContain("money");
    expect(f("POST /auth/login")).toContain("auth");
    expect(f("GET /customers/{}")).toContain("personal-data");
    expect(f("GET /health")).toEqual(["read-only"]);
    // A health check in the payments service is not money code.
    expect(endpointFactors({ endpoint: "GET /payments/health", fullEndpoint: "GET /payments/health", method: "GET", path: "/payments/health", statuses: ["200"], hasBody: false, deprecated: false, words: "/payments/health" })).toEqual(["read-only"]);
  });

  it("finds each endpoint's tests by tag or test-map, tells untested, pending and status-only apart, riskiest first", () => {
    const index = indexSource("tests/api/orders.spec.ts", tests);
    const svc = { name: "orders", path: ".", dependsOn: [], kind: "api", routes: [] } as never;
    const cov = endpointCoverage(svc, specOperations(JSON.stringify(spec)), index, { services: { orders: { endpoints: { "GET /customers/{id}": ["tests/api/orders.spec.ts"] } } } });
    const by = (ep: string) => cov.find((c) => c.endpoint === ep)!;
    expect(by("GET /health").status).toBe("tested");
    expect(by("GET /orders").status).toBe("weak"); // status-only
    expect(by("POST /orders/{}/refund").status).toBe("pending"); // only fixme
    expect(by("GET /customers/{}").status).toBe("tested"); // via test-map.yaml
    expect(by("POST /orders").status).toBe("untested");
    expect(rankGaps(cov).map((g) => `${g.risk} ${g.endpoint} ${g.status}`)).toEqual([
      "critical POST /auth/login untested",
      "critical POST /orders untested",
      "critical POST /orders/{}/refund pending",
      "low GET /orders weak",
    ]); // deprecated /legacy is left out
    const md = coverageMarkdown({ endpoints: cov, pages: [], notes: [] });
    expect(md).toContain("| orders | 7 | 29% | 3 / 0 / 1 | – |");
    expect(md).toContain("| 1 | critical | orders | POST /auth/login – Sign in | ⛔ untested | auth |");
  });

  it("coverage and backfill commands: report, then one batch through planning with the contract as oracle", async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "qas-cov-"));
    const svc = path.join(work, "orders");
    fs.mkdirSync(svc);
    sh(svc, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(svc, "openapi.yaml"), YAML.stringify(spec));
    sh(svc, "add", "-A");
    sh(svc, "commit", "-qm", "spec");
    const qa = path.join(work, "qa-tests");
    fs.mkdirSync(path.join(qa, "tests/api"), { recursive: true });
    fs.writeFileSync(path.join(qa, "tests/api/orders.spec.ts"), tests);
    fs.writeFileSync(
      path.join(qa, "qa-sentinel.config.yaml"),
      YAML.stringify({
        version: 1,
        mode: "existing",
        project: { name: "shop" },
        tests: { api: { framework: "playwright", runCommand: "npx playwright test" } },
        ci: { platform: "gitlab" },
        workspace: { services: [{ name: "orders", path: "../orders", openapi: "openapi.yaml" }, { name: "storefront", path: "../web", kind: "web", routes: ["/orders/new"] }] },
      }),
    );
    fs.writeFileSync(path.join(qa, ".gitignore"), ".qa-sentinel/\nqa-coverage.*\n");
    sh(qa, "init", "-q", "-b", "main");
    sh(qa, "add", "-A");
    sh(qa, "commit", "-qm", "tests");

    expect(await coverageCommand({ cwd: qa })).toBe(0);
    const md = fs.readFileSync(path.join(qa, "qa-coverage.md"), "utf8");
    expect(md).toContain("| storefront | 0 | – | 0 / 0 / 0 | 0/1 |");
    expect(md).toContain("| storefront | /orders/new | ⛔ untested |");
    expect(JSON.parse(fs.readFileSync(path.join(qa, "qa-coverage.json"), "utf8")).endpoints).toHaveLength(7);

    expect(await backfillCommand({ cwd: qa, service: "orders", batch: 2, dryRun: true })).toBe(0);
    expect(prompts).toHaveLength(0);

    prompts.length = 0;
    await backfillCommand({ cwd: qa, service: "orders", batch: 2, minRisk: "critical" });
    const plan = prompts.find((p) => p.kind === "plan")!;
    expect(plan).toBeDefined();
    const runRel = plan.prompt.match(/Run context: (\S+)\/context\.json/)![1];
    const ctx = JSON.parse(fs.readFileSync(path.join(qa, runRel, "context.json"), "utf8"));
    expect(ctx.kind).toBe("backfill");
    expect(ctx.backfill.map((b: { endpoint: string }) => b.endpoint)).toEqual(["POST /auth/login", "POST /orders"]);
    expect(fs.readFileSync(path.join(qa, runRel, "change.diff"), "utf8")).toContain("- POST /orders – Place an order (risk critical; untested)");
    expect(fs.readFileSync(path.join(qa, runRel, "story.md"), "utf8")).toBeTruthy();
  });
});
