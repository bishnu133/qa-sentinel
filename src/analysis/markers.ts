import type { IndexedTest } from "./testIndex.js";
import { type RunResult, matchResult } from "../showcase/results.js";

/**
 * Known defects (`test.fail` + a bug link) are tests that pass while the bug exists. When the bug is fixed the test
 * "unexpectedly passes" and Playwright reports it as a failure with "Expected to fail, but passed". This module
 * finds those, and prepares the edit that takes the markers off. It only prepares text: a person reviews and merges.
 */

export type DefectState = "fixed" | "still-failing" | "inconclusive" | "not-run";

export interface DefectStatus {
  test: IndexedTest;
  state: DefectState;
  /** Why, in a few words (the failure message when inconclusive). */
  detail?: string;
}

const FAIL_PASSED = /Expected to fail, but passed/i;

/** Where each known defect stands in a test run. */
export function defectStatuses(index: IndexedTest[], results: RunResult[]): DefectStatus[] {
  return index
    .filter((t) => t.status === "known-defect")
    .map((test) => {
      const r = matchResult(results, test);
      if (!r || r.status === "skipped") return { test, state: "not-run" as const, detail: r ? "skipped in this run" : "not in this run's results" };
      // Passed here means "failed as expected" (Playwright's own judgement for test.fail).
      if (r.status === "passed") return { test, state: "still-failing" as const };
      if (r.error && FAIL_PASSED.test(r.error)) return { test, state: "fixed" as const };
      return { test, state: "inconclusive" as const, detail: r.error ?? "failed without a message" };
    });
}

export interface MarkerEdit {
  /** The file's new text (set when the markers could be removed). */
  text?: string;
  /** Why not (set when a person must do it). */
  reason?: string;
  /** The comment lines that were removed with the marker. */
  removed?: string[];
}

const DECLARATION = /\b(test|it)\.fail(\s*\()/;
const NOTE = /^\s*\/\/\s*(QA-BUG|QA-AGENT)\s*:/;

/**
 * Take `test.fail` off one test and the `// QA-BUG:` / `// QA-AGENT:` comment lines right above it. Only the plain
 * form `test.fail("title", …)` on the test's own line is handled; a `describe.fail` group, `test.fail()` inside the
 * body or an `issue` annotation is left to a person, with the reason said.
 */
export function removeMarkers(source: string, t: Pick<IndexedTest, "line" | "title">): MarkerEdit {
  const lines = source.split("\n");
  const at = t.line - 1;
  const line = lines[at];
  if (line === undefined || !DECLARATION.test(line)) return { reason: `${t.line}: the test is not a plain test.fail("…") declaration (a describe.fail group, test.fail() in the body or an annotation): take the marker off by hand` };
  // The test's own arguments (up to its function): an `issue` annotation there would be left behind as a stale link.
  const head = lines.slice(at, at + 6).join("\n").split(/=>|\bfunction\b/)[0];
  if (/\bannotation\b/.test(head)) return { reason: `${t.line}: the bug link is an \`annotation\` on the test, not a comment: take test.fail and the annotation off by hand` };
  lines[at] = line.replace(DECLARATION, "$1$2");
  let from = at;
  while (from > 0 && NOTE.test(lines[from - 1])) from--;
  const removed = lines.slice(from, at).map((l) => l.trim());
  lines.splice(from, at - from);
  return { text: lines.join("\n"), removed };
}

/** Several tests of one file, bottom to top so earlier line numbers stay valid. */
export function removeAllMarkers(source: string, tests: Pick<IndexedTest, "line" | "title">[]): { text: string; done: Set<number>; reasons: Map<number, string>; removed: string[] } {
  let text = source;
  const done = new Set<number>();
  const reasons = new Map<number, string>();
  const removed: string[] = [];
  for (const t of [...tests].sort((a, b) => b.line - a.line)) {
    const e = removeMarkers(text, t);
    if (e.text !== undefined) {
      text = e.text;
      done.add(t.line);
      removed.push(...(e.removed ?? []));
    } else reasons.set(t.line, e.reason ?? "not changed");
  }
  return { text, done, reasons, removed };
}
