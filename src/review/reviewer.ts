import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Config } from "../config.js";
import type { AgentEngine, AgentResult } from "../engines/AgentEngine.js";
import type { IndexedTest } from "../analysis/testIndex.js";
import type { RequirementSnapshot } from "../requirements.js";
import { agentEnv, type RunDir } from "../run.js";

/**
 * Independent review of generated tests: a second, read-only agent with a fresh context that never sees the
 * author's notes. It judges each changed test against the acceptance criteria: does it assert the behaviour the
 * AC describes, or only that the endpoint answered? Its output is structured, validated, and advisory: it labels
 * and explains, it never changes the verification status, which comes from running the tests.
 */

const opt = <T extends z.ZodTypeAny>(t: T) => t.nullish().transform((v) => (v === null ? undefined : v)) as unknown as z.ZodOptional<T>;

export const VERDICTS = ["strong", "adequate", "weak", "wrong-oracle"] as const;

export const TestReviewSchema = z
  .object({
    schemaVersion: z.literal(1),
    summary: z.string().min(1),
    tests: z.array(
      z
        .object({
          id: z.string().describe("file:line from the review context"),
          verdict: z.enum(VERDICTS),
          requirementIds: z.array(z.string()).default([]),
          issues: z.array(z.string()).default([]),
          suggestion: opt(z.string()),
        })
        .strict(),
    ),
    missingScenarios: z.array(z.object({ requirementId: opt(z.string()), scenario: z.string() }).strict()).default([]),
  })
  .strict();
export type TestReview = z.infer<typeof TestReviewSchema>;

export interface ReviewOutcome {
  status: "reviewed" | "invalid" | "agent-failed" | "skipped";
  review?: TestReview;
  errors: string[];
  runs: AgentResult[];
}

export function validateReview(raw: unknown, reviewed: IndexedTest[], acIds: string[]): { review?: TestReview; errors: string[] } {
  const parsed = TestReviewSchema.safeParse(raw);
  if (!parsed.success) return { errors: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) };
  const r = parsed.data;
  const errors: string[] = [];
  const ids = new Set(reviewed.map((t) => t.id));
  for (const t of r.tests) {
    if (!ids.has(t.id)) errors.push(`tests: ${t.id} is not one of the tests under review`);
    if ((t.verdict === "weak" || t.verdict === "wrong-oracle") && !t.issues.length) errors.push(`tests: ${t.id} is "${t.verdict}" but names no issue`);
    for (const ac of t.requirementIds) if (acIds.length && !acIds.includes(ac)) errors.push(`tests: ${t.id} cites unknown ${ac}`);
  }
  const missing = [...ids].filter((id) => !r.tests.some((t) => t.id === id));
  if (missing.length) errors.push(`tests: no verdict for ${missing.join(", ")}`);
  return errors.length ? { errors } : { review: r, errors };
}

export async function reviewTests(i: {
  cwd: string;
  c: Config;
  run: RunDir;
  engine: AgentEngine;
  req: RequirementSnapshot;
  tests: IndexedTest[];
  diff: string;
  knowledge?: string;
}): Promise<ReviewOutcome> {
  if (!i.tests.length) return { status: "skipped", errors: [], runs: [] };
  const rel = `${i.run.rel}/review`;
  const dir = path.join(i.cwd, rel);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "tests-under-review.json"), JSON.stringify(i.tests.map(({ id, title, status, acs, endpoints, assertions, statusOnly }) => ({ id, title, status, acs, endpoints, assertions, statusOnly })), null, 2));
  fs.writeFileSync(path.join(dir, "test-changes.diff"), i.diff);
  const out = `${rel}/test-review.json`;
  const runs: AgentResult[] = [];
  const ask = (extra: string[] = []) =>
    i.engine.run({
      kind: "review",
      cwd: i.cwd,
      prompt: [
        "Use the review-tests skill.",
        `Story and acceptance criteria: ${i.run.rel}/story.md. Tests under review: ${rel}/tests-under-review.json. Their diff: ${rel}/test-changes.diff.`,
        ...(i.knowledge ? [`Team domain rules: ${i.knowledge}.`] : []),
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
  const acIds = i.req.acceptanceCriteria.map((a) => a.id);
  const first = await ask();
  runs.push(first);
  if (!first.ok) return { status: "agent-failed", errors: [first.status], runs };
  let v = validateReview(read(), i.tests, acIds);
  if (!v.review) {
    const second = await ask([`Your previous review was rejected:`, ...v.errors.map((e) => `- ${e}`), "Fix these and write the file again."]);
    runs.push(second);
    v = validateReview(read(), i.tests, acIds);
  }
  return v.review ? { status: "reviewed", review: v.review, errors: [], runs } : { status: "invalid", errors: v.errors, runs };
}

const ICON = { strong: "🟢", adequate: "🟡", weak: "🟠", "wrong-oracle": "🔴" } as const;

export function reviewMarkdown(o: ReviewOutcome, tests: IndexedTest[]): string {
  if (o.status === "skipped") return "";
  if (!o.review) return `### Independent test review\n_The reviewer could not produce a valid review (${o.status}${o.errors.length ? `: ${o.errors.slice(0, 3).join("; ")}` : ""}). Review assertions by hand._`;
  const r = o.review;
  const byId = new Map(tests.map((t) => [t.id, t]));
  const counts = VERDICTS.map((v) => [v, r.tests.filter((t) => t.verdict === v).length] as const).filter(([, n]) => n);
  const flagged = r.tests.filter((t) => t.verdict === "weak" || t.verdict === "wrong-oracle");
  const lines = [
    "### Independent test review",
    "_A separate read-only agent checked each changed test against the acceptance criteria. Advisory: it doesn't change the verification result._",
    "",
    `${counts.map(([v, n]) => `${ICON[v]} ${n} ${v}`).join(" · ")} — ${r.summary}`,
  ];
  if (flagged.length) {
    lines.push("", "| Test | Verdict | Issues | Suggestion |", "| --- | --- | --- | --- |");
    for (const t of flagged) {
      const it = byId.get(t.id);
      lines.push(`| \`${t.id}\`${it ? ` ${it.title.replace(/\|/g, "\\|")}` : ""} | ${ICON[t.verdict]} ${t.verdict} | ${t.issues.join("; ").replace(/\|/g, "\\|")} | ${(t.suggestion ?? "").replace(/\|/g, "\\|")} |`);
    }
  }
  if (r.missingScenarios.length) {
    lines.push("", "**Scenarios the reviewer thinks are still missing**");
    for (const m of r.missingScenarios) lines.push(`- ${m.requirementId ? `${m.requirementId}: ` : ""}${m.scenario}`);
  }
  return lines.join("\n");
}
