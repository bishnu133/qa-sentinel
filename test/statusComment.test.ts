import http from "node:http";
import { describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { STATUS_MARKER, parseStatus, postToStory, refreshStaleness, renderStatus, upsertStatusSection, whatChanged, withSection } from "../src/reporting/statusComment.js";
import { BOT, DANA, mockJira } from "./helpers/mockJira.js";

const T = new Date("2026-10-21T11:03:00Z");

describe("status comment text", () => {
  it("renders sections in a fixed order and parses them back", () => {
    let s = withSection([], "post-deploy", "h3. Post-deploy\nok", T);
    s = withSection(s, "gap-report:orders", "h3. Gap report orders\nline1\nline2", T);
    s = withSection(s, "feature", "h3. Feature\nstatus", T);
    s = withSection(s, "bugs", "h3. Bugs\n* a", T);
    const body = renderStatus("SHOP-1", s);
    expect(body).toContain(STATUS_MARKER);
    expect(body.indexOf("Feature")).toBeLessThan(body.indexOf("Gap report orders"));
    expect(body.indexOf("Gap report orders")).toBeLessThan(body.indexOf("Bugs"));
    expect(body.indexOf("Bugs")).toBeLessThan(body.indexOf("Post-deploy"));
    const back = parseStatus(body);
    expect(back.map((x) => x.name)).toEqual(["feature", "gap-report:orders", "bugs", "post-deploy"]);
    expect(back.find((x) => x.name === "gap-report:orders")!.wiki).toBe("h3. Gap report orders\nline1\nline2");
    expect(back[0].updated).toBe("2026-10-21 11:03 UTC");
  });
  it("replaces only the section that is updated", () => {
    const s1 = withSection(withSection([], "feature", "h3. F\nold", T), "bugs", "h3. B\nkeep", T);
    const s2 = withSection(parseStatus(renderStatus("SHOP-1", s1)), "feature", "h3. F\nnew", new Date("2026-10-22T08:00:00Z"));
    expect(s2.find((x) => x.name === "feature")!.wiki).toContain("new");
    expect(s2.find((x) => x.name === "bugs")!.wiki).toContain("keep");
    expect(s2).toHaveLength(2);
  });
  it("shortens the biggest section to stay under Jira's limit", () => {
    const big = "h3. Big\n" + Array.from({ length: 2000 }, (_, i) => `line ${i} ${"x".repeat(30)}`).join("\n");
    const body = renderStatus("SHOP-1", withSection(withSection([], "gap-report:a", big, T), "feature", "h3. F\nsmall", T));
    expect(body.length).toBeLessThan(32_767);
    expect(body).toContain("Shortened to fit");
    expect(parseStatus(body).find((x) => x.name === "feature")!.wiki).toBe("h3. F\nsmall");
  });
});

async function fakeJira(initial: any[] = []) {
  const comments = [...initial];
  const calls: string[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      calls.push(`${req.method} ${req.url}`);
      res.setHeader("content-type", "application/json");
      if (req.method === "GET") return res.end(JSON.stringify({ startAt: 0, total: comments.length, comments }));
      const payload = JSON.parse(body);
      if (req.method === "POST") {
        const c = { id: String(comments.length + 1), ...payload };
        comments.push(c);
        return res.end(JSON.stringify(c));
      }
      Object.assign(comments.find((c) => c.id === req.url!.split("/").pop()), payload);
      res.end("{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  return { comments, calls, server, ctx: { baseUrl: `http://127.0.0.1:${(server.address() as any).port}`, authHeader: "Basic x" } };
}

describe("one status comment per story", () => {
  it("every check lands in the same comment", async () => {
    const j = await fakeJira([{ id: "1", body: "a human comment" }]);
    try {
      const a = await upsertStatusSection(j.ctx, "SHOP-1", "gap-report:orders", "h3. Gap orders\nv1", { type: "role", value: "Developers" }, T);
      const b = await upsertStatusSection(j.ctx, "SHOP-1", "feature", "h3. Feature\nwaiting", undefined, T);
      const c = await upsertStatusSection(j.ctx, "SHOP-1", "gap-report:orders", "h3. Gap orders\nv2", undefined, T);
      expect(a.action).toBe("created");
      expect(b).toMatchObject({ action: "updated", id: a.id });
      expect(c).toMatchObject({ action: "updated", id: a.id });
      expect(j.comments).toHaveLength(2); // the human comment + ONE status comment
      const names = parseStatus(j.comments[1].body).map((x) => x.name);
      expect(names).toEqual(["feature", "gap-report:orders"]);
      expect(j.comments[1].body).toContain("v2");
      expect(j.comments[1].body).not.toContain("v1");
      expect(j.comments[1].visibility).toEqual({ type: "role", value: "Developers" });
      expect(j.comments[0].body).toBe("a human comment");
    } finally {
      j.server.close();
    }
  });

  const cfg = (layout?: string) => ConfigSchema.parse({ version: 1, mode: "existing", project: { name: "t" }, tests: { api: { framework: "playwright", runCommand: "x" } }, ci: { platform: "gitlab" }, ...(layout ? { reporting: { jira: { layout } } } : {}) });

  it("layout single (default) uses the status comment; separate keeps one comment per kind", async () => {
    const j = await fakeJira();
    try {
      await postToStory(cfg(), j.ctx, "SHOP-2", { name: "feature", wiki: "h3. F", legacyKind: "feature", legacyMarker: "qa-sentinel:feature" });
      await postToStory(cfg(), j.ctx, "SHOP-2", { name: "bugs", wiki: "h3. B", legacyKind: "bugs", legacyMarker: "qa-sentinel:bugs" });
      expect(j.comments).toHaveLength(1);
      await postToStory(cfg("separate"), j.ctx, "SHOP-3", { name: "feature", wiki: "h3. F", legacyKind: "feature", legacyMarker: "qa-sentinel:feature" });
      await postToStory(cfg("separate"), j.ctx, "SHOP-3", { name: "bugs", wiki: "h3. B", legacyKind: "bugs", legacyMarker: "qa-sentinel:bugs" });
      expect(j.comments).toHaveLength(3);
    } finally {
      j.server.close();
    }
  });
});

describe("out-of-date marks", () => {
  const OLD = "aaaa1111";
  const NEW = "bbbb2222";
  const sections = () => {
    let s = withSection([], "post-deploy", "h3. Post-deploy\nok", T, OLD);
    s = withSection(s, "gap-report:orders", "h3. Gap orders\nline", T, OLD);
    s = withSection(s, "feature", "h3. Feature\nno basis recorded", T);
    s = withSection(s, "bugs", "h3. Bugs\n* a", T, OLD);
    s = withSection(s, "showcase", "h3. Showcase\nfresh", T, NEW);
    return s;
  };
  const marks = (body: string) => body.split("\n").filter((l) => l.includes("Out of date")).length;

  it("marks result sections written against another basis, and only those", () => {
    const body = renderStatus("SHOP-1", sections(), { currentBasis: NEW });
    expect(marks(body)).toBe(2);
    const text = body.split("\n");
    expect(text[text.findIndex((l) => l.includes("Out of date")) + 1]).toMatch(/Gap orders|Post-deploy/);
    expect(body).toContain("new code was merged or the ACs changed after this was written");
    expect(marks(renderStatus("SHOP-1", sections()))).toBe(0); // no current basis: no marks
  });

  it("the basis is in the stamp; the mark is not kept as section text when the comment is read back", () => {
    const body = renderStatus("SHOP-1", sections(), { currentBasis: NEW });
    expect(body).toContain(`qa-sentinel:section=post-deploy · basis=${OLD}`);
    const back = parseStatus(body);
    expect(back.find((x) => x.name === "post-deploy")).toMatchObject({ basis: OLD, wiki: "h3. Post-deploy\nok" });
    expect(back.find((x) => x.name === "feature")!.basis).toBeUndefined();
    // Drawing it again gives the same text: marks are never doubled.
    expect(renderStatus("SHOP-1", back, { currentBasis: NEW })).toBe(body);
  });

  it("an old-format stamp (no basis) still parses and is never marked", () => {
    const old = `h2. QA status · SHOP-1\n{color:#97a0af}${STATUS_MARKER}{color}\n\nh3. Post-deploy\nold\n{color:#97a0af}Updated 2026-10-01 09:00 UTC · qa-sentinel:section=post-deploy{color}\n`;
    const back = parseStatus(old);
    expect(back).toEqual([{ name: "post-deploy", wiki: "h3. Post-deploy\nold", updated: "2026-10-01 09:00 UTC" }]);
    expect(marks(renderStatus("SHOP-1", back, { currentBasis: NEW }))).toBe(0);
  });

  it("whatChanged names the merges after the section was written", () => {
    const rec = { parts: [{ service: "orders", iid: 12, state: "merged", mergedAt: "2026-10-22T09:00:00Z" }, { service: "shop", iid: 3, state: "merged", mergedAt: "2026-09-01T09:00:00Z" }] } as never;
    expect(whatChanged(rec, { name: "post-deploy", wiki: "", updated: "2026-10-21 11:03 UTC" })).toContain("(orders !12 merged 2026-10-22)");
    expect(whatChanged(undefined, { name: "x", wiki: "", updated: "?" })).toBe("new code was merged or the ACs changed after this was written");
  });

  it("refreshStaleness re-draws our status comment with the marks and no section text changes; a second call writes nothing", async () => {
    const j = await mockJira();
    try {
      j.add("SHOP-1", `${STATUS_MARKER} somebody else's, not ours`, DANA);
      const mine = j.add("SHOP-1", renderStatus("SHOP-1", sections()), BOT);
      expect(await refreshStaleness(j.ctx, "SHOP-1", { basis: NEW })).toBe("updated");
      expect(marks(mine.body)).toBe(2);
      expect(parseStatus(mine.body).map((x) => x.wiki)).toEqual(parseStatus(renderStatus("SHOP-1", sections())).map((x) => x.wiki));
      const puts = j.touched.length;
      expect(await refreshStaleness(j.ctx, "SHOP-1", { basis: NEW })).toBe("unchanged");
      expect(j.touched.length).toBe(puts);
      expect(j.foreignWrites()).toEqual([]);
    } finally {
      await j.close();
    }
  });

  it("refreshStaleness creates nothing when there is no status comment of ours", async () => {
    const j = await mockJira();
    try {
      j.add("SHOP-1", `${STATUS_MARKER} somebody else's`, DANA);
      expect(await refreshStaleness(j.ctx, "SHOP-1", { basis: NEW, pending: "h3. Waiting\n* x" })).toBe("none");
      expect(j.comments["SHOP-1"]).toHaveLength(1);
    } finally {
      await j.close();
    }
  });

  it("the pending section is added at the top, kept when it is the same, and removed with null", async () => {
    const j = await mockJira();
    try {
      j.add("SHOP-1", renderStatus("SHOP-1", withSection([], "feature", "h3. Feature\nx", T)), BOT);
      expect(await refreshStaleness(j.ctx, "SHOP-1", { pending: "h3. Waiting\n* AC-1 marked ready by Dana on 2026-10-21", now: T })).toBe("updated");
      const body = j.comments["SHOP-1"][0].body;
      expect(body.indexOf("Waiting")).toBeLessThan(body.indexOf("Feature"));
      expect(await refreshStaleness(j.ctx, "SHOP-1", { pending: "h3. Waiting\n* AC-1 marked ready by Dana on 2026-10-21", now: new Date("2026-10-23T00:00:00Z") })).toBe("unchanged");
      expect(await refreshStaleness(j.ctx, "SHOP-1", { pending: null })).toBe("updated");
      expect(parseStatus(j.comments["SHOP-1"][0].body).map((x) => x.name)).toEqual(["feature"]);
    } finally {
      await j.close();
    }
  });

  it("a section written by a command carries the story's basis and re-marks the others (postToStory with a basis)", async () => {
    const j = await mockJira();
    try {
      const c = ConfigSchema.parse({ version: 1, mode: "existing", project: { name: "t" }, tests: { api: { framework: "playwright", runCommand: "x" } }, ci: { platform: "gitlab" } });
      await postToStory(c, j.ctx, "SHOP-1", { name: "post-deploy", wiki: "h3. P\nok", legacyKind: "post-deploy", basis: OLD, now: T });
      expect(j.comments["SHOP-1"][0].body).not.toContain("Out of date");
      await postToStory(c, j.ctx, "SHOP-1", { name: "gap-report:orders", wiki: "h3. G\nnew", legacyKind: "orders", basis: NEW, now: T });
      const body = j.comments["SHOP-1"][0].body;
      expect(marks(body)).toBe(1);
      expect(parseStatus(body).find((x) => x.name === "gap-report:orders")!.basis).toBe(NEW);
    } finally {
      await j.close();
    }
  });
});
