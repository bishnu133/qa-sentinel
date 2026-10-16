import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { beforeEach, describe, expect, it } from "vitest";
import { clearSpecCache, specAt } from "../src/specs.js";
import { diffSpecs } from "../src/analysis/contractDiff.js";
import { computeContractDiff } from "../src/plan/planner.js";
import { ConfigSchema } from "../src/config.js";

const sh = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();

/** A service whose spec is generated from its routes by a tool in node_modules (like tsoa), never committed. */
function service() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "qas-specs-"));
  sh(repo, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules/\nopenapi.yaml\n");
  fs.mkdirSync(path.join(repo, "node_modules/fake-tsoa"), { recursive: true });
  fs.writeFileSync(
    path.join(repo, "node_modules/fake-tsoa/index.js"),
    `const fs = require("fs"); const routes = JSON.parse(fs.readFileSync("routes.json", "utf8"));
const paths = {}; for (const r of routes) paths[r.path] = { [r.method]: { responses: { "200": { description: "ok" } } } };
fs.writeFileSync("openapi.yaml", JSON.stringify({ openapi: "3.0.0", info: { title: "s", version: "1" }, paths }));`,
  );
  fs.writeFileSync(path.join(repo, "routes.json"), JSON.stringify([{ method: "get", path: "/orders/{id}" }]));
  sh(repo, "add", "-A");
  sh(repo, "commit", "-q", "-m", "base");
  const base = sh(repo, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(repo, "routes.json"), JSON.stringify([{ method: "get", path: "/orders/{id}" }, { method: "post", path: "/orders" }]));
  sh(repo, "commit", "-qam", "add POST /orders");
  const head = sh(repo, "rev-parse", "HEAD");
  return { repo, base, head };
}

const svc = { name: "orders", openapi: "openapi.yaml", openapiCommand: "node node_modules/fake-tsoa/index.js" };
const env = { PATH: process.env.PATH, HOME: process.env.HOME };

describe("generated OpenAPI specs (openapiCommand)", () => {
  beforeEach(() => clearSpecCache());

  it("generates the spec at base and head in throwaway worktrees, so a spec that isn't committed still gets a contract diff", async () => {
    const { repo, base, head } = service();
    const b = await specAt(repo, base, svc, { env });
    const h = await specAt(repo, head, svc, { env });
    expect(b).toContain("/orders/{id}");
    expect(h).toContain('"/orders"');
    const d = diffSpecs(b, h);
    expect(d.status).toBe("compared");
    expect(d.changes.map((c) => c.endpoint)).toContain("POST /orders");
    // Nothing left behind: no extra worktree, no generated file in the service checkout.
    expect(sh(repo, "worktree", "list").split("\n")).toHaveLength(1);
    expect(fs.existsSync(path.join(repo, "openapi.yaml"))).toBe(false);
  });

  it("reads committed specs from git as before, and gives no spec (not an error) when the command fails", async () => {
    const { repo, head } = service();
    expect(await specAt(repo, head, { name: "orders", openapi: "openapi.yaml" }, { env })).toBeUndefined(); // not committed
    expect(await specAt(repo, head, { ...svc, openapiCommand: "exit 3" }, { env })).toBeUndefined();
    expect(await specAt(repo, head, { ...svc, openapiCommand: "sleep 5" }, { env, timeoutMs: 300 })).toBeUndefined();
    expect(sh(repo, "worktree", "list").split("\n")).toHaveLength(1);
  });

  it("feeds the contract diff in gap reports and gives the agent the generated head spec", async () => {
    const { repo, base, head } = service();
    const c = ConfigSchema.parse({ version: 1, mode: "scratch", project: { name: "p" }, tests: { api: { framework: "playwright", runCommand: "x" } }, ci: { platform: "gitlab" }, workspace: { services: [{ name: "orders", path: repo, ...svc }] } });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qas-run-"));
    const d = await computeContractDiff({ c, service: c.workspace.services[0], repo, cs: { base, head } as never, run: { dir, rel: "run" } as never });
    expect(d.changes.map((x) => x.endpoint)).toContain("POST /orders");
    expect(fs.readFileSync(path.join(dir, "spec-orders.yaml"), "utf8")).toContain('"/orders"');
  });

  it("never runs the MR's git hooks during the checkout (they could read CI secrets)", async () => {
    const { repo, base, head } = service();
    const marker = path.join(os.tmpdir(), `qas-hook-${process.pid}-${Date.now()}`);
    fs.mkdirSync(path.join(repo, ".husky"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".husky/post-checkout"), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
    sh(repo, "add", "-A");
    sh(repo, "commit", "-qm", "hook");
    sh(repo, "config", "core.hooksPath", ".husky");
    expect(await specAt(repo, "HEAD", svc, { env })).toContain("/orders");
    expect(await specAt(repo, base, svc, { env })).toBeTruthy();
    expect(fs.existsSync(marker)).toBe(false);
    void head;
  });

  it("runs in the service's folder when the service is a folder of a monorepo, with dependencies hoisted to the root", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "qas-specs-mono-"));
    sh(root, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(root, ".gitignore"), "node_modules/\nopenapi.yaml\n");
    fs.mkdirSync(path.join(root, "node_modules/fake-tsoa"), { recursive: true });
    fs.writeFileSync(path.join(root, "node_modules/fake-tsoa/index.js"), `require("fs").writeFileSync("openapi.yaml", JSON.stringify({ openapi: "3.0.0", info: { title: "s", version: "1" }, paths: { [require("fs").readFileSync("route.txt", "utf8").trim()]: { get: { responses: { "200": { description: "ok" } } } } } }));`);
    fs.mkdirSync(path.join(root, "services/orders"), { recursive: true });
    fs.writeFileSync(path.join(root, "services/orders/route.txt"), "/orders\n");
    sh(root, "add", "-A");
    sh(root, "commit", "-qm", "init");
    const spec = await specAt(path.join(root, "services/orders"), "HEAD", { ...svc, openapiCommand: "node ../../node_modules/fake-tsoa/index.js" }, { env });
    expect(spec).toContain('"/orders"');
  });
});
