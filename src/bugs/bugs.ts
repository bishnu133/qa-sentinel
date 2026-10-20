import fs from "node:fs";
import type { Config } from "../config.js";
import type { IndexedTest } from "../analysis/testIndex.js";
import type { RunResult } from "../showcase/results.js";
import { matchResult } from "../showcase/results.js";
import type { Discrepancy } from "../verification.js";
import type { TestPlan } from "../plan/schema.js";
import {
  type JiraContext,
  addComment,
  attachFile,
  createIssue,
  getIssueProperty,
  issueStatus,
  linkIssues,
  markdownToJiraWiki,
  projectIssueTypes,
  setIssueProperty,
  upsertIssueComment,
} from "../scm/jira.js";
import { log } from "../log.js";
import { classifyFailure } from "../reporting/taxonomy.js";

/**
 * Bug cards from evidence, written so a developer (or their coding agent) can act on them directly:
 * expected (the AC) vs actual, how to reproduce (the test and the exact command), the evidence, and where in
 * the code to look. One bug per story and requirement item; never duplicated; "verified fixed" when it passes.
 */

export interface BugCandidate {
  story: string;
  /** AC or scope item id. */
  item: string;
  kind: "not-working" | "not-built";
  title: string;
  expected: string;
  actual: string;
  test?: { file: string; line?: number; title: string };
  command?: string;
  environment?: string;
  code?: { file: string; line?: number; service?: string; reference?: string }[];
  evidence?: { path: string; name: string; contentType?: string }[];
  /** Static analysis only (not observed at runtime). */
  suspected?: boolean;
}

export const BUGS_PROPERTY = "qa-sentinel.bugs";
interface BugRecord {
  [item: string]: { key: string; kind: BugCandidate["kind"]; createdAt: string; fixedNotedAt?: string };
}

const clean = (t: string) => t.replace(/\s*@\S+/g, "").trim();

/** Failing tests that are written to a story's AC (after retries: a flaky pass is not a bug). */
export function bugsFromResults(c: Config, story: string, items: { id: string; text: string }[], index: IndexedTest[], results: RunResult[], o: { environment?: string; runCommand: (t: IndexedTest) => string }): BugCandidate[] {
  const out: BugCandidate[] = [];
  for (const it of items) {
    const failing = index
      .filter((t) => t.stories.includes(story) && t.acs.includes(it.id.toUpperCase()) && t.status === "active")
      .map((t) => ({ t, r: matchResult(results, t) }))
      .filter((x) => x.r?.status === "failed")
      // The environment failing (network, certificates, gateway errors) says nothing about the product: no bug card.
      .filter((x) => classifyFailure({ message: x.r?.error }) !== "environment");
    if (!failing.length) continue;
    const { t, r } = failing[0];
    out.push({
      story,
      item: it.id,
      kind: "not-working",
      title: `${story} ${it.id} not working: ${clean(t.title)}`,
      expected: it.text,
      actual: r?.error ?? `the test "${clean(t.title)}" fails`,
      test: { file: t.file, line: t.line, title: clean(t.title) },
      command: o.runCommand(t),
      environment: o.environment,
      evidence: (r?.evidence ?? []).filter((e) => ["video", "screenshot", "trace"].includes(e.kind) && fs.existsSync(e.path)).slice(0, 3),
    });
  }
  return out;
}

/** The fixme tests a generation wrote to an AC because the product does something else (the agent saw it fail). */
export function bugsFromDiscrepancies(story: string, items: { id: string; text: string }[], discrepancies: Discrepancy[], index: IndexedTest[], plan: TestPlan | undefined, o: { environment?: string; runCommand: (t: IndexedTest) => string }): BugCandidate[] {
  const out: BugCandidate[] = [];
  for (const d of discrepancies) {
    const t = index.find((x) => x.file === d.file && clean(x.title) === clean(d.test));
    const item = t?.acs.find((a) => items.some((i) => i.id === a));
    if (!item || out.some((b) => b.item === item)) continue;
    const mismatch = plan?.acMismatches.find((m) => m.requirementId === item);
    const status = plan?.requirementStatus.find((r) => r.id === item);
    out.push({
      story,
      item,
      kind: "not-working",
      title: `${story} ${item} not working: ${clean(d.test)}`,
      expected: items.find((i) => i.id === item)!.text,
      actual: d.note ?? mismatch?.observed ?? "the product does not behave as the acceptance criterion says",
      test: { file: d.file, line: t?.line, title: clean(d.test) },
      command: t ? o.runCommand(t) : undefined,
      environment: o.environment,
      code: [...(mismatch?.evidence ?? []), ...(status?.evidence ?? [])].filter((e) => e.file).map((e) => ({ file: e.file!, line: e.line, reference: e.reference })).slice(0, 3),
    });
  }
  return out;
}

/** Story-wide plans: items nothing builds, or builds differently. Static analysis, so marked suspected. */
export function bugsFromPlan(story: string, items: { id: string; text: string }[], plan: TestPlan): BugCandidate[] {
  const text = (id: string) => items.find((i) => i.id === id)?.text ?? id;
  return plan.requirementStatus
    .filter((r) => r.status === "not-found" || r.status === "conflict")
    .map((r) => {
      const mismatch = plan.acMismatches.find((m) => m.requirementId === r.id);
      const notBuilt = r.status === "not-found";
      return {
        story,
        item: r.id,
        kind: notBuilt ? ("not-built" as const) : ("not-working" as const),
        title: `${story} ${r.id} ${notBuilt ? "not built" : "built differently"}: ${text(r.id).slice(0, 120)}`,
        expected: text(r.id),
        actual: r.note ?? mismatch?.observed ?? (notBuilt ? "no code in the story's services does this" : "the code does something else"),
        code: [...(mismatch?.evidence ?? []), ...r.evidence].filter((e) => e.file).map((e) => ({ file: e.file!, line: e.line, reference: e.reference })).slice(0, 3),
        suspected: true,
      };
    });
}

/** Description in Jira wiki markup, with a machine-readable block for coding agents. */
const uniqueCode = (code: BugCandidate["code"]) => {
  const seen = new Set<string>();
  return (code ?? []).filter((x) => {
    const k = `${x.file}:${x.line ?? ""}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

export function bugDescription(b: BugCandidate): string {
  b = { ...b, code: uniqueCode(b.code) };
  const md = [
    `*Story:* ${b.story} · *Requirement:* ${b.item}${b.suspected ? " · _suspected: found by static analysis, please confirm_" : ""}`,
    "",
    "*Expected (from the story):*",
    b.expected,
    "",
    "*Actual:*",
    b.actual,
    "",
    ...(b.test ? ["*How to reproduce:*", `Test \`${b.test.file}${b.test.line ? `:${b.test.line}` : ""}\` "${b.test.title}"${b.environment ? ` on ${b.environment.toUpperCase()}` : ""}.`, ...(b.command ? ["", "```", b.command, "```"] : []), ""] : []),
    ...(b.code?.length ? ["*Where to look:*", ...b.code.map((x) => `- \`${x.file}${x.line ? `:${x.line}` : ""}\`${x.reference ? ` – ${x.reference}` : ""}`), ""] : []),
    ...(b.evidence?.length ? [`*Evidence:* ${b.evidence.map((e) => e.name).join(", ")} (attached)`, ""] : []),
    "_Raised by qa-sentinel from test evidence. Fix the product to match the requirement (or change the requirement); the test written to the requirement will then pass._",
  ].join("\n");
  const machine = { story: b.story, requirement: b.item, kind: b.kind, expected: b.expected, actual: b.actual, test: b.test, command: b.command, environment: b.environment, code: b.code, suspected: !!b.suspected };
  return `${markdownToJiraWiki(md)}\n\n{code:json}\n${JSON.stringify(machine, null, 2)}\n{code}`;
}

/** suggest: one comment on the story listing the bugs. create: create, link and record them; never twice. */
export async function fileBugs(ctx: JiraContext, c: Config, story: string, candidates: BugCandidate[]): Promise<{ created: string[]; suggested: number; skipped: string[] }> {
  const created: string[] = [];
  const skipped: string[] = [];
  if (!candidates.length || c.bugs.mode === "off") return { created, suggested: 0, skipped };
  const list = c.bugs.notBuilt ? candidates : candidates.filter((b) => b.kind !== "not-built");
  if (c.bugs.mode === "suggest") {
    const md = [
      `### Proposed bugs · ${story}`,
      `qa-sentinel found ${list.length} requirement(s) not working or not built. Create them as bugs if you agree (\`bugs.mode: create\` does this automatically).`,
      "",
      ...list.map((b) => `- *${b.item}*${b.suspected ? " _(suspected)_" : ""}: ${b.title}\n  Expected: ${b.expected}\n  Actual: ${b.actual}${b.test ? `\n  Test: \`${b.test.file}${b.test.line ? `:${b.test.line}` : ""}\`` : ""}`),
    ].join("\n");
    await upsertIssueComment(ctx, story, "bugs", markdownToJiraWiki(md), c.reporting.jira.visibility, "qa-sentinel:bugs");
    return { created, suggested: list.length, skipped };
  }
  const record = ((await getIssueProperty<BugRecord>(ctx, story, BUGS_PROPERTY)) ?? {}) as BugRecord;
  const project = c.bugs.project ?? story.split("-")[0];
  const types = await projectIssueTypes(ctx, project).catch(() => [] as string[]);
  const issueType = types.includes(c.bugs.issueType) ? c.bugs.issueType : types.includes("Bug") ? "Bug" : "Task";
  for (const b of list) {
    const existing = record[b.item];
    if (existing) {
      skipped.push(`${b.item}: already raised as ${existing.key}`);
      continue;
    }
    let issue: { key: string };
    try {
      issue = await createIssue(ctx, {
        project,
        issueType,
        summary: b.title,
        description: bugDescription(b),
        labels: [...c.bugs.labels, ...(issueType !== "Bug" ? ["bug"] : []), ...(b.suspected ? ["qa-sentinel-suspected"] : [])],
        priority: c.bugs.priority,
      });
    } catch (e) {
      skipped.push(`${b.item}: could not create the bug: ${(e as Error).message.slice(0, 200)}`);
      continue;
    }
    // Record it at once: a later failure must never make the next run raise the same bug again.
    record[b.item] = { key: issue.key, kind: b.kind, createdAt: new Date().toISOString() };
    created.push(issue.key);
    await setIssueProperty(ctx, story, BUGS_PROPERTY, record).catch((e) => log.warn(`  could not record ${issue.key} on ${story}: ${(e as Error).message}`));
    await linkIssues(ctx, issue.key, story, c.bugs.linkType).catch((e) => log.warn(`  could not link ${issue.key} to ${story}: ${(e as Error).message}`));
    for (const e of b.evidence ?? []) await attachFile(ctx, issue.key, e.name, fs.readFileSync(e.path), e.contentType).catch(() => undefined);
  }
  return { created, suggested: 0, skipped };
}

/** After a run: bugs whose requirement's tests now all pass get one "verified fixed" comment. */
export async function noteFixedBugs(ctx: JiraContext, story: string, passingItems: string[], environment?: string): Promise<string[]> {
  const record = await getIssueProperty<BugRecord>(ctx, story, BUGS_PROPERTY);
  if (!record) return [];
  const noted: string[] = [];
  for (const [item, r] of Object.entries(record)) {
    if (r.fixedNotedAt || !passingItems.includes(item)) continue;
    const st = await issueStatus(ctx, r.key).catch(() => undefined);
    if (st?.category === "done") continue;
    await addComment(ctx, r.key, `qa-sentinel: the tests for ${story} ${item} now pass${environment ? ` on ${environment.toUpperCase()}` : ""}. Please verify and close.`);
    r.fixedNotedAt = new Date().toISOString();
    noted.push(r.key);
  }
  if (noted.length) await setIssueProperty(ctx, story, BUGS_PROPERTY, record);
  return noted;
}
