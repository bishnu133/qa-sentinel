import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Config } from "../config.js";
import { git, changesBetween, repoPrefix, specialModes, type FileChange } from "../git.js";
import { matchesAny } from "../fsutil.js";
import { ARTIFACT_GLOBS } from "../run.js";
import { checkContent, checkPaths, checkSpecialModes, generatePolicy, violations, type Finding } from "../guardrails.js";
import { layers } from "../layers.js";
import { lockByAuthor } from "../expected/commits.js";

/**
 * The write policy for a branch the agent made, applied by the job that holds the write token (`qa-sentinel publish`).
 * Same rules as `verify --policy`, with these differences, because the input is not trusted:
 *  - the base is given by the caller (computed from the server), never read from the run folder;
 *  - every commit the target branch does not already have counts as the agent's, whatever its author or message says;
 *  - the whole repository is looked at, not only the test folder of a monorepo;
 *  - generated artifacts (.qa-sentinel/**, qa-*.md ...), symbolic links and submodule links in a commit are violations.
 */

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

const tryGit = (cwd: string, args: string[]): string | undefined => {
  try {
    return git(cwd, args);
  } catch {
    return undefined;
  }
};

/** What the branch's own commits changed: per commit (a change that a later commit undid still counts), and a merge of the target branch only for what it adds beyond the target's own content. */
export function ownChanges(cwd: string, base: string, tip: string, targetRef: string): FileChange[] {
  const lines = git(cwd, ["rev-list", "--reverse", "--parents", `${base}..${tip}`, `^${targetRef}`]).split("\n").filter(Boolean);
  const out = new Map<string, FileChange>();
  const add = (ch: FileChange) => {
    out.set(ch.path, ch);
    if (ch.from) out.set(ch.from, { path: ch.from, status: "D" });
  };
  for (const line of lines) {
    const [sha, ...parents] = line.split(" ");
    if (parents.length <= 1) {
      for (const ch of changesBetween(cwd, parents[0] ?? EMPTY_TREE, sha)) add(ch);
      continue;
    }
    // A merge. Taking in the target branch is fine; anything else in the merge commit is the branch's own change.
    const [first, ...others] = parents;
    const fromTarget = others.every((p) => tryGit(cwd, ["merge-base", "--is-ancestor", p, targetRef]) !== undefined);
    const diffFirst = changesBetween(cwd, first, sha);
    if (!fromTarget) {
      diffFirst.forEach(add);
      continue;
    }
    // Paths where the merge differs from every parent were not taken from any of them: a hand-made change in the merge.
    const differs = others.map((p) => new Set(changesBetween(cwd, p, sha).flatMap((ch) => [ch.path, ...(ch.from ? [ch.from] : [])])));
    for (const ch of diffFirst) if (differs.every((d) => d.has(ch.path))) add(ch);
  }
  return [...out.values()];
}

export async function bundleFindings(cwd: string, c: Config, o: { base: string; tip: string; targetRef: string; env: NodeJS.ProcessEnv }): Promise<Finding[]> {
  const own = ownChanges(cwd, o.base, o.tip, o.targetRef);
  const ownPaths = new Set(own.flatMap((ch) => [ch.path, ...(ch.from ? [ch.from] : [])]));
  const findings: Finding[] = [
    ...checkPaths(own, generatePolicy(c)),
    ...[...ownPaths].filter((p) => matchesAny(p, ARTIFACT_GLOBS)).map((p) => ({ level: "violation" as const, rule: "artifact-committed" as const, file: p, message: "a generated artifact may not be committed (it belongs to the run folder)" })),
    ...checkSpecialModes(specialModes(cwd, o.base, o.tip).filter((m) => ownPaths.has(m.path))),
  ];
  // Content of the final files, against the base.
  const net = changesBetween(cwd, o.base, o.tip).filter((ch) => ownPaths.has(ch.path) || (ch.from && ownPaths.has(ch.from)));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "qa-publish-"));
  const wt = path.join(tmp, "wt");
  try {
    git(cwd, ["worktree", "add", "-q", "--detach", wt, o.tip]);
    const prefix = repoPrefix(cwd);
    findings.push(
      ...checkContent(net, {
        repo: prefix ? path.join(wt, prefix) : wt,
        ref: o.base,
        allowedHosts: c.guardrails.allowedHosts,
        baseUrl: o.env[c.tests.api.baseUrlEnv],
        extraBaseUrls: layers(c).map((l) => o.env[l.baseUrlEnv]).filter((u): u is string => Boolean(u)),
        assertionRemoval: c.guardrails.assertionRemoval,
      }),
    );
  } finally {
    try {
      git(cwd, ["worktree", "remove", "--force", wt]);
    } catch {
      /* removed with the folder below */
    }
    fs.rmSync(tmp, { recursive: true, force: true });
    tryGit(cwd, ["worktree", "prune"]);
  }
  // Expected behaviour follows the story: the values may not move, and no test.fail marker may be added. Every commit counts as the agent's.
  findings.push(...(await lockByAuthor(cwd, c, o.base, { head: o.tip, allAgent: true, exclude: o.targetRef })));
  return findings.filter((f, i, all) => all.findIndex((x) => x.rule === f.rule && x.file === f.file && x.message === f.message) === i);
}

export const blocking = (f: Finding[]) => violations(f);
