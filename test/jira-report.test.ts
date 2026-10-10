import fs from "node:fs";
import http from "node:http";
import { describe, expect, it } from "vitest";
import { capForJira, jiraMarker, markdownToJiraWiki, upsertIssueComment } from "../src/scm/jira.js";

describe("markdownToJiraWiki", () => {
  it("converts headings, bold, code, links, lists and tables", () => {
    const md = [
      "<!-- qa-sentinel:gap-report -->",
      "### QA impact – orders · 🟠 High risk",
      "**Verdict:** see `src/server.js:8` and [story](https://x.test/S-1)",
      "",
      "| Change | Risk |",
      "| --- | --- |",
      "| POST /orders | 🟠 High |",
      "",
      "- one",
      "  - nested",
      "1. first",
      "<details><summary>Evidence (2 changes)</summary>",
      "",
      "- c1",
      "</details>",
      "<sub>qa-sentinel 0.2.0</sub>",
    ].join("\n");
    const w = markdownToJiraWiki(md);
    expect(w).toContain("h3. QA impact – orders · 🟠 High risk");
    expect(w).toContain("*Verdict:* see {{src/server.js:8}} and [story|https://x.test/S-1]");
    expect(w).toContain("|| Change || Risk ||");
    expect(w).toContain("| POST /orders | 🟠 High |");
    expect(w).not.toMatch(/---/);
    expect(w).toContain("* one\n** nested\n# first");
    expect(w).toContain("h4. Evidence (2 changes)");
    expect(w).not.toMatch(/<\/?(details|summary|sub)|<!--/);
  });
  it("handles a real gap report without leftover markdown table syntax", () => {
    const w = markdownToJiraWiki(fs.readFileSync("sandbox/shoplite/example-output/SHOP-101-gap-report.md", "utf8"));
    expect(w).toMatch(/^h3\. QA impact/);
    expect(w).not.toMatch(/\|\s*-{3,}/);
    expect(w).not.toMatch(/\*\*[^\s*][^*]*\*\*/); // no markdown bold left (a leading "** " is a nested list)
    expect(w).toContain("|| Change || Risk || Oracle || Coverage || Decision ||");
  });
});

describe("capForJira", () => {
  it("leaves short reports alone and cuts long ones at a line with a link", () => {
    expect(capForJira("short", 2000)).toBe("short");
    const long = Array.from({ length: 500 }, (_, i) => `line ${i} ${"x".repeat(20)}`).join("\n");
    const cut = capForJira(long, 2000, "https://ci/job/1/artifacts/file/qa-gap-report.md");
    expect(cut.length).toBeLessThanOrEqual(2000);
    expect(cut).toContain("[CI artifact|https://ci/job/1/artifacts/file/qa-gap-report.md]");
    expect(cut).not.toMatch(/line \d+ x{0,19}\n\n_Report/); // no half line before the note
  });
});

describe("upsertIssueComment", () => {
  it("creates one comment per service, then updates it in place", async () => {
    const comments: any[] = [{ id: "1", body: "a human comment" }];
    const calls: string[] = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        calls.push(`${req.method} ${req.url}`);
        expect(req.headers.authorization).toBe("Basic abc");
        res.setHeader("content-type", "application/json");
        if (req.method === "GET") return res.end(JSON.stringify({ startAt: 0, total: comments.length, comments }));
        const payload = JSON.parse(body);
        if (req.method === "POST") {
          const c = { id: String(comments.length + 1), ...payload };
          comments.push(c);
          return res.end(JSON.stringify(c));
        }
        const id = req.url!.split("/").pop();
        Object.assign(comments.find((c) => c.id === id), payload);
        res.end(JSON.stringify({ id }));
      });
    });
    await new Promise<void>((r) => server.listen(0, r));
    const ctx = { baseUrl: `http://127.0.0.1:${(server.address() as any).port}`, authHeader: "Basic abc" };
    try {
      const first = await upsertIssueComment(ctx, "SHOP-1", "orders-service", "h3. v1", { type: "role", value: "Developers" });
      const second = await upsertIssueComment(ctx, "SHOP-1", "orders-service", "h3. v2");
      const other = await upsertIssueComment(ctx, "SHOP-1", "payments-service", "h3. p1");
      expect(first.action).toBe("created");
      expect(second).toMatchObject({ action: "updated", id: first.id });
      expect(other.action).toBe("created");
      expect(comments).toHaveLength(3);
      expect(comments[1].body).toContain("h3. v2");
      expect(comments[1].body).toContain(jiraMarker("orders-service"));
      expect(comments[1].visibility).toEqual({ type: "role", value: "Developers" });
      expect(calls.filter((c) => c.startsWith("PUT"))).toHaveLength(1);
    } finally {
      server.close();
    }
  });
});
