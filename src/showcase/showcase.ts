import fs from "node:fs";
import path from "node:path";
import type { Config } from "../config.js";
import type { IndexedTest } from "../analysis/testIndex.js";
import { matchResult, type Evidence, type RunResult } from "./results.js";

/**
 * Showcase: once every acceptance criterion of a story has passing tests in a real run, collect that run's
 * evidence (videos and screenshots for UI tests, request/response logs for API tests) and attach it to the story,
 * once. Plain code, no AI: the decision is a rule and the work is file handling.
 */

export interface AcEvidence {
  id: string;
  text?: string;
  status: "passed" | "failed" | "not-run" | "no-test";
  tests: { test: IndexedTest; result?: RunResult }[];
  pending: IndexedTest[];
}

export interface StoryReadiness {
  story: string;
  acs: AcEvidence[];
  ready: boolean;
  blockers: string[];
}

export function assessStory(c: Config, index: IndexedTest[], results: RunResult[], story: string, acs: { id: string; text?: string }[]): StoryReadiness {
  const forStory = index.filter((t) => t.stories.includes(story));
  const blockers: string[] = [];
  const rows: AcEvidence[] = acs.map(({ id, text }) => {
    const tagged = forStory.filter((t) => t.acs.includes(id.toUpperCase()));
    const active = tagged.filter((t) => t.status === "active");
    const pending = tagged.filter((t) => t.status !== "active");
    const tests = active.map((test) => ({ test, result: matchResult(results, test) }));
    let status: AcEvidence["status"];
    if (!active.length) status = "no-test";
    else if (tests.some((x) => x.result?.status === "failed")) status = "failed";
    else if (tests.some((x) => !x.result || x.result.status !== "passed")) status = "not-run";
    else status = "passed";
    if (status === "no-test") blockers.push(`${id} has no passing test tagged @story:${story} @ac:${id}`);
    if (status === "failed") blockers.push(`${id}: ${tests.filter((x) => x.result?.status === "failed").map((x) => `"${x.test.title}"`).join(", ")} failed in this run`);
    if (status === "not-run") blockers.push(`${id}: ${tests.filter((x) => x.result?.status !== "passed").map((x) => `"${x.test.title}"`).join(", ")} did not run in this run`);
    if (pending.length && c.showcase.requireNoPending) blockers.push(`${id}: ${pending.length} test(s) still waiting for a product fix (fixme/skip)`);
    return { id, text, status, tests, pending };
  });
  if (!acs.length) blockers.push(`no acceptance criteria found for ${story}`);
  return { story, acs: rows, ready: blockers.length === 0, blockers };
}

export interface EvidenceFile {
  name: string; // file name in Jira
  data: Buffer;
  contentType: string;
  source?: string;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50);

/** The files to attach: one evidence summary (with API logs inlined) plus videos/screenshots, within limits. */
export function collectEvidence(c: Config, r: StoryReadiness, meta: { environment?: string; commit?: string; runUrl?: string; at: string }): { files: EvidenceFile[]; skipped: string[] } {
  const skipped: string[] = [];
  const want = new Set(c.showcase.kinds);
  const media: { ac: string; test: IndexedTest; ev: Evidence }[] = [];
  const md: string[] = [
    `# ${r.story} – test evidence`,
    "",
    `All ${r.acs.length} acceptance criteria passed${meta.environment ? ` on ${meta.environment.toUpperCase()}` : ""} (${meta.at}).${meta.commit ? ` Test repo commit ${meta.commit.slice(0, 8)}.` : ""}${meta.runUrl ? ` Run: ${meta.runUrl}` : ""}`,
    "",
    "| Acceptance criterion | Test | Result |",
    "| --- | --- | --- |",
  ];
  for (const ac of r.acs) for (const { test, result } of ac.tests) md.push(`| ${ac.id}${ac.text ? `: ${ac.text}` : ""} | ${test.title} (\`${test.file}:${test.line}\`) | ${result?.status ?? "–"} |`);

  const seen = new Set<string>();
  for (const ac of r.acs) {
    for (const { test, result } of ac.tests) {
      for (const ev of result?.evidence ?? []) {
        if (!want.has(ev.kind as any) || seen.has(ev.path) || !fs.existsSync(ev.path)) continue;
        seen.add(ev.path);
        if (ev.kind === "api-log") {
          try {
            const log = JSON.parse(fs.readFileSync(ev.path, "utf8"));
            md.push("", `## ${ac.id} · ${test.title}`, "");
            for (const call of log.calls ?? []) {
              md.push(`**${call.method} ${call.path}** → ${call.status} (${call.ms} ms)`);
              if (call.request !== undefined) md.push("", "```json", JSON.stringify(call.request, null, 2), "```");
              if (call.response !== undefined) md.push("", "```json", JSON.stringify(call.response, null, 2).slice(0, 3000), "```", "");
            }
          } catch {
            skipped.push(`${ev.path}: unreadable api log`);
          }
        } else media.push({ ac: ac.id, test, ev });
      }
    }
  }
  const files: EvidenceFile[] = [{ name: `${r.story}-test-evidence.md`, data: Buffer.from(md.join("\n") + "\n"), contentType: "text/markdown" }];
  const order = c.showcase.kinds;
  media.sort((a, b) => order.indexOf(a.ev.kind as any) - order.indexOf(b.ev.kind as any));
  for (const m of media) {
    const size = fs.statSync(m.ev.path).size;
    if (files.length >= c.showcase.maxFiles) {
      skipped.push(`${m.ev.path}: more than ${c.showcase.maxFiles} files`);
      continue;
    }
    if (size > c.showcase.maxFileMb * 1024 * 1024) {
      skipped.push(`${m.ev.path}: ${(size / 1024 / 1024).toFixed(1)} MB is over ${c.showcase.maxFileMb} MB`);
      continue;
    }
    const ext = path.extname(m.ev.path) || "";
    files.push({ name: `${r.story}-${m.ac}-${slug(m.test.title)}${ext}`, data: fs.readFileSync(m.ev.path), contentType: m.ev.contentType ?? "application/octet-stream", source: m.ev.path });
  }
  return { files, skipped };
}

/** What we store on the issue so the same evidence is never attached twice. */
export interface ShowcaseRecord {
  version: 1;
  attachedAt: string;
  environment?: string;
  commit?: string;
  attachments: { id: string; filename: string }[];
  tests: string[];
}

export const SHOWCASE_PROPERTY = "qa-sentinel.showcase";

export function showcaseComment(r: StoryReadiness, rec: ShowcaseRecord, refreshLabel: string): string {
  return [
    `### ✅ Showcase · ${r.story}`,
    `All ${r.acs.length} acceptance criteria passed${rec.environment ? ` on ${rec.environment.toUpperCase()}` : ""}; the test evidence is attached to this story.`,
    "",
    "| Acceptance criterion | Passing tests |",
    "| --- | --- |",
    ...r.acs.map((a) => `| ${a.id}${a.text ? `: ${a.text.replace(/\s+/g, " ").slice(0, 80)}` : ""} | ${a.tests.length} |`),
    "",
    `Attached: ${rec.attachments.map((a) => a.filename).join(", ")}`,
    "",
    `_Attached once. To attach fresh evidence later, add the label \`${refreshLabel}\` to this story; the next test run replaces it. Posted by qa-sentinel._`,
  ].join("\n");
}
