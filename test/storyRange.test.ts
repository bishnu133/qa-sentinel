import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { combinedChange, storyParts, storyRange, storyRanges } from "../src/story.js";
import { upsertPart } from "../src/stories/parts.js";
import { emptyRecord } from "../src/stories/record.js";
import { cleanTmp, commit, g, tmp } from "./helpers/mocks.js";

afterEach(cleanTmp);

function workspace() {
  const ws = tmp("qas-range-");
  const orders = path.join(ws, "orders");
  fs.mkdirSync(orders);
  g(orders, "init", "-q", "-b", "main");
  commit(orders, "base.js", "0", "initial");
  const tests = path.join(ws, "qa-tests");
  fs.mkdirSync(tests);
  const c = ConfigSchema.parse({
    version: 1,
    mode: "scratch",
    project: { name: "p" },
    workspace: { services: [{ name: "orders", path: "../orders", gitlabProject: "shop/orders" }] },
    tests: { api: { framework: "playwright", runCommand: "x" } },
    ci: { platform: "gitlab" },
  });
  return { ws, orders, tests, c };
}
const mergeBranch = (repo: string, branch: string, msg: string) => g(repo, "merge", "-q", "--no-ff", "-m", msg, branch);
const filesOf = (p: { relevant: string[] }[]) => p.flatMap((x) => x.relevant).sort();

describe("story range: every MR is its own range", () => {
  it("MR1 merged with a merge commit, unrelated work, MR2 squashed: two ranges, both changes, not the unrelated one", async () => {
    const { orders, tests, c } = workspace();
    g(orders, "checkout", "-q", "-b", "feature/SHOP-106-one");
    commit(orders, "one.js", "1", "SHOP-106: first part");
    commit(orders, "one-b.js", "1", "fix lint");
    g(orders, "checkout", "-q", "main");
    mergeBranch(orders, "feature/SHOP-106-one", "Merge branch 'feature/SHOP-106-one'");
    commit(orders, "unrelated.js", "x", "SHOP-999 somebody else's work");
    commit(orders, "two.js", "2", "SHOP-106: follow-up (#2)");

    const { parts, notes } = await storyParts({ c, cwd: tests, story: "SHOP-106" });
    expect(parts).toHaveLength(2);
    expect(parts.map((p) => p.relevant.sort())).toEqual([["two.js"], ["one-b.js", "one.js"]]);
    expect(filesOf(parts)).toEqual(["one-b.js", "one.js", "two.js"]);
    const v = combinedChange("SHOP-106", parts);
    expect(v.cs.diff).toContain("one.js");
    expect(v.cs.diff).toContain("two.js");
    expect(v.cs.diff).not.toContain("unrelated.js");
    expect(v.cs.diff.match(/# ===== service: orders/g)).toHaveLength(2);
    expect(notes).toEqual([]);
  });

  it("commits in a row are one range; a revert is not story work", () => {
    const { orders } = workspace();
    commit(orders, "a.js", "1", "SHOP-5: a");
    commit(orders, "b.js", "1", "SHOP-5: b");
    commit(orders, "u.js", "1", "other");
    commit(orders, "c.js", "1", "SHOP-5: c");
    commit(orders, "c.js", "2", 'Revert "SHOP-5: c"');
    const ranges = storyRanges(orders, "SHOP-5", "main");
    expect(ranges).toHaveLength(2);
    expect(g(orders, "diff", "--name-only", `${ranges[0].base}..${ranges[0].head}`)).toBe("c.js");
    expect(g(orders, "diff", "--name-only", `${ranges[1].base}..${ranges[1].head}`).split("\n").sort()).toEqual(["a.js", "b.js"]);
  });

  it("storyRange (a tip only) gives the newest range for merged work", () => {
    const { orders } = workspace();
    commit(orders, "a.js", "1", "SHOP-5: a");
    commit(orders, "u.js", "1", "other");
    const b = commit(orders, "b.js", "1", "SHOP-5: b");
    const r = storyRange(orders, "SHOP-5", "main", true)!;
    expect(r.head).toBe(b);
    expect(g(orders, "diff", "--name-only", `${r.base}..${r.head}`)).toBe("b.js");
  });

  it("a branch that merged main into itself leaves main's commit out of its range", async () => {
    const { orders, tests, c } = workspace();
    g(orders, "checkout", "-q", "-b", "feature/SHOP-107-x");
    commit(orders, "mine.js", "1", "my first commit");
    g(orders, "checkout", "-q", "main");
    commit(orders, "main-only.js", "1", "work on main");
    g(orders, "checkout", "-q", "feature/SHOP-107-x");
    g(orders, "merge", "-q", "--no-ff", "-m", "Merge main into the branch", "main");
    commit(orders, "mine2.js", "1", "my second commit");
    g(orders, "checkout", "-q", "main");

    const { parts } = await storyParts({ c, cwd: tests, story: "SHOP-107" });
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ merged: false });
    expect(parts[0].relevant.sort()).toEqual(["mine.js", "mine2.js"]);
    expect(parts[0].cs.diff).not.toContain("main-only.js");
  });
});

describe("story range from the record", () => {
  const T = new Date("2026-10-20T10:00:00Z");
  const partOf = (iid: number, o: Record<string, unknown>) => ({ service: "orders", source: "gitlab-mr" as const, iid, state: "merged" as const, keys: ["SHOP-106"], ...o });

  it("a merge commit, a squash commit and a rebased MR each give their own change; closed and reverted MRs are left out", async () => {
    const { orders, tests, c } = workspace();
    // MR 1: merge commit.
    g(orders, "checkout", "-q", "-b", "mr1");
    commit(orders, "m1.js", "1", "work");
    g(orders, "checkout", "-q", "main");
    mergeBranch(orders, "mr1", "Merge branch 'mr1'");
    const merge1 = g(orders, "rev-parse", "HEAD");
    commit(orders, "unrelated.js", "x", "somebody else");
    // MR 2: squash.
    const squash2 = commit(orders, "s2.js", "1", "squashed work (#2)");
    commit(orders, "unrelated2.js", "x", "somebody else again");
    // MR 3: rebase merge (fast-forwarded commits, no merge or squash commit).
    const base3 = g(orders, "rev-parse", "HEAD");
    commit(orders, "r3a.js", "1", "rebased a");
    const head3 = commit(orders, "r3b.js", "1", "rebased b");
    commit(orders, "unrelated3.js", "x", "last one");
    // MR 4: reverted. MR 5: closed.
    let rec = emptyRecord("SHOP-106", T);
    rec = upsertPart(rec, partOf(1, { mergeSha: merge1 }), T);
    rec = upsertPart(rec, partOf(2, { squashSha: squash2 }), T);
    rec = upsertPart(rec, partOf(3, { headSha: head3, diffBase: base3 }), T);
    rec = upsertPart(rec, partOf(4, { state: "reverted", mergeSha: merge1, revertedBy: "abc" }), T);
    rec = upsertPart(rec, partOf(5, { state: "closed" }), T);

    const { parts, notes } = await storyParts({ c, cwd: tests, story: "SHOP-106", record: rec });
    expect(parts.map((p) => [p.label, p.relevant.sort()])).toEqual([
      ["orders !1 merged", ["m1.js"]],
      ["orders !2 merged", ["s2.js"]],
      ["orders !3 merged", ["r3a.js", "r3b.js"]],
    ]);
    expect(notes.join("\n")).toContain("!4 was reverted");
    expect(combinedChange("SHOP-106", parts).cs.diff).not.toContain("unrelated");
  });

  it("an open MR is fetched from refs/merge-requests/<iid>/head and cut at the merge base", async () => {
    const { ws, orders, tests, c } = workspace();
    const origin = path.join(ws, "origin.git");
    g(ws, "init", "-q", "--bare", "-b", "main", origin);
    g(orders, "remote", "add", "origin", origin);
    g(orders, "push", "-q", "origin", "main");
    // The MR's branch lives only on the server, under GitLab's merge-request ref (pushed from another clone).
    const other = path.join(ws, "other");
    g(ws, "clone", "-q", origin, other);
    commit(other, "open.js", "1", "open MR work");
    const head = g(other, "rev-parse", "HEAD");
    g(other, "push", "-q", "origin", "HEAD:refs/merge-requests/9/head");
    g(orders, "fetch", "-q", "origin", "main"); // a tracking ref for the target branch
    commit(orders, "main-later.js", "1", "main moved on");
    g(orders, "push", "-q", "origin", "main");
    expect(() => g(orders, "cat-file", "-e", head)).toThrow();

    let rec = emptyRecord("SHOP-106", T);
    rec = upsertPart(rec, partOf(9, { state: "opened", headSha: head }), T);
    const { parts, notes } = await storyParts({ c, cwd: tests, story: "SHOP-106", record: rec });
    expect(notes).toEqual([]);
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ merged: false, label: "orders !9 open" });
    expect(parts[0].relevant).toEqual(["open.js"]);
    expect(parts[0].cs.head).toBe(head);
    // The token never reaches the repository's config.
    expect(fs.readFileSync(path.join(orders, ".git/config"), "utf8")).not.toContain("oauth2");
  });

  it("a commit that is not in the clone is said so, not guessed", async () => {
    const { tests, c } = workspace();
    const rec = upsertPart(emptyRecord("SHOP-106", T), partOf(1, { mergeSha: "0".repeat(40) }), T);
    const { parts, notes } = await storyParts({ c, cwd: tests, story: "SHOP-106", record: rec });
    expect(parts).toEqual([]);
    expect(notes.join("\n")).toContain("not in the clone");
  });
});
