import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigSchema, writeConfig } from "../src/config.js";
import { actJobs, storiesCommand } from "../src/commands/stories.js";
import type { Assessment } from "../src/stories/assess.js";
import { GIT_ENV, cleanTmp, commit, g, tmp } from "./helpers/mocks.js";

const a = (key: string, o: Partial<Assessment> = {}): Assessment => ({ key, state: "needs-tests", next: "generate", headline: "", reasons: [], todo: [{ who: "ai", what: "x" }], acs: [], counts: { acs: 1, covered: 0, questions: 0, knownDefects: 0, awaitingTriage: 0 }, code: "merged", ...o });

describe("actJobs: which due jobs the background check starts", () => {
  it("starts nothing for a blocked job or a job for people", () => {
    expect(actJobs([a("S-1", { todo: [{ who: "ai", what: "x", blocked: "budget" }] }), a("S-2", { todo: [{ who: "qa", what: "x" }] }), a("S-3", { next: "wait", todo: [] })], new Map())).toEqual([]);
  });
  it("expected behaviour: the story's generate run does it when code is merged, `spec` when there is no code yet", () => {
    const jobs = actJobs([a("S-1", { state: "needs-expectations", next: "spec", code: "merged" }), a("S-2", { state: "needs-expectations", next: "spec", code: "none" })], new Map());
    expect(jobs.map((j) => [j.key, j.what])).toEqual([["S-1", "generate"], ["S-2", "spec"]]);
  });
  it("end-to-end tests: generate with the ready ACs", () => {
    const jobs = actJobs([a("S-1", { state: "needs-cross-service-tests" })], new Map([["S-1", ["AC-1", "AC-3"]]]));
    expect(jobs).toEqual([{ key: "S-1", what: "generate", acs: ["AC-1", "AC-3"], describe: "generate --story S-1 --acs AC-1,AC-3" }]);
  });
});

describe("stories --act", () => {
  let root: string, qa: string;
  const story = (n: number) => `# SHOP-${n} Story ${n}\n\n## Acceptance criteria\n- AC-1: Thing ${n} works.\n`;
  beforeEach(() => {
    for (const [k, v] of Object.entries(GIT_ENV)) vi.stubEnv(k, v);
    vi.stubEnv("CI", "");
    root = tmp("qas-act-");
    qa = path.join(root, "qa");
    const svc = path.join(root, "orders");
    for (const d of [qa, svc]) {
      fs.mkdirSync(d);
      g(d, "init", "-q", "-b", "main");
    }
    commit(svc, "a.js", "1", "init");
    // Three stories have merged code: each needs expected behaviour first; the fourth has no code at all.
    for (const n of [1, 2, 3]) commit(svc, "a.js", String(n + 1), `SHOP-${n} change`);
    writeConfig(qa, ConfigSchema.parse({ version: 1, mode: "existing", project: { name: "t" }, level: "maintenance", workspace: { services: [{ name: "orders", path: "../orders" }] }, tests: { api: { framework: "mocha", runCommand: "x" } }, ci: { platform: "gitlab" }, automation: { act: { maxJobsPerCheck: 2 } } }));
    fs.mkdirSync(path.join(qa, "stories"));
    for (const n of [1, 2, 3, 4]) fs.writeFileSync(path.join(qa, `stories/SHOP-${n}.md`), story(n));
    fs.writeFileSync(path.join(qa, ".gitignore"), ".qa-sentinel/\nqa-stories.md\n");
    g(qa, "add", "-A");
    g(qa, "commit", "-q", "-m", "init");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    cleanTmp();
  });
  const run = (extra: object, runners: any) => storiesCommand({ cwd: qa, storiesDir: "stories", noSweep: true, act: true, env: { CI: "true" }, runners, ...extra });

  it("starts at most maxJobsPerCheck jobs, in order, as one generate/spec call each", async () => {
    const started: string[] = [];
    const runners = { spec: async (o: any) => (started.push(`spec ${o.story}`), 0), generate: async (o: any) => (started.push(`generate ${o.story}${o.push ? " push" : ""}${o.once ? " once" : ""}`), 0) };
    expect(await run({}, runners)).toBe(0);
    expect(started).toEqual(["generate SHOP-1 push once", "generate SHOP-2 push once"]);
  });
  it("--dry-run says what it would start and starts nothing", async () => {
    const started: string[] = [];
    const runners = { spec: async () => (started.push("spec"), 0), generate: async () => (started.push("generate"), 0) };
    expect(await run({ dryRun: true }, runners)).toBe(0);
    expect(started).toEqual([]);
  });
  it("exit 4 when a limit stopped a job (e.g. the budget), 1 when a job failed, 0 when all are done", async () => {
    const limit = { spec: async () => 0, generate: async () => 4 };
    expect(await run({}, limit)).toBe(4);
    const mixed = { spec: async () => 0, generate: async (o: any) => (o.story === "SHOP-1" ? 4 : 1) };
    expect(await run({}, mixed)).toBe(1);
    const thrown = { spec: async () => 0, generate: async () => { throw new Error("boom"); } };
    expect(await run({}, thrown)).toBe(1);
  });
  it("does not start anything without --act", async () => {
    let n = 0;
    const runners = { spec: async () => (n++, 0), generate: async () => (n++, 0) };
    expect(await storiesCommand({ cwd: qa, storiesDir: "stories", noSweep: true, env: { CI: "true" }, runners })).toBe(0);
    expect(n).toBe(0);
  });
  it("leaves the test repo on the branch it started on after each job", async () => {
    const runners = { spec: async () => 0, generate: async () => (g(qa, "checkout", "-q", "-b", "qa-sentinel/story-X"), 0) };
    await run({}, runners);
    expect(g(qa, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  });
});
