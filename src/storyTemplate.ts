/**
 * How a team writes its stories, as configuration (requirements.template): which headings hold the acceptance
 * criteria, what is in scope, what is explicitly out of scope, implementation notes, context for the agents, the
 * showcase approach, and what to ignore (checklists). Nothing about any one team's template is hard-coded: the
 * defaults cover common heading names, and `qa-sentinel story-check` shows how a real story is read.
 *
 * Input is the markdown-ish text qa-sentinel builds from Jira (wiki markup or ADF) or a story file: headings
 * (#, h2., *bold*, "Heading:"), bullets at any depth (-, *, •, ->, →, 1.), and tables (| a | b |, ||h||h||).
 */

export const SECTION_ROLES = ["acceptance-criteria", "scope", "out-of-scope", "context", "showcase", "ignore"] as const;
export type SectionRole = (typeof SECTION_ROLES)[number];

export interface TemplateSection {
  role: SectionRole;
  /** Shown in reports, e.g. "Tech notes". */
  name: string;
  /** Heading texts that start this section; matched ignoring case, punctuation and markup ("In-scope" = "in scope"). */
  headings: string[];
  /** Scope sections: item id prefix, e.g. IS → IS-1, IS-2. */
  prefix?: string;
}

export const DEFAULT_TEMPLATE: TemplateSection[] = [
  { role: "acceptance-criteria", name: "Acceptance criteria", headings: ["acceptance criteria", "acceptance criterion", "acs", "ac"] },
  { role: "scope", name: "In scope", prefix: "IS", headings: ["in scope", "scope", "functional scope", "scope of work"] },
  {
    role: "scope",
    name: "Tech scope",
    prefix: "TS",
    headings: ["tech scope", "technical scope", "tech notes", "technical notes", "implementation", "implementation notes", "technical details", "tech details", "dev notes"],
  },
  { role: "scope", name: "Expected result", prefix: "ER", headings: ["expected result", "expected results", "expected behaviour", "expected behavior", "expected outcome"] },
  { role: "out-of-scope", name: "Out of scope", headings: ["out of scope", "not in scope", "out scope", "exclusions", "non goals", "not included"] },
  {
    role: "context",
    name: "Context",
    headings: [
      "assumptions",
      "questions",
      "open questions",
      "business information",
      "business context",
      "background",
      "client requirement",
      "user story",
      "dependencies",
      "risks",
      "feature toggle",
      "feature toggles",
      "feature toggle environment variables",
      "environment variables",
      "nfr",
      "non functional requirements",
      "ui reference",
      "ui reference figma screenshots",
      "design",
    ],
  },
  { role: "showcase", name: "Showcase approach", headings: ["showcase approach", "showcase", "demo approach", "demo"] },
  { role: "ignore", name: "Checklist", headings: ["checklist", "ready for development", "definition of ready", "dor", "definition of done", "dod"] },
];

export interface ParsedStory {
  acceptanceCriteria: { id: string; text: string }[];
  acFormat: "table" | "list" | "gherkin" | "none";
  scopeItems: { id: string; text: string; source: string; service?: string }[];
  outOfScope: string[];
  context: { name: string; text: string }[];
  showcase?: string;
  /** Configured services whose name appears in the story (e.g. in tech notes). */
  servicesNamed: string[];
  /** Every heading seen, with the role it got ("unknown" when no template section matched). */
  headings: { text: string; role: SectionRole | "unknown"; section?: string }[];
}

/** "In-scope:" / "*UI Reference (Figma / Screenshots)*" → "in scope" / "ui reference figma screenshots". */
export const normHeading = (s: string) =>
  s
    .toLowerCase()
    .replace(/[*_`#:]/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

interface Heading {
  text: string;
  level: number; // 1-6, or 7 for "bold line" / "Label:" style (level unknown)
}

const MD_HEADING = /^(#{1,6})\s+(.*)$/;
const WIKI_HEADING = /^h([1-6])\.\s+(.*)$/;
const BOLD_LINE = /^\*{1,2}([^*]{2,80})\*{1,2}:?$/;
const LABEL_LINE = /^([A-Za-z][\w ()/&'-]{2,60}):$/;

function headingOf(line: string, known: Set<string>): Heading | undefined {
  const t = line.trim();
  let m = t.match(MD_HEADING) ?? t.match(WIKI_HEADING);
  if (m) return { text: m[2].trim(), level: m[1].startsWith("#") ? m[1].length : Number(m[1]) };
  m = t.match(BOLD_LINE) ?? t.match(LABEL_LINE);
  if (m) return { text: m[1].trim(), level: 7 };
  // A plain short line that is exactly a configured heading (templates pasted as plain text).
  if (t.length <= 60 && !/^[-*+•|>→]/.test(t) && known.has(normHeading(t))) return { text: t, level: 7 };
  return undefined;
}

function matchSection(text: string, template: TemplateSection[]): TemplateSection | undefined {
  const h = normHeading(text);
  if (!h) return undefined;
  let best: { s: TemplateSection; len: number } | undefined;
  for (const s of template)
    for (const raw of s.headings) {
      const x = normHeading(raw);
      if (!x) continue;
      // Exact, or the heading starts with it as whole words ("feature toggle environment variables" ⊇ "feature toggle").
      if (h === x || h.startsWith(`${x} `)) if (!best || x.length > best.len) best = { s, len: x.length };
    }
  return best?.s;
}

// ------------------------------------------------------------------------------------------------
// Blocks: list items (with nesting), tables, plain lines.

const BULLET = /^(\s*)(?:[-*+•]|->|=>|→|➔|\d+[.)]|[a-z][.)]|#)\s+(.*)$/;

interface Item {
  text: string;
  group?: string;
}

/** List items of a block, nested items folded into their parent; short label lines before a list become its group. */
export function listItems(lines: string[]): Item[] {
  const out: (Item & { indent: number })[] = [];
  let group: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].replace(/\t/g, "  ");
    if (!raw.trim() || /^\s*\|/.test(raw)) continue;
    const m = raw.match(BULLET);
    if (m) {
      const indent = m[1].length;
      const text = clean(m[2]);
      if (!text) continue;
      // Deeper than the last top-level item: a sub-point of it.
      const last = out[out.length - 1];
      if (last && indent > last.indent) last.text += `${/:$/.test(last.text) ? " " : last.text.includes(": ") ? "; " : ": "}${text}`;
      else out.push({ text, group, indent });
      continue;
    }
    const t = clean(raw);
    // A short label followed by a list is a group (a service name, a sub-topic) …
    const next = lines.slice(i + 1).find((l) => l.trim());
    if (t.length <= 60 && next && BULLET.test(next.replace(/\t/g, "  ")) && !/[.!?]$/.test(t)) {
      group = t.replace(/:$/, "");
      continue;
    }
    // … an indented line continues the previous item, anything else is a loose paragraph item.
    if (out.length && /^\s{2,}/.test(raw)) out[out.length - 1].text += ` ${t}`;
    else {
      // A free-standing paragraph ends the current group (e.g. a "Note: …" after a service's list).
      group = undefined;
      out.push({ text: t, indent: 0 });
    }
  }
  return out.map(({ text, group }) => ({ text, group }));
}

const clean = (s: string) =>
  s
    .replace(/\\\\/g, " ")
    .replace(/\{\{([^}]*)\}\}/g, "$1") // wiki monospace
    .replace(/(^|\s)[*_]{1,2}([^*_]+)[*_]{1,2}(?=\s|$|[.,;:])/g, "$1$2") // bold / italic
    .replace(/\s+/g, " ")
    .trim();

/** Tables in a block: wiki (||h||h|| / |c|c|, cells may span lines) and markdown (| h | h | + |---|). */
export function tables(lines: string[]): { header: string[]; rows: string[][] }[] {
  const out: { header: string[]; rows: string[][] }[] = [];
  let rows: { cells: string[]; header: boolean }[] = [];
  let buf = "";
  const flushRow = () => {
    if (!buf) return;
    const header = buf.trimStart().startsWith("||");
    const cells = buf
      .trim()
      .replace(/^\|\|?/, "")
      .replace(/\|\|?\s*$/, "")
      .split(/\|\|?/)
      .map(clean);
    if (!cells.every((c) => /^:?-{3,}:?$/.test(c))) rows.push({ cells, header });
    else if (rows.length) rows[rows.length - 1].header = true; // markdown separator: the row above is the header
    buf = "";
  };
  const flushTable = () => {
    flushRow();
    if (rows.length) {
      const first = rows[0];
      const header = first.header || looksLikeHeader(first.cells) ? first.cells : [];
      out.push({ header, rows: (header.length ? rows.slice(1) : rows).map((r) => r.cells) });
    }
    rows = [];
  };
  for (const raw of lines) {
    const t = raw.trim();
    if (t.startsWith("|")) {
      flushRow();
      buf = t;
      if (/\|\s*$/.test(t) && t.length > 1) flushRow();
    } else if (buf) buf += ` ${t}`; // a wiki cell continued on the next line
    else if (rows.length && !t) continue;
    else if (rows.length) flushTable();
  }
  flushTable();
  return out;
}

const looksLikeHeader = (cells: string[]) => cells.some((c) => /^(given|when|then|scenario|#|no\.?|id|ac)$/i.test(c.trim()));

// ------------------------------------------------------------------------------------------------
// Acceptance criteria in any of the usual shapes.

/** A Given/When/Then table (any column order, optional number/scenario column), one AC per row. */
function acsFromTable(t: { header: string[]; rows: string[][] }): { id?: number; text: string }[] | undefined {
  const col = (re: RegExp) => t.header.findIndex((h) => re.test(h.trim()));
  const g = col(/^given$/i);
  const w = col(/^when$/i);
  const th = col(/^then$/i);
  let num = col(/^(#|no\.?|id|ac|ac\s*#|s\/?n)$/i);
  // An unlabelled first column holding 1, 2, 3 … is the AC number too.
  if (num < 0 && t.header.length && !t.header[0].trim() && t.rows.length && t.rows.every((r) => /^\d+$/.test((r[0] ?? "").trim()))) num = 0;
  const scen = col(/^scenario( name)?$/i);
  if (th < 0 && g < 0) {
    // No Given/When/Then columns: one AC per row from its non-number cells.
    if (!t.rows.length) return undefined;
    return t.rows.map((r) => ({ id: idOf(r[num >= 0 ? num : 0]), text: r.filter((_c, i) => i !== num || num < 0).filter((c) => c && !/^\d+$/.test(c)).join(" — ") })).filter((x) => x.text);
  }
  const blank = (s?: string) => !s || /^[-—–]+$/.test(s.trim());
  // Rows with only a leading number and nothing else are layout noise.
  const firstNumeric = num < 0 && t.rows.every((r) => /^\d*$/.test((r[0] ?? "").trim())) ? 0 : num;
  return t.rows
    .map((r) => {
      const parts = [
        scen >= 0 && !blank(r[scen]) ? `${r[scen]}:` : "",
        !blank(r[g]) ? `Given ${r[g]}` : "",
        !blank(r[w]) ? `when ${r[w]}` : "",
        !blank(r[th]) ? `then ${r[th]}` : "",
      ].filter(Boolean);
      return { id: firstNumeric >= 0 ? idOf(r[firstNumeric]) : undefined, text: parts.join(", ").replace(/\s+/g, " ").trim() };
    })
    .filter((x) => x.text);
}

const idOf = (cell?: string) => {
  const m = (cell ?? "").match(/(\d+)/);
  return m ? Number(m[1]) : undefined;
};

/** Gherkin text: one AC per Scenario, else per Given…Then run. */
function acsFromGherkin(text: string): string[] {
  const scenarios = text.split(/\n(?=\s*Scenario(?: Outline)?\s*:)/i).filter((b) => /^\s*Scenario/i.test(b) && /\bThen\b/i.test(b));
  if (scenarios.length) return scenarios.map((s) => s.trim().replace(/\s+/g, " "));
  return (text.match(/(?:^|\n)\s*Given\b[\s\S]*?\bThen\b[^\n]*(?:\n\s*(?:And|But)\b[^\n]*)*/gi) ?? []).map((g) => g.trim().replace(/\s+/g, " "));
}

function acsFromBlock(lines: string[]): { items: { id?: number; text: string }[]; format: ParsedStory["acFormat"] } {
  for (const t of tables(lines)) {
    const rows = acsFromTable(t);
    if (rows?.length) return { items: rows, format: "table" };
  }
  const nonTable = lines.filter((l) => !/^\s*\|/.test(l));
  const gherkin = acsFromGherkin(nonTable.join("\n"));
  const list = listItems(nonTable);
  // Prefer Gherkin when the list would split one scenario into Given/When/Then pieces.
  if (gherkin.length && (!list.length || list.some((x) => /^(given|when|then|and)\b/i.test(x.text)))) return { items: gherkin.map((text) => ({ text })), format: "gherkin" };
  if (list.length) {
    return {
      items: list.map((x) => {
        const m = x.text.match(/^AC\s*-?\s*(\d+)\s*[:.)-]\s*(.*)$/i);
        return m ? { id: Number(m[1]), text: m[2] } : { text: x.text };
      }),
      format: "list",
    };
  }
  return { items: [], format: "none" };
}

/** AC ids: the story's own numbers when every AC has a distinct one, else AC-1, AC-2, … in order. */
function numberAcs(items: { id?: number; text: string }[]): { id: string; text: string }[] {
  const ids = items.map((x) => x.id);
  const own = ids.every((n) => n !== undefined) && new Set(ids).size === ids.length;
  return items.map((x, i) => ({ id: `AC-${own ? x.id : i + 1}`, text: x.text }));
}

// ------------------------------------------------------------------------------------------------

export function parseStory(text: string, template: TemplateSection[] = DEFAULT_TEMPLATE, o: { serviceNames?: string[] } = {}): ParsedStory {
  const lines = text.split(/\r?\n/);
  const known = new Set(template.flatMap((s) => s.headings.map(normHeading)));
  // 1. Sections: a matched heading opens one; a deeper unmatched heading stays inside it as a group label.
  type Sec = { heading: Heading; tpl?: TemplateSection; lines: string[] };
  const secs: Sec[] = [];
  const headings: ParsedStory["headings"] = [];
  let cur: Sec | undefined;
  for (const line of lines) {
    const h = headingOf(line, known);
    if (h) {
      const tpl = matchSection(h.text, template);
      headings.push({ text: h.text, role: tpl?.role ?? "unknown", section: tpl?.name });
      const nested = !tpl && cur?.tpl && (h.level > cur.heading.level || h.level === 7);
      if (nested) {
        cur!.lines.push(`${h.text.replace(/:$/, "")}:`); // keep it as a group label inside the section
        continue;
      }
      cur = { heading: h, tpl, lines: [] };
      secs.push(cur);
      continue;
    }
    if (cur) cur.lines.push(line);
  }

  // 2. Acceptance criteria: from the AC section(s); without one, from a line naming them, then Gherkin anywhere.
  let ac: { items: { id?: number; text: string }[]; format: ParsedStory["acFormat"] } = { items: [], format: "none" };
  const acSecs = secs.filter((s) => s.tpl?.role === "acceptance-criteria");
  for (const s of acSecs) {
    const r = acsFromBlock(s.lines);
    if (r.items.length) {
      ac = { items: [...ac.items, ...r.items], format: ac.format === "none" ? r.format : ac.format };
    }
  }
  if (!ac.items.length) {
    const i = lines.findIndex((l) => /acceptance criteria/i.test(l));
    if (i >= 0) {
      const block: string[] = [];
      for (const l of lines.slice(i + 1)) {
        if (headingOf(l, known) && block.some((b) => b.trim())) break;
        block.push(l);
      }
      ac = acsFromBlock(block);
    }
  }
  if (!ac.items.length) {
    const g = acsFromGherkin(text);
    if (g.length) ac = { items: g.map((t) => ({ text: t })), format: "gherkin" };
  }

  // 3. Scope items, exclusions, context, showcase.
  const scopeItems: ParsedStory["scopeItems"] = [];
  const counters = new Map<string, number>();
  const services = (o.serviceNames ?? []).filter(Boolean);
  const serviceIn = (s?: string) => (s ? services.find((n) => new RegExp(`(^|[^\\w-])${escapeRe(n)}($|[^\\w-])`, "i").test(s)) : undefined);
  const outOfScope: string[] = [];
  const context: ParsedStory["context"] = [];
  let showcase: string | undefined;
  for (const s of secs) {
    if (!s.tpl) continue;
    const body = s.lines.join("\n").trim();
    // "N/A — backend-only story", "None", "TBD", "-": nothing to use.
    if (!body || /^[-—–\s]+$/.test(body) || /^(n\/a|na|none|tbd|nil)(?=$|[\s.—–:-])/i.test(body)) continue;
    switch (s.tpl.role) {
      case "scope": {
        const items: Item[] = [...listItems(s.lines), ...tables(s.lines).flatMap((t) => t.rows.map((r) => ({ text: r.filter(Boolean).join(" | ") })))];
        for (const it of items) {
          if (/^(n\/?a|none|tbd)\b/i.test(it.text)) continue;
          const prefix = s.tpl.prefix ?? "SC";
          const n = (counters.get(prefix) ?? 0) + 1;
          counters.set(prefix, n);
          const service = serviceIn(it.group) ?? serviceIn(it.text);
          scopeItems.push({ id: `${prefix}-${n}`, text: it.group && !it.text.toLowerCase().startsWith(it.group.toLowerCase()) ? `[${it.group}] ${it.text}` : it.text, source: s.tpl.name, ...(service ? { service } : {}) });
        }
        break;
      }
      case "out-of-scope":
        outOfScope.push(...listItems(s.lines).map((x) => (x.group ? `[${x.group}] ${x.text}` : x.text)));
        break;
      case "context":
        context.push({ name: s.heading.text.replace(/:$/, ""), text: body });
        break;
      case "showcase":
        showcase = [showcase, body].filter(Boolean).join("\n\n");
        break;
      default:
        break;
    }
  }
  const servicesNamed = services.filter((n) => new RegExp(`(^|[^\\w-])${escapeRe(n)}($|[^\\w-])`, "i").test(text));
  return { acceptanceCriteria: numberAcs(ac.items), acFormat: ac.items.length ? ac.format : "none", scopeItems, outOfScope, context, showcase, servicesNamed, headings };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
