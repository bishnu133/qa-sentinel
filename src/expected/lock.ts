import { indexSource, type IndexedTest } from "../analysis/testIndex.js";
import type { Finding } from "../guardrails.js";
import type { FileChange } from "../git.js";
import { type CurrentAc, type ExpectedFile, ExpectedFileError, currentHash, expectedPath, freshness, parseExpected, viewEditedByHand, viewOf } from "./format.js";

/**
 * Expectation lock: what the business asked for may not drift toward what the code does.
 *
 * A story's expectations are LOCKED once they are stored (expected/<STORY>.md exists): an AC is locked while its
 * stored text is still in the story. For a locked AC, an AI run may not:
 * - change anything in its entry in expected/<STORY>.md (values, statements, states, sources, text, services),
 *   remove or move its behaviours, or add new ones (unless the entry was an empty placeholder);
 * - change, rewrite or remove an assertion in a test tagged with it; change a literal anywhere in such a test, or
 *   in a top-level constant such a test uses; add an early return, a condition, a try or a skip around its checks;
 *   switch it off (skip/fixme/fail) or delete it.
 * An AC opens only when its stored text is gone from the story (changed or removed), proved by the current ACs the
 * caller passes (Jira, the story file, or the hashes qa-sentinel recorded in its commit). Then its new entry must
 * carry the hash of the story's current text.
 *
 * Stories without a stored expectation (tests written before this existed) get warnings, not violations: nothing
 * reviewed says what they should assert yet. The requirements pass writes the file; from then on they are locked.
 *
 * People are not locked: a QA engineer correcting a value is the review this design relies on. The caller runs
 * the lock on AI changes (generate's own run; `verify --policy` attributes branch changes to commits) and turns
 * people's changes into visible overrides. An expected file that doesn't parse is an error whoever wrote it.
 */

export interface LockInput {
  expectedDir: string;
  changes: FileChange[];
  /** File content before the change (undefined: the file didn't exist). */
  before: (file: string) => string | undefined;
  /** File content after the change (undefined: deleted). */
  after: (file: string) => string | undefined;
  /** The story's current ACs, per upper-case story key, when known. Without them no AC is unlocked. */
  currentAcs?: Map<string, CurrentAc[]>;
  /** Which stored expectations decide what is locked (default: `before`). verify passes the branch base. */
  lockedBy?: (file: string) => string | undefined;
}

/** A lock finding: `what` happened (shown to everyone), `advice` for the AI case only. */
export interface LockFinding extends Finding {
  what: string;
  advice?: string;
  /** Findings that stay errors whoever made the change (an expected file that doesn't parse). */
  always?: boolean;
  /** What it is about (a test title, an AC/behaviour): matches findings across commits. */
  subject: string;
}

const TEST_FILE = /\.(spec|test)\.(ts|tsx|js|mjs|cjs)$/;
const ASSERTION_LINE = /\bexpect(?:\.soft|\.poll)?\s*\(|\bassert(?:\.\w+)?\s*\(|\.should\s*\(|\bexpectSchema\s*\(|^\s*\.(?:not\.)?(?:to|resolves|rejects)\w*/;
/** Added lines that can stop a test's checks from running: an early return, a condition, a try, a skip. */
const WEAKENING = /^\s*(?:return\b|if\s*\(|try\s*\{|\}\s*catch\b|for\s*\(|while\s*\(|\/\*|\/\/.*\b(?:expect|assert)\b|throw\b)|\b(?:test|it|describe)\.(?:skip|fixme|fail|only)\s*\(|\.info\(\)\.annotations|&&\s*(?:test|it)\.|\.route\s*\(|\.fulfill\s*\(|\bmock\w*\s*\(|\bnock\s*\(|\bmsw\b/;
/** Added anywhere in a file with locked tests: switches off or narrows every test in it. */
const FILE_WEAKENING = /\b(?:test|it)\.describe\.(?:skip|fixme|only)\b|\bdescribe\.(?:skip|only)\b|\b(?:test|it)\.only\s*\(|\b(?:beforeEach|beforeAll)\s*\(.*\b(?:skip|fixme)\b/;
const DECLARATION = /^\s*(?:export\s+)?(?:(?:const|let|var)\s+([A-Za-z_$][\w$]*)|(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*))/;
const squash = (l: string) => l.replace(/\s+/g, " ").trim();
/** The line with its literals blanked: two lines with the same shape differ only in values. */
const shape = (l: string) => squash(l).replace(/(["'`])(?:\\.|(?!\1)[^\\])*\1/g, "S").replace(/-?\b\d+(?:\.\d+)?\b/g, "N");
const UNIT = "the stored expectation for its AC is unchanged and the AC is still in the story";

/** Normalised folder ("./expected/" → "expected"). */
export const expectedDirOf = (dir: string) => dir.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, "") || "expected";

/** expected/<STORY>.md → STORY (upper case), or undefined for anything else. */
export function storyOfExpectedPath(dir: string, file: string): string | undefined {
  const d = expectedDirOf(dir);
  const p = file.replace(/\\/g, "/").replace(/^\.\/+/, "");
  const m = p.startsWith(`${d}/`) ? p.slice(d.length + 1).match(/^([A-Za-z][A-Za-z0-9_]*-\d+)\.md$/) : null;
  return m ? m[1].toUpperCase() : undefined;
}

/** Which stored ACs (by stored id) may change: those whose stored text is gone from the story. */
export function unlockedAcs(stored: ExpectedFile | undefined, current: CurrentAc[] | undefined): Set<string> {
  if (!current || !stored) return new Set();
  const out = new Set<string>();
  // Only "changed" (the same id now has other text). An AC missing from the list may be a parsing gap, not a
  // removal: its expectations stay locked (a person can retire them).
  for (const [id, f] of freshness(stored, current)) if (f === "changed") out.add(id);
  return out;
}

type Parsed = { state: "absent" } | { state: "invalid"; error: string } | { state: "ok"; file: ExpectedFile; text: string };
function parseState(text: string | undefined, file: string): Parsed {
  if (text === undefined) return { state: "absent" };
  try {
    return { state: "ok", file: parseExpected(text, file), text };
  } catch (e) {
    return { state: "invalid", error: e instanceof ExpectedFileError ? e.message : String(e) };
  }
}

/** Line diff (LCS) between two texts: removed lines with their 1-based number before, added lines with theirs after. */
export function lineDiff(a: string, b: string): { removed: { n: number; text: string }[]; added: { n: number; text: string }[] } {
  const x = a.split(/\r?\n/);
  const y = b.split(/\r?\n/);
  let s = 0;
  while (s < x.length && s < y.length && x[s] === y[s]) s++;
  let ex = x.length;
  let ey = y.length;
  while (ex > s && ey > s && x[ex - 1] === y[ey - 1]) {
    ex--;
    ey--;
  }
  const xs = x.slice(s, ex);
  const ys = y.slice(s, ey);
  if (xs.length * ys.length > 4_000_000) return { removed: xs.map((t, i) => ({ n: s + i + 1, text: t })), added: ys.map((t, i) => ({ n: s + i + 1, text: t })) };
  const L = Array.from({ length: xs.length + 1 }, () => new Uint32Array(ys.length + 1));
  for (let i = xs.length - 1; i >= 0; i--) for (let j = ys.length - 1; j >= 0; j--) L[i][j] = xs[i] === ys[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const removed: { n: number; text: string }[] = [];
  const added: { n: number; text: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < xs.length && j < ys.length) {
    if (xs[i] === ys[j]) {
      i++;
      j++;
    } else if (L[i + 1][j] >= L[i][j + 1]) removed.push({ n: s + ++i, text: xs[i - 1] });
    else added.push({ n: s + ++j, text: ys[j - 1] });
  }
  while (i < xs.length) removed.push({ n: s + ++i, text: xs[i - 1] });
  while (j < ys.length) added.push({ n: s + ++j, text: ys[j - 1] });
  return { removed, added };
}

const tagsIn = (s: string | undefined, tag: string) => [...(s ?? "").matchAll(new RegExp(`@${tag}:([A-Za-z0-9,_-]+)`, "g"))].flatMap((m) => m[1].split(",")).filter((x) => x && !/^(none|-)$/i.test(x));
/** A test's stories and ACs, including tags on its describe block, upper-cased like Jira keys and AC ids. */
const storiesOf = (t: IndexedTest) => [...new Set([...t.stories, ...tagsIn(t.describe, "story")].map((x) => x.toUpperCase()))];
const acsOf = (t: IndexedTest) => [...new Set([...t.acs, ...tagsIn(t.describe, "ac")].map((x) => x.toUpperCase()))];

/**
 * Tests the plain index misses: `test.each(table)("title")` / `it.each`, whose data rows sit above the title line.
 * Their block starts at the `.each` line so the rows count as part of the test.
 */
function indexWithEach(file: string, src: string): IndexedTest[] {
  const base = indexSource(file, src);
  const lines = src.split(/\r?\n/);
  const extra: IndexedTest[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/\b(?:test|it)(?:\.(?:only|skip|fixme|fail))?\.each\b/.test(lines[i])) continue;
    for (let k = i; k < Math.min(lines.length, i + 200); k++) {
      const m = lines[k].match(/\)\s*\(\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/);
      if (!m) continue;
      const title = m[2];
      const tags = { stories: tagsIn(title, "story"), acs: tagsIn(title, "ac").map((a) => a.toUpperCase()) };
      const describe = base.filter((t) => t.line < i + 1).at(-1)?.describe;
      extra.push({ id: `${file}:${i + 1}`, file, line: i + 1, endLine: k + 1, title: title.replace(/\s*@\S+/g, "").trim(), describe, status: /\.(skip)\b/.test(lines[i]) ? "skip" : /\.fixme\b/.test(lines[i]) ? "fixme" : /\.fail\b/.test(lines[i]) ? "known-defect" : "active", services: [], endpoints: [], pages: [], tags: [], assertions: 0, statusOnly: false, ...tags });
      i = k;
      break;
    }
  }
  if (!extra.length) return base;
  // An .each block's body (after its title line) belongs to it until the next test.
  const all = [...base.filter((t) => !extra.some((e) => t.line >= e.line && t.line <= e.endLine)), ...extra].sort((a, b) => a.line - b.line);
  return all.map((t, k) => ({ ...t, endLine: k + 1 < all.length ? all[k + 1].line - 1 : lines.length }));
}

const enclosing = (tests: IndexedTest[], n: number) => tests.find((t) => t.line <= n && n <= t.endLine);
const sameTitle = (a: IndexedTest, b: IndexedTest) => a.title === b.title && (a.describe ?? "") === (b.describe ?? "");

/**
 * The test in `after` that `t` became: the same title; else, for a renamed test, the renamed one with the same ACs
 * (when several were renamed, by their order in the file).
 */
function counterpart(t: IndexedTest, before: IndexedTest[], after: IndexedTest[]): IndexedTest | undefined {
  const byTitle = after.find((x) => sameTitle(x, t));
  if (byTitle) return byTitle;
  const key = (x: IndexedTest) => acsOf(x).sort().join(",");
  const lost = before.filter((y) => key(y) === key(t) && !after.some((x) => sameTitle(x, y)));
  const fresh = after.filter((x) => key(x) === key(t) && !before.some((y) => sameTitle(y, x)));
  return lost.length === fresh.length ? fresh[lost.indexOf(t)] : undefined;
}

const entryKey = (a: ExpectedFile["acs"][number]) => JSON.stringify({ ...a, id: undefined });
const behaviourKey = (b: ExpectedFile["acs"][number]["behaviours"][number]) => JSON.stringify([b.kind, b.statement, b.expect, b.state, b.question ?? null, b.source]);
const show = (v: unknown) => (v && typeof v === "object" ? Object.entries(v as Record<string, unknown>).map(([k, x]) => `${k} ${JSON.stringify(x)}`).join(", ") || "none" : JSON.stringify(v));

export function checkExpectationLockDetailed(o: LockInput): LockFinding[] {
  const out: LockFinding[] = [];
  const dir = expectedDirOf(o.expectedDir);
  const push = (f: Omit<LockFinding, "message" | "subject">) => {
    const subject = f.what.match(/^"([^"]*)"/)?.[1] ?? f.what.match(/^[A-Za-z][A-Za-z0-9_]*-\d+ ([^\s:.]+)/)?.[1] ?? f.what.match(/: ([A-Za-z_$][\w$]*) is used by/)?.[1] ?? f.what;
    out.push({ ...f, subject, message: f.advice ? `${f.what} ${f.advice}` : f.what });
  };
  const storedCache = new Map<string, Parsed>();
  const storedOf = (story: string) => {
    const read = o.lockedBy ?? o.before;
    if (!storedCache.has(story)) storedCache.set(story, parseState(read(expectedPath(dir, story)) ?? read(expectedPath(dir, story.toLowerCase())), story));
    return storedCache.get(story)!;
  };
  const openOf = (story: string) => {
    const st = storedOf(story);
    return unlockedAcs(st.state === "ok" ? st.file : undefined, o.currentAcs?.get(story));
  };

  for (const ch of o.changes) {
    const expStory = storyOfExpectedPath(dir, ch.path) ?? (ch.from ? storyOfExpectedPath(dir, ch.from) : undefined);
    // ---- expected/<STORY>.md
    if (expStory) {
      const file = ch.path;
      const before = parseState(o.before(ch.from ?? ch.path), ch.from ?? ch.path);
      const afterText = ch.status === "D" ? undefined : o.after(ch.path);
      const after = parseState(afterText, ch.path);
      if (after.state === "invalid") {
        push({ level: "violation", rule: "expected-file-invalid", file, what: `${file} can't be read: ${after.error}`, always: true });
        continue;
      }
      if (before.state === "invalid") {
        push({ level: "violation", rule: "expected-file-invalid", file, what: `${file} couldn't be read before this change, so qa-sentinel can't tell what changed in it`, advice: "A person must fix the file first (in its own commit).", always: false });
        continue;
      }
      if (after.state === "ok" && viewEditedByHand(after.text)) {
        // Someone edited the view itself (it changed), or a new file came with a view that isn't its data. A view that
        // only went stale because the data block was edited (the right way) is not an edit of the view.
        if (before.state !== "ok" || viewOf(before.text) !== viewOf(after.text))
          push({ level: "violation", rule: "expectation-changed", file, what: `${file}: the readable view below the data block doesn't match the data (it was edited directly). Tests use the data block only.`, advice: "Edit the data block instead, then refresh the view: qa-sentinel spec --story <KEY> (no AI run)." });
        else push({ level: "warning", rule: "expectation-changed", file, what: `${file}: the data block changed; the readable view below it is now out of date.`, advice: "Refresh it with: qa-sentinel spec --story <KEY> (no AI run)." });
      }
      if (before.state !== "ok") continue; // a new file: everything in it is new, and QA reviews it in the MR
      if (after.state !== "ok") {
        push({ level: "violation", rule: "expectation-removed", file, what: `the expected-behaviour file for ${expStory} was deleted` });
        continue;
      }
      if (after.file.story.toUpperCase() !== before.file.story.toUpperCase()) push({ level: "violation", rule: "expectation-changed", file, what: `${file}: story changed from ${before.file.story} to ${after.file.story}` });
      const lockState = storedOf(expStory);
      const open = unlockedAcs(lockState.state === "ok" ? lockState.file : before.file, o.currentAcs?.get(expStory));
      const current = o.currentAcs?.get(expStory);
      const currentHashes = new Map((current ?? []).map((c) => [c.id, currentHash(c)]));
      const afterOwner = new Map(after.file.acs.flatMap((a) => a.behaviours.map((b) => [b.id, a] as const)));
      for (const ac of before.file.acs) {
        if (ac.removed) continue;
        const now = after.file.acs.find((a) => a.hash === ac.hash && !a.removed) ?? after.file.acs.find((a) => a.id === ac.id);
        if (open.has(ac.id)) {
          // Open because the story's text changed: the new entry must be written for that text.
          if (now && !now.removed && currentHashes.has(now.id) && now.hash !== currentHashes.get(now.id)) push({ level: "violation", rule: "expectation-changed", file, what: `${expStory} ${now.id}: the stored AC hash ${now.hash} isn't the hash of the story's current text for ${now.id}` });
          continue;
        }
        if (!now) {
          push({ level: "violation", rule: "expectation-removed", file, what: `${expStory} ${ac.id}: its whole entry was removed`, advice: `Blocked: ${UNIT}.` });
          continue;
        }
        if (now.removed) push({ level: "violation", rule: "expectation-removed", file, what: `${expStory} ${ac.id}: marked removed, but it is still in the story${current ? "" : " (or the story couldn't be checked)"}` });
        if (now.hash !== ac.hash) push({ level: "violation", rule: "expectation-changed", file, what: `${expStory} ${ac.id}: the stored AC hash changed, but ${current ? "the story's text for it didn't" : "the story's current ACs weren't available to confirm it changed"}` });
        const placeholder = !ac.behaviours.length && !ac.untestable;
        for (const b of ac.behaviours) {
          const owner = afterOwner.get(b.id);
          const later = owner?.behaviours.find((x) => x.id === b.id);
          if (!later) push({ level: "violation", rule: "expectation-removed", file, what: `${expStory} ${ac.id}/${b.id} was removed ("${b.statement}").`, advice: `Blocked: ${UNIT}.` });
          else if (owner !== now) push({ level: "violation", rule: "expectation-changed", file, what: `${expStory} ${ac.id}/${b.id} was moved to ${owner?.id}.`, advice: `Blocked: ${UNIT}.` });
          else if (behaviourKey(later) !== behaviourKey(b)) {
            const values = JSON.stringify(b.expect) !== JSON.stringify(later.expect) ? `values ${show(b.expect)} → ${show(later.expect)}` : later.statement !== b.statement ? `statement "${b.statement}" → "${later.statement}"` : later.state !== b.state ? `state ${b.state} → ${later.state}` : "its source or question";
            push({ level: "violation", rule: "expectation-changed", file, what: `${expStory} ${ac.id}/${b.id}: ${values}.`, advice: `Blocked: ${UNIT}, so the approved value stays. If it is wrong, a QA engineer edits the data block in this merge request; if the product does something else, that is a defect to raise.` });
          }
        }
        if (now && now.id !== ac.id && !(current && current.find((c) => c.id === now.id && currentHash(c) === ac.hash))) {
          push({ level: "violation", rule: "expectation-changed", file, what: `${expStory} ${ac.id}: its entry now says ${now.id}, but the story didn't renumber it.`, advice: `Blocked: ${UNIT}.` });
        }
        if (now && placeholder) {
          // An empty entry may be filled (that's the requirements pass doing its job), but its AC text stays the story's.
          if (now.text !== ac.text) push({ level: "violation", rule: "expectation-changed", file, what: `${expStory} ${ac.id}: its AC text was changed in the file.`, advice: `Blocked: the text is a copy of the story; change the story in Jira.` });
        } else if (now) {
          const added = now.behaviours.filter((b) => !ac.behaviours.some((x) => x.id === b.id));
          if (added.length) push({ level: "violation", rule: "expectation-changed", file, what: `${expStory} ${ac.id}: new behaviour(s) ${added.map((b) => b.id).join(", ")} added to an approved AC.`, advice: `Blocked: ${UNIT}; a QA engineer adds cases to it.` });
          const strip = (a: typeof ac) => entryKey({ ...a, behaviours: [] });
          if (strip(now) !== strip(ac)) push({ level: "violation", rule: "expectation-changed", file, what: `${expStory} ${ac.id}: its text, services or untestable note changed.`, advice: `Blocked: ${UNIT}.` });
        }
      }
      continue;
    }

    // ---- shared helpers (support code, page objects): a changed assertion or exported value may move a
    // requirement test's expectation without touching the test. Which tests use it isn't known here: warn.
    if (/\.(?:[cm]?[jt]sx?)$/.test(ch.path) && !TEST_FILE.test(ch.path) && ch.status === "M") {
      const b = o.before(ch.from ?? ch.path);
      const a = o.after(ch.path);
      if (b !== undefined && a !== undefined) {
        const d = lineDiff(b, a);
        for (const r of d.removed) {
          if (!ASSERTION_LINE.test(r.text) && !/^\s*export\s+(?:const|let|var)\b/.test(r.text)) continue;
          const twin = d.added.find((x) => shape(x.text) === shape(r.text) && squash(x.text) !== squash(r.text));
          if (twin) push({ level: "warning", rule: "expectation-changed", file: ch.path, what: `\`${squash(r.text)}\` → \`${squash(twin.text)}\` in shared test code: check the requirement tests that use it.` });
        }
      }
      continue;
    }
    // ---- tests tagged with ACs (and the files' top-level constants they use)
    if (!TEST_FILE.test(ch.path) || ch.status === "A" || ch.status === "?") continue;
    const beforeText = o.before(ch.from ?? ch.path);
    if (beforeText === undefined) continue;
    const afterText = ch.status === "D" ? "" : o.after(ch.path);
    if (afterText === undefined) continue;
    const tb = indexWithEach(ch.from ?? ch.path, beforeText);
    const ta = indexWithEach(ch.path, afterText);
    /** Locked ACs of a test, and whether the lock is only advisory (no stored expectation yet). */
    const lockOf = (t: IndexedTest): { acs: string[]; soft: boolean } => {
      const acs = acsOf(t);
      if (!acs.length) return { acs: [], soft: false };
      const stories = storiesOf(t);
      const stored = stories.filter((s) => storedOf(s).state !== "absent");
      if (!stored.length) return { acs, soft: true }; // nothing reviewed says what it should assert yet
      return { acs: acs.filter((ac) => !stored.some((s) => openOf(s).has(ac))), soft: false };
    };
    const level = (soft: boolean) => (soft ? "warning" : "violation") as "warning" | "violation";
    const softNote = (soft: boolean) => (soft ? " (No reviewed expectation is stored for its story yet, so this is a warning.)" : "");
    const pairs = new Map<IndexedTest, IndexedTest | undefined>(tb.map((t) => [t, counterpart(t, tb, ta)]));
    for (const t of tb) {
      const { acs, soft } = lockOf(t);
      if (!acs.length) continue;
      const now = pairs.get(t);
      if (!now) push({ level: level(soft), rule: "expectation-removed", file: ch.path, what: `"${t.title}" (${acs.join(", ")}) was removed.${softNote(soft)}`, advice: soft ? undefined : `Blocked: ${UNIT}.` });
      else if (acs.some((ac) => !acsOf(now).includes(ac))) push({ level: level(soft), rule: "expectation-removed", file: ch.path, what: `"${t.title}" no longer carries ${acs.filter((ac) => !acsOf(now).includes(ac)).join(", ")}.${softNote(soft)}`, advice: soft ? undefined : `Blocked: ${UNIT}.` });
      else if (t.status === "active" && now.status !== "active") push({ level: level(soft), rule: "ac-test-disabled", file: ch.path, what: `"${t.title}" (${acs.join(", ")}) was switched to ${now.status}.${softNote(soft)}`, advice: soft ? undefined : "A requirement test keeps running; when the product disagrees, report a defect instead." });
    }
    const { removed, added } = lineDiff(beforeText, afterText);
    const usedAdded = new Set<number>();
    const lockedTestsAfter = ta.filter((x) => tb.some((t) => pairs.get(t) === x && lockOf(t).acs.length));
    for (const r of removed) {
      if (!squash(r.text)) continue;
      const t = enclosing(tb, r.n);
      if (!t) {
        // Outside any test: a top-level constant used by a locked test is part of its expectation.
        const decl = (() => {
          for (let k = r.n; k >= Math.max(1, r.n - 50); k--) {
            const line = beforeText.split(/\r?\n/)[k - 1];
            if (enclosing(tb, k)) return undefined;
            const d = line.match(DECLARATION);
            if (d) return d[1] ?? d[2];
          }
          return undefined;
        })();
        const twin = added.find((a) => !usedAdded.has(a.n) && !enclosing(ta, a.n) && shape(a.text) === shape(r.text) && squash(a.text) !== squash(r.text));
        if (!twin) continue;
        usedAdded.add(twin.n);
        const users = decl ? lockedTestsAfter.filter((x) => new RegExp(`\\b${decl.replace(/\$/g, "\\$")}\\b`).test(afterText.split(/\r?\n/).slice(x.line - 1, x.endLine).join("\n"))) : [];
        if (users.length) {
          const soft = users.every((u) => lockOf(tb.find((t) => pairs.get(t) === u)!).soft);
          push({ level: level(soft), rule: "expectation-changed", file: ch.path, what: `\`${squash(r.text)}\` → \`${squash(twin.text)}\`: ${decl} is used by requirement test(s) ${users.map((u) => `"${u.title}"`).join(", ")}.${softNote(soft)}`, advice: soft ? undefined : `Blocked: ${UNIT}.` });
        }
        continue;
      }
      const { acs, soft } = lockOf(t);
      if (r.n === t.line) {
        // The test's own line: renames and tags are handled by pairing, but code on it (an inline assertion, a
        // test.each row) is checked like any other line, with the title text taken out.
        const now0 = pairs.get(t);
        const untitled = (l: string) => l.replace(/(["'`])(?:\\.|(?!\1)[^\\])*\1/, "TITLE");
        const nowLine = now0 ? afterText.split(/\r?\n/)[now0.line - 1] ?? "" : "";
        if (acs.length && now0 && squash(untitled(nowLine)) !== squash(untitled(r.text)) && !/^\s*(?:test|it)(?:\.\w+)?\s*\(\s*(["'`]).*\1\s*,\s*(?:async\s*)?\([^)]*\)\s*=>\s*\{\s*$/.test(nowLine)) {
          push({ level: level(soft), rule: "expectation-changed", file: ch.path, what: `"${t.title}" (${acs.join(", ")}): \`${squash(r.text)}\` → \`${squash(nowLine)}\`.${softNote(soft)}`, advice: soft ? undefined : `Blocked: ${UNIT}.` });
        }
        continue;
      }
      if (!acs.length) continue;
      const now = pairs.get(t);
      const inNow = now ? added.filter((a) => a.n >= now.line && a.n <= now.endLine && !usedAdded.has(a.n)) : [];
      const same = inNow.find((a) => squash(a.text) === squash(r.text));
      if (same) {
        usedAdded.add(same.n); // moved or re-indented, unchanged
        continue;
      }
      const twin = inNow.find((a) => shape(a.text) === shape(r.text));
      if (twin) usedAdded.add(twin.n);
      if (twin || ASSERTION_LINE.test(r.text)) {
        push({
          level: level(soft),
          rule: "expectation-changed",
          file: ch.path,
          what: twin ? `"${t.title}" (${acs.join(", ")}): \`${squash(r.text)}\` → \`${squash(twin.text)}\`.${softNote(soft)}` : `"${t.title}" (${acs.join(", ")}): assertion \`${squash(r.text)}\` was removed or rewritten.${softNote(soft)}`,
          advice: soft ? undefined : `Blocked: ${UNIT}. If the product does something else, that is a defect to report, not a test to change.`,
        });
      }
    }
    // Added anywhere in a file that holds locked tests: switches off or narrows all of them.
    const lockedHere = tb.filter((t) => lockOf(t).acs.length);
    if (lockedHere.length) {
      for (const a of added) {
        if (!FILE_WEAKENING.test(a.text)) continue;
        usedAdded.add(a.n);
        const soft = lockedHere.every((t) => lockOf(t).soft);
        push({ level: level(soft), rule: "expectation-changed", file: ch.path, what: `"${lockedHere[0].title}" and the file's other requirement tests: added \`${squash(a.text)}\`, which switches off or narrows them.${softNote(soft)}`, advice: soft ? undefined : `Blocked: ${UNIT}.` });
      }
    }
    // Added lines that can keep a locked test's checks from running.
    for (const a of added) {
      if (usedAdded.has(a.n) || !WEAKENING.test(a.text)) continue;
      const t = enclosing(ta, a.n);
      const orig = t ? tb.find((x) => pairs.get(x) === t) : undefined;
      if (!t || !orig || a.n === t.line) continue; // switching the test itself off is ac-test-disabled
      const { acs, soft } = lockOf(orig);
      if (!acs.length) continue;
      push({ level: level(soft), rule: "expectation-changed", file: ch.path, what: `"${t.title}" (${acs.join(", ")}): added \`${squash(a.text)}\`, which can stop its checks from running.${softNote(soft)}`, advice: soft ? undefined : `Blocked: ${UNIT}.` });
    }
  }
  return out;
}

export function checkExpectationLock(o: LockInput): Finding[] {
  return checkExpectationLockDetailed(o).map(({ level, rule, file, message }) => ({ level, rule, file, message }));
}

/** People's changes to locked expectations: accepted (that's the review), but listed so they stay visible. */
export function overrideFindings(found: LockFinding[], who: string): Finding[] {
  return found.flatMap((f) => {
    if (f.always) return [{ level: f.level, rule: f.rule, file: f.file, message: f.message }];
    if (f.level !== "violation") return [];
    return [{ level: "warning" as const, rule: "expectation-override" as const, file: f.file, message: `QA override by ${who}: ${f.what} Accepted. Reviewer: confirm it was agreed with the PO, record it as a clarification in expected/, and keep the test and expected/ saying the same thing.` }];
  });
}
