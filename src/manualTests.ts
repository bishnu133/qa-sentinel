import fs from "node:fs";
import path from "node:path";
import type { ManualTest } from "./plan/schema.js";

/**
 * Manual test cards: what a person checks for requirements that can't (or shouldn't) be automated. They live next to
 * the automated tests, one file per story (`manual-tests/SHOP-101.md`), reviewed in the same MR, and they count for
 * traceability: an AC proven by a manual card is "checked by hand", not "missing".
 *
 * Each card carries a marker qa-sentinel reads back: `<!-- qa-sentinel: @story:SHOP-101 @ac:AC-3 -->`.
 */
export interface ManualCard {
  story?: string;
  acs: string[];
  title: string;
  file: string;
  line: number;
  /** From the card's Result line, once a tester ticked it: pass or fail. Unset = not run yet. */
  result?: "pass" | "fail";
}

/** "☒ pass", "[x] pass", "✅ pass", "pass ✔" … ticked boxes in the Result line. */
const TICK = /(?:☒|☑|✅|✔|\[x\])\s*(pass|fail)|(pass|fail)\s*(?:☒|☑|✅|✔|\[x\])/i;

const MARKER = /<!--\s*qa-sentinel:\s*([^>]*?)\s*-->/;

export function cardMarkdown(story: string | undefined, m: ManualTest): string {
  const list = (xs: string[], ordered = false) => xs.map((x, i) => `${ordered ? `${i + 1}.` : "-"} ${x}`).join("\n");
  return [
    `## ${m.requirementIds.join(", ")}: ${m.title}`,
    `<!-- qa-sentinel: ${story ? `@story:${story} ` : ""}@ac:${m.requirementIds.join(",")} -->`,
    "",
    `**Why by hand:** ${m.why}`,
    ...(m.preconditions.length ? ["", "**Before you start:**", list(m.preconditions)] : []),
    "",
    "**Steps:**",
    list(m.steps, true),
    "",
    "**Expected:**",
    list(m.expected),
    "",
    "**Result:** ☐ pass ☐ fail · tested by: ______ · date: ______ · environment: ______",
    "",
  ].join("\n");
}

/** Cards in a file. */
export function parseCards(file: string, text: string): ManualCard[] {
  const lines = text.split(/\r?\n/);
  const out: ManualCard[] = [];
  lines.forEach((l, i) => {
    const m = l.match(MARKER);
    if (!m) return;
    const tags = Object.fromEntries([...m[1].matchAll(/@([\w-]+):(\S+)/g)].map((x) => [x[1], x[2]]));
    const heading = [...lines.slice(0, i)].reverse().find((h) => /^#{1,4}\s/.test(h)) ?? "";
    const next = lines.slice(i + 1).findIndex((x) => MARKER.test(x) || /^#{1,2}\s/.test(x));
    const resultLine = lines.slice(i + 1, next < 0 ? undefined : i + 1 + next).find((x) => /\*\*Result:\*\*/i.test(x)) ?? "";
    const tick = resultLine.match(TICK);
    const result = tick ? ((tick[1] ?? tick[2]).toLowerCase() as "pass" | "fail") : undefined;
    out.push({
      ...(result ? { result } : {}),
      story: tags.story,
      acs: (tags.ac ?? "").split(",").filter(Boolean).map((a: string) => a.toUpperCase()),
      title: heading.replace(/^#+\s*/, "").replace(/^[A-Z]{1,4}-\d+(,\s*[A-Z]{1,4}-\d+)*:\s*/, ""),
      file,
      line: i + 1,
    });
  });
  return out;
}

/** Every card under the manual tests folder. */
export function readManualCards(repo: string, dir: string): ManualCard[] {
  const root = path.join(repo, dir);
  if (!fs.existsSync(root)) return [];
  const out: ManualCard[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.md$/i.test(e.name)) out.push(...parseCards(path.relative(repo, p).split(path.sep).join("/"), fs.readFileSync(p, "utf8")));
    }
  };
  walk(root);
  return out;
}

/**
 * Add new cards to the story's file. Existing cards are never rewritten (QA may have edited them): a card whose
 * requirement already has one is left out. Returns the file written (relative) and how many cards were added.
 */
export function writeCards(repo: string, dir: string, story: string | undefined, name: string, cards: ManualTest[]): { file?: string; added: number } {
  if (!cards.length) return { added: 0 };
  const rel = `${dir}/${name}.md`;
  const abs = path.join(repo, rel);
  const existing = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : "";
  const have = new Set(parseCards(rel, existing).flatMap((c) => c.acs));
  const fresh = cards.filter((c) => !c.requirementIds.every((r) => have.has(r.toUpperCase())));
  if (!fresh.length) return { added: 0 };
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const head = existing || `# Manual tests${story ? ` – ${story}` : ""}\n\nChecks a person runs: the requirements below can't be proven by an automated test (see why on each card). Fill in the result line when you run one.\n\n`;
  fs.writeFileSync(abs, head.replace(/\n*$/, "\n\n") + fresh.map((c) => cardMarkdown(story, c)).join("\n"));
  return { file: rel, added: fresh.length };
}
