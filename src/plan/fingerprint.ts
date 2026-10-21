import crypto from "node:crypto";

/**
 * Has anything the gap report depends on changed since the last report on this MR? The report is stamped with a
 * fingerprint of the test-relevant diff and the story's ACs; a later push with the same fingerprint (a rebase, a
 * merge from main, a doc or config change) needs no new AI run and no edit of the comment.
 */

/** The per-file parts of a unified diff, keyed by path (new path for renames). */
export function diffByFile(diff: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const block of diff.split(/^(?=diff --git )/m)) {
    const m = /^diff --git a\/(.+?) b\/(.+)$/m.exec(block);
    if (m) out.set(m[2], block);
  }
  return out;
}

/** Digest of the diff of the relevant files only, with line numbers dropped (a rebase moves lines without changing the change). */
export function relevantDiffDigest(diff: string, relevant: string[]): string {
  const files = diffByFile(diff);
  const body = [...relevant]
    .sort()
    .map((f) => `${f}\n${(files.get(f) ?? "").split("\n").filter((l) => !/^(index |@@ )/.test(l)).join("\n")}`)
    .join("\n\u0000");
  return crypto.createHash("sha256").update(body).digest("hex").slice(0, 16);
}

export const gapFingerprint = (diff: string, relevant: string[], acHashes: string[]) =>
  crypto.createHash("sha256").update([relevantDiffDigest(diff, relevant), ...[...acHashes].sort()].join("\u0001")).digest("hex").slice(0, 16);

export const stampOf = (fp: string, head: string) => `<!-- qa-sentinel:gap-fp fp=${fp} head=${head.slice(0, 12)} -->`;

export function parseStamp(body: string | undefined): { fp: string; head: string } | undefined {
  const m = /<!-- qa-sentinel:gap-fp fp=([0-9a-f]+) head=([0-9a-f]+) -->/.exec(body ?? "");
  return m ? { fp: m[1], head: m[2] } : undefined;
}

/** The line at the top of a refreshed report, so a reviewer sees the report is not the first one. */
export const updatedLine = (head: string, previousHead: string) => `> 🔄 Updated for commit \`${head.slice(0, 8)}\` (the previous report was for \`${previousHead.slice(0, 8)}\`): the code or the acceptance criteria changed since.`;
