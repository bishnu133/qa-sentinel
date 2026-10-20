import fs from "node:fs";
import path from "node:path";
import type { FileChange } from "../git.js";
import type { Finding } from "../guardrails.js";
import { TEST_FILE, addedLines } from "../guardrails.js";
import { type IndexedTest, changedTests, indexSource } from "../analysis/testIndex.js";
import type { ExpectedFile } from "./format.js";

/**
 * Do the tests the AI just wrote assert the expected values? The plan only says which behaviours a scenario proves;
 * this checks the code. A changed test names its behaviours with `@b:B1` tags; every number and text the behaviour
 * expects must appear in its test file (in the test or a constant it uses). A missing value means the test asserts
 * something else (often what the code does), and the run is rejected.
 *
 * It is a necessary check, not a proof: a value that appears can still be used wrongly. The independent test review
 * and QA's review cover the rest.
 */
export function checkExpectedValues(i: { repo: string; ref: string; changes: FileChange[]; expected: ExpectedFile; plannedBehaviours: string[] }): Finding[] {
  const out: Finding[] = [];
  const story = i.expected.story.toUpperCase();
  const live = i.expected.acs.filter((a) => !a.removed);
  const byId = new Map(live.flatMap((a) => a.behaviours.map((b) => [b.id, { ac: a.id, b }] as const)));
  const files = i.changes.filter((x) => x.status !== "D" && TEST_FILE.test(x.path)).map((x) => x.path);
  const src = new Map(files.map((f) => [f, fs.readFileSync(path.join(i.repo, f), "utf8")]));
  const index: IndexedTest[] = files.flatMap((f) => indexSource(f, src.get(f)!));
  const changed = changedTests(index, i.repo, files, (f) => addedLines(i.repo, i.ref, f)).filter((t) => t.stories.map((s) => s.toUpperCase()).includes(story) || !t.stories.length);
  const tagged = new Set<string>();
  for (const t of changed) {
    const ids = t.tags.filter((x) => /^b:/i.test(x)).flatMap((x) => x.slice(2).split(",")).map((x) => x.toUpperCase());
    const valued = t.acs.filter((ac) => live.some((a) => a.id === ac && a.behaviours.some((b) => b.state === "ready")));
    if (!ids.length && valued.length) out.push({ level: "warning", rule: "traceability", file: `${t.file}:${t.line}`, message: `"${t.title}" proves ${valued.join(", ")} but names no expected behaviour: tag it @b:<id> (expected/${story}.md)` });
    for (const id of ids) {
      const hit = byId.get(id);
      if (!hit) {
        out.push({ level: "violation", rule: "expected-value-missing", file: t.file, message: `"${t.title}" is tagged @b:${id}, which isn't in expected/${story}.md` });
        continue;
      }
      tagged.add(id);
      if (!t.acs.includes(hit.ac)) out.push({ level: "warning", rule: "traceability", file: t.file, message: `"${t.title}" proves ${story}/${id}, which belongs to ${hit.ac}: add @ac:${hit.ac}` });
      if (hit.b.state !== "ready") continue;
      const text = src.get(t.file)!;
      const missing = values(hit.b.expect).filter((v) => !appears(v, text));
      if (missing.length)
        out.push({
          level: "violation",
          rule: "expected-value-missing",
          file: `${t.file}:${t.line}`,
          message: `"${t.title}" proves ${story}/${id} (${hit.b.statement}), but ${missing.map((v) => JSON.stringify(v)).join(", ")} doesn't appear in the test file. Tests assert the expected value, never the code's; when the product disagrees, the test stays on the expected value and is marked test.fixme with a QA-AGENT note`,
        });
    }
  }
  for (const id of i.plannedBehaviours) if (!tagged.has(id) && byId.get(id)?.b.state === "ready") out.push({ level: "warning", rule: "traceability", file: `expected/${story}.md`, message: `${story}/${id} was planned, but no changed test is tagged @b:${id}` });
  return out;
}

function values(expect: Record<string, unknown>): (string | number)[] {
  const out: (string | number)[] = [];
  const visit = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(visit);
    else if (typeof v === "number" || (typeof v === "string" && v.trim())) out.push(v);
  };
  Object.values(expect).forEach(visit);
  return out;
}

function appears(v: string | number, text: string): boolean {
  if (typeof v === "number") {
    const nums = [...text.matchAll(/(?<![\w.])-?\d[\d_]*(?:\.\d+)?(?![\w])/g)].map((m) => Number(m[0].replace(/_/g, "")));
    return nums.includes(v);
  }
  return text.includes(v.trim()) || text.toLowerCase().includes(v.trim().toLowerCase().replace(/[.!?]+$/, ""));
}
