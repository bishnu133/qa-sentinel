import type { Config } from "../config.js";
import { jiraMode } from "../config.js";
import { deleteComment, findIssueComment, JiraIdentityError, listOwnComments, type JiraContext, upsertIssueComment, writeIssueComment } from "../scm/jira.js";
import type { ServicePart } from "../feature/manifest.js";
import { emptyRecord, SAFE_KEY, type RecordPart, type RecordStore, type StoryRecord } from "../stories/record.js";
import { basisNow } from "../stories/parts.js";
import { openStore } from "../stories/start.js";
import { log } from "../log.js";

/**
 * One QA status comment per story. Everything qa-sentinel says about a story on Jira (feature readiness, the gap
 * report of each service, the story review, proposed bugs, post-deploy results) lives in ONE comment made of
 * sections. A command replaces only its own section and leaves the others; the comment is edited in place, so the
 * story's activity does not fill up with qa-sentinel comments. Short notifications that mention people are separate
 * new comments (see notify.ts): an edited comment does not notify anyone.
 *
 * Each result section remembers the "basis" it was written against (a digest of the merged code and the ACs, from the
 * story record). When the basis moves on, the section is shown with an "out of date" mark. Only qa-sentinel's own
 * comments are ever edited or deleted.
 */

export const STATUS_MARKER = "qa-sentinel:status";
const SECTION_RE = /^(.*?)(?:\{color:#97a0af\})?Updated ([^{]*?) · qa-sentinel:section=([A-Za-z0-9:._-]+)(?: · basis=([0-9a-f]+))?(?: · acs=([0-9a-f]+))?(?:\{color\})?\s*$/;
/** Jira rejects comments over 32,767 characters. */
const HARD_LIMIT = 32_000;
/** The first line of an out-of-date result section; it is added when drawing and removed when reading. */
const STALE_LINE = "{color:#de350b}⚠️ *Out of date:*";

export interface Section {
  name: string;
  /** Wiki text, starting with its heading. */
  wiki: string;
  updated: string;
  /** The story basis this section was written against (absent in comments written before bases existed: never marked). */
  basis?: string;
  /** Digest of the AC hashes when it was written (absent when the ACs were not known). */
  acs?: string;
}

/** Sections that report a result and can be out of date. The others (pending, bugs, story review, hotfix) are not marked. */
export const isResultSection = (name: string) => name === "feature" || name.startsWith("gap-report:") || name === "post-deploy" || name === "showcase" || name === "cross-service";

/** Fixed order in the comment: the feature first, then gap reports, then the rest. */
const rank = (name: string) => (name === "pending" ? -1 : name === "feature" ? 0 : name.startsWith("gap-report:") ? 1 : name === "story-review" ? 2 : name === "bugs" ? 3 : name === "post-deploy" ? 4 : 5);

/** The sections of an existing status comment (anything before the status marker line is the header). */
export function parseStatus(body: string): Section[] {
  const lines = body.split("\n");
  const start = lines.findIndex((l) => l.includes(STATUS_MARKER));
  const out: Section[] = [];
  let acc: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const m = SECTION_RE.exec(line);
    if (m) {
      if (m[1].trim()) acc.push(m[1]);
      // The out-of-date line is drawn from the basis every time; never keep it as section text.
      const text = acc.filter((l) => !l.startsWith(STALE_LINE)).join("\n").trim();
      out.push({ name: m[3], wiki: text, updated: m[2].trim(), ...(m[4] ? { basis: m[4] } : {}), ...(m[5] ? { acs: m[5] } : {}) });
      acc = [];
    } else acc.push(line);
  }
  return out;
}

const stamp = (d: Date) => `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;

/** Shorten the biggest sections until the comment fits Jira's limit. */
function fit(sections: Section[], header: string): Section[] {
  const size = (ss: Section[]) => header.length + ss.reduce((n, x) => n + x.wiki.length + 120, 0);
  let out = sections;
  while (size(out) > HARD_LIMIT) {
    const big = [...out].sort((a, b) => b.wiki.length - a.wiki.length)[0];
    if (big.wiki.length < 600) break;
    const keep = Math.floor(big.wiki.length * 0.7);
    const cut = big.wiki.slice(0, keep);
    out = out.map((x) => (x === big ? { ...x, wiki: `${cut.slice(0, Math.max(0, cut.lastIndexOf("\n")))}\n\n_Shortened to fit Jira's comment size. The full text is in the CI artifact._` } : x));
  }
  return out;
}

export interface RenderOptions {
  /** The story's basis now. Result sections written against another basis are marked out of date. */
  currentBasis?: string;
  /** The story's AC digest now. */
  currentAcs?: string;
  /** The story record's parts: with them, a section is marked only when something merged (or was reverted) after it was written, or the ACs changed. */
  parts?: Pick<RecordPart, "state" | "mergedAt">[];
  /** What changed, for the mark; given the section. */
  why?: (s: Section) => string;
}

const GENERIC_WHY = "new code was merged or the ACs changed after this was written";

/** Text that looks like our own section stamp or mark cannot start a section of its own: a zero-width space breaks it. */
const ZW = "\u200b";
const safeText = (wiki: string) =>
  wiki
    .split("\n")
    .map((l) => (l.startsWith(STALE_LINE) ? ZW + l : l).replace(/qa-sentinel:section=/g, `qa-sentinel:section${ZW}=`))
    .join("\n");

/** Is this result section out of date? A different basis alone is not enough when the record says nothing merged after the section was written. */
export function isStale(x: Section, o: RenderOptions): boolean {
  if (!o.currentBasis || !x.basis || x.basis === o.currentBasis || !isResultSection(x.name)) return false;
  if (!o.parts) return true;
  const since = stampToIso(x.updated);
  const acsChanged = Boolean(x.acs && o.currentAcs && x.acs !== o.currentAcs);
  const mergedAfter = o.parts.some((p) => (p.state === "merged" && (!p.mergedAt || !since || p.mergedAt > since)) || p.state === "reverted");
  return acsChanged || mergedAfter;
}

export function renderStatus(story: string, sections: Section[], o: RenderOptions = {}): string {
  const header = `h2. QA status · ${story}\n_One comment, kept up to date by qa-sentinel. Each part is replaced when its check runs again._\n{color:#97a0af}${STATUS_MARKER}{color}\n`;
  const ordered = [...sections].sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
  return [
    header,
    ...fit(ordered, header).map((x) => {
      const mark = isStale(x, o) ? `${STALE_LINE} ${o.why?.(x) ?? GENERIC_WHY}.{color}\n` : "";
      return `${mark}${safeText(x.wiki)}\n{color:#97a0af}Updated ${x.updated} · qa-sentinel:section=${x.name}${x.basis ? ` · basis=${x.basis}` : ""}${x.basis && x.acs ? ` · acs=${x.acs}` : ""}{color}\n`;
    }),
  ].join("\n");
}

/** Replace (or add) one section. Pure. */
export function withSection(existing: Section[], name: string, wiki: string, now = new Date(), basis?: string, acs?: string): Section[] {
  return [...existing.filter((s) => s.name !== name), { name, wiki: wiki.trim(), updated: stamp(now), ...(basis ? { basis } : {}), ...(basis && acs ? { acs } : {}) }];
}

/** "2026-10-21 11:03 UTC" -> ISO time (undefined when it is not that format). */
const stampToIso = (u: string) => {
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) UTC$/.exec(u);
  return m ? `${m[1]}T${m[2]}:00.000Z` : undefined;
};

/** What changed since a section was written, in words, from the story record. */
export function whatChanged(rec: Pick<StoryRecord, "parts"> | undefined, s: Section): string {
  const since = stampToIso(s.updated);
  const merged = (rec?.parts ?? []).filter((p) => p.state === "merged" && p.mergedAt && (!since || p.mergedAt > since));
  if (!merged.length) return GENERIC_WHY;
  return `${GENERIC_WHY} (${merged.slice(0, 3).map((p) => `${p.service}${p.iid ? ` !${p.iid}` : ""} merged ${p.mergedAt!.slice(0, 10)}`).join(", ")}${merged.length > 3 ? `, +${merged.length - 3} more` : ""})`;
}

export interface StatusWrite {
  /** skipped: Jira would not say which comments are qa-sentinel's own, so nothing was written. */
  action: "created" | "updated" | "skipped";
  id: string;
  url: string;
}

type Visibility = { type: "role" | "group"; value: string };

export interface BasisOptions {
  basis?: string;
  acs?: string;
  parts?: Pick<RecordPart, "state" | "mergedAt">[];
  why?: (s: Section) => string;
}

/**
 * Put a section into the story's status comment. Jira has no compare-and-set, so the comment is read right before
 * it is written; two runners updating different sections at the same moment could still lose one of them, and the
 * next run of that check restores it. Only the token user's own status comment is edited; when Jira will not say who
 * the token belongs to this throws JiraIdentityError and writes nothing.
 */
export async function upsertStatusSection(ctx: JiraContext, story: string, name: string, wiki: string, visibility?: Visibility, now = new Date(), o: BasisOptions = {}): Promise<StatusWrite> {
  const existing = await findIssueComment(ctx, story, STATUS_MARKER);
  const sections = withSection(existing ? parseStatus(existing.body) : [], name, wiki, now, o.basis, o.acs);
  return writeIssueComment(ctx, story, existing?.id, renderStatus(story, sections, { currentBasis: o.basis, currentAcs: o.acs, parts: o.parts, why: o.why }), visibility);
}

// ---------------------------------------------------------------------------------------------
// Older comments

/** Markers of the comments the old layout wrote (one per kind). */
export const LEGACY_MARKERS = ["qa-sentinel:gap-report:", "qa-sentinel:feature", "qa-sentinel:post-deploy", "qa-sentinel:bugs", "qa-sentinel:story-review", "qa-sentinel:showcase", "qa-sentinel:hotfix-"];
export const REPLACED_MARKER = "qa-sentinel:replaced";

const isLegacy = (body: string) => !body.includes(STATUS_MARKER) && !body.includes(REPLACED_MARKER) && LEGACY_MARKERS.some((m) => body.includes(m));

/** The status-comment section an old comment becomes (by its marker). */
export function sectionOfLegacy(body: string): string | undefined {
  const hot = /qa-sentinel:(?:gap-report:)?hotfix-([A-Za-z0-9._-]+)/.exec(body);
  if (hot) return `hotfix:${hot[1]}`;
  const gap = /qa-sentinel:gap-report:([A-Za-z0-9._-]+)/.exec(body);
  if (gap) return `gap-report:${gap[1]}`;
  for (const k of ["feature", "post-deploy", "bugs", "story-review", "showcase"]) if (body.includes(`qa-sentinel:${k}`)) return k;
  return undefined;
}

/** An old comment's text without its trailing marker line. */
const withoutMarker = (body: string) =>
  body
    .split("\n")
    .filter((l) => !(LEGACY_MARKERS.some((m) => l.includes(m)) && l.replace(/\{color[^}]*\}/g, "").trim().startsWith("qa-sentinel:")))
    .join("\n")
    .trim();

const jiraTime = (t: string | undefined) => {
  const d = t ? new Date(t.replace(/([+-]\d\d)(\d\d)$/, "$1:$2")) : new Date(NaN);
  return Number.isNaN(d.getTime()) ? new Date(0) : d;
};

const sameVisibility = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * qa-sentinel's own older comments on a story (one per kind) are moved into the status comment, then made a one-line
 * pointer (or deleted, `cleanup: delete`). Nothing is lost: a kind's text becomes the status comment's section of that
 * kind unless the status comment already has a section of it (a fresher run); only after the status comment holds it is the
 * old comment changed. Other people's comments are never touched, even when they contain a marker. A comment with a
 * different visibility than the status comment is left alone (moving it would show it to more people). When Jira will not
 * say who the token belongs to this throws JiraIdentityError and changes nothing. Idempotent. Returns how many comments
 * were changed and how many could not be.
 */
export async function migrateLegacy(c: Config, ctx: JiraContext, story: string, status: { id: string; url: string }, o: BasisOptions = {}): Promise<{ changed: number; failed: number }> {
  const how = c.reporting.jira.cleanup;
  if (how === "keep") return { changed: 0, failed: 0 };
  const own = await listOwnComments(ctx, story);
  const statusCm = own.find((cm) => cm.id === status.id);
  const legacy = own.filter((cm) => isLegacy(cm.body));
  if (!statusCm || !legacy.length) return { changed: 0, failed: 0 };
  let failed = 0;
  const movable = legacy.filter((cm) => {
    const ok = sameVisibility(cm.visibility, statusCm.visibility);
    if (!ok) {
      failed++;
      log.warn(`${story}: comment ${cm.id} has a different visibility than the status comment; left as it is`);
    }
    return ok;
  });
  // 1. The text goes into the status comment first (newest comment of a kind wins; a section already there is fresher).
  let sections = parseStatus(statusCm.body);
  const have = new Set(sections.map((x) => x.name));
  const carried: Section[] = [];
  for (const cm of [...movable].reverse()) {
    const name = sectionOfLegacy(cm.body);
    if (!name || have.has(name)) continue;
    have.add(name);
    carried.push({ name, wiki: withoutMarker(cm.body), updated: stamp(jiraTime(cm.updated ?? cm.created)) });
  }
  if (carried.length) {
    sections = [...sections, ...carried];
    try {
      await writeIssueComment(ctx, story, statusCm.id, renderStatus(story, sections, { currentBasis: o.basis, currentAcs: o.acs, parts: o.parts, why: o.why }), statusCm.visibility as Visibility | undefined);
    } catch (e) {
      log.warn(`${story}: could not move the older comments into the status comment (${(e as Error).message.split("\n")[0]}); they are left as they are`);
      return { changed: 0, failed: movable.length + failed };
    }
  }
  // 2. Only now is an old comment replaced.
  let changed = 0;
  for (const cm of movable) {
    try {
      if (how === "delete") {
        try {
          await deleteComment(ctx, story, cm.id);
          changed++;
          continue;
        } catch (e) {
          log.warn(`${story}: could not delete comment ${cm.id} (${(e as Error).message.split("\n")[0]}); making it a pointer instead`);
        }
      }
      await writeIssueComment(ctx, story, cm.id, `Replaced by the QA status comment: ${status.url} {color:#97a0af}${REPLACED_MARKER}{color}`, cm.visibility as Visibility | undefined);
      changed++;
    } catch (e) {
      failed++;
      log.warn(`${story}: could not update comment ${cm.id}: ${(e as Error).message.split("\n")[0]}`);
    }
  }
  if (changed) log.info(`${story}: ${changed} older qa-sentinel comment(s) moved into the status comment (${how === "delete" ? "deleted" : "left as a pointer"})`);
  return { changed, failed };
}

// ---------------------------------------------------------------------------------------------
// What the commands call

/** The story record, for the basis. The record is a cache: any problem reading it means no basis, never a failure. */
async function recordOf(cwd: string | undefined, c: Config, story: string, env: NodeJS.ProcessEnv | undefined): Promise<{ rec?: StoryRecord; store?: RecordStore }> {
  if (!cwd) return {};
  try {
    const store = openStore(cwd, c, env);
    return { rec: await store.load(story), store };
  } catch {
    return {};
  }
}

/** Remember (or forget) that the older comments were moved. Best effort. */
async function setCleaned(store: RecordStore | undefined, rec: StoryRecord | undefined, story: string, value: string | undefined): Promise<void> {
  if (!store || !SAFE_KEY.test(story) || (rec?.legacyCleanedAt ?? undefined) === value) return;
  try {
    await store.locked(story, async () => {
      const fresh = (await store.load(story)) ?? emptyRecord(story);
      const { legacyCleanedAt: _drop, ...rest } = fresh;
      await store.save({ ...rest, ...(value ? { legacyCleanedAt: value } : {}) });
    });
  } catch {
    /* only an extra read next time */
  }
}

export interface PostOptions {
  name: string;
  wiki: string;
  legacyKind: string;
  legacyMarker?: string;
  /** The legacy comment's text when it differs from the section's (the showcase mention). */
  legacyWiki?: string;
  /** Where the story record is (for the basis the section is written against). */
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** The parts the caller has just seen: a merge the sweep has not recorded yet still counts in the basis. */
  parts?: ServicePart[];
  /** The basis, when the caller has it (else it is worked out from the record and `parts`). */
  basis?: string;
  now?: Date;
}

/**
 * What every command calls to say something on a story. `reporting.jira.mode`: status (default) puts it in the
 * status comment; legacy is the old behaviour, one comment per kind with its own marker; both writes both. While in
 * status mode, qa-sentinel's own older comments are moved into the status comment once (`reporting.jira.cleanup`; the
 * story record remembers it was done, and a legacy or both write forgets it). When Jira will not say which comments
 * are qa-sentinel's own, nothing is written: the result is `{ action: "skipped" }` and a warning.
 */
export async function postToStory(c: Config, ctx: JiraContext, story: string, o: PostOptions): Promise<StatusWrite> {
  const j = c.reporting.jira;
  const mode = jiraMode(c);
  const legacy = () => upsertIssueComment(ctx, story, o.legacyKind, o.legacyWiki ?? o.wiki, j.visibility, o.legacyMarker);
  const { rec, store } = await recordOf(o.cwd, c, story, o.env);
  try {
    if (mode === "legacy") {
      const r = await legacy();
      await setCleaned(store, rec, story, undefined);
      return r;
    }
    const b = o.basis ? { basis: o.basis, acs: undefined, parts: rec?.parts } : basisNow(rec, o.parts, o.now);
    const opts: BasisOptions = { basis: b.basis, acs: b.acs, parts: b.parts, why: (s) => whatChanged({ parts: b.parts ?? [] }, s) };
    const r = await upsertStatusSection(ctx, story, o.name, o.wiki, j.visibility, o.now, opts);
    if (mode === "both") {
      await legacy();
      await setCleaned(store, rec, story, undefined);
    } else if (j.cleanup !== "keep" && !rec?.legacyCleanedAt) {
      const m = await migrateLegacy(c, ctx, story, r, opts).catch((e) => (log.warn(`${story}: ${(e as Error).message}`), { changed: 0, failed: 1 }));
      if (!m.failed) await setCleaned(store, rec, story, (o.now ?? new Date()).toISOString());
    }
    return r;
  } catch (e) {
    if (e instanceof JiraIdentityError) {
      log.warn(`${story}: not written to Jira: ${e.message}`);
      return { action: "skipped", id: "", url: "" };
    }
    throw e;
  }
}

/**
 * Re-draw an existing status comment against the story's basis now: marks result sections that are out of date, and
 * sets (or removes, with null) the `pending` section. Section texts do not change and nothing is created: with no
 * status comment of ours there is nothing to refresh. No AI. Writes only when the comment would look different. Throws
 * JiraIdentityError (and writes nothing) when Jira will not say which comments are qa-sentinel's own.
 */
export async function refreshStaleness(ctx: JiraContext, story: string, o: { basis?: string; acs?: string; rec?: Pick<StoryRecord, "parts">; pending?: string | null; visibility?: Visibility; now?: Date }): Promise<"none" | "unchanged" | "updated"> {
  const existing = await findIssueComment(ctx, story, STATUS_MARKER);
  if (!existing) return "none";
  let sections = parseStatus(existing.body);
  if (o.pending !== undefined) {
    const cur = sections.find((x) => x.name === "pending");
    if (o.pending === null) sections = sections.filter((x) => x.name !== "pending");
    else if (cur?.wiki !== o.pending.trim()) sections = withSection(sections, "pending", o.pending, o.now);
  }
  const body = renderStatus(story, sections, { currentBasis: o.basis, currentAcs: o.acs, parts: o.rec?.parts, why: (s) => whatChanged(o.rec, s) });
  if (body.trim() === existing.body.trim()) return "unchanged";
  await writeIssueComment(ctx, story, existing.id, body, o.visibility);
  return "updated";
}
