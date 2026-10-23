import { afterEach, describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { jiraIdentityCheck } from "../src/commands/doctor.js";
import { STATUS_MARKER, migrateLegacy, postToStory, refreshStaleness, renderStatus, withSection } from "../src/reporting/statusComment.js";
import { JiraIdentityError, findIssueComment, isAuthor, listOwnComments, myself, upsertIssueComment } from "../src/scm/jira.js";
import { readOverrides } from "../src/stories/overrides.js";
import { BOT, DANA, mockJira } from "./helpers/mockJira.js";

const cfg = (jira: Record<string, unknown> = {}) =>
  ConfigSchema.parse({ version: 1, mode: "existing", project: { name: "t" }, tests: { api: { framework: "playwright", runCommand: "x" } }, ci: { platform: "gitlab" }, reporting: { jira } });
const feature = { name: "feature", wiki: "h3. Feature\nok", legacyKind: "feature", legacyMarker: "qa-sentinel:feature" };

let closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const f of closers.splice(0)) await f();
});
const jira = async (o: Parameters<typeof mockJira>[0] = {}) => {
  const j = await mockJira(o);
  closers.push(j.close);
  return j;
};

describe("when Jira will not say who the token belongs to, nothing is edited, deleted or created", () => {
  for (const [label, o] of [["403", { me: null }], ["500", { meStatus: 500 }]] as const) {
    it(`/myself ${label}: no write in any path, and a person's comment holding the markers is never touched`, async () => {
      const j = await jira(o);
      const foreignStatus = j.add("SHOP-1", `${STATUS_MARKER} pasted by a person`, DANA);
      const foreignLegacy = j.add("SHOP-1", "pasted qa-sentinel:feature and qa-sentinel:gap-report:orders", DANA);
      const ours = j.add("SHOP-1", renderStatus("SHOP-1", withSection([], "feature", "h3. F\nx", new Date("2026-10-21T10:00:00Z"), "aaaa1111")), BOT);
      const oursLegacy = j.add("SHOP-1", "h3. Old\n{color:#97a0af}qa-sentinel:feature{color}", BOT);
      const before = JSON.stringify(j.comments);
      for (const mode of ["status", "legacy", "both"] as const) {
        const r = await postToStory(cfg({ mode }), j.ctx, "SHOP-1", feature);
        expect(r.action).toBe("skipped");
      }
      await expect(refreshStaleness(j.ctx, "SHOP-1", { basis: "bbbb2222", pending: "h3. Waiting\n* x" })).rejects.toBeInstanceOf(JiraIdentityError);
      await expect(upsertIssueComment(j.ctx, "SHOP-1", "orders", "h3. Gap")).rejects.toBeInstanceOf(JiraIdentityError);
      await expect(findIssueComment(j.ctx, "SHOP-1", STATUS_MARKER)).rejects.toBeInstanceOf(JiraIdentityError);
      await expect(listOwnComments(j.ctx, "SHOP-1")).rejects.toBeInstanceOf(JiraIdentityError);
      await expect(migrateLegacy(cfg(), j.ctx, "SHOP-1", { id: ours.id, url: "u" })).rejects.toBeInstanceOf(JiraIdentityError);
      expect(await readOverrides(cfg(), j.ctx, "SHOP-1", [])).toEqual([]);
      expect(j.writes()).toEqual([]);
      expect(j.foreignWrites()).toEqual([]);
      expect(JSON.stringify(j.comments)).toBe(before);
      expect([foreignStatus.id, foreignLegacy.id, ours.id, oursLegacy.id].length).toBe(4);
    });
  }

  it("a failure is not remembered: when /myself works again the next call goes through; after 3 failures in a process it stops asking", async () => {
    const j = await jira({ me: null });
    expect((await postToStory(cfg(), j.ctx, "SHOP-1", feature)).action).toBe("skipped");
    j.setMeFails(false);
    expect((await postToStory(cfg(), j.ctx, "SHOP-1", feature)).action).toBe("created");
    expect(await myself(j.ctx)).toMatchObject({ accountId: BOT.accountId });
    // Remembered once it worked: no more /myself calls.
    const asked = () => j.calls.filter((c) => c.endsWith("/myself")).length;
    const n = asked();
    await postToStory(cfg(), j.ctx, "SHOP-1", feature);
    expect(asked()).toBe(n);

    const k = await jira({ meStatus: 500 });
    for (let i = 0; i < 5; i++) await myself(k.ctx);
    expect(k.calls.filter((c) => c.endsWith("/myself"))).toHaveLength(3);
  });

  it("doctor --online reports who the credentials belong to, and fails (when Jira is a report target) or warns when it cannot", async () => {
    const ok = await jira();
    expect(await jiraIdentityCheck(ok.ctx, true)).toMatchObject({ level: "ok", label: expect.stringContaining("qa-sentinel") });
    const bad = await jira({ me: null });
    expect(await jiraIdentityCheck(bad.ctx, true)).toMatchObject({ level: "fail" });
    expect(await jiraIdentityCheck(bad.ctx, false)).toMatchObject({ level: "warn" });
  });
});

describe("who is the same user", () => {
  it("compares accountId first, then key, then name (the first identifier both sides have decides)", () => {
    expect(isAuthor({ accountId: "a1", name: "x" }, { accountId: "a1", name: "y" })).toBe(true);
    expect(isAuthor({ accountId: "a2", name: "x" }, { accountId: "a1", name: "x" })).toBe(false);
    expect(isAuthor({ key: "K1", name: "x" }, { key: "K2", name: "x" })).toBe(false);
    expect(isAuthor({ key: "K1", name: "x" }, { key: "K1", name: "z" })).toBe(true);
    expect(isAuthor({ name: "bot" }, { name: "bot" })).toBe(true);
    expect(isAuthor({ name: "bot" }, { accountId: "a1" })).toBe(false);
    expect(isAuthor(undefined, { name: "bot" })).toBe(false);
  });
});
