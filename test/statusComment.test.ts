import http from "node:http";
import { describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { STATUS_MARKER, parseStatus, postToStory, renderStatus, upsertStatusSection, withSection } from "../src/reporting/statusComment.js";

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
