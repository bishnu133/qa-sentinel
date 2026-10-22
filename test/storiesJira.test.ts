import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigSchema, writeConfig } from "../src/config.js";
import { storiesCommand } from "../src/commands/stories.js";
import { renderStatus, withSection, parseStatus, STATUS_MARKER } from "../src/reporting/statusComment.js";
import { emptyRecord, fileStore } from "../src/stories/record.js";
import { storyBasis } from "../src/stories/parts.js";
import { BOT, DANA, mockJira } from "./helpers/mockJira.js";
import { GIT_ENV, cleanTmp, g, tmp } from "./helpers/mocks.js";

const T = new Date("2026-10-21T11:03:00Z");
const AC = "A slot takes at most 3 orders.";

describe("stories: the status comment is kept current with no AI", () => {
  let qa: string;
  let j: Awaited<ReturnType<typeof mockJira>>;
  const json: any[][] = [];
  beforeEach(async () => {
    for (const [k, v] of Object.entries(GIT_ENV)) vi.stubEnv(k, v);
    j = await mockJira({ issues: { "SHOP-101": { summary: "Delivery slots", issuetype: { name: "Story" }, status: { name: "Ready for QA" }, description: `## Acceptance criteria\n- AC-1: ${AC}\n`, labels: [], components: [] } } });
    qa = tmp("qas-storiesjira-");
    g(qa, "init", "-q", "-b", "main");
  });
  afterEach(async () => {
    await j.close();
    cleanTmp();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  const configure = (extra: Record<string, unknown> = {}, jira: Record<string, unknown> = {}) =>
    writeConfig(qa, ConfigSchema.parse({ version: 1, mode: "existing", project: { name: "t" }, tests: { api: { framework: "playwright", runCommand: "x" } }, ci: { platform: "gitlab" }, requirements: { source: "jira", jira: { baseUrl: j.baseUrl, projectKeys: ["SHOP"], featureIssueTypes: ["Story"] } }, reporting: { jira }, ...extra }));
  /** A record whose merged part is newer than what the status comment was written against. */
  const seedRecord = async (extra: Record<string, unknown> = {}) => {
    const rec = emptyRecord("SHOP-101", T);
    rec.parts = [{ service: "orders", source: "git", state: "merged", mergeSha: "abc1234", keys: ["SHOP-101"], firstSeenAt: "2026-10-22T09:00:00Z", lastSeenAt: "2026-10-22T09:00:00Z", mergedAt: "2026-10-22T09:00:00Z" }];
    await fileStore(qa).save({ ...rec, ...extra });
  };
  const run = (o: Record<string, unknown> = {}) => {
    const runners = { spec: vi.fn(async () => 0), generate: vi.fn(async () => 0) };
    const out: string[] = [];
    const w = vi.spyOn(process.stdout, "write").mockImplementation(((s: string) => (out.push(String(s)), true)) as never);
    return storiesCommand({ cwd: qa, story: ["SHOP-101"], json: true, noSweep: true, env: { JIRA_PAT: "x" }, now: new Date("2026-10-23T08:00:00Z"), runners, ...o }).then((code) => (w.mockRestore(), json.push(JSON.parse(out.join(""))), { code, runners }));
  };

  it("marks the result sections that are out of date, once, calling no AI step; a person's comment with the marker is untouched", async () => {
    configure();
    await seedRecord();
    const foreign = j.add("SHOP-101", `${STATUS_MARKER} pasted by a person`, DANA);
    let s = withSection([], "post-deploy", "h3. Post-deploy\nok", T, "00000000");
    s = withSection(s, "gap-report:orders", "h3. Gap\nline", T, "00000000");
    s = withSection(s, "feature", "h3. Feature\nold format, no basis", T);
    const mine = j.add("SHOP-101", renderStatus("SHOP-101", s), BOT);

    const { code, runners } = await run();
    expect(code).toBe(0);
    expect(runners.spec).not.toHaveBeenCalled();
    expect(runners.generate).not.toHaveBeenCalled();
    const lines = mine.body.split("\n");
    expect(mine.body.match(/Out of date/g)).toHaveLength(2);
    // The mark is the first line of its section: the line before "h3. Post-deploy".
    expect(lines[lines.indexOf("h3. Post-deploy") - 1]).toContain("Out of date");
    expect(lines[lines.indexOf("h3. Feature") - 1]).not.toContain("Out of date");
    expect(parseStatus(mine.body).find((x) => x.name === "post-deploy")!.wiki).toBe("h3. Post-deploy\nok");
    expect(mine.body).toContain("orders merged 2026-10-22");
    expect(foreign.body).toBe(`${STATUS_MARKER} pasted by a person`);
    expect(j.foreignWrites()).toEqual([]);
    // The record has the basis the marks were drawn against.
    const rec = (await fileStore(qa).load("SHOP-101"))!;
    expect(rec.basis).toBe(storyBasis(rec, rec.acs.map((a) => a.hash)));

    // Same state again: nothing is written.
    const puts = j.touched.length;
    await run();
    expect(j.touched.length).toBe(puts);
  });

  it("never creates a status comment: with none of ours, nothing is posted", async () => {
    configure();
    await seedRecord();
    j.add("SHOP-101", "hello", DANA);
    await run();
    expect(j.comments["SHOP-101"]).toHaveLength(1);
  });

  it("reads /qa ready AC-1 into the record and shows it in a pending section with the person's name", async () => {
    configure();
    await seedRecord();
    const mine = j.add("SHOP-101", renderStatus("SHOP-101", withSection([], "feature", "h3. Feature\nx", T)), BOT);
    const said = j.add("SHOP-101", "/qa ready AC-1 checked by hand", DANA);
    await run();
    expect(json.at(-1)[0].overrides).toEqual([{ ac: "AC-1", by: "Dana Tester", at: said.created, commentId: said.id }]);
    const rec = (await fileStore(qa).load("SHOP-101"))!;
    expect(rec.overrides).toEqual([{ ac: "AC-1", by: "Dana Tester", at: said.created, commentId: said.id }]);
    expect(parseStatus(mine.body).find((x) => x.name === "pending")!.wiki).toContain(`AC-1 marked ready by Dana Tester on ${said.created.slice(0, 10)}`);
    // Taken back: the override and its line go.
    j.add("SHOP-101", "/qa unready AC-1", DANA);
    await run();
    expect((await fileStore(qa).load("SHOP-101"))!.overrides).toEqual([]);
    expect(parseStatus(mine.body).some((x) => x.name === "pending")).toBe(false);
  });

  it("tells the people once when an AC looks not built but the story is in a ready status", async () => {
    configure({ showcase: { notify: ["jsmith"] } }, { notify: { "ac-not-built-but-ready": { on: true } } });
    await seedRecord({ acEvidence: { "AC-1": { status: "not-found", at: "2026-10-22T10:00:00Z" } } });
    await run();
    await run();
    const notes = j.comments["SHOP-101"].filter((c) => c.body.includes("qa-sentinel:notify:ac-not-built-but-ready"));
    expect(notes).toHaveLength(1);
    expect(notes[0].body).toContain("[~jsmith] AC-1 does not look built");
  });

  it("legacy mode: no status comment is made or touched", async () => {
    configure({}, { mode: "legacy" });
    await seedRecord();
    await run();
    expect(j.comments["SHOP-101"] ?? []).toHaveLength(0);
  });
});
