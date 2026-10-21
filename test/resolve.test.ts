import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { parseLinks, type JiraIssue } from "../src/scm/jira.js";
import { isReadyStatus, linkApplies, resolveFeature, servicesFromComponents, statusSets } from "../src/stories/resolve.js";
import { inputsFromJira } from "../src/stories/gather.js";
import { jiraConfigChecks } from "../src/commands/doctor.js";

const cfg = (jira: Record<string, unknown> = {}) =>
  ConfigSchema.parse({
    version: 1,
    mode: "existing",
    project: { name: "t" },
    tests: { api: { framework: "playwright", runCommand: "npx playwright test" } },
    ci: { platform: "gitlab" },
    requirements: { source: "jira", jira: { baseUrl: "https://j.example", projectKeys: ["SHOP"], featureIssueTypes: ["Story"], hierarchy: { links: [{ name: "is caused by", from: ["Bug"] }] }, ...jira } },
  });

const issue = (key: string, issueType: string, o: Partial<JiraIssue> = {}): JiraIssue => ({ key, summary: key, description: "", status: "To Do", issueType, url: `https://j.example/browse/${key}`, ...o });
const link = (key: string, direction: "inward" | "outward" = "inward") => ({ type: "Cause", inward: "is caused by", outward: "causes", direction, key });
const world = (...cards: JiraIssue[]) => async (k: string) => cards.find((c) => c.key === k);

describe("resolveFeature", () => {
  it("a feature is its own feature", async () => {
    const r = await resolveFeature(cfg(), issue("SHOP-1", "Story"), world());
    expect(r).toMatchObject({ kind: "feature", feature: "SHOP-1" });
  });
  it("parent first", async () => {
    const story = issue("SHOP-1", "Story");
    const other = issue("SHOP-2", "Story");
    const bug = issue("SHOP-9", "Bug", { parent: { key: "SHOP-1" }, links: [link("SHOP-2")] });
    const r = await resolveFeature(cfg(), bug, world(story, other));
    expect(r).toMatchObject({ kind: "resolved", feature: "SHOP-1", via: "parent" });
  });
  it("one hop only: a parent that is not a feature does not lead further", async () => {
    const task = issue("SHOP-5", "Task", { parent: { key: "SHOP-1" } });
    const sub = issue("SHOP-6", "Sub-task", { parent: { key: "SHOP-5" } });
    const r = await resolveFeature(cfg(), sub, world(task, issue("SHOP-1", "Story")));
    expect(r.kind).toBe("none");
    expect(r.explain).toContain("SHOP-5");
  });
  it("uses a configured link when there is no parent", async () => {
    const r = await resolveFeature(cfg(), issue("SHOP-9", "Bug", { links: [link("SHOP-1")] }), world(issue("SHOP-1", "Story")));
    expect(r).toMatchObject({ kind: "resolved", feature: "SHOP-1", via: "link" });
  });
  it("a card reaching two features is attached to neither", async () => {
    const r = await resolveFeature(cfg(), issue("SHOP-9", "Bug", { links: [link("SHOP-1"), link("SHOP-2")] }), world(issue("SHOP-1", "Story"), issue("SHOP-2", "Story")));
    expect(r).toMatchObject({ kind: "ambiguous", candidates: ["SHOP-1", "SHOP-2"] });
  });
  it("ignores links that are not configured, or from another card type", async () => {
    const c = cfg();
    const r = await resolveFeature(c, issue("SHOP-9", "Task", { links: [link("SHOP-1")] }), world(issue("SHOP-1", "Story")));
    expect(r.kind).toBe("none");
    const r2 = await resolveFeature(cfg({ hierarchy: { links: [] } }), issue("SHOP-9", "Bug", { links: [link("SHOP-1")] }), world(issue("SHOP-1", "Story")));
    expect(r2.explain).toContain("no link types are configured");
  });
  it("a target in another project is not accepted", async () => {
    const r = await resolveFeature(cfg(), issue("SHOP-9", "Bug", { parent: { key: "OTHER-1" } }), world(issue("OTHER-1", "Story")));
    expect(r.kind).toBe("none");
  });
  it("a card with no code change is not attached", async () => {
    const r = await resolveFeature(cfg(), issue("SHOP-9", "Bug", { parent: { key: "SHOP-1" } }), world(issue("SHOP-1", "Story")), { hasCode: false });
    expect(r.kind).toBe("none");
  });
  it("with no feature types every card is its own feature", async () => {
    const r = await resolveFeature(cfg({ featureIssueTypes: [] }), issue("SHOP-9", "Bug", { parent: { key: "SHOP-1" } }), world(issue("SHOP-1", "Story")));
    expect(r.kind).toBe("feature");
  });
  it("a failed lookup is a non-answer, not a crash", async () => {
    const r = await resolveFeature(cfg(), issue("SHOP-9", "Bug", { parent: { key: "SHOP-1" } }), async () => {
      throw new Error("404");
    });
    expect(r.kind).toBe("none");
  });
});

describe("linkApplies", () => {
  const l = { type: "Cause", inward: "is caused by", outward: "causes", direction: "inward" as const };
  it("matches the wording this card sees, or the link type name", () => {
    expect(linkApplies({ name: "is caused by", from: [] }, l, "Bug")).toBe(true);
    expect(linkApplies({ name: "cause", from: [] }, l, "Bug")).toBe(true);
    expect(linkApplies({ name: "causes", from: [] }, l, "Bug")).toBe(false);
    expect(linkApplies({ name: "is caused by", from: ["Task"] }, l, "Bug")).toBe(false);
  });
});

describe("statuses and components", () => {
  it("per-project statuses replace the global ones", () => {
    const c = cfg({ workflow: { readyStatuses: ["Ready for Testing"], byProject: { SHOP: { readyStatuses: ["QA Ready"], approvedStatuses: ["Refined"] } } } });
    expect(statusSets(c, "SHOP-3")).toEqual({ ready: ["QA Ready"], approved: ["Refined"] });
    expect(statusSets(c, "ABC-3").ready).toEqual(["Ready for Testing"]);
    expect(isReadyStatus(c, "SHOP-3", "qa ready")).toBe(true);
    expect(isReadyStatus(c, "SHOP-3", "Ready for Testing")).toBe(false);
    expect(isReadyStatus(c, "ABC-3", "Ready for Testing")).toBe(true);
    expect(isReadyStatus(c, "SHOP-3", "Whatever", "done")).toBe(true);
  });
  it("components map to services; the rest come back unmapped", () => {
    const c = cfg({ components: { Orders: "orders-api" } });
    expect(servicesFromComponents(c, ["orders", "Billing"])).toEqual({ services: ["orders-api"], unmapped: ["Billing"] });
    expect(servicesFromComponents(c, undefined)).toEqual({ services: [], unmapped: [] });
  });
});

describe("parseLinks", () => {
  it("reads both directions and skips broken entries", () => {
    const out = parseLinks([
      { type: { name: "Cause", inward: "is caused by", outward: "causes" }, outwardIssue: { key: "A-1", fields: { issuetype: { name: "Story" } } } },
      { type: { name: "Cause", inward: "is caused by", outward: "causes" }, inwardIssue: { key: "A-2" } },
      { type: {} },
    ]);
    expect(out).toEqual([
      { type: "Cause", inward: "is caused by", outward: "causes", direction: "outward", key: "A-1", issueType: "Story" },
      { type: "Cause", inward: "is caused by", outward: "causes", direction: "inward", key: "A-2" },
    ]);
    expect(parseLinks(undefined)).toEqual([]);
  });
});

describe("inputsFromJira with a bug key", () => {
  afterEach(() => vi.unstubAllGlobals());
  const raw = (key: string, type: string, extra: Record<string, unknown> = {}) => ({ key, fields: { summary: key, description: "h2. Acceptance criteria\n* AC-1: x", status: { name: "Ready for Testing" }, issuetype: { name: type }, labels: [], components: [{ name: "Orders" }], ...extra } });
  it("reports a bug under its story", async () => {
    const db: Record<string, unknown> = { "SHOP-9": raw("SHOP-9", "Bug", { parent: { key: "SHOP-1", fields: { issuetype: { name: "Story" } } } }), "SHOP-1": raw("SHOP-1", "Story") };
    vi.stubGlobal("fetch", async (url: string) => {
      const key = decodeURIComponent(new URL(url).pathname.split("/").pop()!);
      return db[key] ? new Response(JSON.stringify(db[key]), { status: 200 }) : new Response("no", { status: 404 });
    });
    const out = await inputsFromJira(cfg({ components: { Orders: "orders-api" } }), { baseUrl: "https://j.example", authHeader: "x" }, { keys: ["shop-9"] });
    expect(out.map((x) => x.key)).toEqual(["SHOP-1"]);
    expect(out[0].resolvedFrom).toContain("SHOP-9");
    expect(out[0].ready).toBe(true);
    expect(out[0].components).toEqual(["Orders"]);
  });
});

describe("jiraConfigChecks", () => {
  const probe = (o: Partial<Parameters<typeof jiraConfigChecks>[1]> = {}) => ({
    statuses: async () => ["To Do", "Ready for Testing", "Done"],
    issueTypes: async () => ["Story", "Bug"],
    linkTypes: async () => [{ name: "Cause", inward: "is caused by", outward: "causes" }],
    ...o,
  });
  it("is quiet when the names exist", async () => {
    const out = await jiraConfigChecks(cfg({ approvedStatuses: ["To Do"] }), probe());
    expect(out.every((x) => x.level === "ok")).toBe(true);
  });
  it("warns about names Jira doesn't have", async () => {
    const out = await jiraConfigChecks(cfg({ featureIssueTypes: ["Epic"], approvedStatuses: ["Nope"], hierarchy: { links: [{ name: "blocks", from: [] }] } }), probe());
    const warns = out.filter((x) => x.level === "warn").map((x) => x.label);
    expect(warns.some((l) => l.includes("approved status exists"))).toBe(true);
    expect(warns.some((l) => l.includes("feature issue types exist"))).toBe(true);
    expect(warns.some((l) => l.includes('link type "blocks"'))).toBe(true);
  });
  it("a Jira error becomes a warning", async () => {
    const out = await jiraConfigChecks(cfg(), probe({ statuses: async () => { throw new Error("403 no permission"); } }));
    expect(out.some((x) => x.level === "warn" && x.hint?.includes("403"))).toBe(true);
  });
});
