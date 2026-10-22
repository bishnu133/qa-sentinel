import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";
import { ConfigSchema } from "../src/config.js";
import { checkContract, contractCheckMarkdown, loadContract } from "../src/contracts.js";
import { computeContractDiff } from "../src/plan/planner.js";
import { contractCheckCommand } from "../src/commands/contractCheck.js";

const sh = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();

/** The spec the team agreed before coding: GET /orders/{id} returns id, total and status, and 404 when unknown. POST /orders 201 or 409. */
const agreed = {
  openapi: "3.0.0",
  info: { title: "orders", version: "1" },
  paths: {
    "/orders/{id}": {
      get: {
        responses: {
          "200": { content: { "application/json": { schema: { type: "object", required: ["id", "total", "status"], properties: { id: { type: "string" }, total: { type: "number" }, status: { type: "string", enum: ["new", "paid"] } } } } } },
          "404": { content: { "application/json": { schema: { type: "object", properties: { message: { type: "string" } } } } } },
        },
      },
    },
    "/orders": {
      post: {
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["slot"], properties: { slot: { type: "string" } } } } } },
        responses: { "201": { description: "created" }, "409": { description: "slot full" } },
      },
    },
  },
};

/** What the code implements: total became a string, no 404 documented, no 409, and an extra DELETE. */
function implemented() {
  const s = structuredClone(agreed) as any;
  s.paths["/orders/{id}"].get.responses["200"].content["application/json"].schema.properties.total = { type: "string" };
  delete s.paths["/orders/{id}"].get.responses["404"];
  delete s.paths["/orders"].post.responses["409"];
  s.paths["/orders/{id}"].delete = { responses: { "204": { description: "deleted" } } };
  return s;
}

const config = (services: unknown[]) =>
  ConfigSchema.parse({ version: 1, mode: "scratch", project: { name: "p" }, tests: { api: { framework: "playwright", runCommand: "x" } }, ci: { platform: "gitlab" }, requirements: { jira: { baseUrl: "https://acme.atlassian.net" } }, workspace: { services } });

describe("spec-first contracts (agreed API spec outside the service repo)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("accepts exactly one source, and says what's wrong otherwise", () => {
    expect(() => config([{ name: "o", path: ".", contract: { file: "specs/o.yaml" } }])).not.toThrow();
    expect(() => config([{ name: "o", path: ".", contract: { gitlabProject: "g/specs", path: "o.yaml", ref: "v2" } }])).not.toThrow();
    expect(() => config([{ name: "o", path: ".", contract: { file: "a.yaml", url: "https://x/y.yaml" } }])).toThrow(/exactly one/);
    expect(() => config([{ name: "o", path: ".", contract: { repo: "../specs" } }])).toThrow(/need `path`/);
    expect(() => config([{ name: "o", path: ".", contract: {} }])).toThrow(/exactly one/);
  });

  it("finds every way the code differs from the agreed spec, error responses included", () => {
    const k = checkContract("orders", { text: JSON.stringify(agreed), from: "file specs/orders.yaml" }, JSON.stringify(implemented()));
    expect(k.status).toBe("checked");
    const by = (loc: string) => k.deviations.find((d) => d.location === loc);
    expect(by("response.200.body.total")).toMatchObject({ severity: "mismatch", kind: "type-changed" });
    expect(by("response.404")).toMatchObject({ severity: "mismatch", detail: expect.stringContaining("agreed response not in the code (404)") });
    expect(by("response.409")).toMatchObject({ severity: "mismatch", endpoint: "POST /orders" });
    expect(k.deviations.find((d) => d.endpoint === "DELETE /orders/{}")).toMatchObject({ severity: "extra", detail: "implemented, but not in the agreed spec" });

    expect(checkContract("orders", { text: JSON.stringify(agreed), from: "x" }, JSON.stringify(agreed)).status).toBe("conforms");
    expect(checkContract("orders", { text: JSON.stringify(agreed), from: "x" }, undefined).status).toBe("no-implementation-spec");
    expect(checkContract("orders", undefined, "{}", "file not found")).toMatchObject({ status: "no-contract", note: "file not found" });
  });

  it("keeps a per-MR report about the endpoints the MR touches and counts the rest", () => {
    const k = checkContract("orders", { text: JSON.stringify(agreed), from: "file specs/orders.yaml" }, JSON.stringify(implemented()));
    const md = contractCheckMarkdown([k], new Set(["POST /orders"]));
    expect(md).toContain("1 mismatch and 0 extra on the endpoints this change touches");
    expect(md).toContain("| ❌ mismatch | POST /orders | `response.409` |");
    expect(md).not.toContain("GET /orders/{}");
    expect(md).toMatch(/3 more deviations on endpoints this change doesn't touch/);
  });

  it("loads the agreed spec from a file, a specs repo at a ref, or a Jira attachment (newest match, same site only)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qas-contract-"));
    fs.mkdirSync(path.join(dir, "specs"));
    fs.writeFileSync(path.join(dir, "specs/orders.yaml"), YAML.stringify(agreed));
    const c = config([]);
    expect((await loadContract(c, { file: "specs/orders.yaml" }, { cwd: dir })).contract?.text).toContain("/orders/{id}");
    expect((await loadContract(c, { file: "nope.yaml" }, { cwd: dir })).reason).toMatch(/file not found/);

    const specs = path.join(dir, "api-specs");
    fs.mkdirSync(specs);
    sh(specs, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(specs, "orders.yaml"), "v1");
    sh(specs, "add", "-A");
    sh(specs, "commit", "-qm", "v1");
    sh(specs, "tag", "v1");
    fs.writeFileSync(path.join(specs, "orders.yaml"), "v2");
    sh(specs, "commit", "-qam", "v2");
    expect((await loadContract(c, { repo: "api-specs", path: "orders.yaml", ref: "v1" }, { cwd: dir })).contract?.text).toBe("v1");
    expect((await loadContract(c, { repo: "api-specs", path: "orders.yaml" }, { cwd: dir })).contract?.text).toBe("v2");

    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push(`${url} ${(init?.headers as Record<string, string>)?.Authorization ? "auth" : "anon"}`);
        if (url.includes("fields=attachment"))
          return new Response(
            JSON.stringify({
              fields: {
                attachment: [
                  { id: "1", filename: "orders-api-v1.yaml", content: "https://acme.atlassian.net/att/1", created: "2026-01-01T00:00:00.000+0000" },
                  { id: "2", filename: "orders-api-v2.yaml", content: "https://acme.atlassian.net/att/2", created: "2026-02-01T00:00:00.000+0000" },
                  { id: "3", filename: "screenshot.png", content: "https://acme.atlassian.net/att/3", created: "2026-03-01T00:00:00.000+0000" },
                ],
              },
            }),
          );
        return new Response(url.endsWith("/2") ? "agreed v2" : "agreed v1");
      }),
    );
    const env = { JIRA_EMAIL: "a@b", JIRA_API_TOKEN: "t" };
    const r = await loadContract(c, { jiraAttachment: "orders-api*.yaml" }, { cwd: dir, storyKey: "SHOP-1", env });
    expect(r.contract).toEqual({ text: "agreed v2", from: "Jira SHOP-1 attachment orders-api-v2.yaml" });
    expect(calls.at(-1)).toBe("https://acme.atlassian.net/att/2 auth");
    expect((await loadContract(c, { jiraAttachment: "*.yaml" }, { cwd: dir, env })).reason).toMatch(/no story/);

    // A link to another host never gets the Jira credentials.
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ fields: { attachment: [{ id: "9", filename: "o.yaml", content: "https://evil.example/o.yaml" }] } }))));
    expect((await loadContract(c, { jiraAttachment: "o.yaml" }, { cwd: dir, storyKey: "SHOP-1", env })).reason).toMatch(/not on the Jira baseUrl origin https:\/\/acme.atlassian.net/);
  });

  it("puts the check into gap-report runs (contract-diff.md, contract-check.md, the agreed spec for the agents) and the contract-check command", async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "qas-contract-run-"));
    const repo = path.join(work, "orders");
    fs.mkdirSync(repo);
    sh(repo, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(repo, "openapi.yaml"), YAML.stringify(agreed));
    sh(repo, "add", "-A");
    sh(repo, "commit", "-qm", "base");
    const base = sh(repo, "rev-parse", "HEAD");
    fs.writeFileSync(path.join(repo, "openapi.yaml"), YAML.stringify(implemented()));
    sh(repo, "commit", "-qam", "head");
    const head = sh(repo, "rev-parse", "HEAD");
    const tests = path.join(work, "qa-tests");
    fs.mkdirSync(path.join(tests, "specs"), { recursive: true });
    fs.writeFileSync(path.join(tests, "specs/orders.yaml"), YAML.stringify(agreed));

    const svc = { name: "orders", path: "../orders", openapi: "openapi.yaml", contract: { file: "specs/orders.yaml" } };
    const c = config([svc]);
    const run = fs.mkdtempSync(path.join(os.tmpdir(), "qas-run-"));
    const d = await computeContractDiff({ c, cwd: tests, service: c.workspace.services[0], repo, cs: { base, head } as never, run: { dir: run, rel: "run" } as never });
    expect(d.agreed?.[0].deviations.some((x) => x.severity === "mismatch")).toBe(true);
    expect(fs.readFileSync(path.join(run, "contract-diff.md"), "utf8")).toContain("Agreed API contract — orders");
    expect(fs.readFileSync(path.join(run, "agreed-spec-orders.yaml"), "utf8")).toContain("/orders/{id}");
    expect(JSON.parse(fs.readFileSync(path.join(run, "contract-check.json"), "utf8"))[0].service).toBe("orders");

    fs.writeFileSync(path.join(tests, "qa-sentinel.config.yaml"), YAML.stringify({ version: 1, mode: "scratch", project: { name: "p" }, tests: { api: { framework: "playwright", runCommand: "x" } }, ci: { platform: "gitlab" }, workspace: { services: [svc] } }));
    expect(await contractCheckCommand({ cwd: tests, strict: true })).toBe(1);
    expect(await contractCheckCommand({ cwd: tests, ref: base })).toBe(0);
    expect(await contractCheckCommand({ cwd: tests, ref: base, strict: true })).toBe(0); // base conforms
    expect(fs.readFileSync(path.join(tests, "qa-contract-check.md"), "utf8")).toContain("matches it");
  });
});
