import crypto from "node:crypto";

/**
 * Has anything the gap report depends on changed since the last report on this MR? The report is stamped with a
 * fingerprint of the test-relevant diff, the story's ACs and the other inputs of the plan; a later push with the same
 * fingerprint (a rebase, a merge from main, a doc or config change) needs no new AI run and no edit of the comment.
 * When a fingerprint cannot be built safely, there is none, and the report is made.
 */

/**
 * Digest of the diff of the relevant files only. `diffOf` returns one file's diff straight from git (so quoted
 * paths, spaces and binary files need no parsing here). Line numbers are dropped (a rebase moves lines without
 * changing the change). A relevant file whose diff comes back empty cannot be fingerprinted: undefined.
 */
export function relevantDiffDigest(diffOf: (file: string) => string, relevant: string[]): string | undefined {
  const parts: string[] = [];
  for (const f of [...relevant].sort()) {
    const d = diffOf(f);
    if (!d.trim()) return undefined;
    parts.push(`${f}\n${d.split("\n").filter((l) => !/^(index |@@ )/.test(l)).join("\n")}`);
  }
  return crypto.createHash("sha256").update(parts.join("\n\u0000")).digest("hex").slice(0, 16);
}

/** `extra`: the other inputs of the plan (the expected-behaviour file, scope items), as text. */
export const gapFingerprint = (diffDigest: string | undefined, acHashes: string[], extra: string[] = []): string | undefined =>
  diffDigest === undefined ? undefined : crypto.createHash("sha256").update([diffDigest, ...[...acHashes].sort(), "\u0002", ...extra].join("\u0001")).digest("hex").slice(0, 16);

export const stampOf = (fp: string, head: string) => `<!-- qa-sentinel:gap-fp fp=${fp} head=${head.slice(0, 12)} -->`;

/** The stamp is the last thing in the comment; text earlier in the body that looks like one (an AC quoted in the report) does not count. */
export function parseStamp(body: string | undefined): { fp: string; head: string } | undefined {
  const m = /<!-- qa-sentinel:gap-fp fp=([0-9a-f]+) head=([0-9a-f]+) -->\s*$/.exec(body ?? "");
  return m ? { fp: m[1], head: m[2] } : undefined;
}

/** The line at the top of a refreshed report, so a reviewer sees the report is not the first one. */
export const updatedLine = (head: string, previousHead: string) => `> 🔄 Updated for commit \`${head.slice(0, 8)}\` (the previous report was for \`${previousHead.slice(0, 8)}\`): the code or the acceptance criteria changed since.`;
