import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { prepareStoryBranch, pushStoryBranch, redact, storyBranchName } from "../src/generation/storyBranch.js";
import { GIT_ENV, cleanTmp, commit, g, serve, tmp } from "./helpers/mocks.js";
import { latestMrForBranch } from "../src/scm/gitlab.js";

const c = ConfigSchema.parse({ version: 1, mode: "existing", project: { name: "t" }, tests: { api: { framework: "mocha", runCommand: "x" } }, ci: { platform: "gitlab" } });
const B = "qa-sentinel/story-SHOP-1";
let root: string, origin: string, work: string, other: string;

beforeEach(() => {
  for (const [k, v] of Object.entries(GIT_ENV)) vi.stubEnv(k, v);
  root = tmp("qas-sb-");
  origin = path.join(root, "origin.git");
  fs.mkdirSync(origin);
  g(origin, "init", "-q", "--bare", "-b", "main");
  work = path.join(root, "work");
  fs.mkdirSync(work);
  g(work, "init", "-q", "-b", "main");
  commit(work, "README.md", "hi\n", "init");
  g(work, "remote", "add", "origin", origin);
  g(work, "push", "-q", "origin", "main");
  other = path.join(root, "other");
  g(root, "clone", "-q", origin, other);
});
afterEach(() => {
  vi.unstubAllEnvs();
  cleanTmp();
});

/** One run's worth of work on the prepared branch. */
const addTests = (name: string) => commit(work, `tests/${name}.spec.ts`, `// ${name}\n`, `tests: ${name}`);

describe("prepareStoryBranch and pushStoryBranch", () => {
  it("the first run creates the branch from main and pushes it", async () => {
    const p = await prepareStoryBranch(work, c, "shop-1");
    expect(p).toMatchObject({ ok: true, existing: false, mergedMain: false, branch: B });
    expect(storyBranchName(c, "shop-1")).toBe(B);
    addTests("a");
    pushStoryBranch(work, { branch: B, remote: "origin", expect: p.ok ? p.remoteSha : undefined });
    expect(g(origin, "rev-parse", B)).toBe(g(work, "rev-parse", "HEAD"));
  });

  it("the second run continues from the server's branch, keeps a reviewer's commit, merges main and pushes fast-forward", async () => {
    const first = await prepareStoryBranch(work, c, "SHOP-1");
    addTests("a");
    pushStoryBranch(work, { branch: B, remote: "origin", expect: first.ok ? first.remoteSha : undefined });
    const firstTip = g(origin, "rev-parse", B);
    g(other, "fetch", "-q", "origin");
    g(other, "checkout", "-q", B);
    const reviewer = commit(other, "REVIEW.md", "r\n", "reviewer");
    g(other, "push", "-q", "origin", B);
    g(other, "checkout", "-q", "main");
    commit(other, "docs.md", "main moved\n", "main moves");
    g(other, "push", "-q", "origin", "main");

    g(work, "checkout", "-q", "main"); // the next run starts on main, as a pipeline does
    const p = await prepareStoryBranch(work, c, "SHOP-1");
    expect(p).toMatchObject({ ok: true, existing: true, mergedMain: true, remoteSha: reviewer });
    addTests("b");
    pushStoryBranch(work, { branch: B, remote: "origin", expect: p.ok ? p.remoteSha : undefined });
    for (const ancestor of [firstTip, reviewer]) g(origin, "merge-base", "--is-ancestor", ancestor, B);
    expect(g(origin, "ls-tree", "-r", "--name-only", B).split("\n")).toEqual(expect.arrayContaining(["REVIEW.md", "docs.md", "tests/a.spec.ts", "tests/b.spec.ts"]));
  });

  it("a conflict with main is aborted: the repo is back where it was, nothing is pushed", async () => {
    const first = await prepareStoryBranch(work, c, "SHOP-1");
    commit(work, "shared.txt", "mine\n", "branch change");
    pushStoryBranch(work, { branch: B, remote: "origin", expect: first.ok ? first.remoteSha : undefined });
    const tip = g(origin, "rev-parse", B);
    commit(other, "shared.txt", "theirs\n", "main change");
    g(other, "push", "-q", "origin", "main");
    g(work, "checkout", "-q", "main");
    const p = await prepareStoryBranch(work, c, "SHOP-1");
    expect(p).toMatchObject({ ok: false, reason: "conflict", files: ["shared.txt"] });
    expect(g(work, "status", "--porcelain")).toBe("");
    expect(g(work, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(g(origin, "rev-parse", B)).toBe(tip);
  });

  it("a push is refused when somebody pushed meanwhile, then retried once after merging their commits", async () => {
    const p = await prepareStoryBranch(work, c, "SHOP-1");
    addTests("a");
    pushStoryBranch(work, { branch: B, remote: "origin", expect: p.ok ? p.remoteSha : undefined });
    const second = await prepareStoryBranch(work, c, "SHOP-1");
    addTests("b");
    // A reviewer pushes after this run fetched the branch.
    g(other, "fetch", "-q", "origin");
    g(other, "checkout", "-q", B);
    const reviewer = commit(other, "REVIEW.md", "r\n", "reviewer, late");
    g(other, "push", "-q", "origin", B);
    const r = pushStoryBranch(work, { branch: B, remote: "origin", expect: second.ok ? second.remoteSha : undefined });
    expect(r.retried).toBe(true);
    g(origin, "merge-base", "--is-ancestor", reviewer, B);
    expect(g(origin, "ls-tree", "-r", "--name-only", B)).toContain("tests/b.spec.ts");
  });

  it("fails clearly, overwriting nothing, when the retry is refused too", async () => {
    const p = await prepareStoryBranch(work, c, "SHOP-1");
    addTests("a");
    const hook = path.join(origin, "hooks/pre-receive");
    fs.writeFileSync(hook, "#!/bin/sh\necho 'no pushes today' >&2\nexit 1\n", { mode: 0o755 });
    expect(() => pushStoryBranch(work, { branch: B, remote: "origin", expect: p.ok ? p.remoteSha : undefined })).toThrow(/could not be pushed after fetching/);
    expect(g(origin, "branch", "--list", B)).toBe("");
  });

  it("an unpushed local branch with commits is continued, not rebuilt", async () => {
    await prepareStoryBranch(work, c, "SHOP-1");
    const mine = addTests("local-only");
    g(work, "checkout", "-q", "main");
    const p = await prepareStoryBranch(work, c, "SHOP-1");
    expect(p).toMatchObject({ ok: true, existing: true });
    g(work, "merge-base", "--is-ancestor", mine, "HEAD");
  });

  it("a branch whose commits are all in main already starts again from main", async () => {
    await prepareStoryBranch(work, c, "SHOP-1");
    g(work, "checkout", "-q", "main");
    const p = await prepareStoryBranch(work, c, "SHOP-1");
    expect(p).toMatchObject({ ok: true, existing: false });
  });

  it("never uses a plain --force, and keeps the push token out of messages", () => {
    const src = fs.readFileSync(path.join(__dirname, "../src/generation/storyBranch.ts"), "utf8");
    expect(src).not.toMatch(/["']--force["']/);
    expect(src).toMatch(/--force-with-lease=refs\/heads\//);
    expect(redact("fatal: unable to access 'https://oauth2:SECRET@gitlab.example/x.git/'")).not.toContain("SECRET");
  });

  it("main rewritten (rebased, force-pushed) after it was merged into the branch: the run is blocked, nothing is pushed", async () => {
    const first = await prepareStoryBranch(work, c, "SHOP-1");
    addTests("a");
    pushStoryBranch(work, { branch: B, remote: "origin", expect: first.ok ? first.remoteSha : undefined });
    // Main moves on and is merged into the branch (the merge commit carries the main tip it merged).
    commit(other, "docs.md", "v1\n", "main moves");
    g(other, "push", "-q", "origin", "main");
    g(work, "checkout", "-q", "main");
    const second = await prepareStoryBranch(work, c, "SHOP-1");
    expect(second).toMatchObject({ ok: true, mergedMain: true });
    addTests("b");
    pushStoryBranch(work, { branch: B, remote: "origin", expect: second.ok ? second.remoteSha : undefined });
    const tip = g(origin, "rev-parse", B);
    // Somebody rewrites that main commit and force-pushes main.
    g(other, "commit", "-q", "--amend", "-m", "main moves (rewritten)");
    g(other, "push", "-q", "--force", "origin", "main");
    g(work, "checkout", "-q", "main");
    const third = await prepareStoryBranch(work, c, "SHOP-1");
    expect(third).toMatchObject({ ok: false, reason: "main-rewritten" });
    expect(third.ok ? "" : third.message).toMatch(/was rewritten.*duplicate/);
    expect(g(origin, "rev-parse", B)).toBe(tip);
    expect(g(work, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  });

  it("without GitLab the branch is taken as open; a branch fully deleted on the server and locally just starts from main", async () => {
    const first = await prepareStoryBranch(work, c, "SHOP-1");
    addTests("a");
    pushStoryBranch(work, { branch: B, remote: "origin", expect: first.ok ? first.remoteSha : undefined });
    g(work, "checkout", "-q", "main");
    g(work, "branch", "-q", "-D", B);
    g(origin, "branch", "-q", "-D", B);
    expect(await prepareStoryBranch(work, c, "SHOP-1")).toMatchObject({ ok: true, existing: false });
  });
});

describe("latestMrForBranch: which merge request says what happened to the branch", () => {
  const ask = async (list: object[]) => {
    const srv = await serve(() => ({ body: list }));
    try {
      return await latestMrForBranch({ apiUrl: `${srv.url}/api/v4`, token: "t" }, 1, B, "main");
    } finally {
      await srv.close();
    }
  };
  it("an open merge request wins over a closed one that was updated later", async () => {
    const m = await ask([
      { iid: 1, state: "closed", created_at: "2026-03-01T00:00:00Z", updated_at: "2026-06-01T00:00:00Z" },
      { iid: 2, state: "opened", created_at: "2026-02-01T00:00:00Z", updated_at: "2026-02-02T00:00:00Z" },
    ]);
    expect(m).toMatchObject({ iid: 2, state: "opened" });
  });
  it("with none open, the newest by creation time decides, not the one touched last", async () => {
    const m = await ask([
      { iid: 1, state: "closed", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z" },
      { iid: 2, state: "merged", created_at: "2026-05-01T00:00:00Z", updated_at: "2026-05-02T00:00:00Z" },
    ]);
    expect(m).toMatchObject({ iid: 2, state: "merged" });
    expect(await ask([])).toBeUndefined();
  });
});
