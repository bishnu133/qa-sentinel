import fs from "node:fs";
import path from "node:path";
import type { Config } from "../config.js";
import { mrToPart, type ServicePart } from "../feature/manifest.js";
import { jiraKeyPattern, extractMrKeys } from "../requirements.js";
import { call, getAll, type GitLabContext } from "../scm/gitlab.js";
import type { JiraContext, JiraIssue } from "../scm/jira.js";
import { log } from "../log.js";
import { isFeatureType } from "./resolve.js";
import { partToInput, storyBasis, upsertPart } from "./parts.js";
import { type RecordPart, type RecordStore, type StoryRecord, SAFE_KEY, SWEEP_FILE, emptyRecord, recordsDir } from "./record.js";
import { type IssueCache, resolveKeysCached } from "./resolve.js";

/**
 * The merge-request sweep: one paged list call per configured repository for the merge requests updated since the
 * last check (GitLab API only, no clones, no AI). Every MR is matched to the stories it names, through Jira's parent
 * and link rules, and recorded as a part of each story's record. The record is a cache: a sweep with a long look-back
 * (`stories --rebuild`) can fill it again from GitLab and Jira.
 */

export interface SweepResult {
  /** Feature keys whose record got a part. */
  touched: string[];
  /** Merge requests that name no story key. */
  noKey: { service: string; iid: number; title: string; url?: string }[];
  /** Keys that are not in Jira, calls that failed. */
  notes: string[];
  /** Merge requests looked at. */
  mrs: number;
  /** False when a call failed: the next sweep then starts from the same time again. */
  complete: boolean;
  /** A listing hit the page cap: some merge requests were not looked at. The next sweep resumes from `resumeAt`. */
  truncated?: boolean;
  /** Where the next sweep may start when `truncated` (the newest update among the merge requests looked at, oldest repository first). */
  resumeAt?: string;
  since: string;
}

export interface SweepState {
  lastAt?: string;
}

const statePath = (cwd: string) => path.join(recordsDir(cwd), SWEEP_FILE);

export function readSweepState(cwd: string): SweepState {
  try {
    const j = JSON.parse(fs.readFileSync(statePath(cwd), "utf8"));
    return typeof j?.lastAt === "string" ? { lastAt: j.lastAt } : {};
  } catch {
    return {};
  }
}

export function writeSweepState(cwd: string, state: SweepState): void {
  fs.mkdirSync(path.dirname(statePath(cwd)), { recursive: true });
  fs.writeFileSync(statePath(cwd), JSON.stringify(state, null, 2) + "\n");
}

/** Where this sweep starts: the last check minus the overlap; the first time (or with `rebuild`) the look-back window. */
export function sweepSince(cwd: string, c: Config, now: Date, o: { rebuild?: boolean } = {}): string {
  const day = 86_400_000;
  if (o.rebuild) return new Date(now.getTime() - 365 * day).toISOString();
  const last = readSweepState(cwd).lastAt;
  if (!last || Number.isNaN(Date.parse(last))) return new Date(now.getTime() - c.requirements.jira.search.mrLookbackDays * day).toISOString();
  return new Date(Date.parse(last) - c.automation.sweep.overlapHours * 3_600_000).toISOString();
}

/**
 * GitLab's list endpoint has no diff_refs. A merged MR with no merge or squash commit (rebase or fast-forward) is
 * found again later only through its diff base, so it is read once on its own here and the base is kept in the record.
 */
async function withDiffBase(gitlab: GitLabContext, project: string, part: ServicePart): Promise<ServicePart> {
  if (!part.mr || !part.merged || part.mergeSha || part.squashSha || part.diffRefs) return part;
  try {
    const { data } = await call(gitlab, "GET", `/projects/${encodeURIComponent(project)}/merge_requests/${part.mr.iid}`, undefined, 2);
    const d = data?.diff_refs;
    if (d?.base_sha && d?.head_sha) return { ...part, diffRefs: { base: d.base_sha, head: d.head_sha, start: d.start_sha ?? d.base_sha } };
  } catch {
    // the commit scan on the local clone is the fallback
  }
  return part;
}

export async function sweepMrs(
  c: Config,
  gitlab: GitLabContext,
  jira: JiraContext | undefined,
  store: RecordStore,
  o: { since: string; now?: Date; cache?: IssueCache; read?: (key: string) => Promise<JiraIssue> },
): Promise<SweepResult> {
  const now = o.now ?? new Date();
  const at = now.toISOString();
  const pattern = jiraKeyPattern(c);
  const cache: IssueCache = o.cache ?? new Map();
  const result: SweepResult = { touched: [], noKey: [], notes: [], mrs: 0, complete: true, since: o.since };
  const byFeature = new Map<string, { parts: ReturnType<typeof partToInput>[]; linked: StoryRecord["linked"] }>();

  for (const s of c.workspace.services) {
    if (!s.gitlabProject) continue;
    let mrs: any[];
    try {
      // Oldest first: when the page cap cuts the list, what was read is a prefix in time and the next sweep can resume after it.
      const info: { truncated?: boolean } = {};
      mrs = await getAll(gitlab, `/projects/${encodeURIComponent(s.gitlabProject)}/merge_requests?state=all&updated_after=${encodeURIComponent(o.since)}&order_by=updated_at&sort=asc`, c.automation.sweep.maxPages, info);
      if (info.truncated) {
        result.truncated = true;
        const last = mrs.map((m) => String(m.updated_at ?? "")).filter(Boolean).sort().at(-1) ?? o.since;
        if (!result.resumeAt || last < result.resumeAt) result.resumeAt = last;
        result.notes.push(`${s.name}: only the oldest ${mrs.length} merge requests since ${o.since.slice(0, 16)}Z were looked at (automation.sweep.maxPages); the next run goes on from there`);
      }
    } catch (e) {
      result.complete = false;
      result.notes.push(`${s.name}: could not list merge requests (${(e as Error).message.split("\n")[0].slice(0, 160)})`);
      continue;
    }
    for (const m of mrs) {
      result.mrs++;
      const keys = extractMrKeys(pattern, m, c.requirements.jira.projectKeys);
      if (!keys.length) {
        result.noKey.push({ service: s.name, iid: m.iid, title: String(m.title ?? ""), ...(m.web_url ? { url: m.web_url } : {}) });
        continue;
      }
      const targets: { feature: string; work: string; via?: "parent" | "link"; issueType?: string }[] = [];
      if (jira) {
        for (const r of await resolveKeysCached(c, jira, keys, { hasCode: true, cache, read: o.read })) {
          if (r.via === "not-found") result.notes.push(`${s.name} !${m.iid}: ${r.explain}`);
          else if (r.via === "error") {
            result.complete = false;
            result.notes.push(`${s.name} !${m.iid}: ${r.explain}`);
          } else {
            // A card that reaches no feature (or two) and is not a feature itself (a loose bug) is not a story: nothing to record.
            const feature = r.feature ?? (isFeatureType(c, r.workIssue?.issueType) ? r.work : undefined);
            if (!feature) continue;
            if (!targets.some((t) => t.feature.toLowerCase() === feature.toLowerCase())) targets.push({ feature, work: r.work, ...(r.via === "parent" || r.via === "link" ? { via: r.via } : {}), issueType: r.workIssue?.issueType });
          }
        }
      } else for (const k of keys) targets.push({ feature: k, work: k });
      for (const t of targets) {
        const slot = byFeature.get(t.feature) ?? { parts: [], linked: [] };
        const input = partToInput(await withDiffBase(gitlab, s.gitlabProject!, mrToPart(s.name, m, pattern, c.requirements.jira.projectKeys)));
        slot.parts.push({ ...input, ...(t.via ? { workKey: t.work } : {}) });
        if (t.via) slot.linked.push({ key: t.work, ...(t.issueType ? { issueType: t.issueType } : {}), via: t.via, at });
        byFeature.set(t.feature, slot);
      }
    }
  }

  for (const [feature, slot] of byFeature) {
    if (!SAFE_KEY.test(feature)) continue;
    try {
      await store.locked(feature, async () => {
        let rec: StoryRecord = (await store.load(feature)) ?? emptyRecord(feature, now);
        for (const p of slot.parts) rec = upsertPart(rec, p, now);
        const linked = [...rec.linked];
        for (const l of slot.linked) {
          const i = linked.findIndex((x) => x.key === l.key);
          if (i < 0) linked.push(l);
          else linked[i] = { ...linked[i], ...l, at: linked[i].at };
        }
        await store.save({ ...rec, linked, basis: storyBasis(rec, rec.acs.map((a) => a.hash)), updatedAt: at });
      });
      result.touched.push(feature);
    } catch (e) {
      result.complete = false;
      result.notes.push(`${feature}: record not updated (${(e as Error).message.split("\n")[0].slice(0, 160)})`);
    }
  }
  log.dim(`  sweep: ${result.mrs} merge request(s) since ${o.since.slice(0, 16)}Z, ${result.touched.length} story record(s) updated`);
  return result;
}

/** Parts of a record that are not closed, for callers that only care about live work. */
export const liveParts = (rec: StoryRecord | undefined): RecordPart[] => (rec?.parts ?? []).filter((p) => p.state !== "closed");

/**
 * Record a merge request when it is first seen (the gap report runs in its pipeline), so later steps know it, its
 * branch and its head without the key being in a commit message. Best effort: the record is a cache.
 */
export async function recordMrSeen(
  store: RecordStore,
  o: { feature: string; workKey?: string; service: string; mrIid: string | number | undefined; url?: string; title?: string; branch?: string; headSha?: string; keys?: string[]; now?: Date },
): Promise<void> {
  const iid = Number(o.mrIid);
  if (!Number.isInteger(iid) || iid <= 0 || !SAFE_KEY.test(o.feature)) return;
  const now = o.now ?? new Date();
  await store.locked(o.feature, async () => {
    let rec: StoryRecord = (await store.load(o.feature)) ?? emptyRecord(o.feature, now);
    // A merge request already recorded as merged or closed keeps that state: this run saw its pipeline, not its end.
    const known = rec.parts.find((p) => p.service === o.service && p.iid === iid);
    rec = upsertPart(
      rec,
      { service: o.service, source: "gitlab-mr", iid, state: known && known.state !== "opened" ? known.state : "opened", keys: o.keys ?? [o.feature], ...(o.url ? { url: o.url } : {}), ...(o.title ? { title: o.title } : {}), ...(o.branch ? { branch: o.branch } : {}), ...(o.headSha ? { headSha: o.headSha } : {}), ...(o.workKey ? { workKey: o.workKey } : {}) },
      now,
    );
    await store.save({ ...rec, basis: storyBasis(rec, rec.acs.map((a) => a.hash)) });
  });
}
