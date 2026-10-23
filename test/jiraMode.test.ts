import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigSchema, jiraMode, writeConfig } from "../src/config.js";
import { hotfixCommand } from "../src/commands/hotfix.js";
import { STATUS_MARKER, parseStatus, postToStory, renderStatus, withSection } from "../src/reporting/statusComment.js";
import { fileStore } from "../src/stories/record.js";
import { findIssueComment, upsertIssueComment } from "../src/scm/jira.js";
import { BOT, DANA, mockJira } from "./helpers/mockJira.js";
import { cleanTmp, commit, g, tmp } from "./helpers/mocks.js";

afterEach(() => {
  cleanTmp();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const cfg = (jira: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
  ConfigSchema.parse({ version: 1, mode: "existing", project: { name: "t" }, tests: { api: { framework: "playwright", runCommand: "x" } }, ci: { platform: "gitlab" }, reporting: { jira }, ...extra });

const feature = { name: "feature", wiki: "h3. Feature\nok", legacyKind: "feature", legacyMarker: "qa-sentinel:feature" };

describe("reporting.jira.mode", () => {
  it("resolves from mode, or from the old layout key when mode is not set", () => {
    expect(jiraMode(cfg())).toBe("status");
    expect(jiraMode(cfg({ layout: "single" }))).toBe("status");
    expect(jiraMode(cfg({ layout: "separate" }))).toBe("legacy");
    expect(jiraMode(cfg({ layout: "separate", mode: "both" }))).toBe("both");
    expect(jiraMode(cfg({ mode: "status", layout: "separate" }))).toBe("status");
  });

  it("has the defaults of the plan for cleanup, notify and the override", () => {
    const j = cfg().reporting.jira;
    expect(j.cleanup).toBe("pointer");
    expect(j.mode).toBeUndefined();
    expect(Object.fromEntries(Object.entries(j.notify).map(([k, v]) => [k, v.on]))).toEqual({ "showcase-ready": true, "ac-not-built-but-ready": false, "cross-service-tests-ready": false, "stopped-by-budget": false, "merge-conflict": false });
    expect(j.override).toEqual({ command: "/qa ready", allowed: [] });
    expect(cfg().showcase.reattachOnChange).toBe(false);
  });

  it("legacy (and the old layout: separate) writes one comment per kind and no status comment", async () => {
    const j = await mockJira();
    try {
      for (const c of [cfg({ mode: "legacy" }), cfg({ layout: "separate" })]) {
        await postToStory(c, j.ctx, "SHOP-1", feature);
        await postToStory(c, j.ctx, "SHOP-1", { name: "bugs", wiki: "h3. B", legacyKind: "bugs", legacyMarker: "qa-sentinel:bugs" });
      }
      expect(j.comments["SHOP-1"].map((x) => x.body.match(/qa-sentinel:\w+/)?.[0])).toEqual(["qa-sentinel:feature", "qa-sentinel:bugs"]);
      expect(j.comments["SHOP-1"].some((x) => x.body.includes(STATUS_MARKER))).toBe(false);
    } finally {
      await j.close();
    }
  });

  it("both writes the status section and the legacy comment, and edits each in place next time", async () => {
    const j = await mockJira();
    try {
      const c = cfg({ mode: "both" });
      await postToStory(c, j.ctx, "SHOP-1", feature);
      await postToStory(c, j.ctx, "SHOP-1", { ...feature, wiki: "h3. Feature\nv2" });
      expect(j.comments["SHOP-1"]).toHaveLength(2);
      expect(j.comments["SHOP-1"].map((x) => x.body.includes(STATUS_MARKER))).toEqual([true, false]);
      expect(j.comments["SHOP-1"].every((x) => x.body.includes("v2"))).toBe(true);
    } finally {
      await j.close();
    }
  });
});

describe("older comments move into the status comment", () => {
  const legacyBodies = ["h3. Gap orders\nold gap text\n\n{color:#97a0af}qa-sentinel:gap-report:orders{color}", "h3. Feature\nold feature text\n\n{color:#97a0af}qa-sentinel:feature{color}", "h3. Post-deploy\nold post-deploy text\n\n{color:#97a0af}qa-sentinel:post-deploy{color}"];
  const seed = async () => {
    const j = await mockJira();
    const own = legacyBodies.map((b) => j.add("SHOP-1", b, BOT));
    // A person who pasted a marker, and a person's own comment: neither is ours.
    const foreign = j.add("SHOP-1", "I copied this: qa-sentinel:feature qa-sentinel:gap-report:orders", DANA);
    const human = j.add("SHOP-1", "looks fine to me", DANA);
    return { j, own, foreign, human };
  };
  const statusOf = (j: Awaited<ReturnType<typeof mockJira>>, id: string) => parseStatus(j.comments["SHOP-1"].find((x) => x.id === id)!.body);

  it("pointer (default): the text is carried into the status comment first, then our three become one-line pointers; the foreign one is untouched; a second run changes nothing", async () => {
    const { j, own, foreign, human } = await seed();
    try {
      const c = cfg();
      const r = await postToStory(c, j.ctx, "SHOP-1", feature);
      expect(r.action).toBe("created");
      // Nothing is lost: the fresh feature section is there, and the gap report and post-deploy text of the old comments became sections.
      const sections = statusOf(j, r.id);
      expect(sections.map((x) => x.name).sort()).toEqual(["feature", "gap-report:orders", "post-deploy"]);
      expect(sections.find((x) => x.name === "gap-report:orders")!.wiki).toBe("h3. Gap orders\nold gap text");
      expect(sections.find((x) => x.name === "post-deploy")!.wiki).toContain("old post-deploy text");
      expect(sections.find((x) => x.name === "feature")!.wiki).toBe("h3. Feature\nok"); // the fresher run wins over the old comment
      const pointers = own.map((o) => j.comments["SHOP-1"].find((x) => x.id === o.id)!.body);
      for (const p of pointers) {
        expect(p.split("\n")).toHaveLength(1);
        expect(p).toContain(`Replaced by the QA status comment: ${r.url}`);
        expect(p).toContain("qa-sentinel:replaced");
      }
      expect(j.comments["SHOP-1"].find((x) => x.id === foreign.id)!.body).toContain("I copied this");
      expect(j.comments["SHOP-1"].find((x) => x.id === human.id)!.body).toBe("looks fine to me");
      expect(j.foreignWrites()).toEqual([]);
      const writes = j.writes().length;
      await postToStory(c, j.ctx, "SHOP-1", feature); // the status comment exists: one update, nothing else
      expect(j.writes().length).toBe(writes + 1);
      expect(j.foreignWrites()).toEqual([]);
    } finally {
      await j.close();
    }
  });

  it("delete: the text is carried first, then our three are deleted; the foreign comment and the human one stay", async () => {
    const { j, foreign, human } = await seed();
    try {
      const r = await postToStory(cfg({ cleanup: "delete" }), j.ctx, "SHOP-1", feature);
      expect(statusOf(j, r.id).map((x) => x.name).sort()).toEqual(["feature", "gap-report:orders", "post-deploy"]);
      const ids = j.comments["SHOP-1"].map((x) => x.id);
      expect(ids).toContain(foreign.id);
      expect(ids).toContain(human.id);
      expect(j.comments["SHOP-1"]).toHaveLength(3); // foreign, human, the new status comment
      expect(j.touched.filter((t) => t.method === "DELETE")).toHaveLength(3);
      expect(j.foreignWrites()).toEqual([]);
    } finally {
      await j.close();
    }
  });

  it("keep: nothing is touched", async () => {
    const { j } = await seed();
    try {
      await postToStory(cfg({ cleanup: "keep" }), j.ctx, "SHOP-1", feature);
      expect(j.touched).toEqual([]);
    } finally {
      await j.close();
    }
  });

  it("an older comment of a kind the status comment has no section for is never pointed before its text is in the status comment", async () => {
    const { j, own } = await seed();
    try {
      // The status comment write is made to fail after the first one: the old comments must stay as they were.
      const realFetch = globalThis.fetch;
      let puts = 0;
      vi.stubGlobal("fetch", (url: string, init?: RequestInit) => (init?.method === "PUT" && ++puts === 1 ? Promise.resolve(new Response("no", { status: 403 })) : realFetch(url, init)));
      await postToStory(cfg(), j.ctx, "SHOP-1", feature);
      vi.unstubAllGlobals();
      for (const o of own) expect(j.comments["SHOP-1"].find((x) => x.id === o.id)!.body).not.toContain("qa-sentinel:replaced");
    } finally {
      await j.close();
    }
  });

  it("one old comment that cannot be changed: its text is in the status comment already, the others are done, and the next write retries", async () => {
    const { j, own } = await seed();
    const cwd = tmp("qas-cleanup-");
    try {
      const realFetch = globalThis.fetch;
      let fail = true;
      vi.stubGlobal("fetch", (url: string, init?: RequestInit) => (fail && init?.method === "PUT" && url.endsWith(`/comment/${own[2].id}`) ? Promise.resolve(new Response("no", { status: 403 })) : realFetch(url, init)));
      const r = await postToStory(cfg(), j.ctx, "SHOP-1", { ...feature, cwd });
      expect(statusOf(j, r.id).map((x) => x.name)).toContain("post-deploy"); // content kept in the status comment
      expect(j.comments["SHOP-1"].find((x) => x.id === own[2].id)!.body).toContain("old post-deploy text"); // that one is still as it was
      expect(j.comments["SHOP-1"].find((x) => x.id === own[0].id)!.body).toContain("qa-sentinel:replaced");
      expect((await fileStore(cwd).load("SHOP-1"))?.legacyCleanedAt).toBeUndefined(); // not marked as done
      fail = false;
      await postToStory(cfg(), j.ctx, "SHOP-1", { ...feature, cwd });
      expect(j.comments["SHOP-1"].find((x) => x.id === own[2].id)!.body).toContain("qa-sentinel:replaced");
      expect((await fileStore(cwd).load("SHOP-1"))?.legacyCleanedAt).toBeDefined();
      vi.unstubAllGlobals();
    } finally {
      vi.unstubAllGlobals();
      await j.close();
    }
  });

  it("a comment with a different visibility than the status comment is left alone (moving it would show it to more people)", async () => {
    const j = await mockJira();
    try {
      const restricted = j.add("SHOP-1", legacyBodies[0], BOT, { visibility: { type: "role", value: "Administrators" } });
      const r = await postToStory(cfg(), j.ctx, "SHOP-1", feature);
      expect(j.comments["SHOP-1"].find((x) => x.id === restricted.id)!.body).toBe(legacyBodies[0]);
      expect(statusOf(j, r.id).map((x) => x.name)).toEqual(["feature"]);
    } finally {
      await j.close();
    }
  });

  it("a pointer keeps the visibility its comment had", async () => {
    const j = await mockJira();
    try {
      const vis = { type: "role", value: "Developers" };
      const old = j.add("SHOP-1", legacyBodies[0], BOT, { visibility: vis });
      await postToStory(cfg({ visibility: vis }), j.ctx, "SHOP-1", feature);
      expect(j.comments["SHOP-1"].find((x) => x.id === old.id)).toMatchObject({ visibility: vis });
      expect(j.comments["SHOP-1"].find((x) => x.id === old.id)!.body).toContain("qa-sentinel:replaced");
    } finally {
      await j.close();
    }
  });

  it("upgrade both -> status: the legacy comments kept up to date in `both` become pointers on the next status write", async () => {
    const j = await mockJira();
    const cwd = tmp("qas-upgrade-");
    try {
      await postToStory(cfg({ mode: "both" }), j.ctx, "SHOP-1", { ...feature, cwd });
      expect(j.comments["SHOP-1"]).toHaveLength(2);
      expect(j.comments["SHOP-1"].some((x) => x.body.includes("qa-sentinel:replaced"))).toBe(false);
      // `both` never marks the cleanup as done, so switching to `status` cleans up on the next write (an update, not a creation).
      const r = await postToStory(cfg({ mode: "status" }), j.ctx, "SHOP-1", { ...feature, wiki: "h3. Feature\nv2", cwd });
      expect(r.action).toBe("updated");
      const legacy = j.comments["SHOP-1"].find((x) => !x.body.includes(STATUS_MARKER))!;
      expect(legacy.body).toContain(`Replaced by the QA status comment: ${r.url}`);
      expect(statusOf(j, r.id).find((x) => x.name === "feature")!.wiki).toContain("v2");
      expect((await fileStore(cwd).load("SHOP-1"))?.legacyCleanedAt).toBeDefined();
    } finally {
      await j.close();
    }
  });

  it("an existing status comment from the current main plus old own comments: the first write of this version cleans up, once (the record remembers)", async () => {
    const j = await mockJira();
    const cwd = tmp("qas-upgrade-");
    try {
      const statusCm = j.add("SHOP-1", renderStatus("SHOP-1", withSection([], "post-deploy", "h3. P\nkept", new Date("2026-10-21T10:00:00Z"))), BOT);
      const old = j.add("SHOP-1", legacyBodies[0], BOT);
      const c = cfg();
      const r = await postToStory(c, j.ctx, "SHOP-1", { ...feature, cwd });
      expect(r).toMatchObject({ action: "updated", id: statusCm.id });
      expect(j.comments["SHOP-1"].find((x) => x.id === old.id)!.body).toContain("qa-sentinel:replaced");
      expect(statusOf(j, r.id).map((x) => x.name).sort()).toEqual(["feature", "gap-report:orders", "post-deploy"]);
      // Marked done: a new legacy-looking own comment is not looked for on every write (one fewer read than without the record).
      const gets = () => j.calls.filter((x) => x.startsWith("GET") && x.endsWith("/comment")).length;
      const before = gets();
      await postToStory(c, j.ctx, "SHOP-1", { ...feature, cwd });
      const withRecord = gets() - before;
      const before2 = gets();
      await postToStory(c, j.ctx, "SHOP-1", feature); // no record: it looks again
      expect(gets() - before2).toBeGreaterThan(withRecord);
    } finally {
      await j.close();
    }
  });

  it("mode legacy and both never clean up", async () => {
    const { j } = await seed();
    try {
      await postToStory(cfg({ mode: "both" }), j.ctx, "SHOP-1", feature);
      expect(j.comments["SHOP-1"].filter((x) => x.body.includes("qa-sentinel:replaced"))).toHaveLength(0);
    } finally {
      await j.close();
    }
  });
});

describe("only qa-sentinel's own comments are found and edited", () => {
  it("a person's comment holding the status marker is never edited; ours is created instead", async () => {
    const j = await mockJira();
    try {
      const theirs = j.add("SHOP-1", `Look: ${STATUS_MARKER} h2. QA status`, DANA);
      const r = await postToStory(cfg(), j.ctx, "SHOP-1", feature);
      expect(r.action).toBe("created");
      expect(r.id).not.toBe(theirs.id);
      expect(j.comments["SHOP-1"].find((x) => x.id === theirs.id)!.body).toContain("Look:");
      expect(parseStatus(j.comments["SHOP-1"].find((x) => x.id === r.id)!.body).map((x) => x.name)).toEqual(["feature"]);
      expect(j.touched).toEqual([]);
    } finally {
      await j.close();
    }
  });

  it("findIssueComment / upsertIssueComment skip other people's comments with the marker (legacy mode too)", async () => {
    const j = await mockJira();
    try {
      const theirs = j.add("SHOP-1", "qa-sentinel:gap-report:orders pasted", DANA);
      expect(await findIssueComment(j.ctx, "SHOP-1", "qa-sentinel:gap-report:orders")).toBeUndefined();
      expect(await findIssueComment(j.ctx, "SHOP-1", "qa-sentinel:gap-report:orders", { ownOnly: false })).toMatchObject({ id: theirs.id });
      const r = await upsertIssueComment(j.ctx, "SHOP-1", "orders", "h3. Gap");
      expect(r.action).toBe("created");
      const r2 = await upsertIssueComment(j.ctx, "SHOP-1", "orders", "h3. Gap v2");
      expect(r2).toMatchObject({ action: "updated", id: r.id });
      expect(j.foreignWrites()).toEqual([]);
    } finally {
      await j.close();
    }
  });

  it("Data Center identifies the user by name/key", async () => {
    const dc = { name: "qa-bot", key: "JIRAUSER10100", displayName: "QA bot" };
    const j = await mockJira({ me: dc });
    try {
      j.add("SHOP-1", `${STATUS_MARKER} foreign`, { name: "alice", key: "JIRAUSER1" });
      const mine = j.add("SHOP-1", `${STATUS_MARKER} mine`, dc);
      expect(await findIssueComment(j.ctx, "SHOP-1", STATUS_MARKER)).toMatchObject({ id: mine.id });
    } finally {
      await j.close();
    }
  });
});

describe("hotfix comment in legacy mode", () => {
  it("uses its own marker (qa-sentinel:hotfix-<service>), not a gap-report one, and updates the same comment", async () => {
    const j = await mockJira();
    const ws = tmp("qas-hotfix-");
    const svc = path.join(ws, "orders");
    fs.mkdirSync(svc);
    g(svc, "init", "-q", "-b", "main");
    commit(svc, "a.txt", "1", "start");
    const fix = commit(svc, "b.txt", "2", "SHOP-9 hotfix");
    writeConfig(ws, cfg({ mode: "legacy", baseUrl: undefined }, { workspace: { services: [{ name: "orders", path: "orders" }] }, requirements: { storyKeyPattern: "SHOP-\\d+", jira: { baseUrl: j.baseUrl } } }));
    vi.stubEnv("JIRA_PAT", "x");
    try {
      const run = () => hotfixCommand({ cwd: ws, service: "orders", commit: [fix], story: "SHOP-9", post: true });
      await run();
      await run();
      const list = j.comments["SHOP-9"];
      expect(list).toHaveLength(1);
      expect(list[0].body).toContain("qa-sentinel:hotfix-orders");
      expect(list[0].body).not.toContain("gap-report:hotfix");
      // The cleanup knows this marker: in status mode a comment like it becomes a pointer and its text a hotfix section.
      const r = await postToStory(cfg(), j.ctx, "SHOP-9", feature);
      expect(list[0].body).toContain(`Replaced by the QA status comment: ${r.url}`);
      expect(list.find((x) => x.id === r.id)!.body).toContain("qa-sentinel:section=hotfix:orders");
    } finally {
      await j.close();
    }
  });
});
