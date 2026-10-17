import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Config } from "../config.js";
import type { AgentEngine, AgentResult } from "../engines/AgentEngine.js";
import type { RequirementSnapshot } from "../requirements.js";
import { type RunDir, agentEnv } from "../run.js";

/** Story review before development: a read-only agent judges the story itself (no code involved). */
export const FINDING_TYPES = ["ambiguous", "untestable", "missing-negative", "missing-edge", "scope-without-ac", "conflict", "missing-nfr", "needs-test-hook", "other"] as const;

export const StoryReviewSchema = z
  .object({
    schemaVersion: z.literal(1),
    summary: z.string().min(1),
    findings: z
      .array(z.object({ type: z.enum(FINDING_TYPES), ref: z.string().nullish(), finding: z.string().min(1), suggestion: z.string().min(1) }).strict())
      .default([]),
    suggestedAcs: z.array(z.object({ text: z.string().min(1), why: z.string().min(1), from: z.string().nullish() }).strict()).default([]),
    openQuestions: z.array(z.string()).default([]),
  })
  .strict();
export type StoryReview = z.infer<typeof StoryReviewSchema>;

export function validateStoryReview(raw: unknown, ids: string[]): { review?: StoryReview; errors: string[] } {
  const p = StoryReviewSchema.safeParse(raw);
  if (!p.success) return { errors: p.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) };
  const errors: string[] = [];
  const known = new Set(ids);
  p.data.findings.forEach((f, i) => f.ref && !known.has(f.ref) && errors.push(`findings[${i}].ref: unknown id ${f.ref} (known: ${ids.join(", ") || "none"})`));
  p.data.suggestedAcs.forEach((a, i) => a.from && !known.has(a.from) && errors.push(`suggestedAcs[${i}].from: unknown id ${a.from}`));
  return errors.length ? { errors } : { review: p.data, errors };
}

export async function reviewStory(i: { cwd: string; c: Config; run: RunDir; engine: AgentEngine; req: RequirementSnapshot; knowledge?: string }): Promise<{ review?: StoryReview; errors: string[]; runs: AgentResult[] }> {
  const out = `${i.run.rel}/story-review.json`;
  const ids = [...i.req.acceptanceCriteria, ...(i.req.scopeItems ?? [])].map((a) => a.id);
  const runs: AgentResult[] = [];
  const ask = (extra: string[] = []) =>
    i.engine.run({
      kind: "story-review",
      cwd: i.cwd,
      prompt: [
        "Use the review-story skill.",
        `The story: ${i.run.rel}/story.md.${i.knowledge ? ` Team domain rules: ${i.knowledge}.` : ""}`,
        i.c.tests.hooks.length
          ? `Test hooks the system already offers (tests.hooks in qa-sentinel.config.yaml): ${i.c.tests.hooks.map((h) => `${h.name} (${h.how})`).join("; ")}.`
          : "The system offers no test hooks yet (tests.hooks in qa-sentinel.config.yaml is empty).",
        `Write your review as JSON to ${out}. That is the only file you may write. Then answer "done".`,
        ...extra,
      ].join("\n"),
      readOnlyDirs: [],
      write: { allowed: [out], blocked: [] },
      bash: [],
      maxTurns: i.c.agent.maxTurns.review,
      maxBudgetUsd: i.c.agent.maxBudgetUsd.review,
      timeoutMs: i.c.agent.timeoutMinutes.review * 60_000,
      env: agentEnv(i.c),
      model: i.c.agent.model,
    });
  const read = () => {
    try {
      return JSON.parse(fs.readFileSync(path.join(i.cwd, out), "utf8"));
    } catch {
      return undefined;
    }
  };
  const first = await ask();
  runs.push(first);
  if (!first.ok) return { errors: [first.status], runs };
  let v = validateStoryReview(read(), ids);
  if (!v.review) {
    runs.push(await ask(["Your previous review was rejected:", ...v.errors.map((e) => `- ${e}`), "Fix these and write the file again."]));
    v = validateStoryReview(read(), ids);
  }
  return { ...v, runs };
}

const LABEL: Record<(typeof FINDING_TYPES)[number], string> = {
  ambiguous: "Ambiguous",
  untestable: "Not testable",
  "missing-negative": "Missing negative case",
  "missing-edge": "Missing edge case",
  "scope-without-ac": "Scope without an AC",
  conflict: "Conflict",
  "missing-nfr": "Missing non-functional need",
  "needs-test-hook": "Needs a test hook",
  other: "Other",
};

/** Plain language for the Jira story (converted to wiki markup when posted). */
export function storyReviewMarkdown(story: string, r: StoryReview): string {
  const lines = [`### QA story review · ${story}`, `Stage: *before development* · ${r.findings.length ? `${r.findings.length} point(s) to clarify` : "no gaps found"}`, "", r.summary];
  if (r.findings.length) {
    lines.push("", "| Where | Point | Finding | Suggestion |", "| --- | --- | --- | --- |");
    for (const f of r.findings) lines.push(`| ${f.ref ?? "story"} | ${LABEL[f.type]} | ${f.finding.replace(/\|/g, "\\|")} | ${f.suggestion.replace(/\|/g, "\\|")} |`);
  }
  if (r.suggestedAcs.length) {
    lines.push("", "**Suggested acceptance criteria** (PO to confirm):");
    r.suggestedAcs.forEach((a, k) => lines.push(`${k + 1}. ${a.text} _(${a.from ? `${a.from}: ` : ""}${a.why})_`));
  }
  if (r.openQuestions.length) lines.push("", "**Questions for the PO:**", ...r.openQuestions.map((q) => `- ${q}`));
  lines.push("", "_Posted by qa-sentinel before development, so gaps are fixed in the story rather than found in testing._");
  return lines.join("\n");
}
