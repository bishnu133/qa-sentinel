import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import YAML from "yaml";
import { z } from "zod";

/**
 * Expected behaviour: what each acceptance criterion means in testable terms, written from the requirements alone
 * (never from the code) and reviewed by QA in the story's test merge request. Tests assert these values; the code
 * is checked against them, never the other way round.
 *
 * One file per story, `expected/<STORY>.md`: a YAML block at the top holds the data (QA edits it there), and a
 * readable view generated from it follows. A file on the test repository's main branch counts as approved: it got
 * there through a reviewed merge request.
 *
 * Behaviour ids (B1, B2, …) are stable within the story and never reused, so tests and reports can point at
 * `SHOP-101/B3` while ACs are renumbered or reworded. Each AC entry keeps a hash of the AC's normalised text: when
 * the story changes, the hash no longer matches and only that AC's expectations may change (see lock.ts).
 */

const Scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const Value = z.union([Scalar, z.array(Scalar)]);

export const BehaviourSource = z.union([
  /** Derived from the AC text. */
  z.literal("ac"),
  /** Agreed outside Jira (a call, a chat): wins until the AC itself changes; the Jira report asks to update the story. */
  z.object({ clarification: z.object({ by: z.string().min(1), date: z.string().min(1), link: z.string().optional() }).strict() }).strict(),
]);

export const BehaviourState = z.enum([
  /** Concrete and usable: tests assert it. */
  "ready",
  /** The AC changed since this was written, or the AC was removed: check it before relying on it. */
  "needs-review",
  /** The AC doesn't say (\"orders are capped\" without a number): no value is invented; `question` asks the PO. */
  "unspecified",
]);

export const BehaviourSchema = z
  .object({
    id: z.string().regex(/^B\d+$/, "behaviour ids look like B1, B2, …"),
    kind: z.enum(["main", "edge", "boundary", "negative"]).default("main"),
    statement: z.string().min(1),
    /** Named values the tests assert, e.g. { maxOrdersPerSlot: 3, status: 409 }. */
    expect: z.record(z.string(), Value).default({}),
    state: BehaviourState.default("ready"),
    question: z.string().optional(),
    source: BehaviourSource.default("ac"),
    /** The words in the story (or team rules, or agreed API spec) this behaviour and its values come from. */
    basis: z.string().optional(),
    note: z.string().optional(),
  })
  .strict()
  .superRefine((b, ctx) => {
    if (b.state === "unspecified" && !b.question) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "an unspecified behaviour needs a question for the PO", path: ["question"] });
    if (b.state === "ready") {
      const empty = Object.entries(b.expect).filter(([, v]) => v === null).map(([k]) => k);
      if (empty.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `still has no value (${empty.join(", ")} is null): fill it in, or keep state: unspecified with a question`, path: ["expect"] });
    }
  });
export type Behaviour = z.infer<typeof BehaviourSchema>;

export const AcEntrySchema = z
  .object({
    id: z.string().min(1),
    /** Hash of the AC's normalised text when these expectations were written (acHash). */
    hash: z.string().regex(/^[0-9a-f]{12}$/, "hash: 12 hex characters (qa-sentinel writes it)"),
    text: z.string(),
    /** Services this AC needs (data for cross-service readiness; may be empty). */
    services: z.array(z.string()).default([]),
    /** The AC is no longer in the story: kept so nothing disappears silently. */
    removed: z.boolean().optional(),
    /** Why the AC has no automated behaviours (untestable as written, manual only, …). */
    untestable: z.string().optional(),
    behaviours: z.array(BehaviourSchema).default([]),
  })
  .strict();
export type AcEntry = z.infer<typeof AcEntrySchema>;

export const ExpectedFileSchema = z
  .object({
    version: z.literal(1),
    story: z.string().min(1),
    title: z.string().optional(),
    acs: z.array(AcEntrySchema),
  })
  .strict()
  .superRefine((f, ctx) => {
    const seen = new Map<string, string>();
    const acIds = new Set<string>();
    for (const ac of f.acs) {
      if (acIds.has(ac.id) && !ac.removed) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${ac.id} is listed twice` });
      if (!ac.removed) acIds.add(ac.id);
      for (const b of ac.behaviours) {
        const prev = seen.get(b.id);
        if (prev) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `behaviour id ${b.id} is used in ${prev} and ${ac.id}: ids must be unique in the story` });
        seen.set(b.id, ac.id);
      }
    }
  });
export type ExpectedFile = z.infer<typeof ExpectedFileSchema>;

/**
 * AC text as compared for "did the AC change?": formatting, numbering, case, spacing and closing punctuation don't
 * count (Jira reformats rich text, people fix typography); words and numbers do.
 */
export function normaliseAcText(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/\{(?:color|noformat|code)(?::[^}]*)?\}/gi, " ") // Jira wiki markup
    .replace(/<\/?(?:p|br|div|span|strong|em|b|i|u|s|ul|ol|li|code|pre|a|h[1-6]|table|thead|tbody|tr|td|th|blockquote)(?:\s[^>]*)?\/?>/gi, " ") // HTML tags, not "<max and total>"
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/^\s*(?:[-*+#>]+\s+|\d+[.)]\s+(?!\d)|AC[- ]?\d+\s*[:.)-]\s*)/i, "") // "- ", "1. " or "AC-3:" in front; not "-1" or "5.5%"
    .replace(/(^|\s)[*_~`]+|[*_~`]+(?=\s|$|[.,;:!?])/g, "$1") // emphasis marks around words, not inside snake_case
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.;:,!]+$/, "")
    .toLowerCase();
}

export const acHash = (text: string): string => createHash("sha256").update(normaliseAcText(text)).digest("hex").slice(0, 12);

export const expectedPath = (dir: string, story: string): string => `${dir.replace(/\/+$/, "")}/${story}.md`;

const FRONT = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

export class ExpectedFileError extends Error {
  constructor(
    message: string,
    readonly issues: { where: string; message: string }[] = [],
  ) {
    super(message);
  }
}

/** Parse a file's data block. Throws ExpectedFileError with every problem, named by path. */
export function parseExpected(text: string, file = "expected file"): ExpectedFile {
  const m = text.match(FRONT);
  if (!m) throw new ExpectedFileError(`${file}: no data block (a YAML block between --- lines at the top)`);
  let data: unknown;
  try {
    data = YAML.parse(m[1]);
  } catch (e) {
    throw new ExpectedFileError(`${file}: the data block is not valid YAML: ${(e as Error).message.split("\n")[0]}`);
  }
  const r = ExpectedFileSchema.safeParse(data);
  if (!r.success) {
    const issues = r.error.issues.map((i) => issueText(i, data));
    throw new ExpectedFileError(`${file}: ${issues.map((x) => (x.where ? `${x.where}: ${x.message}` : x.message)).join("; ")}`, issues);
  }
  return r.data;
}

/** "AC-2 / B2 / state: …" instead of "acs.1.behaviours.0.state: …": what QA sees in the file. */
function issueText(i: z.ZodIssue, data: unknown): { where: string; message: string } {
  const names: string[] = [];
  let node: any = data;
  for (let k = 0; k < i.path.length; k++) {
    const seg = i.path[k];
    node = node?.[seg as any];
    if (typeof seg === "number" && node && typeof node === "object" && typeof node.id === "string") names.push(node.id);
    else if (typeof seg === "string" && seg !== "acs" && seg !== "behaviours") names.push(seg);
  }
  let msg = i.message;
  if (i.code === "unrecognized_keys") msg = `${i.keys.map((k) => `"${k}"`).join(", ")} ${i.keys.length > 1 ? "are not fields" : "is not a field"} here: check the indentation (values a test asserts go under expect:)`;
  if (i.code === "invalid_enum_value") msg = `${JSON.stringify(i.received)} isn't allowed; use ${i.options.join(", ")} (lower case)`;
  return { where: names.join(" / "), message: msg };
}

const fmt = (v: z.infer<typeof Value>): string => (Array.isArray(v) ? v.map((x) => fmt(x)).join(", ") : v === null ? "? (ask PO)" : String(v));
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
const sourceText = (s: z.infer<typeof BehaviourSource>) => (s === "ac" ? "AC" : `clarified: ${s.clarification.by}, ${s.clarification.date}${s.clarification.link ? `, ${s.clarification.link}` : ""}`);

const VIEW_MARK = "<!-- GENERATED from the data block above by qa-sentinel. Edits below this line are ignored by tests and overwritten. -->";

/** The data block's own instructions, at its top, so whoever opens the file sees them first. */
const DATA_HELP = [
  "# Expected behaviour for {story}: the data qa-sentinel's tests assert. QA edits it here, in this block.",
  "# Edit: statement, expect (the values), state, question, source, services, untestable. basis = the story's words it comes from.",
  "# Don't edit: id, hash and text (qa-sentinel copies hash and text from the story; to change an AC, change the story in Jira).",
  "# state: ready = tests assert it · needs-review = the AC changed in the story, check it, then set ready · unspecified = the story doesn't say, ask the PO (question), not tested until answered.",
  "# PO answered outside Jira? Fill in expect, set state: ready, delete question, and add",
  "#   source: { clarification: { by: <name>, date: <yyyy-mm-dd>, link: <chat or mail> } }",
];

/** The whole file: data block plus a readable view generated from it. Same input, same bytes. */
export function renderExpected(f: ExpectedFile): string {
  const data = YAML.stringify(f, { lineWidth: 0 }).trimEnd();
  return `${["---", ...DATA_HELP.map((l) => l.replace("{story}", f.story)), data, "---", "", renderView(f)].join("\n")}\n`;
}

function renderView(f: ExpectedFile): string {
  const lines = [
    VIEW_MARK,
    "",
    `# Expected behaviour: ${f.story}${f.title ? ` ${f.title}` : ""}`,
    "",
    "What each acceptance criterion means in testable terms, written from the story alone. Tests assert these values; when the product does something else, it is reported as a defect, never changed here.",
    "",
    "Merging the test merge request approves every **ready** row. Rows that are **unspecified** or **needs-review** are not tested until someone resolves them in the data block above.",
  ];
  for (const ac of f.acs) {
    lines.push("", `## ${ac.id}${ac.removed ? " (no longer in the story)" : ""}`, "", `> ${cell(ac.text)}`, "", `Services: ${ac.services.length ? ac.services.join(", ") : "–"}`);
    if (ac.untestable) lines.push("", `Not tested automatically: ${ac.untestable}`);
    if (!ac.behaviours.length) continue;
    lines.push("", "| Id | Kind | Expected behaviour | Values | State | Source |", "| --- | --- | --- | --- | --- | --- |");
    for (const b of ac.behaviours) {
      const values = Object.entries(b.expect).map(([k, v]) => `${k} = ${fmt(v)}`).join("; ") || "–";
      const state = b.state === "unspecified" ? `unspecified: ${b.question}` : b.state;
      lines.push(`| ${b.id} | ${b.kind} | ${cell(b.statement)}${b.note ? ` _(${cell(b.note)})_` : ""} | ${cell(values)} | ${cell(state)} | ${cell(sourceText(b.source))} |`);
    }
  }
  return lines.join("\n");
}

/** True when the readable view was edited by hand (it no longer matches the data): those edits do nothing. */
export function viewEditedByHand(text: string): boolean {
  const m = text.match(FRONT);
  if (!m) return false;
  let f: ExpectedFile;
  try {
    f = parseExpected(text);
  } catch {
    return false;
  }
  const norm = (s: string) => s.replace(/\r\n/g, "\n").trim();
  return norm(text.slice(m[0].length)) !== norm(renderView(f));
}

export function readExpected(repo: string, dir: string, story: string): ExpectedFile | undefined {
  const rel = expectedPath(dir, story);
  const abs = path.join(repo, rel);
  if (!fs.existsSync(abs)) return undefined;
  return parseExpected(fs.readFileSync(abs, "utf8"), rel);
}

export function writeExpected(repo: string, dir: string, f: ExpectedFile): string {
  const rel = expectedPath(dir, f.story);
  const abs = path.join(repo, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, renderExpected(ExpectedFileSchema.parse(f)));
  return rel;
}

/** An AC as the story has it now: its text, or only its hash (recorded in a qa-sentinel commit). */
export interface CurrentAc {
  id: string;
  text?: string;
  hash?: string;
}

export const currentHash = (ac: CurrentAc): string => ac.hash ?? acHash(ac.text ?? "");

export type AcFreshness = "current" | "changed" | "new" | "removed";

/**
 * Per AC id: is the stored expectation written for the story's current text?
 * - current: the stored text is still in the story (possibly under another number);
 * - changed: the stored text is gone from the story and the same id now has other text;
 * - removed: the stored text is gone and the id isn't in the story any more;
 * - new: the story has an AC with no stored expectation.
 * Changed/removed are keyed by the STORED id: that is what tests tagged before the change point at.
 */
export function freshness(f: ExpectedFile | undefined, current: CurrentAc[]): Map<string, AcFreshness> {
  const out = new Map<string, AcFreshness>();
  const live = (f?.acs ?? []).filter((a) => !a.removed);
  const hashes = new Set(current.map(currentHash));
  const storedHashes = new Set(live.map((a) => a.hash));
  for (const a of live) if (!hashes.has(a.hash)) out.set(a.id, current.some((c) => c.id === a.id) ? "changed" : "removed");
  for (const ac of current) if (!out.has(ac.id)) out.set(ac.id, storedHashes.has(currentHash(ac)) ? "current" : "new");
  return out;
}

const num = (id: string) => Number(id.slice(1));
/** QA's own note stays; qa-sentinel's remark is added after it (once). */
const addNote = (note: string | undefined, add: string) => (!note ? add : note.includes(add) ? note : `${note}; ${add}`);

/**
 * Bring a stored file up to date with the story, using a fresh proposal from the requirements pass.
 *
 * - AC unchanged (same normalised text): the stored entry stays exactly as it is, QA's edits included; the
 *   proposal is ignored. A rerun on an unchanged story is a zero diff.
 * - AC renumbered (same text, other id): the entry moves to the new id; behaviour ids stay.
 * - AC edited: the proposal's version replaces behaviours it names by id; stored behaviours the proposal drops are
 *   kept as needs-review (nothing disappears silently); new ones get fresh ids. Clarifications lose their win:
 *   the AC changed after them, so they need review too unless the proposal restates them.
 * - New AC: the proposal's entry, with ids made unique.
 * - AC gone from the story: kept, marked removed.
 * - ACs in the proposal that aren't in the story are dropped (the pass may not invent requirements).
 */
export function mergeExpected(stored: ExpectedFile | undefined, proposal: ExpectedFile, current: CurrentAc[]): { file: ExpectedFile; changes: string[] } {
  const changes: string[] = [];
  const keep = stored?.acs ?? [];
  let next = Math.max(0, ...keep.flatMap((a) => a.behaviours.map((b) => num(b.id))));
  const used = new Set(keep.flatMap((a) => a.behaviours.map((b) => b.id)));
  const fresh = () => {
    next += 1;
    used.add(`B${next}`);
    return `B${next}`;
  };
  const matched = new Set<AcEntry>();
  const acs: AcEntry[] = [];
  // Same text first, for every AC, so a renumbered AC is never mistaken for an edited one; then same id.
  const live = keep.filter((a) => !a.removed);
  const byText = new Map<string, AcEntry>();
  for (const ac of current) {
    const h = acHash(ac.text ?? "");
    // A removed entry whose text comes back is revived (QA's behaviours with it).
    const same = live.find((a) => !matched.has(a) && a.hash === h && a.id === ac.id) ?? live.find((a) => !matched.has(a) && a.hash === h) ?? keep.find((a) => !matched.has(a) && a.removed && a.hash === h);
    if (same) {
      matched.add(same);
      byText.set(ac.id, same);
    }
  }
  const byId = new Map<string, AcEntry>();
  for (const ac of current) {
    if (byText.has(ac.id)) continue;
    const edited = live.find((a) => !matched.has(a) && a.id === ac.id);
    if (edited) {
      matched.add(edited);
      byId.set(ac.id, edited);
    }
  }

  for (const ac of current) {
    const text = ac.text ?? "";
    const h = acHash(text);
    // A proposal counts only for the AC text it was written from (a stale proposal for an old text is ignored).
    const prop = proposal.acs.find((p) => p.id === ac.id && acHash(p.text) === h);
    const same = byText.get(ac.id);
    if (same) {
      const revived = same.removed ? { ...same, removed: undefined, behaviours: same.behaviours.map((b) => ({ ...b, note: addNote(b.note, "the AC is back in the story: check it") })) } : same;
      if (same.removed) changes.push(`${ac.id} is back in the story: its earlier expectations restored for review`);
      else if (same.id !== ac.id) changes.push(`${same.id} is now ${ac.id} (renumbered, same text)`);
      // Nothing stored yet for this AC (a placeholder): the proposal fills it.
      if (!revived.behaviours.length && !revived.untestable && prop && (prop.behaviours.length || prop.untestable)) {
        acs.push({ ...revived, id: ac.id, services: prop.services, ...(prop.untestable ? { untestable: prop.untestable } : {}), behaviours: prop.behaviours.map((b) => ({ ...b, id: used.has(b.id) ? fresh() : (used.add(b.id), b.id) })) });
        changes.push(`${ac.id}: expectations added`);
        continue;
      }
      acs.push(revived.id === ac.id && revived === same ? same : { ...revived, id: ac.id });
      continue;
    }
    const edited = byId.get(ac.id);
    if (edited) {
      const proposed = new Map((prop?.behaviours ?? []).map((b) => [b.id, b]));
      const behaviours: Behaviour[] = edited.behaviours.map((b) => {
        const p = proposed.get(b.id);
        if (p) {
          proposed.delete(b.id);
          return { ...p, note: addNote(b.note, p.note ?? "revised after the AC changed") };
        }
        return { ...b, state: b.state === "unspecified" ? "unspecified" : "needs-review", note: addNote(b.note, "the AC changed after this was written: check it still applies") };
      });
      for (const p of proposed.values()) behaviours.push({ ...p, id: used.has(p.id) ? fresh() : (used.add(p.id), p.id) });
      acs.push({ ...edited, hash: h, text, services: prop?.services.length ? prop.services : edited.services, ...(prop?.untestable ? { untestable: prop.untestable } : {}), behaviours });
      changes.push(`${ac.id} changed in the story: expectations revised for review`);
      continue;
    }
    if (prop) {
      acs.push({ ...prop, hash: h, text, removed: undefined, behaviours: prop.behaviours.map((b) => ({ ...b, id: used.has(b.id) ? fresh() : (used.add(b.id), b.id) })) });
      changes.push(`${ac.id}: expectations added`);
    } else {
      acs.push({ id: ac.id, hash: h, text, services: [], behaviours: [] });
      changes.push(`${ac.id}: no expectations proposed yet`);
    }
  }
  for (const a of keep) {
    if (matched.has(a)) continue;
    if (!a.removed) changes.push(`${a.id} is no longer in the story: kept, marked removed`);
    acs.push(a.removed ? a : { ...a, removed: true, behaviours: a.behaviours.map((b) => ({ ...b, state: "needs-review" as const, note: addNote(b.note, "the AC was removed from the story") })) });
  }
  for (const p of proposal.acs) if (!current.some((c) => c.id === p.id)) changes.push(`${p.id} was proposed but isn't in the story: ignored`);
  const file = ExpectedFileSchema.parse({ version: 1, story: stored?.story ?? proposal.story, title: stored?.title ?? proposal.title, acs });
  return { file, changes };
}
