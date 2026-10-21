import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExpectedFile } from "../src/expected/format.js";
import type { FeatureManifest, ServicePart } from "../src/feature/manifest.js";
import { acReadiness, readinessMarkdown, testRunnable } from "../src/feature/readiness.js";
import { isDraftTitle, mrIsDraft } from "../src/scm/gitlab.js";

const part = (service: string, o: Partial<ServicePart> = {}): ServicePart => ({ service, source: "git", merged: true, sha: "a".repeat(40), deployed: { environment: "uat", sha: "a".repeat(40), includesChange: true }, ...o });
const manifest = (parts: ServicePart[], environment: string | null = "uat"): FeatureManifest => ({ story: "SHOP-1", environment: environment ?? undefined, parts, status: "merged", notes: [] });
const expected = (map: Record<string, string[]>): ExpectedFile => ({ version: 1, story: "SHOP-1", acs: Object.entries(map).map(([id, services]) => ({ id, hash: "h", text: id, services, behaviours: [] })) });

describe("acReadiness", () => {
  const orders = part("orders");
  const web = part("web", { deployed: { environment: "uat", sha: "b".repeat(40), includesChange: false } });
  it("each AC waits only for the services it names", () => {
    const r = acReadiness(manifest([orders, web]), expected({ "AC-1": ["orders"], "AC-2": ["orders", "web"] }), ["AC-1", "AC-2"], true);
    expect(r.map((x) => x.state)).toEqual(["ready", "waiting-for-deployment"]);
    expect(r[1].reason).toContain("web");
  });
  it("an AC naming no service needs every part", () => {
    const r = acReadiness(manifest([orders, web]), expected({ "AC-1": [] }), ["AC-1"], true);
    expect(r[0].state).toBe("waiting-for-deployment");
  });
  it("an unmerged part comes first, then the Jira status, then the deployment", () => {
    const open = part("orders", { merged: false, deployed: undefined });
    expect(acReadiness(manifest([open]), undefined, ["AC-1"], false)[0].state).toBe("not-merged");
    expect(acReadiness(manifest([orders]), undefined, ["AC-1"], false)[0].state).toBe("waiting-for-status");
    expect(acReadiness(manifest([orders]), undefined, ["AC-1"], undefined)[0].state).toBe("ready");
  });
  it("cannot tell without an environment or when the deployed commit is unknown", () => {
    expect(acReadiness(manifest([orders], null), undefined, ["AC-1"], true)[0].state).toBe("undetermined");
    const unsure = part("orders", { deployed: { environment: "uat", error: "no version endpoint" } });
    const r = acReadiness(manifest([unsure]), undefined, ["AC-1"], true)[0];
    expect(r.state).toBe("undetermined");
    expect(r.reason).toContain("no version endpoint");
  });
  it("an AC naming a service the story did not change is undetermined, with the fix", () => {
    const r = acReadiness(manifest([orders]), expected({ "AC-1": ["billing"] }), ["AC-1"], true)[0];
    expect(r.state).toBe("undetermined");
    expect(r.reason).toContain("billing");
  });
  it("says which named services were not waited for", () => {
    const r = acReadiness(manifest([orders]), expected({ "AC-1": ["orders", "web"] }), ["AC-1"], true)[0];
    expect(r.state).toBe("ready");
    expect(r.reason).toContain("web named by the AC, not changed in this story");
  });
  it("renders a table", () => {
    const md = readinessMarkdown(acReadiness(manifest([orders]), undefined, ["AC-1"], true)).join("\n");
    expect(md).toContain("| AC-1 | ✅ ready |");
    expect(readinessMarkdown([])).toEqual([]);
  });
});

describe("testRunnable", () => {
  const rows = [
    { ac: "AC-1", state: "ready" as const, services: [], reason: "" },
    { ac: "AC-2", state: "waiting-for-deployment" as const, services: [], reason: "" },
  ];
  it("needs every AC it names to be ready", () => {
    expect(testRunnable(["AC-1"], rows)).toBe(true);
    expect(testRunnable(["AC-1", "AC-2"], rows)).toBe(false);
    expect(testRunnable(["AC-9"], rows)).toBe(false);
  });
  it("a test with no AC tag waits for all of them", () => {
    expect(testRunnable([], rows)).toBe(false);
    expect(testRunnable([], [rows[0]])).toBe(true);
    expect(testRunnable([], [])).toBe(false);
  });
});

describe("draft merge requests", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("knows GitLab's draft prefixes", () => {
    for (const t of ["Draft: x", "draft - x", "[Draft] x", "(Draft) x", "  DRAFT: x"]) expect(isDraftTitle(t)).toBe(true);
    for (const t of ["Drafting rules", "Add draft mode", "Draft-mode toggle", undefined, ""]) expect(isDraftTitle(t)).toBe(false);
  });
  it("asks GitLab first, falls back to the title, and never guesses draft", async () => {
    const ctx = { baseUrl: "https://gl.example", token: "t", apiUrl: "https://gl.example/api/v4", headers: {} } as any;
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ draft: false, title: "Draft: old" }), { status: 200 }));
    expect(await mrIsDraft(ctx, "1", "5", "Draft: old")).toBe(false);
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ draft: true }), { status: 200 }));
    expect(await mrIsDraft(ctx, "1", "5", "ready title")).toBe(true);
    vi.stubGlobal("fetch", async () => new Response("no", { status: 500 }));
    expect(await mrIsDraft(ctx, "1", "5", "Draft: x")).toBe(true);
    expect(await mrIsDraft(undefined, undefined, undefined, "plain")).toBe(false);
  });
});
