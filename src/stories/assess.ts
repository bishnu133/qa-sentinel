import { type AcFreshness, type ExpectedFile, freshness } from "../expected/format.js";
import { acsNeedingProposal } from "../expected/spec.js";
import type { AcTrace, IndexedTest } from "../analysis/testIndex.js";

/**
 * Where one story stands, worked out from facts alone: what Jira says, what expected/ holds, what the tests prove.
 * No AI is involved, and nothing is read from the story record (it is a cache, and may be missing). The result says
 * what comes next and who does it, so a scheduled check can start the AI steps that are due and tell people about
 * the rest.
 */

export type CodeState = "merged" | "unmerged" | "none" | "unknown";

export interface StoryFacts {
  key: string;
  title?: string;
  source: "jira" | "story-file";
  url?: string;
  status?: string;
  /** The status counts as agreed and testable (requirements.jira.approvedStatuses); story files are taken as approved. */
  approved: boolean;
  issueType?: string;
  /** requirements.jira.featureIssueTypes (empty list: every type is a feature). */
  isFeature: boolean;
  labels: string[];
  /** Labels that opt a story out / in (requirements.jira.search). */
  skipLabels: string[];
  onlyLabels: string[];
  acs: { id: string; text: string }[];
  /** The stored expected file (undefined: none), or why it can't be read. */
  expected: { file?: ExpectedFile; error?: string };
  /** tests.expectations: with "off" no expected behaviour is written. */
  expectationsMode: "write" | "off";
  trace: AcTrace[];
  /** The last test-generation run for these exact ACs found that existing tests and reasons already cover everything: ACs without a tagged test are not asked for again. */
  generateSettled?: boolean;
  /** Is there merged code for the story? Unknown when no service repo is reachable from here. */
  code: CodeState;
  /** Why the AI step can't start right now (budget, too many failed attempts, already running), per step. */
  limits: { spec?: string; generate?: string };
  /** Jira's status is a ready status for this story's project (requirements.jira.workflow). Informs readiness; does not change the state. */
  jiraReady?: boolean;
  /** Services named by the card's Jira Components (requirements.jira.components), and components with no mapping. */
  services?: string[];
  unmappedComponents?: string[];
  /** How the story was reached when it was asked for through a bug, task or sub-task ("SHOP-210 (Bug) → SHOP-12 via parent"). */
  resolvedFrom?: string;
}

export type StoryState = "skipped" | "needs-attention" | "needs-expectations" | "needs-tests" | "needs-triage" | "covered";
export type Next = "none" | "wait" | "spec" | "generate" | "triage" | "fix";

export interface Todo {
  who: "ai" | "qa" | "po" | "dev";
  what: string;
  /** The command that does it, when there is one. */
  command?: string;
  /** Set when it should start but can't (budget used up, failed too many times, already running). */
  blocked?: string;
}

export interface AcView {
  id: string;
  freshness: AcFreshness | "n/a";
  /** Counts of the stored behaviours: ready, needs-review, unspecified. */
  behaviours: { ready: number; needsReview: number; unspecified: number };
  /** covered: a passing test (or a known defect, or a manual card ticked); triage: fixme/skip waiting for QA; none. */
  tests: "covered" | "known-defect" | "triage" | "manual-pending" | "manual-failed" | "untestable" | "none";
}

export interface Assessment {
  key: string;
  title?: string;
  url?: string;
  status?: string;
  state: StoryState;
  next: Next;
  /** One line why. */
  headline: string;
  reasons: string[];
  todo: Todo[];
  acs: AcView[];
  counts: { acs: number; covered: number; questions: number; knownDefects: number; awaitingTriage: number };
  code: CodeState;
  jiraReady?: boolean;
  services?: string[];
  unmappedComponents?: string[];
  resolvedFrom?: string;
}

const isTriage = (t: IndexedTest) => t.status === "fixme" || t.status === "skip";

function acTests(r: AcTrace): AcView["tests"] {
  if (r.status === "manual-failed") return "manual-failed";
  if (r.status === "manual-pending") return "manual-pending";
  if (r.active.length || r.status === "manual") return "covered";
  if (r.pending.some((t) => t.status === "known-defect")) return "known-defect";
  if (r.pending.some(isTriage)) return "triage";
  return "none";
}

export function assessStory(f: StoryFacts): Assessment {
  const reasons: string[] = [];
  const todo: Todo[] = [];
  const blank = (state: StoryState, next: Next, headline: string): Assessment => ({
    key: f.key,
    title: f.title,
    url: f.url,
    status: f.status,
    state,
    next,
    headline,
    reasons,
    todo,
    acs: [],
    counts: { acs: f.acs.length, covered: 0, questions: 0, knownDefects: 0, awaitingTriage: 0 },
    code: f.code,
  });

  // 1. Stories qa-sentinel leaves alone.
  const skip = f.skipLabels.find((l) => f.labels.some((x) => x.toLowerCase() === l.toLowerCase()));
  if (skip) return blank("skipped", "none", `opted out (label ${skip})`);
  if (f.onlyLabels.length && !f.onlyLabels.some((l) => f.labels.some((x) => x.toLowerCase() === l.toLowerCase()))) return blank("skipped", "none", `not opted in (needs one of the labels: ${f.onlyLabels.join(", ")})`);
  if (!f.isFeature) return blank("skipped", "none", `${f.issueType ?? "this issue type"} is not a feature type (requirements.jira.featureIssueTypes)`);
  if (!f.approved) return blank("skipped", "wait", `status "${f.status ?? "unknown"}" is not approved yet (requirements.jira.approvedStatuses)`);

  // 2. Things only a person can fix first.
  if (!f.acs.length) {
    todo.push({ who: "po", what: "write acceptance criteria that qa-sentinel can read", command: `qa-sentinel story-check --story ${f.key}` });
    return blank("needs-attention", "fix", "no acceptance criteria that qa-sentinel can read");
  }
  if (f.expected.error) {
    todo.push({ who: "qa", what: `fix the expected file: ${f.expected.error}` });
    return blank("needs-attention", "fix", "the expected file can't be read");
  }

  const file = f.expected.file;
  const fresh = freshness(file, f.acs);
  const acsView: AcView[] = f.acs.map((a) => {
    const entry = file?.acs.find((e) => !e.removed && e.id === a.id);
    const bs = entry?.behaviours ?? [];
    const r = f.trace.find((t) => t.ac.toUpperCase() === a.id.toUpperCase());
    const tests = r ? acTests(r) : "none";
    return {
      id: a.id,
      freshness: file ? (fresh.get(a.id) ?? "n/a") : "n/a",
      behaviours: { ready: bs.filter((b) => b.state === "ready").length, needsReview: bs.filter((b) => b.state === "needs-review").length, unspecified: bs.filter((b) => b.state === "unspecified").length },
      tests: tests === "none" && entry?.untestable ? "untestable" : tests,
    };
  });

  // Questions and reviews that wait for people: they never block the tests of the behaviours that are ready.
  const live = (file?.acs ?? []).filter((a) => !a.removed);
  const questions = live.flatMap((a) => a.behaviours.filter((b) => b.state === "unspecified").map((b) => ({ ac: a.id, id: b.id, q: b.question ?? "" })));
  const toReview = live.flatMap((a) => a.behaviours.filter((b) => b.state === "needs-review").map((b) => `${a.id}/${b.id}`));
  if (questions.length) todo.push({ who: "po", what: `answer ${questions.length} open question(s): ${questions.slice(0, 3).map((q) => `${q.ac}/${q.id} ${q.q}`).join("; ")}${questions.length > 3 ? "; …" : ""}` });
  if (toReview.length) todo.push({ who: "qa", what: `review ${toReview.length} behaviour(s) marked needs-review (the AC changed): ${toReview.slice(0, 6).join(", ")}${toReview.length > 6 ? ", …" : ""}` });
  const gone = [...fresh.entries()].filter(([, v]) => v === "removed").map(([id]) => id);
  if (gone.length) todo.push({ who: "qa", what: `${gone.join(", ")} is no longer in the story; set removed: true in the expected file if it was dropped on purpose` });

  // Known defects need a link; fixme/skip tests need QA's decision.
  const all = f.trace.flatMap((r) => r.pending);
  const defects = all.filter((t) => t.status === "known-defect");
  const noLink = defects.filter((t) => !t.bug);
  if (noLink.length) todo.push({ who: "qa", what: `add a // QA-BUG: <link> to ${noLink.length} known-defect test(s): ${noLink.slice(0, 3).map((t) => `${t.file}:${t.line}`).join(", ")}` });
  const waiting = [...new Map(all.filter(isTriage).map((t) => [t.id, t])).values()];
  if (waiting.length) todo.push({ who: "qa", what: `triage ${waiting.length} fixme/skip test(s): confirm a product defect (test.fail + bug link) or fix the test: ${waiting.slice(0, 3).map((t) => `${t.file}:${t.line}`).join(", ")}${waiting.length > 3 ? ", …" : ""}`, command: `qa-sentinel trace --story ${f.key}` });
  const manualFailed = acsView.filter((a) => a.tests === "manual-failed").map((a) => a.id);
  if (manualFailed.length) todo.push({ who: "dev", what: `${manualFailed.join(", ")} failed when checked by hand` });
  const manualPending = acsView.filter((a) => a.tests === "manual-pending").map((a) => a.id);
  if (manualPending.length) todo.push({ who: "qa", what: `run the manual card(s) for ${manualPending.join(", ")}` });

  const counts = {
    acs: f.acs.length,
    covered: acsView.filter((a) => a.tests === "covered" || a.tests === "known-defect" || a.tests === "untestable").length,
    questions: questions.length,
    knownDefects: defects.length,
    awaitingTriage: waiting.length,
  };
  const done = (state: StoryState, next: Next, headline: string): Assessment => ({ ...blank(state, next, headline), acs: acsView, counts });

  // 3. AI step 1: expected behaviour for ACs that are new, changed, or still empty.
  if (f.expectationsMode === "write") {
    const needed = acsNeedingProposal(file, f.acs).filter((a) => a.needsProposal);
    if (needed.length) {
      const names = needed.map((a) => `${a.id} (${fresh.get(a.id) === "changed" ? "changed" : file ? (fresh.get(a.id) === "new" ? "new" : "empty") : "no expected file yet"})`);
      reasons.push(`expected behaviour is missing or out of date for ${names.join(", ")}`);
      todo.unshift({ who: "ai", what: `write expected behaviour for ${needed.map((a) => a.id).join(", ")}`, command: `qa-sentinel spec --story ${f.key}`, ...(f.limits.spec ? { blocked: f.limits.spec } : {}) });
      return done("needs-expectations", "spec", `expected behaviour needed for ${needed.length} of ${f.acs.length} AC(s)`);
    }
  }

  // 4. AI step 2: tests for ACs that have none (needs the code to be merged: tests are written after the merge).
  const missing = f.generateSettled ? [] : acsView.filter((a) => a.tests === "none").map((a) => a.id);
  if (missing.length) {
    reasons.push(`no test, known defect or manual card for ${missing.join(", ")}`);
    if (f.code === "merged" || f.code === "unknown") {
      if (f.code === "unknown") reasons.push("could not check whether the code is merged (no service repo or GitLab access from here)");
      todo.unshift({ who: "ai", what: `write tests for ${missing.join(", ")}`, command: `qa-sentinel generate --story ${f.key}`, ...(f.limits.generate ? { blocked: f.limits.generate } : {}) });
      return done("needs-tests", "generate", `${missing.length} of ${f.acs.length} AC(s) have no test`);
    }
    reasons.push(f.code === "unmerged" ? "the code is not merged yet" : "no merged code found for this story yet");
    todo.unshift({ who: "dev", what: f.code === "unmerged" ? "merge the story's change(s); tests are written after the merge" : "no change carrying this story key was found in the service repos" });
    return done("needs-tests", "wait", `waiting for merged code; ${missing.length} of ${f.acs.length} AC(s) have no test`);
  }

  // 5. People.
  if (waiting.length) {
    reasons.push(`${waiting.length} test(s) are fixme/skip and wait for QA`);
    return done("needs-triage", "triage", `${waiting.length} test(s) wait for QA triage`);
  }
  if (manualFailed.length || manualPending.length || noLink.length || questions.length || toReview.length || gone.length) {
    reasons.push("every AC has a test or card; some people tasks are open");
    return done("covered", "none", `covered; ${todo.length} task(s) for people`);
  }
  return done("covered", "none", counts.knownDefects ? `covered (${counts.knownDefects} known defect(s))` : "covered");
}

const ICON: Record<StoryState, string> = { skipped: "⏭️", "needs-attention": "🛑", "needs-expectations": "📝", "needs-tests": "🧪", "needs-triage": "🔎", covered: "✅" };
const WHO: Record<Todo["who"], string> = { ai: "AI", qa: "QA", po: "PO", dev: "Dev" };

export function stateIcon(s: StoryState): string {
  return ICON[s];
}

/** The overview as markdown: one row per story, then each story's open tasks. */
export function storiesMarkdown(list: Assessment[], at = new Date()): string {
  const lines = [`### Stories (${at.toISOString().slice(0, 16).replace("T", " ")} UTC)`, "", "| Story | State | Next | Detail |", "| --- | --- | --- | --- |"];
  for (const a of list) lines.push(`| ${a.url ? `[${a.key}](${a.url})` : a.key} | ${ICON[a.state]} ${a.state} | ${a.next} | ${a.headline} |`);
  const open = list.filter((a) => a.todo.length);
  if (open.length) {
    lines.push("", "#### Open tasks");
    for (const a of open) lines.push("", `**${a.key}**${a.title ? ` ${a.title}` : ""}`, ...a.todo.map((t) => `- ${WHO[t.who]}: ${t.what}${t.command ? ` (\`${t.command}\`)` : ""}${t.blocked ? ` — **not started:** ${t.blocked}` : ""}`));
  }
  return lines.join("\n");
}

/** The overview for a terminal: one line per story, its open tasks underneath. */
export function storiesText(list: Assessment[], changes: Map<string, string[]> = new Map()): string {
  const w = Math.max(...list.map((a) => a.key.length), 6);
  const sw = Math.max(...list.map((a) => a.state.length), 5);
  const out: string[] = [];
  for (const a of list) {
    out.push(`${a.key.padEnd(w)}  ${ICON[a.state]} ${a.state.padEnd(sw)}  ${a.headline}`);
    for (const c of changes.get(a.key) ?? []) out.push(`${" ".repeat(w + 2)}↻ ${c}`);
    for (const t of a.todo) out.push(`${" ".repeat(w + 2)}→ ${WHO[t.who]}: ${t.what}${t.command ? `  [${t.command}]` : ""}${t.blocked ? `\n${" ".repeat(w + 6)}not started: ${t.blocked}` : ""}`);
  }
  return out.join("\n");
}
