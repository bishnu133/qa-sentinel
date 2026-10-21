import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { findCherryPicks, findRevert, inRef, storyKeysBetween } from "../src/release/git.js";
import { ConfigSchema, writeConfig } from "../src/config.js";
import { judgeStory } from "../src/commands/suite.js";
import { featureStatus } from "../src/feature/manifest.js";
import { releaseFeaturesCommand } from "../src/commands/releaseFeatures.js";
import { hotfixCommand } from "../src/commands/hotfix.js";

const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const g = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8", env }).trim();
const write = (r: string, f: string, t: string) => fs.writeFileSync(path.join(r, f), t);

/** main with a base commit, a production tag, and a hotfix branch off it with one commit. */
function repo() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), "qas-rel-"));
  g(r, "init", "-q", "-b", "main");
  write(r, "a.txt", "1\n2\n3\n4\n5\n6\n7\n8\n");
  g(r, "add", "-A");
  g(r, "commit", "-qm", "init");
  g(r, "tag", "v1.0");
  g(r, "checkout", "-q", "-b", "hotfix/shop-9");
  write(r, "a.txt", "1\n2\n3\n4\n5\n6\n7\nEIGHT\n");
  g(r, "commit", "-qam", "SHOP-9: fix total");
  const fix = g(r, "rev-parse", "HEAD");
  g(r, "checkout", "-q", "main");
  return { r, fix };
}

describe("cherry-pick matching", () => {
  it("finds a cherry-pick by its -x line", () => {
    const { r, fix } = repo();
    write(r, "b.txt", "x");
    g(r, "add", "-A");
    g(r, "commit", "-qm", "other work");
    g(r, "cherry-pick", "-x", fix);
    const picks = findCherryPicks(r, fix, "main");
    expect(picks).toHaveLength(1);
    expect(picks[0].how).toBe("cherry-pick -x line");
  });
  it("finds a plain cherry-pick by patch id, even when the line numbers moved", () => {
    const { r, fix } = repo();
    write(r, "a.txt", "0\n1\n2\n3\n4\n5\n6\n7\n8\n");
    g(r, "commit", "-qam", "shift lines");
    g(r, "cherry-pick", fix);
    const picks = findCherryPicks(r, fix, "main");
    expect(picks.map((p) => p.how)).toEqual(["same change (patch id)"]);
  });
  it("finds nothing while the hotfix is not on main", () => {
    const { r, fix } = repo();
    expect(findCherryPicks(r, fix, "main")).toEqual([]);
  });
});

describe("revert, tag and story keys", () => {
  it("detects a revert and what a tag contains", () => {
    const { r, fix } = repo();
    g(r, "merge", "-q", "--no-ff", "hotfix/shop-9", "-m", "SHOP-9 merge");
    expect(findRevert(r, fix, "main")).toBeUndefined();
    g(r, "revert", "--no-edit", fix);
    expect(findRevert(r, fix, "main")).toBe(g(r, "rev-parse", "HEAD"));
    expect(inRef(r, fix, "v1.0")).toBe(false);
    g(r, "tag", "v1.1");
    expect(inRef(r, fix, "v1.1")).toBe(true);
    expect(inRef(r, fix, "nope")).toBeUndefined();
    expect(storyKeysBetween(r, "v1.0", "v1.1", "[A-Z]+-\\d+").map((k) => k.key)).toEqual(["SHOP-9"]);
  });
});

const part = (o: any = {}) => ({ service: "orders", source: "git", merged: true, sha: "abc", ...o });
const man = (parts: any[], environment: any = null): any => ({ story: "SHOP-1", environment, parts, status: "x", notes: [] });
describe("judgeStory", () => {
  it("holds back reverted, unmerged and undeployed work; runs unknown", () => {
    expect(judgeStory(man([part({ reverted: "def" })]), undefined).state).toBe("held-back");
    expect(judgeStory(man([part({ merged: false })]), undefined).state).toBe("held-back");
    expect(judgeStory(man([part({ deployed: { includesChange: false } })], "uat"), undefined).state).toBe("held-back");
    expect(judgeStory(man([part({ deployed: { includesChange: true } })], "uat"), undefined).state).toBe("included");
    expect(judgeStory(man([part({ deployed: { includesChange: undefined, error: "down" } })], "uat"), undefined).state).toBe("unknown");
    expect(judgeStory(man([]), undefined).state).toBe("unknown");
  });
  it("by tag", () => {
    const t = (v: boolean | undefined) => ({ ref: "v3.4", inRef: () => v });
    expect(judgeStory(man([part()]), t(true)).state).toBe("included");
    expect(judgeStory(man([part()]), t(false)).state).toBe("held-back");
    expect(judgeStory(man([part()]), t(undefined)).state).toBe("unknown");
  });
  it("featureStatus says reverted first", () => {
    expect(featureStatus([part({ reverted: "def" }) as any])).toBe("reverted");
  });
});

function workspace() {
  const { r, fix } = repo();
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "qas-ws-"));
  fs.renameSync(r, path.join(ws, "orders"));
  writeConfig(ws, ConfigSchema.parse({ version: 1, mode: "scratch", project: { name: "p" }, tests: { api: { framework: "playwright", runCommand: "x" } }, ci: { platform: "gitlab" }, workspace: { services: [{ name: "orders", path: "orders" }] }, requirements: { storyKeyPattern: "SHOP-\\d+" } }));
  return { ws, repo: path.join(ws, "orders"), fix };
}

describe("commands on a real workspace", () => {
  it("release-features lists stories between tags", () => {
    const { ws, repo: r } = workspace();
    g(r, "merge", "-q", "--no-ff", "hotfix/shop-9", "-m", "SHOP-9 merge");
    g(r, "tag", "v1.1");
    const out: string[] = [];
    const w = process.stdout.write.bind(process.stdout);
    (process.stdout as any).write = (s: string) => (out.push(String(s)), true);
    try {
      expect(releaseFeaturesCommand({ cwd: ws, tag: "v1.1", from: "v1.0", json: true })).toBe(0);
    } finally {
      process.stdout.write = w;
    }
    expect(JSON.parse(out.join("")).stories).toEqual([{ story: "SHOP-9", services: { orders: 2 } }]);
  });
  it("hotfix reports waiting, then cherry-picked", async () => {
    const { ws, repo: r, fix } = workspace();
    const run = async () => {
      const out: string[] = [];
      const w = process.stdout.write.bind(process.stdout);
      (process.stdout as any).write = (s: string) => (out.push(String(s)), true);
      try {
        await hotfixCommand({ cwd: ws, service: "orders", commit: [fix], json: true });
      } finally {
        process.stdout.write = w;
      }
      return JSON.parse(out.join(""));
    };
    const before = await run();
    expect(before.rows[0].state).toBe("waiting-for-cherry-pick");
    expect(before.story).toBe("SHOP-9");
    g(r, "cherry-pick", "-x", fix);
    expect((await run()).rows[0].state).toBe("cherry-picked");
  });
});

describe("suite --tag", () => {
  it("leaves out tests of features that are not in the release", async () => {
    const { ws, repo: r } = workspace();
    g(r, "merge", "-q", "--no-ff", "hotfix/shop-9", "-m", "SHOP-9 merge");
    g(r, "checkout", "-q", "-b", "feature/SHOP-10-new");
    write(r, "n.txt", "n");
    g(r, "add", "-A");
    g(r, "commit", "-qm", "SHOP-10: new thing");
    g(r, "checkout", "-q", "main");
    g(r, "merge", "-q", "--no-ff", "feature/SHOP-10-new", "-m", "SHOP-10 merge");
    // v1.1 is cut before SHOP-10 is merged: put the tag on the SHOP-9 merge
    g(r, "tag", "v1.1", "HEAD^");
    fs.mkdirSync(path.join(ws, "tests/api"), { recursive: true });
    write(ws, "tests/api/a.spec.ts", `import { test } from "@playwright/test";\ntest("baseline", async () => {});\ntest("nine @story:SHOP-9", async () => {});\ntest("ten @story:SHOP-10", async () => {});\n`);
    const { suiteCommand } = await import("../src/commands/suite.js");
    expect(await suiteCommand({ cwd: ws, tag: "v1.1", out: "qa-suite" })).toBe(0);
    const list = fs.readFileSync(path.join(ws, "qa-suite.txt"), "utf8").trim().split("\n");
    const md = fs.readFileSync(path.join(ws, "qa-suite.md"), "utf8");
    expect(md).toContain("SHOP-10");
    expect(md).toContain("not in v1.1");
    expect(list).toHaveLength(2);
  });
});
