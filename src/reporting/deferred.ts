import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { z } from "zod";
import { VERSION, createRunDir, type RunDir } from "../run.js";

/**
 * Deferred publishing (F3). With `--defer-publish`, gap-report and generate do their analysis and leave what they
 * would have published in `<run dir>/publish.json` (and, for generate, the branch as `<run dir>/branch.bundle`).
 * `qa-sentinel publish` reads that and does the writing: it needs the write tokens but no model credentials, while
 * the analysis needs the model key and a read token only. Nothing here calls GitLab or Jira.
 */

export const PUBLISH_FILE = "publish.json";
export const PUBLISHED_FILE = "published.json";
export const BUNDLE_FILE = "branch.bundle";

const KEY = /^[A-Za-z][A-Za-z0-9]*-\d+$/;
const key = z.string().regex(KEY).max(40);
const text = (max: number) => z.string().max(max);
const sha = z.string().regex(/^[0-9a-f]{40}$/);
const oneLine = z.string().max(200).regex(/^[^\r\n]*$/);

/**
 * What a run may hand to the publish job. This file comes from the analysis job, which runs generated code with the
 * model key: it is DATA, not instructions. Every object is strict (an unknown field is refused), and the publish job takes
 * the places it writes to (project, merge request, target branch, remote) from its own configuration and CI variables,
 * never from this file. That is why there is no project, target, base commit, push mode or merge request id here.
 */

/** A report for the MR note and/or the story in Jira: what `publish()` posts. The merge request it goes to is the publish job's own (CI_MERGE_REQUEST_IID). */
const reportStep = z
  .object({
    type: z.literal("report"),
    report: text(400_000),
    jiraSummary: text(400_000).optional(),
    service: oneLine,
    storyKey: key.optional(),
    targets: z.array(z.enum(["gitlab-mr", "jira"])).max(2).optional(),
    stamp: z.string().max(200).regex(/^<!-- qa-sentinel:gap-fp fp=[0-9a-f]+ head=[0-9a-f]+ -->$/).optional(),
  })
  .strict();

const mrSeenStep = z
  .object({
    type: z.literal("mr-seen"),
    args: z.object({ feature: key, workKey: key.optional(), service: oneLine, headSha: z.string().regex(/^[0-9a-f]{7,64}$/).optional(), keys: z.array(key).max(50).optional() }).strict(),
  })
  .strict();

const bugsStep = z.object({ type: z.literal("bugs"), story: key, candidates: z.array(z.record(z.unknown())).max(100) }).strict();

/** A note for the story (Jira): a merge conflict on the story's test branch, and the like. The story's own key only. */
const notifyStep = z
  .object({ type: z.literal("notify"), story: key, event: z.enum(["merge-conflict", "cross-service-tests-ready", "stopped-by-budget"]), text: text(2000), key: oneLine })
  .strict();

/** A note on the open merge request of the story's test branch (the branch is computed from the story key, never named here). */
const branchNoteStep = z.object({ type: z.literal("branch-note"), story: key, marker: z.literal("<!-- qa-sentinel:story-branch-blocked -->"), text: text(4000) }).strict();

/** The test branch and its merge request (generate). */
const mergeRequestStep = z
  .object({
    type: z.literal("merge-request"),
    /** Must be `qa-sentinel/...`; a story branch must be the one the config computes for `storyKey`. */
    branch: oneLine,
    /** The tip of the branch in branch.bundle. */
    headSha: sha,
    /** What the server had for the story branch when the analysis started; a different tip now means "stale, not pushed". */
    expectSha: sha.optional(),
    storyKey: key.optional(),
    title: oneLine,
    description: text(60_000),
    /** Only labels of the shapes qa-sentinel makes are kept (qa-agent, story::, service::, qa-sentinel::, risk::). */
    labels: z.array(oneLine).max(20),
    /** Said in Jira when the merge request exists ({mr} is the merge request URL, {iid} its number). */
    notify: z.object({ story: key, event: z.literal("cross-service-tests-ready"), text: text(500), key: oneLine }).strict().optional(),
    jira: z
      .object({
        storyKey: key.optional(),
        service: oneLine,
        risk: z.string().max(40),
        /** The analysis job's own claim; publish does not run tests. */
        verification: z.string().max(60),
        environment: oneLine.optional(),
        trace: z.array(z.unknown()).max(500),
        acText: z.array(z.tuple([z.string().max(100), z.string().max(4000)])).max(500),
        discrepancies: z.array(z.object({ test: z.string().max(500), note: z.string().max(2000).optional() }).strict()).max(500),
        weakTests: z.number().int().min(0).max(100000).optional(),
        report: text(400_000),
      })
      .strict()
      .optional(),
  })
  .strict();

/**
 * What a story-scoped run leaves in the story record (ACs written or held, what the plan said about each AC, a merge conflict,
 * a fresh start of the branch). In split mode the analysis job only keeps a local copy; the publish job writes the real record
 * (Jira, with automation.record: jira) from this step, after the push.
 */
const recordStep = z
  .object({
    type: z.literal("record"),
    story: key,
    /** The story branch starts again: what the record says was written on the old one no longer holds. */
    reset: z.boolean().optional(),
    entries: z.array(z.object({ ac: z.string().max(100), kind: z.enum(["cross", "single"]), state: z.enum(["written", "held"]), heads: z.string().max(4000), acHash: z.string().max(100), reason: z.string().max(500).optional() }).strict()).max(200).default([]),
    evidence: z.array(z.object({ id: z.string().max(100), status: z.string().max(40), runId: z.string().max(200) }).strict()).max(200).default([]),
    /** The branch took the main branch: any earlier conflict is over. */
    clearConflict: z.boolean().optional(),
    conflict: z.object({ branch: oneLine, message: z.string().max(300), key: oneLine }).strict().optional(),
  })
  .strict();

const publishStep = z.discriminatedUnion("type", [reportStep, mrSeenStep, bugsStep, notifyStep, branchNoteStep, mergeRequestStep, recordStep]);

export const publishFileSchema = z
  .object({ version: z.literal(1), kind: z.enum(["gap-report", "generate"]), runId: z.string().max(200).regex(/^[A-Za-z0-9._-]+$/), createdAt: z.string().max(40), steps: z.array(publishStep).max(50) })
  .strict();

export type ReportStep = z.infer<typeof reportStep>;
export type MrSeenStep = z.infer<typeof mrSeenStep>;
export type BugsStep = z.infer<typeof bugsStep>;
export type NotifyStep = z.infer<typeof notifyStep>;
export type BranchNoteStep = z.infer<typeof branchNoteStep>;
export type RecordStep = z.infer<typeof recordStep>;
export type MergeRequestStep = z.infer<typeof mergeRequestStep>;
export type PublishStep = z.infer<typeof publishStep>;
export type PublishFile = z.infer<typeof publishFileSchema>;

/** Parse publish.json strictly. Throws a short message (no file content) when it is malformed or holds anything unknown. */
export function parsePublishFile(raw: string): PublishFile {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error("publish.json is not valid JSON");
  }
  const r = publishFileSchema.safeParse(json);
  if (!r.success) {
    const i = r.error.issues[0];
    throw new Error(`publish.json is not valid: ${i.path.join(".") || "(top)"}: ${i.message}`);
  }
  return r.data;
}

/** Add steps to a run directory's publish.json (created on the first call). */
export function deferSteps(runDir: string, kind: PublishFile["kind"], runId: string, steps: PublishStep[]): PublishFile {
  const file = path.join(runDir, PUBLISH_FILE);
  let doc: PublishFile = { version: 1, kind, runId, createdAt: new Date().toISOString(), steps: [] };
  try {
    doc = parsePublishFile(fs.readFileSync(file, "utf8"));
  } catch (e) {
    if (fs.existsSync(file)) throw e; // a file that is there but unreadable is an error, never silently started again
  }
  doc.steps.push(...steps);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(doc, null, 2) + "\n");
  return doc;
}

/**
 * A run folder for a note no analysis run owns (the joined comment of a merge request that names several stories, a
 * waiting note). It gets a small manifest, so the note's id can be saved in it (`mr`) and `metrics --online` can count
 * the reactions on that comment too. The outcome is the label ("gap-joined", "gap-waiting").
 */
export function noteRun(cwd: string, kind: PublishFile["kind"], label: string): RunDir {
  const run = createRunDir(cwd, label);
  const now = new Date().toISOString();
  fs.writeFileSync(path.join(run.dir, "manifest.json"), JSON.stringify({ qaSentinelVersion: VERSION, kind, runId: run.id, startedAt: now, finishedAt: now, outcome: label }, null, 2));
  return run;
}

/** For steps with no run of their own (the joined comment of a merge request that names several stories, a waiting note). */
export function deferInNewRun(cwd: string, kind: PublishFile["kind"], label: string, steps: PublishStep[]): string {
  const run = noteRun(cwd, kind, label);
  deferSteps(run.dir, kind, run.id, steps);
  return run.dir;
}

/** `git bundle create` of one branch, with its whole history, so the publish job needs nothing from the analysis job but the artifact. */
export function bundleBranch(cwd: string, runDir: string, branch: string): string {
  const file = path.join(runDir, BUNDLE_FILE);
  execFileSync("git", ["bundle", "create", file, `refs/heads/${branch}`], { cwd, stdio: ["ignore", "pipe", "pipe"] });
  return file;
}
