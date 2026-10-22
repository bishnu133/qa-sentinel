import type { ServicePart } from "../feature/manifest.js";
import { digest } from "./jobs.js";
import type { RecordPart, StoryRecord } from "./record.js";

/** What a caller gives to `upsertPart`: a part without the two times the record adds. */
export type PartInput = Omit<RecordPart, "firstSeenAt" | "lastSeenAt">;

const sameMr = (a: RecordPart, b: PartInput) => a.service === b.service && (b.iid !== undefined ? a.iid === b.iid : a.iid === undefined && a.source === b.source && a.branch === b.branch && a.headSha === b.headSha);

/**
 * Add a part to the record, or update the one already there (same service and MR number; a part from plain git has
 * no number, so it is matched on its branch). The time it was first seen never changes. A part that was reverted
 * stays reverted unless the new part says otherwise.
 */
export function upsertPart(rec: StoryRecord, part: PartInput, now = new Date()): StoryRecord {
  const at = now.toISOString();
  const i = rec.parts.findIndex((p) => sameMr(p, part));
  const next: RecordPart = i < 0 ? { ...part, firstSeenAt: at, lastSeenAt: at } : { ...rec.parts[i], ...stripUndefined(part), firstSeenAt: rec.parts[i].firstSeenAt, lastSeenAt: at };
  if (i >= 0 && rec.parts[i].state === "reverted" && part.state === "merged" && !part.revertedBy) next.state = "reverted";
  const parts = i < 0 ? [...rec.parts, next] : rec.parts.map((p, j) => (j === i ? next : p));
  return { ...rec, parts, updatedAt: at };
}

const stripUndefined = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

/** The parts of one service. */
export const partsOf = (rec: StoryRecord, service: string): RecordPart[] => rec.parts.filter((p) => p.service === service);

/** The commit that carries a merged part on the target branch. */
export const mergedShaOf = (p: RecordPart): string | undefined => p.mergeSha ?? p.squashSha ?? p.headSha;

/**
 * A short digest of what the story is made of right now: the merged, not reverted commits per service and the AC
 * hashes. When it changes, something reported about the story (a status, a result) was written against older code or ACs.
 */
export function storyBasis(rec: Pick<StoryRecord, "parts">, acHashes: string[]): string {
  const merged = rec.parts.filter((p) => p.state === "merged").map((p) => `${p.service}:${mergedShaOf(p) ?? ""}`).sort();
  return digest([...merged, "--", ...[...acHashes].sort()]);
}

/** A part found by the manifest or the sweep, as the record keeps it. */
export function partToInput(p: ServicePart): PartInput {
  return {
    service: p.service,
    source: p.source,
    ...(p.mr ? { iid: p.mr.iid, url: p.mr.url, title: p.mr.title } : {}),
    state: p.dropped ? "closed" : p.reverted ? "reverted" : p.merged ? "merged" : "opened",
    ...(p.branch ? { branch: p.branch } : {}),
    // The head of the MR's branch (GitLab diff_refs), else the manifest's commit when there is no merge or squash commit to name.
    ...(p.diffRefs ? { headSha: p.diffRefs.head, diffBase: p.diffRefs.base } : p.sha && !(p.merged && (p.mergeSha || p.squashSha)) ? { headSha: p.sha } : {}),
    ...(p.mergeSha ? { mergeSha: p.mergeSha } : {}),
    ...(p.squashSha ? { squashSha: p.squashSha } : {}),
    ...(p.mergedAt ? { mergedAt: p.mergedAt } : {}),
    keys: p.keys ?? [],
    ...(p.workKey ? { workKey: p.workKey } : {}),
    ...(p.reverted ? { revertedBy: p.reverted } : {}),
  };
}

/** A record's part as the manifest and story-range code read it. */
export function inputToServicePart(p: RecordPart): ServicePart {
  const merged = p.state === "merged" || p.state === "reverted";
  return {
    service: p.service,
    source: p.source,
    ...(p.iid !== undefined ? { mr: { iid: p.iid, url: p.url ?? "", state: p.state === "opened" ? "opened" : p.state === "closed" ? "closed" : "merged", title: p.title ?? "" } } : {}),
    ...(p.branch ? { branch: p.branch } : {}),
    sha: merged ? (p.mergeSha ?? p.squashSha ?? p.headSha) : p.headSha,
    merged,
    keys: p.keys,
    ...(p.workKey ? { workKey: p.workKey } : {}),
    ...(p.mergeSha ? { mergeSha: p.mergeSha } : {}),
    ...(p.squashSha ? { squashSha: p.squashSha } : {}),
    ...(p.diffBase && p.headSha ? { diffRefs: { base: p.diffBase, head: p.headSha, start: p.diffBase } } : {}),
    ...(p.mergedAt ? { mergedAt: p.mergedAt } : {}),
    ...(p.state === "closed" ? { dropped: true } : {}),
    ...(p.state === "reverted" ? { reverted: p.revertedBy ?? "reverted" } : {}),
  };
}
