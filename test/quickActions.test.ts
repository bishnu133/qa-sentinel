import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { call, neutraliseQuickActions, upsertMrNote, createOrUpdateMergeRequest, type GitLabContext } from "../src/scm/gitlab.js";
import { parseOverrideLines } from "../src/stories/overrides.js";

const servers: http.Server[] = [];
afterEach(() => servers.splice(0).forEach((s) => s.close()));

async function mock() {
  const seen: { method: string; url: string; body: string }[] = [];
  const srv = http.createServer((req, res) => {
    let b = "";
    req.on("data", (d) => (b += d));
    req.on("end", () => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", body: b });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(req.method === "GET" ? "[]" : JSON.stringify({ id: 1, iid: 5, web_url: "http://x/mr/5" }));
    });
  });
  await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok));
  servers.push(srv);
  const ctx = { apiUrl: `http://127.0.0.1:${(srv.address() as { port: number }).port}/api/v4`, token: "t" } as GitLabContext;
  return { ctx, seen };
}
const ZW = "​";

describe("GitLab quick actions never run from text qa-sentinel posts", () => {
  it("a line starting with / gets a zero-width space; other lines and slashes inside a line are untouched", () => {
    expect(neutraliseQuickActions("/approve\n/merge\n  /target_branch evil\nsee /api/orders and a/b\n/")).toBe(`${ZW}/approve\n${ZW}/merge\n  ${ZW}/target_branch evil\nsee /api/orders and a/b\n/`);
    expect(neutraliseQuickActions("no commands")).toBe("no commands");
  });
  it("note bodies and merge request descriptions are neutralised on the way out", async () => {
    const { ctx, seen } = await mock();
    await call(ctx, "POST", "/projects/1/merge_requests/2/notes", { body: "report\n/approve\n/merge" });
    await call(ctx, "PUT", "/projects/1/merge_requests/2", { description: "/target_branch evil\ntext" });
    await call(ctx, "POST", "/projects/1/merge_requests", { title: "t", description: "/assign @me" });
    expect(JSON.parse(seen[0].body).body).toBe(`report\n${ZW}/approve\n${ZW}/merge`);
    expect(JSON.parse(seen[1].body).description).toBe(`${ZW}/target_branch evil\ntext`);
    expect(JSON.parse(seen[2].body).description).toBe(`${ZW}/assign @me`);
  });
  it("the helpers that post notes and merge requests go through it", async () => {
    const { ctx, seen } = await mock();
    await upsertMrNote(ctx, 1, 2, "x\n/merge");
    await createOrUpdateMergeRequest(ctx, 1, { source: "qa-sentinel/x", target: "main", title: "t", description: "/approve", labels: [] });
    const posted = seen.filter((s) => s.method !== "GET").map((s) => s.body).join("\n");
    expect(posted).toContain(`${ZW}/merge`);
    expect(posted).toContain(`${ZW}/approve`);
    expect(posted).not.toMatch(/"(?:body|description)":"[^"]*(?:\\n|^)\//);
  });
  it("a /qa ready line that went through GitLab (with the zero-width space) is still read as an override", () => {
    expect(parseOverrideLines(`${ZW}/qa ready AC-1 checked by hand`, "/qa ready")).toEqual([{ op: "ready", ac: "AC-1", reason: "checked by hand" }]);
  });
});
