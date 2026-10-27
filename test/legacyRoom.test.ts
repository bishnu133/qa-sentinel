import { afterEach, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { postToStory, renderStatus, withSection } from "../src/reporting/statusComment.js";
import { BOT, mockJira } from "./helpers/mockJira.js";
const cfg = ConfigSchema.parse({ version: 1, mode: "existing", project: { name: "t" }, tests: { api: { framework: "playwright", runCommand: "x" } }, ci: { platform: "gitlab" } });
let closers: (() => Promise<void>)[] = [];
afterEach(async () => { for (const f of closers.splice(0)) await f(); });
const big = (tag: string, n: number) => "h3. Old " + tag + "\n" + Array.from({ length: n }, (_, i) => `line ${i} ${"x".repeat(30)}`).join("\n") + `\nTAIL-${tag}`;
it("an old comment is not moved when later writes could then shorten it: its text stays whole somewhere", async () => {
  const j = await mockJira({}); closers.push(j.close);
  j.add("SHOP-1", renderStatus("SHOP-1", withSection([], "story-review", "h3. R\nx", new Date("2026-10-21T10:00:00Z"))), BOT);
  j.add("SHOP-1", big("feature", 600) + "\n{color:#97a0af}qa-sentinel:feature{color}", BOT); // ~24k fits alone, but leaves no room
  await postToStory(cfg, j.ctx, "SHOP-1", { name: "bugs", wiki: "h3. Bugs\nnone", legacyKind: "bugs", legacyMarker: "qa-sentinel:bugs" });
  await postToStory(cfg, j.ctx, "SHOP-1", { name: "post-deploy", wiki: "h3. Post deploy\n" + "y".repeat(12000), legacyKind: "post-deploy", legacyMarker: "qa-sentinel:post-deploy" });
  expect(JSON.stringify(j.comments).includes("TAIL-feature")).toBe(true);
});
it("a section already in the status comment is not shortened by a move", async () => {
  const j = await mockJira({}); closers.push(j.close);
  j.add("SHOP-1", renderStatus("SHOP-1", withSection([], "story-review", big("review", 650), new Date("2026-10-21T10:00:00Z"))), BOT);
  j.add("SHOP-1", "h3. small\n" + "z".repeat(6000) + "\n{color:#97a0af}qa-sentinel:showcase{color}", BOT);
  await postToStory(cfg, j.ctx, "SHOP-1", { name: "bugs", wiki: "h3. Bugs\nnone", legacyKind: "bugs", legacyMarker: "qa-sentinel:bugs" });
  const all = JSON.stringify(j.comments);
  expect(all.includes("TAIL-review")).toBe(true);
  expect(all.includes("Shortened to fit")).toBe(false);
  expect(Object.values(j.comments).flat().some((x: any) => x.body.includes("zzzzzz") && !x.body.includes("QA status"))).toBe(true); // the small old comment stays as it was
});
it("a moved old comment is not shortened by later ordinary writes (13k moved, then three 7k sections): other sections are shortened first", async () => {
  const j = await mockJira({}); closers.push(j.close);
  j.add("SHOP-1", renderStatus("SHOP-1", withSection([], "story-review", "h3. R\nx", new Date("2026-10-21T10:00:00Z"))), BOT);
  j.add("SHOP-1", big("feature", 330) + "\n{color:#97a0af}qa-sentinel:feature{color}", BOT);
  await postToStory(cfg, j.ctx, "SHOP-1", { name: "bugs", wiki: "h3. Bugs\nnone", legacyKind: "bugs", legacyMarker: "qa-sentinel:bugs" });
  expect(JSON.stringify(j.comments)).toContain("qa-sentinel:replaced"); // it was moved
  for (const n of ["post-deploy", "showcase", "gap-report:orders"]) await postToStory(cfg, j.ctx, "SHOP-1", { name: n, wiki: `h3. ${n}\n` + "y".repeat(7000), legacyKind: n, legacyMarker: `qa-sentinel:${n}` });
  const status = Object.values(j.comments).flat().find((x: any) => x.body.includes("QA status")) as { body: string };
  expect(status.body).toContain("TAIL-feature");
  expect(status.body).toContain("kept=1");
  expect(status.body.length).toBeLessThan(32_767);
});
