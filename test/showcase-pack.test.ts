import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { indexSource } from "../src/analysis/testIndex.js";
import { acCardHtml, buildShowcasePack, evidenceHtml, findFfmpeg, introCardHtml, pickShowcaseTests } from "../src/showcase/pack.js";
import type { StoryReadiness } from "../src/showcase/showcase.js";

const c = ConfigSchema.parse({
  version: 1,
  mode: "scratch",
  project: { name: "p" },
  tests: { api: { framework: "playwright", runCommand: "npx playwright test --project=api" }, web: { enabled: true } },
  ci: { platform: "gitlab" },
});
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "qas-pack-"));
const dir = tmp();
const apiLog = path.join(dir, "api-log.json");
fs.writeFileSync(apiLog, JSON.stringify({ calls: [{ method: "POST", path: "/orders", status: 201, request: { item: "<book>" }, response: { id: "ord_1" }, ms: 12 }] }));
const [api] = indexSource("tests/api/orders.spec.ts", `test("creates an order @story:S-1 @ac:AC-1", async () => {});`);
const [web1, web2] = indexSource(
  "tests/web/orders.spec.ts",
  `test("shows the total @story:S-1 @ac:AC-1", async () => {});
test("shows the price @story:S-1 @ac:AC-2 @showcase", async () => {});`,
);
const ok = (evidence: any[] = []) => ({ title: "", status: "passed" as const, evidence });
const r: StoryReadiness = {
  story: "S-1",
  ready: true,
  blockers: [],
  acs: [
    { id: "AC-1", text: "Order total is shown", status: "passed", pending: [], tests: [{ test: api, result: ok([{ kind: "api-log", name: "api-log", path: apiLog }]) }, { test: web1, result: ok() }] },
    { id: "AC-2", text: "Price <each>", status: "passed", pending: [], tests: [{ test: web2, result: ok() }] },
  ],
};

describe("showcase pack", () => {
  it("picks one test per AC: @showcase first, then a web test", () => {
    const picks = pickShowcaseTests(c, r);
    expect(picks.map((p) => [p.ac, p.test.title, p.ui])).toEqual([
      ["AC-1", "shows the total", true],
      ["AC-2", "shows the price", true],
    ]);
  });

  it("writes cards and the evidence page with escaped text and the API calls", () => {
    const meta = { title: "Prices", environment: "sit", at: "2026-10-13 12:00 UTC", commit: "abcdef1234" };
    expect(introCardHtml("S-1", meta, 2)).toContain("on SIT");
    const picks = pickShowcaseTests(c, r);
    expect(acCardHtml("S-1", picks[1], 2, 2)).toContain("Price &lt;each&gt;");
    const html = evidenceHtml(r, picks, meta, () => undefined);
    expect(html).toContain("POST /orders");
    expect(html).toContain("&quot;&lt;book&gt;&quot;");
    expect(html).toContain("commit abcdef12");
  });

  it("finds no ffmpeg on an empty PATH and builds no video (the caller falls back)", async () => {
    const env = { PATH: "/nonexistent" };
    expect(await findFfmpeg(c, dir, env)).toBeUndefined();
    const out = await buildShowcasePack({ cwd: tmp(), c: { ...c, showcase: { ...c.showcase, video: { ...c.showcase.video, record: false } } }, r, meta: { at: "now" }, workDir: path.join(tmp(), "w"), env });
    expect(out.video).toBe(false);
    expect(out.notes.join(" ")).toMatch(/PDF not built|ffmpeg/);
  });
});

import { redact } from "../src/showcase/redact.js";
describe("API evidence redaction", () => {
  it("masks secrets by key and tokens inside strings, keeps the rest", () => {
    const out = redact({ email: "a@b.c", password: "hunter2", nested: { accessToken: "abc", items: [{ cardNumber: "4111", qty: 2 }] }, note: "use Bearer abcdefghijkl now", jwt: "x eyJhbGciOi.eyJzdWIiOiIx.c2lnbmF0dXJl y", pin: null });
    expect(out).toEqual({ email: "a@b.c", password: "[redacted]", nested: { accessToken: "[redacted]", items: [{ cardNumber: "[redacted]", qty: 2 }] }, note: "use Bearer [redacted] now", jwt: "x [redacted jwt] y", pin: null });
  });
});

import { attachedWhat } from "../src/commands/showcase.js";
describe("showcase mention", () => {
  it("names what was actually attached", () => {
    expect(attachedWhat(["S-1-showcase.mp4", "S-1-showcase.pdf"])).toBe("the showcase video and the evidence PDF are");
    expect(attachedWhat(["S-1-showcase.pdf", "a.webm", "b.png"])).toBe("2 test recording(s) and screenshot(s) and the evidence PDF are");
    expect(attachedWhat(["S-1-test-evidence.md"])).toBe("the test evidence is");
  });
});
