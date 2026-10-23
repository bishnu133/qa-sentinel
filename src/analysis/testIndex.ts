import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { Config } from "../config.js";
import { layers } from "../layers.js";
import { showFile } from "../git.js";

/**
 * Scenario-level traceability, derived from the tests themselves rather than maintained by hand.
 *
 * Every test declares what it proves with tags in its title:
 *   test("refund over the amount returns 422 @service:payments-service @endpoint:POST_/payments/{id}/refund @story:SHOP-102 @ac:AC-2", …)
 * qa-sentinel parses these (plus fixme/skip status and the number of assertions) into an index, checks the index
 * against test-map.yaml, and renders requirement → test matrices. Because the index is rebuilt from the code on
 * every run, it cannot drift from the tests the way a hand-written scenario list would.
 */

/**
 * active: runs and must pass. fixme/skip: doesn't run (fixme = written to the requirement, product disagrees, waiting
 * for QA triage). known-defect: `test.fail`, QA confirmed a product defect (bug link in `bug`): it runs and passes while
 * the defect is there, and goes red once the product is fixed (then the marker comes off).
 */
export type TestStatus = "active" | "fixme" | "skip" | "known-defect";

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
  /** Web tests: the pages they open, "/orders/:id" (tag @page:/orders/:id). */
  pages: string[];
  stories: string[];
  /** Bug cards this test belongs to (tag @bug:SHOP-210): a test written for a fix, run again when the bug's feature is re-tested. */
  bugs: string[];
  acs: string[]; // "AC-2"
  /** Access-control tests: the role a test logs in as (tag @role:admin; @role:none when no token is sent). */
  roles: string[];
  tags: string[]; // other bare tags, e.g. "smoke"
  assertions: number;
  /** Every assertion only checks the HTTP status (a common sign of a weak test). */
  statusOnly: boolean;
  /** A Cucumber scenario: counts for traceability and coverage; the team's BDD job runs it, not qa-sentinel. */
  bdd?: boolean;
  /** known-defect tests: the bug link (`// QA-BUG: <link>` above the test, or an `issue` annotation). */
  bug?: string;
}

const SPEC = /\.(spec|test)\.[cm]?[jt]sx?$/;
const DECL = /\b(test|it)(?:\.(only|skip|fixme|fail|failing|fails|slow))?\s*\(\s*(["'`])((?:\\.|(?!\3)[^\\])*)\3/;
const DESCRIBE = /\b(?:test\.)?describe(?:\.\w+)?\s*\(\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/;
const CONST = /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*(["'`])((?:\\.|(?!\2)[^\\$])*)\2\s*;?/g;
const ASSERT = /\b(expect|expectSchema|assert)\s*[.(]/g;

/** "POST_/orders" (tag form) → "POST /orders". */
export const endpointFromTag = (t: string) => t.replace(/^([A-Z]+)_/, "$1 ");
export const endpointTag = (e: string) => e.trim().replace(/^([A-Z]+)\s+/, "$1_");

/** "/orders/{id}/", "orders/:orderId" → "/orders/:id": one spelling per route so tags, plans and maps compare. */
export const normPage = (p: string) => ("/" + p.trim().replace(/^\/+/, "").replace(/\/+$/, "")).replace(/\{[^}]*\}|:[A-Za-z_]\w*/g, ":id");

export function parseTags(raw: string): Pick<IndexedTest, "services" | "endpoints" | "pages" | "stories" | "bugs" | "acs" | "roles" | "tags"> & { title: string } {
  const out = { services: [] as string[], endpoints: [] as string[], pages: [] as string[], stories: [] as string[], bugs: [] as string[], acs: [] as string[], roles: [] as string[], tags: [] as string[] };
  const title = raw.replace(/\s*@([\w-]+)(?::(\S+))?/g, (_m, k: string, v?: string) => {
    const vals = (v ?? "").split(",").filter(Boolean);
    if (k === "service") out.services.push(...vals);
    else if (k === "endpoint") out.endpoints.push(...vals.map(endpointFromTag));
    // Mobile tests tag the screen (@screen:orders/new); it is indexed like a page (same matching and screens map).
    else if (k === "page" || k === "screen") out.pages.push(...vals.map(normPage));
    else if (k === "story") out.stories.push(...vals);
    else if (k === "bug") out.bugs.push(...vals);
    else if (k === "role") out.roles.push(...vals);
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
  // Small tag helpers: const tags = (ac: string) => `@story:S-1 @ac:${ac}`; used as ${tags("AC-3")}.
  const helpers = new Map<string, { params: string[]; body: string }>();
  for (const m of src.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*\(([^)]*)\)\s*(?::\s*\w+\s*)?=>\s*`([^`]*)`/g)) {
    helpers.set(m[1], { params: m[2].split(",").map((p) => p.split(/[:=]/)[0].trim()).filter(Boolean), body: m[3] });
  }
  const call = (name: string, rawArgs: string) => {
    const h = helpers.get(name);
    if (!h) return undefined;
    const args = [...rawArgs.matchAll(/(["'`])((?:\\.|(?!\1).)*)\1/g)].map((a) => a[2]);
    return h.body.replace(/\$\{\s*([A-Za-z_$][\w$]*)\s*\}/g, (m, n: string) => {
      const i = h.params.indexOf(n);
      return i >= 0 && args[i] !== undefined ? args[i] : (consts.get(n) ?? m);
    });
  };
  return (s: string) =>
    s
      .replace(/\$\{\s*([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\}/g, (m, n: string, a: string) => call(n, a) ?? m)
      .replace(/\$\{\s*([A-Za-z_$][\w$]*)\s*\}/g, (m, n: string) => consts.get(n) ?? m);
}

export function indexSource(file: string, src: string): IndexedTest[] {
  const subst = constSubstituter(src);

  const lines = src.split(/\r?\n/);
  const describes: { indent: number; title: string; fail?: boolean }[] = [];
  const found: { line: number; kind?: string; raw: string; indent: number }[] = [];
  lines.forEach((l, i) => {
    const indent = l.length - l.trimStart().length;
    const d = l.match(DESCRIBE);
    if (d) {
      while (describes.length && describes[describes.length - 1].indent >= indent) describes.pop();
      describes.push({ indent, title: subst(d[2]), fail: /\bdescribe\.fail\b/.test(l) });
      return;
    }
    const t = l.match(DECL);
    if (t && !/\.(describe|step|use|beforeEach|afterEach|beforeAll|afterAll|extend|info)\b/.test(l.slice(t.index ?? 0, (t.index ?? 0) + 20))) {
      while (describes.length && describes[describes.length - 1].indent >= indent) describes.pop();
      found.push({ line: i + 1, kind: t[2], raw: subst(t[4]), indent });
      (found[found.length - 1] as any).describe = describes.map((x) => x.title).join(" › ") || undefined;
      (found[found.length - 1] as any).failGroup = describes.some((x) => x.fail);
    }
  });
  return found.map((f, k) => {
    const end = k + 1 < found.length ? found[k + 1].line - 1 : lines.length;
    const body = lines.slice(f.line - 1, end).join("\n");
    const asserts = body.split("\n").filter((l) => ASSERT.test(l) && ((ASSERT.lastIndex = 0), true));
    const parsed = parseTags(f.raw);
    // A @story tag on an enclosing describe is part of the full test name, so a runner's title filter (and `suite`) sees it: the index must too.
    const inherited = parseTags(String((f as any).describe ?? "")).stories;
    if (inherited.length) parsed.stories = [...new Set([...parsed.stories, ...inherited])];
    // test.fail("title", …), test.fail() / test.fail(cond) inside the body, or a test.describe.fail group around it.
    const defect = f.kind === "fail" || f.kind === "failing" || f.kind === "fails" || /\b(?:test|it)\.(?:fail|failing|fails)(?:\.only)?\s*\(/.test(lines.slice(f.line, end).join("\n")) || (f as any).failGroup;
    return {
      id: `${file}:${f.line}`,
      file,
      line: f.line,
      endLine: end,
      describe: (f as any).describe,
      status: defect ? "known-defect" : f.kind === "fixme" ? "fixme" : f.kind === "skip" ? "skip" : "active",
      ...(defect ? bugLink(lines, f.line, end) : {}),
      assertions: (body.match(ASSERT) ?? []).length,
      statusOnly: asserts.length > 0 && asserts.every((l) => /\.status\(\)\)?\s*\)?\s*\.(toBe|toEqual)\(\s*\d{3}\s*\)/.test(l) || /expect\([^)]*status\(\)\)/.test(l)),
      ...parsed,
    } satisfies IndexedTest;
  });
}

/**
 * Cucumber feature files: each Scenario (or Scenario Outline) is a test, its tags are the @-lines above it plus the
 * Feature's (`@service:orders @endpoint:POST_/orders @story:SHOP-1 @ac:AC-2`). @wip/@skip/@ignore → skip, @fixme →
 * fixme. Then-steps count as assertions. So existing BDD suites count for traceability, coverage and regression.
 */
export function indexFeature(file: string, src: string): IndexedTest[] {
  const lines = src.split(/\r?\n/);
  let featureTags: string[] = [];
  let pending: string[] = [];
  let feature: string | undefined;
  const found: { line: number; title: string; tags: string[] }[] = [];
  lines.forEach((raw, i) => {
    const l = raw.trim();
    if (l.startsWith("@")) pending.push(...l.split(/\s+/).filter((t) => t.startsWith("@")));
    else if (/^Feature:/i.test(l)) {
      feature = l.replace(/^Feature:\s*/i, "");
      featureTags = pending;
      pending = [];
    } else if (/^(Scenario|Scenario Outline|Scenario Template|Example):/i.test(l)) {
      found.push({ line: i + 1, title: l.replace(/^[^:]+:\s*/, ""), tags: [...featureTags, ...pending] });
      pending = [];
    } else if (l && !l.startsWith("#")) pending = l.startsWith("@") ? pending : pending.length && /^(Rule|Background):/i.test(l) ? [] : pending;
  });
  return found.map((f, k) => {
    const end = k + 1 < found.length ? found[k + 1].line - 1 : lines.length;
    const body = lines.slice(f.line, end);
    const thens = body.filter((l) => /^\s*(Then|And|But)\b/.test(l)).length;
    const parsed = parseTags(`${f.title} ${f.tags.join(" ")}`);
    const tags = f.tags.map((t) => t.slice(1).toLowerCase());
    return {
      id: `${file}:${f.line}`,
      file,
      line: f.line,
      endLine: end,
      describe: feature,
      status: tags.includes("fixme") ? "fixme" : tags.some((t) => ["wip", "skip", "ignore", "manual"].includes(t)) ? "skip" : "active",
      assertions: thens,
      statusOnly: false,
      bdd: true,
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
    else if (SPEC.test(e.name) || /\.feature$/.test(e.name)) out.push(path.relative(root, p).split(path.sep).join("/"));
  }
}

/** Build the index for every spec under the test directories (relative to the test repo). */
export function buildTestIndex(repo: string, testDirs: string | string[]): IndexedTest[] {
  const files: string[] = [];
  for (const d of new Set(Array.isArray(testDirs) ? testDirs : [testDirs])) walk(path.join(repo, d), repo, files);
  return [...new Set(files)].sort().flatMap((f) => (f.endsWith(".feature") ? indexFeature : indexSource)(f, fs.readFileSync(path.join(repo, f), "utf8")));
}

/** The same index for the tests as they are at a git ref (a branch not checked out). Files are read with `git show`. */
export function buildTestIndexAt(repo: string, ref: string, testDirs: string | string[]): IndexedTest[] {
  const dirs = [...new Set(Array.isArray(testDirs) ? testDirs : [testDirs])];
  let listed = "";
  try {
    listed = execFileSync("git", ["-c", "core.quotePath=false", "ls-tree", "-r", "--name-only", ref, "--", ...dirs], { cwd: repo, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return [];
  }
  const files = listed.split("\n").filter((f) => f && (SPEC.test(path.posix.basename(f)) || f.endsWith(".feature")) && !f.split("/").some((seg) => seg === "node_modules" || seg.startsWith("."))).sort();
  return files.flatMap((f) => {
    const src = showFile(repo, ref, f);
    return src === undefined ? [] : (f.endsWith(".feature") ? indexFeature : indexSource)(f, src);
  });
}

/** Index every enabled layer's tests (API, and web when enabled). */
export const indexTests = (repo: string, c: Config) => buildTestIndex(repo, layers(c).map((l) => l.dir));

// ---------------------------------------------------------------------------------------------
// Checks: the index against test-map.yaml, and new tests against the tagging convention.

export interface TraceFinding {
  level: "warning" | "info";
  file: string;
  message: string;
}

export function readTestMap(repo: string): { services: Record<string, { endpoints?: Record<string, string[]>; screens?: Record<string, string[]> }> } | undefined {
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
  // Web: screens (route → files) against @page tags.
  const screens = new Map<string, Set<string>>();
  for (const s of Object.values(map.services)) for (const [pg, files] of Object.entries(s?.screens ?? {})) for (const f of files ?? []) {
    const set = screens.get(normPage(pg)) ?? new Set();
    set.add(f);
    screens.set(normPage(pg), set);
  }
  for (const t of index) for (const pg of t.pages) if (screens.size && !screens.get(pg)?.has(t.file)) out.push({ level: "warning", file: t.id, message: `tagged @page:${pg} but test-map.yaml does not list ${t.file} under screens for ${pg}` });
  return dedupe(out);
}

/** New or changed tests must say what they prove. */
export function checkNewTests(index: IndexedTest[], changedFiles: string[], storyKey?: string, acIds: string[] = []): TraceFinding[] {
  const out: TraceFinding[] = [];
  const known = new Set(acIds.map((a) => a.toUpperCase()));
  for (const t of index.filter((x) => changedFiles.includes(x.file))) {
    if (!t.endpoints.length && !t.pages.length) out.push({ level: "warning", file: t.id, message: `"${t.title}" has no @endpoint (API), @page (web) or @screen (mobile) tag` });
    if (storyKey && !t.stories.length && !t.acs.length) continue; // pre-existing style tests: not this change's concern
    for (const ac of t.acs) if (known.size && !known.has(ac)) out.push({ level: "warning", file: t.id, message: `"${t.title}" references ${ac}, which is not in ${storyKey ?? "the story"}` });
  }
  return dedupe(out);
}

const dedupe = (xs: TraceFinding[]) => [...new Map(xs.map((x) => [`${x.file}|${x.message}`, x])).values()];

// ---------------------------------------------------------------------------------------------
/** The bug link of a known-defect test: `// QA-BUG: <link>` in the 4 lines above, or `type: "issue", description: "<link>"` in it. */
function bugLink(lines: string[], line: number, end: number): { bug?: string } {
  for (let j = line - 2; j >= Math.max(0, line - 6); j--) {
    const m = lines[j].match(/\/\/\s*QA-BUG:\s*(\S+)/);
    if (m) return { bug: m[1] };
    if (!/^\s*(\/\/|\*|\/\*)/.test(lines[j]) && lines[j].trim()) break;
  }
  const body = lines.slice(line - 1, Math.min(end, line + 5)).join("\n");
  const a = body.match(/type:\s*["'`]issue["'`]\s*,\s*description:\s*["'`]([^"'`]+)/);
  return a ? { bug: a[1] } : {};
}

// Requirement → test matrix.

export interface AcTrace {
  ac: string;
  text?: string;
  active: IndexedTest[];
  pending: IndexedTest[]; // fixme / skip
  status: "covered" | "weak" | "discrepancy" | "pending-only" | "not-traced" | "manual" | "manual-pending" | "manual-failed";
  /** Manual test cards for this AC (when no automated test proves it). */
  manual?: { file: string; line: number; title: string; result?: "pass" | "fail" }[];
}

export function traceStory(
  index: IndexedTest[],
  storyKey: string | undefined,
  acs: { id: string; text?: string }[],
  manual: { story?: string; acs: string[]; file: string; line: number; title: string; result?: "pass" | "fail" }[] = [],
): { acs: AcTrace[]; storyOnly: IndexedTest[]; outsideAcs: IndexedTest[] } {
  const forStory = index.filter((t) => (storyKey ? t.stories.includes(storyKey) : false) || (!t.stories.length && t.acs.length && !storyKey));
  const rows = acs.map(({ id, text }) => {
    const hits = forStory.filter((t) => t.acs.includes(id.toUpperCase()));
    const active = hits.filter((t) => t.status === "active");
    const pending = hits.filter((t) => t.status !== "active");
    const cards = manual.filter((m) => (storyKey ? m.story === storyKey : !m.story) && m.acs.includes(id.toUpperCase())).map(({ file, line, title, result }) => ({ file, line, title, ...(result ? { result } : {}) }));
    // A card counts as checked by hand once a tester ticked pass on every card for the AC.
    const handStatus = !cards.length ? "not-traced" : cards.some((m) => m.result === "fail") ? "manual-failed" : cards.every((m) => m.result === "pass") ? "manual" : "manual-pending";
    const status = active.length && pending.length ? "discrepancy" : active.length ? "covered" : pending.length ? "pending-only" : handStatus;
    return { ac: id, text, active, pending, status, ...(cards.length ? { manual: cards } : {}) } as AcTrace;
  });
  return { acs: rows, storyOnly: forStory.filter((t) => !t.acs.length && !t.tags.includes("ac:none")), outsideAcs: forStory.filter((t) => t.tags.includes("ac:none")) };
}

const STATUS_ICON = { covered: "✅", weak: "🟠", discrepancy: "⚠️", "pending-only": "⏸️", "not-traced": "⬜", manual: "✋", "manual-pending": "✋⏳", "manual-failed": "✋❌" } as const;
const STATUS_WORDS: Partial<Record<AcTrace["status"], string>> = { manual: "checked by hand", "manual-pending": "to check by hand (card not run yet)", "manual-failed": "failed when checked by hand" };

/**
 * Render the matrix. `flagged` holds tests the independent reviewer judged weak or wrong-oracle: they are marked,
 * and an AC whose only passing tests are flagged is shown as weak rather than covered.
 */
export function traceMarkdown(storyKey: string | undefined, trace: ReturnType<typeof traceStory>, flagged: Map<string, string> = new Map()): string {
  if (!trace.acs.length) return "";
  const mark = (t: IndexedTest) => (flagged.has(t.id) ? ` 🟠 _${flagged.get(t.id)}_` : "");
  const defect = (t: IndexedTest) => (t.status === "known-defect" ? ` _(known defect${t.bug ? `: ${t.bug}` : ", no bug link"})_` : "");
  const cell = (ts: IndexedTest[]) => (ts.length ? ts.map((t) => `\`${t.file}:${t.line}\` ${t.title}${mark(t)}${defect(t)}`).join("<br>") : "–");
  const status = (r: AcTrace) => (r.status === "covered" && r.active.every((t) => flagged.has(t.id)) ? "weak" : r.status);
  const lines = [
    `### Requirement traceability${storyKey ? ` (${storyKey})` : ""}`,
    `_Built from test tags (\`@story\`, \`@ac\`), not from the agent's claims${flagged.size ? "; 🟠 = judged weak or wrong-oracle by the independent review" : ""}._`,
    "",
    "| AC | Status | Passing tests | Pending (fixme/skip, known defects) |",
    "| --- | --- | --- | --- |",
    ...trace.acs.map((r) => `| ${r.ac} | ${STATUS_ICON[status(r)]} ${STATUS_WORDS[status(r)] ?? status(r)} | ${r.manual ? r.manual.map((m) => `manual card \`${m.file}:${m.line}\` ${m.title}`).join("<br>") : cell(r.active)} | ${cell(r.pending)} |`),
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
