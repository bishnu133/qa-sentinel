import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { mentionOf, notify, notifyOutcome, notifyStory, recipients } from "../src/reporting/notify.js";
import { emptyRecord, fileStore } from "../src/stories/record.js";
import { startJob } from "../src/stories/start.js";
import { mockJira } from "./helpers/mockJira.js";
import { cleanTmp, tmp } from "./helpers/mocks.js";

afterEach(() => cleanTmp());

const cfg = (jira: Record<string, unknown> = {}, showcase: Record<string, unknown> = {}) =>
  ConfigSchema.parse({ version: 1, mode: "existing", project: { name: "t" }, tests: { api: { framework: "playwright", runCommand: "x" } }, ci: { platform: "gitlab" }, reporting: { jira }, showcase });

describe("notifications", () => {
  it("the same event and subject twice posts one comment; another subject posts another", async () => {
    const j = await mockJira();
    const store = fileStore(tmp("qas-notify-"));
    try {
      const c = cfg({ notify: { "ac-not-built-but-ready": { on: true, to: ["5b10ac8d82e05b22cc7d4ef5"] } } });
      const o = { c, ctx: j.ctx, store, story: "SHOP-1", event: "ac-not-built-but-ready" as const, text: "AC-1 does not look built." };
      expect(await notify({ ...o, key: "AC-1" })).toBe(true);
      expect(await notify({ ...o, key: "AC-1" })).toBe(false);
      expect(await notify({ ...o, key: "AC-2" })).toBe(true);
      expect(j.comments["SHOP-1"]).toHaveLength(2);
      expect(j.comments["SHOP-1"][0].body).toContain("[~accountid:5b10ac8d82e05b22cc7d4ef5] AC-1 does not look built.");
      expect((await store.load("SHOP-1"))!.notified.map((n) => `${n.event}/${n.key}`)).toEqual(["ac-not-built-but-ready/AC-1", "ac-not-built-but-ready/AC-2"]);
    } finally {
      await j.close();
    }
  });

  it("mentions: Cloud account ids and Data Center usernames", () => {
    expect(mentionOf("5b10ac8d82e05b22cc7d4ef5")).toBe("[~accountid:5b10ac8d82e05b22cc7d4ef5]");
    expect(mentionOf("712020:abc-def")).toBe("[~accountid:712020:abc-def]");
    expect(mentionOf("jsmith")).toBe("[~jsmith]");
  });

  it("an event that is off posts nothing; to: [] falls back to showcase.notify; nobody to tell posts nothing", async () => {
    const j = await mockJira();
    const store = fileStore(tmp("qas-notify-"));
    try {
      const off = cfg({}, { notify: ["jsmith"] });
      expect(off.reporting.jira.notify["merge-conflict"].on).toBe(false);
      expect(off.reporting.jira.notify["showcase-ready"].on).toBe(true);
      const base = { ctx: j.ctx, store, story: "SHOP-1", text: "x", key: "k" };
      expect(await notify({ ...base, c: off, event: "merge-conflict" })).toBe(false);
      // Only showcase-ready falls back to showcase.notify; the other events with to: [] tell nobody.
      const on = cfg({ notify: { "merge-conflict": { on: true } } }, { notify: ["jsmith"] });
      expect(recipients(on, "merge-conflict")).toEqual([]);
      expect(recipients(on, "showcase-ready")).toEqual(["jsmith"]);
      expect(await notify({ ...base, c: on, event: "merge-conflict" })).toBe(false);
      expect(j.comments["SHOP-1"] ?? []).toHaveLength(0);
      expect(await notify({ ...base, c: on, event: "showcase-ready" })).toBe(true);
      expect(j.comments["SHOP-1"][0].body).toContain("[~jsmith]");
      const nobody = cfg({ notify: { "stopped-by-budget": { on: true } } });
      expect(await notify({ ...base, c: nobody, event: "stopped-by-budget" })).toBe(false);
      expect(j.comments["SHOP-1"]).toHaveLength(1);
    } finally {
      await j.close();
    }
  });

  it("a Jira failure is a warning, not an error, and is not remembered as sent", async () => {
    const j = await mockJira();
    const store = fileStore(tmp("qas-notify-"));
    const c = cfg({ notify: { "stopped-by-budget": { on: true, to: ["jsmith"] } } });
    const ctx = { ...j.ctx };
    await j.close();
    expect(await notify({ c, ctx, store, story: "SHOP-1", event: "stopped-by-budget", text: "x", key: "k" })).toBe(false);
    // The mark was taken back, so the next run tries again.
    expect((await store.load("SHOP-1"))?.notified ?? []).toEqual([]);
  });

  it("notifyStory does nothing without Jira credentials", async () => {
    const cwd = tmp("qas-notify-");
    const c = cfg({ notify: { "merge-conflict": { on: true, to: ["jsmith"] } } });
    expect(await notifyStory(cwd, c, "SHOP-1", "merge-conflict", "x", "k", {})).toBe(false);
    expect(fs.existsSync(path.join(cwd, ".qa-sentinel"))).toBe(false);
  });

  it("a job refused for its budget tells the people once (startJob), the same job refused again does not", async () => {
    const j = await mockJira();
    const cwd = tmp("qas-notify-");
    try {
      const c = ConfigSchema.parse({ version: 1, mode: "existing", project: { name: "t" }, tests: { api: { framework: "playwright", runCommand: "x" } }, ci: { platform: "gitlab" }, requirements: { jira: { baseUrl: j.baseUrl } }, automation: { budgets: { perStoryUsd: 1 } }, reporting: { jira: { notify: { "stopped-by-budget": { on: true, to: ["jsmith"] } } } } });
      await fileStore(cwd).save({ ...emptyRecord("SHOP-1"), totalCostUsd: 5 });
      const env = { JIRA_PAT: "x" };
      for (let i = 0; i < 2; i++) {
        const r = await startJob({ cwd, c, story: "SHOP-1", kind: "generate", key: "generate:SHOP-1:abc", env });
        expect(r).toMatchObject({ run: false, exitCode: 4 });
      }
      expect(j.comments["SHOP-1"]).toHaveLength(1);
      expect(j.comments["SHOP-1"][0].body).toContain("[~jsmith] qa-sentinel stopped before starting AI work on this story: AI budget:");
    } finally {
      await j.close();
    }
  });

  it("in the split analysis job (local) a budget stop writes nothing to Jira; the note waits as a notify step for publish, which sends it once", async () => {
    const j = await mockJira();
    const cwd = tmp("qas-notify-");
    try {
      const c = ConfigSchema.parse({ version: 1, mode: "existing", project: { name: "t" }, tests: { api: { framework: "playwright", runCommand: "x" } }, ci: { platform: "gitlab" }, requirements: { jira: { baseUrl: j.baseUrl } }, automation: { budgets: { perStoryUsd: 1 } }, reporting: { jira: { notify: { "stopped-by-budget": { on: true, to: ["jsmith"] } } } } });
      await fileStore(cwd).save({ ...emptyRecord("SHOP-1"), totalCostUsd: 5 });
      const r = await startJob({ cwd, c, story: "SHOP-1", kind: "generate", key: "generate:SHOP-1:abc", env: { JIRA_PAT: "x" }, local: true });
      expect(r).toMatchObject({ run: false, exitCode: 4 });
      expect(j.calls.filter((x) => !x.startsWith("GET "))).toEqual([]);
      const runs = path.join(cwd, ".qa-sentinel", "runs");
      const dir = fs.readdirSync(runs).map((n) => path.join(runs, n)).find((d) => fs.existsSync(path.join(d, "publish.json")))!;
      const doc = JSON.parse(fs.readFileSync(path.join(dir, "publish.json"), "utf8"));
      expect(doc.steps).toMatchObject([{ type: "notify", story: "SHOP-1", event: "stopped-by-budget" }]);
      const { publishCommand } = await import("../src/commands/publish.js");
      const { writeConfig } = await import("../src/config.js");
      writeConfig(cwd, c);
      expect(await publishCommand({ cwd, kind: "generate", env: { JIRA_PAT: "x", QA_STORY_KEY: "SHOP-1" } })).toBe(0);
      expect(j.comments["SHOP-1"]).toHaveLength(1);
      expect(j.comments["SHOP-1"][0].body).toContain("qa-sentinel stopped before starting AI work");
    } finally {
      await j.close();
    }
  });

  it("when the record cannot be saved nothing is posted (it would be repeated on every run); when the post fails the mark is taken back", async () => {
    const j = await mockJira();
    const real = fileStore(tmp("qas-notify-"));
    try {
      const c = cfg({ notify: { "merge-conflict": { on: true, to: ["jsmith"] } } });
      const o = { c, ctx: j.ctx, story: "SHOP-1", event: "merge-conflict" as const, text: "x", key: "k" };
      const broken = { ...real, save: async () => { throw new Error("disk full"); } };
      expect(await notifyOutcome({ ...o, store: broken })).toBe("failed");
      expect(await notifyOutcome({ ...o, store: broken })).toBe("failed");
      expect(j.comments["SHOP-1"] ?? []).toHaveLength(0);
      expect(await notifyOutcome({ ...o, store: real })).toBe("sent");
      expect(await notifyOutcome({ ...o, store: real })).toBe("duplicate");
      expect(j.comments["SHOP-1"]).toHaveLength(1);
    } finally {
      await j.close();
    }
  });

  it("a later conflict on a new branch tip has a new key and tells again", async () => {
    const j = await mockJira();
    const store = fileStore(tmp("qas-notify-"));
    try {
      const c = cfg({ notify: { "merge-conflict": { on: true, to: ["jsmith"] } } });
      const o = { c, ctx: j.ctx, store, story: "SHOP-1", event: "merge-conflict" as const, text: "x" };
      expect(await notify({ ...o, key: "qa-sentinel/story-SHOP-1@aaaa+bbbb" })).toBe(true);
      expect(await notify({ ...o, key: "qa-sentinel/story-SHOP-1@aaaa+bbbb" })).toBe(false);
      expect(await notify({ ...o, key: "qa-sentinel/story-SHOP-1@cccc+bbbb" })).toBe(true);
    } finally {
      await j.close();
    }
  });
});
