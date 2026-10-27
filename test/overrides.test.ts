import { afterEach, describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { parseOverrideLines, readOverrides, unreadyCommand } from "../src/stories/overrides.js";
import { pendingWiki } from "../src/reporting/pending.js";
import { acWriteReadiness } from "../src/feature/readiness.js";
import { STATUS_MARKER } from "../src/reporting/statusComment.js";
import { BOT, DANA, EVE, mockJira } from "./helpers/mockJira.js";

const cfg = (override: Record<string, unknown> = {}) =>
  ConfigSchema.parse({ version: 1, mode: "existing", project: { name: "t" }, tests: { api: { framework: "playwright", runCommand: "x" } }, ci: { platform: "gitlab" }, reporting: { jira: { override } } });

let closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const f of closers.splice(0)) await f();
});
const jira = async (o: Parameters<typeof mockJira>[0] = {}) => {
  const j = await mockJira(o);
  closers.push(j.close);
  return j;
};

describe("/qa ready AC-n", () => {
  it("parses lines of a comment (command at the start of a line, reason optional, case does not matter)", () => {
    expect(parseOverrideLines("hello\n/qa ready AC-1 checked by hand\n  /QA READY ac-2\n/qa unready AC-1\nnot /qa ready AC-3", "/qa ready")).toEqual([
      { op: "ready", ac: "AC-1", reason: "checked by hand" },
      { op: "ready", ac: "AC-2" },
      { op: "unready", ac: "AC-1" },
    ]);
    expect(unreadyCommand("/qa ready")).toBe("/qa unready");
  });

  it("a human's comment becomes an override with their name and the date", async () => {
    const j = await jira();
    const c = j.add("SHOP-1", "/qa ready AC-1 checked by hand", DANA);
    const o = await readOverrides(cfg(), j.ctx, "SHOP-1");
    expect(o).toEqual([{ ac: "AC-1", by: "Dana Tester", at: c.created, commentId: c.id }]);
  });

  it("qa-sentinel's own comment (even one that quotes the command) is ignored, and so is an app user", async () => {
    const j = await jira();
    j.add("SHOP-1", `${STATUS_MARKER}\nTo mark an AC ready, comment:\n/qa ready AC-1`, BOT);
    j.add("SHOP-1", "/qa ready AC-2", { accountId: "5app0000000000000009", displayName: "Some bot", accountType: "app" });
    expect(await readOverrides(cfg(), j.ctx, "SHOP-1")).toEqual([]);
  });

  it("the allowed list is enforced by account id or username", async () => {
    const j = await jira();
    j.add("SHOP-1", "/qa ready AC-1", EVE);
    j.add("SHOP-1", "/qa ready AC-2", DANA);
    const o = await readOverrides(cfg({ allowed: [DANA.accountId] }), j.ctx, "SHOP-1");
    expect(o.map((x) => x.ac)).toEqual(["AC-2"]);
    j.add("SHOP-1", "/qa ready AC-3", { name: "alice", displayName: "Alice" });
    expect((await readOverrides(cfg({ allowed: ["alice"] }), j.ctx, "SHOP-1")).map((x) => [x.ac, x.by])).toEqual([["AC-3", "Alice"]]);
  });

  it("/qa unready takes it back, and a later ready puts it back; a deleted comment drops it", async () => {
    const j = await jira();
    j.add("SHOP-1", "/qa ready AC-1\n/qa ready AC-2", DANA);
    const un = j.add("SHOP-1", "/qa unready AC-1", EVE);
    expect((await readOverrides(cfg(), j.ctx, "SHOP-1")).map((x) => x.ac)).toEqual(["AC-2"]);
    j.add("SHOP-1", "/qa ready AC-1 again", EVE);
    expect((await readOverrides(cfg(), j.ctx, "SHOP-1")).map((x) => x.ac)).toEqual(["AC-1", "AC-2"]);
    j.comments["SHOP-1"].splice(j.comments["SHOP-1"].indexOf(un), 1);
    expect((await readOverrides(cfg(), j.ctx, "SHOP-1")).map((x) => x.ac)).toEqual(["AC-1", "AC-2"]);
  });

  it("a custom command is honoured", async () => {
    const j = await jira();
    j.add("SHOP-1", "/qa ready AC-1", DANA);
    j.add("SHOP-1", "!qa-ok AC-2", DANA);
    expect((await readOverrides(cfg({ command: "!qa-ok" }), j.ctx, "SHOP-1")).map((x) => x.ac)).toEqual(["AC-2"]);
  });

  it("when Jira will not say who qa-sentinel is, nothing new is read and the stored ones stay", async () => {
    const j = await jira({ me: null });
    j.add("SHOP-1", "/qa ready AC-1", DANA);
    const prev = [{ ac: "AC-9", by: "x", at: "2026-10-01T00:00:00Z", commentId: "1" }];
    expect(await readOverrides(cfg(), j.ctx, "SHOP-1", prev)).toEqual(prev);
  });

  it("an override lets a cross-service AC be written before the Jira card is ready (an open merge request still holds it)", () => {
    const merged = [
      { service: "orders", merged: true, sha: "a1" },
      { service: "payments", merged: true, sha: "b2" },
    ] as never;
    const o = { mode: "when-ready-status" as const, jiraReady: false };
    expect(acWriteReadiness(merged, undefined, ["AC-1"], o)[0].state).toBe("waiting-status");
    expect(acWriteReadiness(merged, undefined, ["AC-1"], { ...o, overrides: [{ ac: "AC-1" }] })[0].state).toBe("ready");
    const open = [{ service: "orders", merged: true, sha: "a1" }, { service: "payments", merged: false, sha: "b2" }] as never;
    expect(acWriteReadiness(open, undefined, ["AC-1"], { ...o, overrides: [{ ac: "AC-1" }] })[0].state).toBe("waiting-merge");
  });

  it("a quote that holds a code block is quoted to its own end (open blocks are a stack)", () => {
    const body = ["{quote}", "{code}", "/qa ready AC-1", "{code}", "/qa ready AC-2", "{quote}", "{quote}", "{code:sh}", "x", "{code}", "{noformat}", "/qa ready AC-3", "{noformat}", "/qa ready AC-4", "{quote}", "/qa ready AC-5 outside"].join("\n");
    expect(parseOverrideLines(body, "/qa ready").map((x) => x.ac)).toEqual(["AC-5"]);
    // A {quote} written inside {code} is text, not the end of anything.
    expect(parseOverrideLines(["{code}", "{quote}", "{code}", "/qa ready AC-1 real"].join("\n"), "/qa ready").map((x) => x.ac)).toEqual(["AC-1"]);
  });
  it("ignores the command inside {code}, {noformat}, {quote}, bq. lines and > quotes", () => {
    const body = ["{code}", "/qa ready AC-1", "{code}", "{noformat}", "/qa ready AC-2", "{noformat}", "{quote}", "/qa ready AC-3", "{quote}", "bq. /qa ready AC-4", "> /qa ready AC-5", "{code:sh}/qa ready AC-6{code}", "/qa ready AC-7 for real"].join("\n");
    expect(parseOverrideLines(body, "/qa ready")).toEqual([{ op: "ready", ac: "AC-7", reason: "for real" }]);
  });

  it("builds the take-back command for any command", () => {
    expect(unreadyCommand("/qa ready")).toBe("/qa unready");
    expect(unreadyCommand("/qa-ready")).toBe("/qa-unready");
    expect(unreadyCommand("!qa-ok")).toBe("!qa-ok undo");
    expect(parseOverrideLines("/qa-unready AC-1\n/qa-ready AC-2", "/qa-ready")).toEqual([{ op: "unready", ac: "AC-1" }, { op: "ready", ac: "AC-2" }]);
  });

  it("uses the time the comment was last edited as the time of the override", async () => {
    const j = await jira();
    const c = j.add("SHOP-1", "/qa ready AC-1", DANA, { updated: "2026-10-21T09:00:00.000+0000" });
    expect((await readOverrides(cfg(), j.ctx, "SHOP-1"))[0].at).toBe("2026-10-21T09:00:00.000+0000");
    expect(c.created).not.toBe(c.updated);
  });
});

describe("the waiting section says what an override covers", () => {
  const rec = (o: Record<string, unknown> = {}) => ({ crossService: {}, acEvidence: {}, overrides: [], conflict: undefined, ...o }) as never;
  it("names the service that has no change, and flags an AC the story does not have", () => {
    const text = pendingWiki(rec({ overrides: [{ ac: "AC-1", by: "Dana Tester", at: "2026-10-21T09:00:00Z", commentId: "1" }] }), {
      waits: [{ ac: "AC-1", state: "ready", reason: "marked ready by a person (payments has no change)" }],
      unknownOverrides: ["AC-99"],
    })!;
    expect(text).toContain("AC-1 marked ready by Dana Tester on 2026-10-21; this skips: payments has no change");
    expect(text).toContain("AC-99 was marked ready, but this story has no such AC (ignored)");
  });
  it("lists what waiting ACs wait for, a held cross-service AC and a conflict; escapes a display name", () => {
    const text = pendingWiki(
      rec({
        conflict: { branch: "qa-sentinel/story-SHOP-1", message: "merging main conflicts in a.ts", at: "t", key: "k" },
        crossService: { "AC-3": { state: "held", heads: "h", acHash: "x", at: "t", reason: "storefront not merged" } },
        overrides: [{ ac: "AC-1", by: "Eve [~admin] *bold*\nnewline", at: "2026-10-21T09:00:00Z", commentId: "1" }],
      }),
      { waits: [{ ac: "AC-2", state: "waiting-merge", reason: "not merged yet: payments !7", waitingFor: "the merge of payments !7" }, { ac: "AC-1", state: "waiting-merge", reason: "r" }] },
    )!;
    expect(text).toContain("cannot take the main branch");
    expect(text).toContain("AC-3: end-to-end tests are held: storefront not merged");
    expect(text).toContain("AC-2: tests wait for the merge of payments !7");
    expect(text).not.toContain("AC-1: tests wait"); // overridden, shown on its own line
    expect(text).toContain("Eve \\[\\~admin\\] \\*bold\\* newline");
    expect(text).not.toContain("[~admin]");
    expect(pendingWiki(rec(), {})).toBeNull();
  });
});
