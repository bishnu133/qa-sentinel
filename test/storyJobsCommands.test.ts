import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema, writeConfig } from "../src/config.js";
import { specCommand } from "../src/commands/spec.js";
import { generateCommand } from "../src/commands/generate.js";
import { acHash } from "../src/expected/format.js";
import { parseStoryFor } from "../src/requirements.js";
import { fileStore, emptyRecord } from "../src/stories/record.js";
import { crossServiceJobKey, specJobKey } from "../src/stories/jobs.js";

const STORY = "# SHOP-101 Delivery slots\n\n## Acceptance criteria\n- AC-1: A slot takes at most 3 orders.\n- AC-2: Orders in the past are rejected.\n";
const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });

let root: string, repo: string, svc: string, storyFile: string;
const saved = { CI: process.env.CI };
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "qas-cmd-"));
  repo = path.join(root, "qa-tests");
  svc = path.join(root, "orders");
  for (const d of [repo, svc]) {
    fs.mkdirSync(d, { recursive: true });
    git(d, "init", "-q", "-b", "main");
  }
  fs.mkdirSync(path.join(svc, "src"), { recursive: true });
  fs.writeFileSync(path.join(svc, "src/app.js"), "v1");
  git(svc, "add", "-A");
  git(svc, "commit", "-qm", "init");
  fs.writeFileSync(path.join(svc, "src/app.js"), "v2");
  git(svc, "commit", "-qam", "SHOP-101 change");
  const c = ConfigSchema.parse({
    version: 1,
    mode: "existing",
    project: { name: "t" },
    workspace: { services: [{ name: "orders", path: "../orders" }] },
    tests: { api: { framework: "playwright", runCommand: "npx playwright test" } },
    ci: { platform: "gitlab" },
    automation: { budgets: { perStoryUsd: 25 } },
  });
  writeConfig(repo, c);
  storyFile = path.join(repo, "story.md");
  fs.writeFileSync(storyFile, STORY);
  fs.writeFileSync(path.join(repo, ".gitignore"), ".qa-sentinel/\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "init");
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  if (saved.CI === undefined) delete process.env.CI;
  else process.env.CI = saved.CI;
});

const storyAcs = () => parseStoryFor(ConfigSchema.parse({ version: 1, mode: "existing", project: { name: "t" }, tests: { api: { framework: "playwright", runCommand: "x" } }, ci: { platform: "gitlab" } }), STORY).acceptanceCriteria;

describe("spec: job keys and budgets", () => {
  it("stops before any AI call when the story has used its budget (exit 4)", async () => {
    const s = fileStore(repo);
    const r = emptyRecord("SHOP-101");
    r.totalCostUsd = 25;
    await s.save(r);
    expect(await specCommand({ cwd: repo, storyFile })).toBe(4);
  });
  it("skips the AI call when the same job is already done and skipDone applies (CI), exit 0", async () => {
    process.env.CI = "true";
    const s = fileStore(repo);
    const hashes = storyAcs().map((a) => acHash(a.text));
    expect(hashes).toHaveLength(2);
    const key = specJobKey("SHOP-101", hashes);
    const r = emptyRecord("SHOP-101");
    r.jobs[key] = { key, kind: "spec", state: "done", startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), attempts: 1, costUsd: 0.05, outcome: "ok" };
    await s.save(r);
    expect(await specCommand({ cwd: repo, storyFile })).toBe(0);
  });
  it("stops (exit 4) after the job failed maxAttempts times with the same inputs", async () => {
    delete process.env.CI;
    const s = fileStore(repo);
    const key = specJobKey("SHOP-101", storyAcs().map((a) => acHash(a.text)));
    const r = emptyRecord("SHOP-101");
    r.jobs[key] = { key, kind: "spec", state: "failed", startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), attempts: 3, costUsd: 0.3, outcome: "requirements-pass-failed" };
    await s.save(r);
    expect(await specCommand({ cwd: repo, storyFile })).toBe(4);
  });
  it("makes no job for --dry-run", async () => {
    expect(await specCommand({ cwd: repo, storyFile, dryRun: true })).toBe(0);
    expect(await fileStore(repo).list()).toEqual([]);
  });
});

describe("generate: job keys and budgets", () => {
  const opts = () => ({ cwd: repo, service: "orders", storyFile, base: "HEAD~1", head: "HEAD" });
  it("stops before planning when the story has used its budget (exit 4)", async () => {
    const s = fileStore(repo);
    const r = emptyRecord("SHOP-101");
    r.totalCostUsd = 24.5;
    await s.save(r);
    expect(await generateCommand(opts())).toBe(4);
  });
  it("skips when the same service change and ACs were already done (CI)", async () => {
    process.env.CI = "true";
    const head = git(svc, "rev-parse", "HEAD").trim();
    // Story scope: the key is the ACs planned and the commits they are written against.
    const key = crossServiceJobKey("SHOP-101", ["AC-1", "AC-2"], [`orders:${head}`], storyAcs().map((a) => acHash(a.text)));
    const s = fileStore(repo);
    const r = emptyRecord("SHOP-101");
    r.jobs[key] = { key, kind: "generate", state: "done", startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), attempts: 1, costUsd: 1.2, outcome: "verified" };
    await s.save(r);
    expect(await generateCommand(opts())).toBe(0);
  });
  it("is stopped by a budget even with --force", async () => {
    const s = fileStore(repo);
    const r = emptyRecord("SHOP-101");
    r.totalCostUsd = 24.5;
    await s.save(r);
    expect(await generateCommand({ ...opts(), force: true })).toBe(4);
  });
});

import { withSpend } from "../src/stories/start.js";
import { ClaudeAccessError } from "../src/claude.js";
import { loadConfig } from "../src/config.js";
import type { AgentEngine, AgentTask } from "../src/engines/AgentEngine.js";

describe("withSpend (commands that are not spec or generate)", () => {
  const fake = (cost: number): AgentEngine => ({ name: "f", available: () => ({ ok: true }), run: async () => ({ ok: true, status: "ok" as const, result: "", costUsd: cost }) });
  it("refuses when the day's budget is used, and does not run the command", async () => {
    const c = loadConfig(repo);
    c.automation.budgets.perDayUsd = 1;
    const s = fileStore(repo);
    const r = emptyRecord("_no-story");
    r.ledger = [{ at: new Date().toISOString(), job: "x", kind: "other", costUsd: 0.9 }];
    await s.save(r);
    let ran = false;
    const out = await withSpend({ cwd: repo, c, label: "gap-report" }, (code) => ({ code }), async () => ((ran = true), { code: 0 }), (x) => x.code);
    expect(out).toEqual({ code: 4 });
    expect(ran).toBe(false);
  });
  it("counts what the wrapped engine spends into the ledger, and closes the job", async () => {
    const c = loadConfig(repo);
    const out = await withSpend(
      { cwd: repo, c, story: "shop-101", label: "story-review" },
      (code) => code,
      async (wrap) => {
        await wrap(fake(0.42)).run({ maxBudgetUsd: 1 } as AgentTask);
        return 0;
      },
      (x) => x,
    );
    expect(out).toBe(0);
    const rec = (await fileStore(repo).load("SHOP-101"))!;
    expect(rec.totalCostUsd).toBeCloseTo(0.42);
    expect(Object.values(rec.jobs)[0]).toMatchObject({ kind: "other", state: "done" });
  });
  it("marks the job failed on an error, aborted when Claude can't be used, and rethrows", async () => {
    const c = loadConfig(repo);
    await expect(withSpend({ cwd: repo, c, story: "SHOP-102", label: "tag" }, (x) => x, async () => { throw new Error("boom"); }, (x: number) => x)).rejects.toThrow("boom");
    await expect(withSpend({ cwd: repo, c, story: "SHOP-103", label: "tag" }, (x) => x, async () => { throw new ClaudeAccessError("no key"); }, (x: number) => x)).rejects.toThrow("no key");
    expect(Object.values((await fileStore(repo).load("SHOP-102"))!.jobs)[0]).toMatchObject({ state: "failed", attempts: 1 });
    expect(Object.values((await fileStore(repo).load("SHOP-103"))!.jobs)[0]).toMatchObject({ state: "aborted", attempts: 0 });
  });
  it("makes no record when skipped (dry runs)", async () => {
    const c = loadConfig(repo);
    await withSpend({ cwd: repo, c, label: "tag", skip: true }, (x) => x, async () => 0, (x: number) => x);
    expect(await fileStore(repo).list()).toEqual([]);
  });
});
