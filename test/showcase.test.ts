import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { showcaseCommand } from "../src/commands/showcase.js";
import { readRunResults } from "../src/showcase/results.js";
import { emptyRecord, fileStore } from "../src/stories/record.js";

function repo(): string {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), "qas-show-"));
  const w = (rel: string, s: string) => (fs.mkdirSync(path.dirname(path.join(r, rel)), { recursive: true }), fs.writeFileSync(path.join(r, rel), s));
  w("qa-sentinel.config.yaml", `version: 1
mode: scratch
project: { name: t }
tests: { api: { framework: playwright, dir: tests/api, helpersDir: src/api, runCommand: "npx playwright test" } }
ci: { platform: gitlab }
requirements: { source: jira, jira: { baseUrl: "http://127.0.0.1:PORT" } }
`);
  w("tests/api/refund.spec.ts", `const t = "@story:SHOP-1 @endpoint:POST_/refund";
test(\`refunds part \${t} @ac:AC-1\`, async () => {});
test(\`rejects over-refund \${t} @ac:AC-2\`, async () => {});
`);
  w("test-results/refund/api-log.json", JSON.stringify({ calls: [{ method: "POST", path: "/payments/p1/refund", request: { amount: 10 }, status: 200, response: { refundedAmount: 10 }, ms: 5 }] }));
  w("test-results/refund/video.webm", "fake-video");
  const att = (dir: string) => [
    { name: "api-log", contentType: "application/json", path: path.join(r, "test-results", dir, "api-log.json") },
    { name: "video", contentType: "video/webm", path: path.join(r, "test-results", dir, "video.webm") },
  ];
  w("test-results/results.json", JSON.stringify({
    suites: [{ file: "refund.spec.ts", specs: [
      { title: "refunds part @story:SHOP-1 @endpoint:POST_/refund @ac:AC-1", file: "refund.spec.ts", line: 2, tests: [{ status: "expected", results: [{ status: "passed", attachments: att("refund") }] }] },
      { title: "rejects over-refund @story:SHOP-1 @endpoint:POST_/refund @ac:AC-2", file: "refund.spec.ts", line: 3, tests: [{ status: "expected", results: [{ status: "passed", attachments: [] }] }] },
    ] }],
  }));
  return r;
}

function fakeJira() {
  const state = { labels: [] as string[], property: undefined as any, attachments: [] as any[], comments: [] as any[], deleted: [] as string[], posts: 0, failNth: 0 };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (d) => chunks.push(d));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString();
      const u = req.url!;
      const json = (code: number, v: unknown) => (res.writeHead(code, { "content-type": "application/json" }), res.end(v === undefined ? "" : JSON.stringify(v)));
      if (u.endsWith("/myself")) return json(200, { accountId: "bot" });
      if (req.method === "GET" && u.includes("fields=labels")) return json(200, { fields: { labels: state.labels } });
      if (req.method === "GET" && /\/issue\/SHOP-1\?fields=/.test(u)) return json(200, { key: "SHOP-1", fields: { summary: "Refunds", description: "h2. Acceptance criteria\n# Partial refunds work\n# Total never exceeds the amount", status: { name: "In Progress" } } });
      if (u.includes("/properties/")) {
        if (req.method === "GET") return state.property ? json(200, { key: "qa-sentinel.showcase", value: state.property }) : json(404, { errorMessages: ["not found"] });
        state.property = JSON.parse(body);
        return json(200, undefined);
      }
      if (u.endsWith("/attachments") && req.method === "POST") {
        expect(req.headers["x-atlassian-token"]).toBe("no-check");
        const name = body.match(/filename="([^"]+)"/)![1];
        const a = { id: String(100 + state.attachments.length), filename: name };
        state.attachments.push(a);
        return json(200, [a]);
      }
      if (u.startsWith("/rest/api/2/attachment/") && req.method === "DELETE") return state.deleted.push(u.split("/").pop()!), json(204, undefined);
      if (u.includes("/comment") && req.method === "GET") return json(200, { startAt: 0, total: state.comments.length, comments: state.comments });
      if (u.includes("/comment") && req.method === "POST" && ++state.posts === state.failNth) return json(403, { errorMessages: ["no"] });
      if (u.includes("/comment") && req.method === "POST") return state.comments.push({ id: String(state.comments.length + 1), author: { accountId: "bot" }, ...JSON.parse(body) }), json(200, { id: String(state.comments.length) });
      if (u.includes("/comment/") && req.method === "PUT") return json(200, {});
      if (req.method === "PUT" && /\/issue\/SHOP-1$/.test(u)) return (state.labels = state.labels.filter((l) => !body.includes(l))), json(204, undefined);
      json(404, { u });
    });
  });
  return { server, state };
}

describe("results with evidence", () => {
  it("reads Playwright JSON results and classifies attachments", () => {
    const r = readRunResults(path.join(repo(), "test-results/results.json"));
    expect(r[0]).toMatchObject({ line: 2, status: "passed" });
    expect(r[0].evidence.map((e) => e.kind)).toEqual(["api-log", "video"]);
  });
});

describe("showcase", () => {
  it("attaches evidence once, skips reruns, and refreshes only when QA adds the label", async () => {
    const { server, state } = fakeJira();
    await new Promise<void>((ok) => server.listen(0, ok));
    const port = (server.address() as any).port;
    const r = repo();
    fs.writeFileSync(path.join(r, "qa-sentinel.config.yaml"), fs.readFileSync(path.join(r, "qa-sentinel.config.yaml"), "utf8").replace("PORT", String(port)));
    const env = { ...process.env };
    process.env.JIRA_EMAIL = "qa@example.test";
    process.env.JIRA_API_TOKEN = "t";
    try {
      await showcaseCommand({ cwd: r });
      expect(state.attachments.map((a) => a.filename)).toEqual(["SHOP-1-test-evidence.md", "SHOP-1-AC-1-refunds-part.webm"]);
      expect(state.property.attachments).toHaveLength(2);
      expect(state.comments[0].body).toContain("Showcase · SHOP-1");
      expect(fs.readFileSync(path.join(r, "qa-showcase.md"), "utf8")).toContain("ready to showcase");

      await showcaseCommand({ cwd: r }); // second run: already showcased
      expect(state.attachments).toHaveLength(2);

      state.labels = ["qa-showcase-refresh"]; // QA asks for fresh evidence
      await showcaseCommand({ cwd: r });
      expect(state.deleted).toEqual(["100", "101"]);
      expect(state.attachments).toHaveLength(4);
      expect(state.labels).toEqual([]);
    } finally {
      process.env = env;
      server.close();
    }
  });

  it("does not showcase a story with a failing test or a waiting fixme", async () => {
    const r = repo();
    fs.appendFileSync(path.join(r, "tests/api/refund.spec.ts"), 'test.fixme(`cumulative cap ${t} @ac:AC-2`, async () => {});\n');
    fs.writeFileSync(path.join(r, "story.md"), "## Acceptance criteria\n1. Partial refunds work\n2. Total never exceeds the amount\n");
    const cfg = path.join(r, "qa-sentinel.config.yaml");
    fs.writeFileSync(cfg, fs.readFileSync(cfg, "utf8").replace(/requirements:.*\n/, ""));
    await showcaseCommand({ cwd: r, storyFile: "story.md", story: ["SHOP-1"] });
    const md = fs.readFileSync(path.join(r, "qa-showcase.md"), "utf8");
    expect(md).toContain("SHOP-1 · not ready");
    expect(md).toContain("AC-2: 1 test(s) still waiting for a product fix");
  });
});

describe("showcase and the Jira status comment", () => {
  async function setup(extraConfig: string) {
    const { server, state } = fakeJira();
    await new Promise<void>((ok) => server.listen(0, ok));
    const r = repo();
    const cfg = path.join(r, "qa-sentinel.config.yaml");
    fs.writeFileSync(cfg, fs.readFileSync(cfg, "utf8").replace("PORT", String((server.address() as any).port)) + extraConfig);
    return { server, state, r };
  }
  const withEnv = async (fn: () => Promise<void>) => {
    const env = { ...process.env };
    process.env.JIRA_EMAIL = "qa@example.test";
    process.env.JIRA_API_TOKEN = "t";
    try {
      await fn();
    } finally {
      process.env = env;
    }
  };

  it("status mode: the summary is a section of the status comment and the mention is a separate short comment, once", async () => {
    const { server, state, r } = await setup("showcase: { notify: [jsmith] }\n");
    try {
      await withEnv(async () => {
        await showcaseCommand({ cwd: r });
        const [first, second] = state.comments;
        expect(first.body).toContain("qa-sentinel:status");
        expect(first.body).toContain("qa-sentinel:section=showcase");
        expect(first.body).not.toContain("[~jsmith]");
        expect(second.body).toMatch(/^\[~jsmith\] this story is ready for your review: /);
        expect(second.body).toContain("qa-sentinel:notify:showcase-ready");
        expect(state.comments).toHaveLength(2);
      });
    } finally {
      server.close();
    }
  });

  it("legacy mode keeps today's behaviour: one separate showcase comment with the mention inside", async () => {
    const { server, state, r } = await setup("showcase: { notify: [jsmith] }\nreporting: { jira: { mode: legacy } }\n");
    try {
      await withEnv(async () => {
        await showcaseCommand({ cwd: r });
        expect(state.comments).toHaveLength(1);
        expect(state.comments[0].body).toContain("[~jsmith] this story is ready for your review");
        expect(state.comments[0].body).toContain("qa-sentinel:showcase");
        expect(state.comments[0].body).not.toContain("qa-sentinel:status");
      });
    } finally {
      server.close();
    }
  });

  it("evidence older than the latest change is reported; reattachOnChange attaches again without the label", async () => {
    const a = await setup("");
    try {
      await withEnv(async () => {
        const store = fileStore(a.r);
        await store.save({ ...emptyRecord("SHOP-1"), basis: "aaaa1111" });
        await showcaseCommand({ cwd: a.r });
        expect(a.state.property.basis).toBe("aaaa1111");
        expect(a.state.attachments).toHaveLength(2);

        await store.save({ ...(await store.load("SHOP-1"))!, basis: "bbbb2222" });
        await showcaseCommand({ cwd: a.r });
        expect(a.state.attachments).toHaveLength(2);
        expect(fs.readFileSync(path.join(a.r, "qa-showcase.md"), "utf8")).toContain("Evidence older than the latest change");

        fs.appendFileSync(path.join(a.r, "qa-sentinel.config.yaml"), "showcase: { reattachOnChange: true }\n");
        await showcaseCommand({ cwd: a.r });
        expect(a.state.attachments).toHaveLength(4);
        expect(a.state.property.basis).toBe("bbbb2222");
        // Same basis again: not attached a third time.
        await showcaseCommand({ cwd: a.r });
        expect(a.state.attachments).toHaveLength(4);
      });
    } finally {
      a.server.close();
    }
  });

  it("both mode: the mention is in the legacy comment only, so people are tagged once", async () => {
    const { server, state, r } = await setup("showcase: { notify: [jsmith] }\nreporting: { jira: { mode: both } }\n");
    try {
      await withEnv(async () => {
        await showcaseCommand({ cwd: r });
        expect(state.comments).toHaveLength(2);
        const status = state.comments.find((c) => c.body.includes("qa-sentinel:status"));
        const legacy = state.comments.find((c) => !c.body.includes("qa-sentinel:status"));
        expect(status.body).toContain("qa-sentinel:section=showcase");
        expect(status.body).not.toContain("[~jsmith]");
        expect(legacy.body).toContain("[~jsmith] this story is ready for your review");
        expect(state.comments.filter((c) => c.body.includes("[~jsmith]"))).toHaveLength(1);
      });
    } finally {
      server.close();
    }
  });

  it("a mention that failed to post is posted on the next run, without attaching the evidence again", async () => {
    const { server, state, r } = await setup("showcase: { notify: [jsmith] }\n");
    try {
      await withEnv(async () => {
        state.failNth = 2; // the status comment goes through, the mention does not
        await showcaseCommand({ cwd: r });
        expect(state.comments.filter((c) => c.body.includes("[~jsmith]"))).toHaveLength(0);
        expect(state.property.notifyPending).toBe(true);
        expect(state.attachments).toHaveLength(2);
        await showcaseCommand({ cwd: r });
        expect(state.comments.filter((c) => c.body.includes("[~jsmith]"))).toHaveLength(1);
        expect(state.property.notifyPending).toBeUndefined();
        expect(state.attachments).toHaveLength(2); // not attached again
        await showcaseCommand({ cwd: r });
        expect(state.comments.filter((c) => c.body.includes("[~jsmith]"))).toHaveLength(1); // and not twice
      });
    } finally {
      server.close();
    }
  });

  it("a status comment that failed to post is posted on the next run too", async () => {
    const { server, state, r } = await setup("");
    try {
      await withEnv(async () => {
        state.failNth = 1;
        await showcaseCommand({ cwd: r });
        expect(state.comments).toHaveLength(0);
        expect(state.property.notifyPending).toBe(true);
        await showcaseCommand({ cwd: r });
        expect(state.comments[0].body).toContain("qa-sentinel:section=showcase");
        expect(state.attachments).toHaveLength(2);
      });
    } finally {
      server.close();
    }
  });
});
