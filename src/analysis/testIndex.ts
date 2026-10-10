import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

/**
 * Scenario-level traceability, derived from the tests themselves rather than maintained by hand.
 *
 * Every test declares what it proves with tags in its title:
 *   test("refund over the amount returns 422 @service:payments-service @endpoint:POST_/payments/{id}/refund @story:SHOP-102 @ac:AC-2", …)
 * qa-sentinel parses these (plus fixme/skip status and the number of assertions) into an index, checks the index
 * against test-map.yaml, and renders requirement → test matrices. Because the index is rebuilt from the code on
 * every run, it cannot drift from the tests the way a hand-written scenario list would.
 */

export type TestStatus = "active" | "fixme" | "skip";

export interface IndexedTest {
  id: string; // file:line
  file: string;
  line: number;
  /** Last line of the test's block (up to the next test). */
  endLine: number;
  title: string; // without tags
  describe?: string;
  status: TestStatus;
  services: string[];
  endpoints: string[]; // "POST /orders"
  stories: string[];
  acs: string[]; // "AC-2"
  tags: string[]; // other bare tags, e.g. "smoke"
  assertions: number;
  /** Every assertion only checks the HTTP status (a common sign of a weak test). */
  statusOnly: boolean;
}

const SPEC = /\.(spec|test)\.[cm]?[jt]sx?$/;
const DECL = /\b(test|it)(?:\.(only|skip|fixme|fail|slow))?\s*\(\s*(["'`])((?:\\.|(?!\3)[^\\])*)\3/;
const DESCRIBE = /\b(?:test\.)?describe(?:\.\w+)?\s*\(\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/;
const CONST = /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*(["'`])((?:\\.|(?!\2)[^\\$])*)\2\s*;?/g;
const ASSERT = /\b(expect|expectSchema|assert)\s*[.(]/g;

/** "POST_/orders" (tag form) → "POST /orders". */
export const endpointFromTag = (t: string) => t.replace(/^([A-Z]+)_/, "$1 ");
export const endpointTag = (e: string) => e.trim().replace(/^([A-Z]+)\s+/, "$1_");

export function parseTags(raw: string): Pick<IndexedTest, "services" | "endpoints" | "stories" | "acs" | "tags"> & { title: string } {
  const out = { services: [] as string[], endpoints: [] as string[], stories: [] as string[], acs: [] as string[], tags: [] as string[] };
  const title = raw.replace(/\s*@([\w-]+)(?::(\S+))?/g, (_m, k: string, v?: string) => {
    const vals = (v ?? "").split(",").filter(Boolean);
    if (k === "service") out.services.push(...vals);
    else if (k === "endpoint") out.endpoints.push(...vals.map(endpointFromTag));
    else if (k === "story") out.stories.push(...vals);
    else if (k === "ac") {
      // "@ac:none" says on purpose that no acceptance criterion covers this test (e.g. contract-only behaviour).
      if (vals.some((a) => /^(none|-)$/i.test(a))) out.tags.push("ac:none");
      out.acs.push(...vals.filter((a) => !/^(none|-)$/i.test(a)).map((a) => a.toUpperCase()));
    }
    else out.tags.push(v ? `${k}:${v}` : k);
    return "";
  }).trim();
  // "(AC-2)" in the title text counts too; authors often write it that way.
  for (const m of title.matchAll(/\bAC-\d+\b/gi)) out.acs.push(m[0].toUpperCase());
  out.acs = [...new Set(out.acs)];
  return { title, ...out };
}

/** Index one spec file. Exported for tests. */
/** Replace `${name}` with string constants declared in the same file (titles often interpolate a tags constant). */
export function constSubstituter(src: string): (s: string) => string {
  const consts = new Map<string, string>();
  for (const m of src.matchAll(CONST)) consts.set(m[1], m[3]);
  return (s: string) => s.replace(/\$\{\s*([A-Za-z_$][\w$]*)\s*\}/g, (m, n: string) => consts.get(n) ?? m);
}

export function indexSource(file: string, src: string): IndexedTest[] {
  const subst = constSubstituter(src);

  const lines = src.split(/\r?\n/);
  const describes: { indent: number; title: string }[] = [];
  const found: { line: number; kind?: string; raw: string; indent: number }[] = [];
  lines.forEach((l, i) => {
    const indent = l.length - l.trimStart().length;
    const d = l.match(DESCRIBE);
    if (d) {
      while (describes.length && describes[describes.length - 1].indent >= indent) describes.pop();
      describes.push({ indent, title: subst(d[2]) });
      return;
    }
    const t = l.match(DECL);
    if (t && !/\.(describe|step|use|beforeEach|afterEach|beforeAll|afterAll|extend|info)\b/.test(l.slice(t.index ?? 0, (t.index ?? 0) + 20))) {
      while (describes.length && describes[describes.length - 1].indent >= indent) describes.pop();
      found.push({ line: i + 1, kind: t[2], raw: subst(t[4]), indent });
      (found[found.length - 1] as any).describe = describes.map((x) => x.title).join(" › ") || undefined;
    }
  });
  return found.map((f, k) => {
    const end = k + 1 < found.length ? found[k + 1].line - 1 : lines.length;
    const body = lines.slice(f.line - 1, end).join("\n");
    const asserts = body.split("\n").filter((l) => ASSERT.test(l) && ((ASSERT.lastIndex = 0), true));
    const parsed = parseTags(f.raw);
    return {
      id: `${file}:${f.line}`,
      file,
      line: f.line,
      endLine: end,
      describe: (f as any).describe,
      status: f.kind === "fixme" || f.kind === "fail" ? "fixme" : f.kind === "skip" ? "skip" : "active",
      assertions: (body.match(ASSERT) ?? []).length,
      statusOnly: asserts.length > 0 && asserts.every((l) => /\.status\(\)\)?\s*\)?\s*\.(toBe|toEqual)\(\s*\d{3}\s*\)/.test(l) || /expect\([^)]*status\(\)\)/.test(l)),
      ...parsed,
    } satisfies IndexedTest;
  });
}

function walk(dir: string, root: string, out: string[]) {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, root, out);
    else if (SPEC.test(e.name)) out.push(path.relative(root, p).split(path.sep).join("/"));
  }
}

/** Build the index for every spec under `testDir` (relative to the test repo). */
export function buildTestIndex(repo: string, testDir: string): IndexedTest[] {
  const files: string[] = [];
  walk(path.join(repo, testDir), repo, files);
  return files.sort().flatMap((f) => indexSource(f, fs.readFileSync(path.join(repo, f), "utf8")));
}

// ---------------------------------------------------------------------------------------------
// Checks: the index against test-map.yaml, and new tests against the tagging convention.

export interface TraceFinding {
  level: "warning" | "info";
  file: string;
  message: string;
}

export function readTestMap(repo: string): { services: Record<string, { endpoints?: Record<string, string[]> }> } | undefined {
  const f = path.join(repo, "test-map.yaml");
  if (!fs.existsSync(f)) return undefined;
  return YAML.parse(fs.readFileSync(f, "utf8")) ?? undefined;
}

/** test-map.yaml says "endpoint → files"; the tags say which tests really exercise which endpoint. Compare. */
export function checkTestMap(index: IndexedTest[], map: ReturnType<typeof readTestMap>, repo?: string): TraceFinding[] {
  const out: TraceFinding[] = [];
  if (!map?.services) return out;
  const mapped = new Map<string, Set<string>>(); // endpoint -> files
  for (const [svc, s] of Object.entries(map.services)) {
    for (const [ep, files] of Object.entries(s?.endpoints ?? {})) {
      for (const f of files ?? []) {
        if (repo && !fs.existsSync(path.join(repo, f))) out.push({ level: "warning", file: "test-map.yaml", message: `${svc} · ${ep} → ${f}: file does not exist` });
        const set = mapped.get(ep) ?? new Set();
        set.add(f);
        mapped.set(ep, set);
        if (!index.some((t) => t.file === f && t.endpoints.includes(ep)) && index.some((t) => t.file === f))
          out.push({ level: "info", file: f, message: `mapped to ${ep} in test-map.yaml, but no test in it is tagged @endpoint:${endpointTag(ep)}` });
      }
    }
  }
  for (const t of index) {
    for (const ep of t.endpoints) {
      if (!mapped.get(ep)?.has(t.file)) out.push({ level: "warning", file: t.id, message: `tagged @endpoint:${endpointTag(ep)} but test-map.yaml does not list ${t.file} for ${ep}` });
    }
  }
  return dedupe(out);
}

/** New or changed tests must say what they prove. */
export function checkNewTests(index: IndexedTest[], changedFiles: string[], storyKey?: string, acIds: string[] = []): TraceFinding[] {
  const out: TraceFinding[] = [];
  const known = new Set(acIds.map((a) => a.toUpperCase()));
  for (const t of index.filter((x) => changedFiles.includes(x.file))) {
    if (!t.endpoints.length) out.push({ level: "warning", file: t.id, message: `"${t.title}" has no @endpoint tag` });
    if (storyKey && !t.stories.length && !t.acs.length) continue; // pre-existing style tests: not this change's concern
    for (const ac of t.acs) if (known.size && !known.has(ac)) out.push({ level: "warning", file: t.id, message: `"${t.title}" references ${ac}, which is not in ${storyKey ?? "the story"}` });
  }
  return dedupe(out);
}

const dedupe = (xs: TraceFinding[]) => [...new Map(xs.map((x) => [`${x.file}|${x.message}`, x])).values()];

// ---------------------------------------------------------------------------------------------
// Requirement → test matrix.

export interface AcTrace {
  ac: string;
  text?: string;
  active: IndexedTest[];
  pending: IndexedTest[]; // fixme / skip
  status: "covered" | "weak" | "discrepancy" | "pending-only" | "not-traced";
}

export function traceStory(
  index: IndexedTest[],
  storyKey: string | undefined,
  acs: { id: string; text?: string }[],
): { acs: AcTrace[]; storyOnly: IndexedTest[]; outsideAcs: IndexedTest[] } {
  const forStory = index.filter((t) => (storyKey ? t.stories.includes(storyKey) : false) || (!t.stories.length && t.acs.length && !storyKey));
  const rows = acs.map(({ id, text }) => {
    const hits = forStory.filter((t) => t.acs.includes(id.toUpperCase()));
    const active = hits.filter((t) => t.status === "active");
    const pending = hits.filter((t) => t.status !== "active");
    const status = active.length && pending.length ? "discrepancy" : active.length ? "covered" : pending.length ? "pending-only" : "not-traced";
    return { ac: id, text, active, pending, status } as AcTrace;
  });
  return { acs: rows, storyOnly: forStory.filter((t) => !t.acs.length && !t.tags.includes("ac:none")), outsideAcs: forStory.filter((t) => t.tags.includes("ac:none")) };
}

const STATUS_ICON = { covered: "✅", weak: "🟠", discrepancy: "⚠️", "pending-only": "⏸️", "not-traced": "⬜" } as const;

/**
 * Render the matrix. `flagged` holds tests the independent reviewer judged weak or wrong-oracle: they are marked,
 * and an AC whose only passing tests are flagged is shown as weak rather than covered.
 */
export function traceMarkdown(storyKey: string | undefined, trace: ReturnType<typeof traceStory>, flagged: Map<string, string> = new Map()): string {
  if (!trace.acs.length) return "";
  const mark = (t: IndexedTest) => (flagged.has(t.id) ? ` 🟠 _${flagged.get(t.id)}_` : "");
  const cell = (ts: IndexedTest[]) => (ts.length ? ts.map((t) => `\`${t.file}:${t.line}\` ${t.title}${mark(t)}`).join("<br>") : "–");
  const status = (r: AcTrace) => (r.status === "covered" && r.active.every((t) => flagged.has(t.id)) ? "weak" : r.status);
  const lines = [
    `### Requirement traceability${storyKey ? ` (${storyKey})` : ""}`,
    `_Built from test tags (\`@story\`, \`@ac\`), not from the agent's claims${flagged.size ? "; 🟠 = judged weak or wrong-oracle by the independent review" : ""}._`,
    "",
    "| AC | Status | Passing tests | Pending (fixme/skip) |",
    "| --- | --- | --- | --- |",
    ...trace.acs.map((r) => `| ${r.ac} | ${STATUS_ICON[status(r)]} ${status(r)} | ${cell(r.active)} | ${cell(r.pending)} |`),
  ];
  if (trace.outsideAcs.length) lines.push("", `Outside the story's ACs on purpose (\`@ac:none\`): ${trace.outsideAcs.map((t) => `\`${t.file}:${t.line}\` ${t.title}${t.status !== "active" ? ` (${t.status})` : ""}`).join(", ")}.`);
  if (trace.storyOnly.length) lines.push("", `${trace.storyOnly.length} test(s) are tagged with the story but no AC: ${trace.storyOnly.map((t) => `\`${t.file}:${t.line}\``).join(", ")}.`);
  return lines.join("\n");
}

/** Tests whose code changed since `ref` (any added line inside the test's block), for review and reporting. */
export function changedTests(index: IndexedTest[], repo: string, files: string[], added: (file: string) => string[]): IndexedTest[] {
  const out: IndexedTest[] = [];
  for (const f of new Set(files)) {
    const set = new Set(added(f).map((l) => l.trim()).filter(Boolean));
    if (!set.size) continue;
    const lines = fs.readFileSync(path.join(repo, f), "utf8").split(/\r?\n/);
    for (const t of index.filter((x) => x.file === f)) {
      if (lines.slice(t.line - 1, t.endLine).some((l) => set.has(l.trim()))) out.push(t);
    }
  }
  return out;
}
