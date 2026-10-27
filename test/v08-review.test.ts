import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";
import { pendingRecords, sweep, sweepUrl } from "../src/testData.js";
import { checkContract, contractCheckMarkdown } from "../src/contracts.js";
import { ConfigSchema } from "../src/config.js";
import { downloadAttachment } from "../src/scm/jira.js";
import { initCommand } from "../src/commands/init.js";
import { render } from "../src/templates.js";
import { computeCoverage } from "../src/commands/coverage.js";
import { contractCheckCommand } from "../src/commands/contractCheck.js";
import { discoverCommand } from "../src/commands/discover.js";

const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const line = (o: object) => JSON.stringify(o) + "\n";

describe("v0.8 review fixes", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("the sweeper only ever calls the test environment's origin, under its base path", async () => {
    expect(sweepUrl("http://qa.local/api/", "/users/1")).toBe("http://qa.local/api/users/1");
    for (const bad of ["/http://evil.com/x", "/\\\\evil.com/x", "//evil.com/x", "/%5cevil.com", "/https:evil.com", "/a b"]) expect(sweepUrl("http://qa.local/api", bad)).toBeUndefined();
    const dir = tmp("qas-sweep-");
    fs.writeFileSync(path.join(dir, "r.jsonl"), line({ op: "create", seq: 1, kind: "x", id: "1", remove: { path: "/http://evil.com/x" }, at: "2026-01-01T00:00:00Z" }));
    const fetchImpl = vi.fn();
    const r = await sweep({ dir, baseUrl: "http://qa.local/", authHeader: "Bearer secret", fetchImpl: fetchImpl as never });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(r.failed).toHaveLength(1);
  });

  it("after its own run, generate sweeps only ledgers started during that run", () => {
    const dir = tmp("qas-sweep-");
    fs.writeFileSync(path.join(dir, "old.jsonl"), line({ op: "create", seq: 1, kind: "x", id: "old", remove: { path: "/x/old" }, at: "2026-01-01T00:00:00Z" }));
    fs.writeFileSync(path.join(dir, "new.jsonl"), line({ op: "create", seq: 1, kind: "x", id: "new", remove: { path: "/x/new" }, at: new Date().toISOString() }));
    expect(pendingRecords(dir, { startedAfter: Date.now() - 60_000 }).map((p) => p.id)).toEqual(["new"]);
  });

  it("CI sweeps after every test job: installs qa-sentinel only when data was left, with the environment URL restored", async () => {
    const root = tmp("qas-ci-");
    await initCommand({ cwd: root, yes: true, mode: "scratch", ci: "gitlab", workspace: root, name: "demo" });
    const ci = fs.readFileSync(path.join(root, "ci/qa-sentinel/tests.gitlab-ci.yml"), "utf8");
    const doc = YAML.parse(ci, { customTags: [{ tag: "!reference", collection: "seq", resolve: (v: unknown) => v }] });
    const after: string[] = doc[".qa-node"].after_script.map(String);
    expect(after.join("\n")).toContain("sed -n"); // the URL is read as text from .qa-env.sh, never sourced
    expect(after.join("\n")).not.toContain(". \"$CI_PROJECT_DIR/.qa-env.sh\"");
    expect(after.join("\n")).toContain("export QA_BASE_URL=\"$qa_url\"");
    expect(after.join("\n")).toContain("qa-sentinel data sweep --older-than 0");
    expect(ci).toContain(`echo "export QA_BASE_URL='$QA_BASE_URL'" > "$CI_PROJECT_DIR/.qa-env.sh"`);
    expect(doc[".qa-sentinel-install"].script[0]).toContain('if [ "${QA_INSTALL_SKIP:-}" != "1" ]');
    expect(render("x{{ledgerDir}}", { ledgerDir: ".qa-data" })).toBe("x.qa-data");
  });

  it("specs written with a base path compare with specs that inline it; per-MR reports show only touched endpoints", () => {
    const agreed = { openapi: "3.0.0", servers: [{ url: "https://api.acme.test/api/v1" }], paths: { "/orders": { get: { responses: { "200": { description: "ok" } } } } } };
    const impl = { openapi: "3.0.0", paths: { "/api/v1/orders": { get: { responses: { "200": { description: "ok" } } } } } };
    expect(checkContract("o", { text: JSON.stringify(agreed), from: "x" }, JSON.stringify(impl)).status).toBe("conforms");
    const withRef = { ...impl, paths: { "/api/v1/orders": { get: { responses: { "200": { content: { "application/json": { schema: { $ref: "./schemas.yaml#/Order" } } } } } } } } };
    expect(checkContract("o", { text: JSON.stringify(withRef), from: "x" }, JSON.stringify(withRef)).note).toMatch(/aren't followed/);

    const implV1 = { openapi: "3.0.0", servers: [{ url: "/api/v1" }], paths: { "/orders": { get: { responses: { "200": { description: "ok" } } } } } };
    const k = checkContract("o", { text: JSON.stringify({ ...agreed, paths: { ...agreed.paths, "/orders/{id}": { get: { responses: { "200": { description: "ok" } } } } } }), from: "x" }, JSON.stringify(implV1));
    expect(k.deviations[0]).toMatchObject({ endpoint: "GET /api/v1/orders/{}", localEndpoint: "GET /orders/{}" });
    // The MR touched nothing in the spec: the old deviation is counted, not listed.
    const md = contractCheckMarkdown([k], new Set());
    expect(md).toContain("0 mismatches and 0 extra on the endpoints this change touches");
    expect(md).toContain("1 more deviation on endpoints this change doesn't touch");
    expect(contractCheckMarkdown([k], new Set(["GET /orders/{}"]))).toContain("| ❌ mismatch | GET /orders/{} |");
  });

  it("refuses a huge Jira attachment before downloading it", async () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    await expect(downloadAttachment({ baseUrl: "https://acme.atlassian.net", authHeader: "x" }, "https://acme.atlassian.net/a/1", 500 * 1024 * 1024)).rejects.toThrow(/larger than 5 MB/);
    expect(f).not.toHaveBeenCalled();
  });

  it("service names must be unique; coverage and contract-check use --service-path and say when the repo is missing", async () => {
    const base = { version: 1, mode: "existing", project: { name: "p" }, tests: { api: { framework: "playwright", runCommand: "x" } }, ci: { platform: "gitlab" } };
    expect(() => ConfigSchema.parse({ ...base, workspace: { services: [{ name: "a", path: "." }, { name: "a", path: "../x" }] } })).toThrow(/two services are named/);

    const qa = tmp("qas-svcpath-");
    fs.mkdirSync(path.join(qa, "specs"));
    fs.writeFileSync(path.join(qa, "specs/o.yaml"), YAML.stringify({ openapi: "3.0.0", paths: { "/o": { get: { responses: { "200": { description: "ok" } } } } } }));
    fs.writeFileSync(path.join(qa, "qa-sentinel.config.yaml"), YAML.stringify({ ...base, workspace: { services: [{ name: "o", path: "../not-cloned", openapi: "openapi.yaml", contract: { file: "specs/o.yaml" } }] } }));
    const c = ConfigSchema.parse(YAML.parse(fs.readFileSync(path.join(qa, "qa-sentinel.config.yaml"), "utf8")));
    // No clone, but a contract: coverage falls back to it.
    expect((await computeCoverage(qa, c, "o")).endpoints.map((e) => e.endpoint)).toEqual(["GET /o"]);
    // With --service-path pointing to a checkout without a spec file: no crash, and the contract still lists the endpoints.
    const checkout = tmp("qas-checkout-");
    expect((await computeCoverage(qa, c, "o", checkout)).endpoints).toHaveLength(1);
    await contractCheckCommand({ cwd: qa });
    expect(fs.readFileSync(path.join(qa, "qa-contract-check.md"), "utf8")).toContain("the service repo isn't at");
  });

  it("discover keeps names unique across subgroups and never writes an invalid config", async () => {
    const projects = [
      { id: 1, path: "orders", path_with_namespace: "acme/team-a/orders", default_branch: "main" },
      { id: 2, path: "orders", path_with_namespace: "acme/team-b/orders", default_branch: "main" },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const p = decodeURIComponent(new URL(url).pathname.replace(/^\/api\/v4/, ""));
        if (p === "/groups/acme/projects") return new Response(JSON.stringify(projects));
        if (/\/repository\/tree$/.test(p)) return new Response(JSON.stringify([{ type: "blob", path: "package.json" }, { type: "blob", path: "openapi.yaml" }]));
        if (/package\.json\/raw$/.test(p)) return new Response(JSON.stringify({ dependencies: { express: "4" } }));
        return new Response("", { status: 404 });
      }),
    );
    const cwd = tmp("qas-disc-");
    const cfg = { version: 1, mode: "existing", project: { name: "p" }, tests: { api: { framework: "playwright", runCommand: "x" } }, ci: { platform: "gitlab", gitlabUrl: "https://gl.test" }, workspace: { services: [] } };
    fs.writeFileSync(path.join(cwd, "qa-sentinel.config.yaml"), YAML.stringify(cfg));
    await discoverCommand({ cwd, group: "acme", env: { QA_SENTINEL_GITLAB_TOKEN: "t" }, apply: true });
    const names = YAML.parse(fs.readFileSync(path.join(cwd, "qa-sentinel.config.yaml"), "utf8")).workspace.services.map((s: { name: string }) => s.name);
    expect(names).toEqual(["team-a-orders", "team-b-orders"]);
  });
});
