import fs from "node:fs";
import path from "node:path";
import type { Config } from "../config.js";
import { type IndexedTest, indexTests, traceStory } from "../analysis/testIndex.js";
import { assembleFeature } from "../feature/manifest.js";
import { expectedDirOf } from "../expected/lock.js";
import { acHash, readExpected } from "../expected/format.js";
import { acsNeedingProposal } from "../expected/spec.js";
import { readManualCards } from "../manualTests.js";
import { extractStoryKey, isFeature, jiraIssueText, parseStoryFor } from "../requirements.js";
import { type GitLabContext } from "../scm/gitlab.js";
import { fetchIssue, jiraContext, searchStories, storiesJql, type FoundStory, type JiraContext } from "../scm/jira.js";
import type { CodeState, StoryFacts } from "./assess.js";
import { type JobPolicy, type Budgets, budgetStatus, digest, jobGate, MIN_USEFUL_USD, specJobKey } from "./jobs.js";
import { type RecordStore, type StoryRecord } from "./record.js";
import { log } from "../log.js";

/** One story as read from its source, before anything is worked out about it. */
export interface StoryInput {
  key: string;
  title?: string;
  status?: string;
  issueType?: string;
  labels: string[];
  url?: string;
  /** The story as markdown (summary, description, AC field), parsed with the project's story template. Empty for stories skipped before reading. */
  text: string;
  source: "jira" | "story-file";
}

const same = (a: string | undefined, b: string) => (a ?? "").toLowerCase() === b.toLowerCase();

export function isApprovedStatus(c: Config, status: string | undefined): boolean {
  return c.requirements.jira.approvedStatuses.some((s) => same(status, s));
}

/** Would this story be left alone, judging by what the search already says (so its text needn't be fetched)? */
export function skippedBeforeReading(c: Config, f: { status?: string; issueType?: string; labels: string[] }): boolean {
  const s = c.requirements.jira.search;
  const has = (l: string) => f.labels.some((x) => same(x, l));
  return s.skipLabels.some(has) || (s.onlyLabels.length > 0 && !s.onlyLabels.some(has)) || !isFeature(c, { issueType: f.issueType }) || !isApprovedStatus(c, f.status);
}

/** Stories from Jira: the given keys, or what the search (requirements.jira.search) finds. */
export async function inputsFromJira(c: Config, ctx: JiraContext, o: { keys?: string[] }): Promise<StoryInput[]> {
  const j = c.requirements.jira;
  const fetchOne = async (key: string): Promise<StoryInput> => {
    const issue = await fetchIssue(ctx, key, j.acceptanceCriteriaField, j.scopeFields.map((f) => f.field));
    return { key: issue.key, title: issue.summary, status: issue.status, issueType: issue.issueType, labels: issue.labels ?? [], url: issue.url, text: jiraIssueText(c, issue), source: "jira" };
  };
  if (o.keys?.length) return Promise.all(o.keys.map((k) => fetchOne(k.toUpperCase())));
  // Statuses are filtered here, not in the JQL: a status name the workflow doesn't have makes Jira reject the whole query.
  const jql = j.search.jql ?? storiesJql({ projectKeys: j.projectKeys, statuses: [], issueTypes: j.featureIssueTypes, lookbackDays: j.search.lookbackDays });
  const found = await searchStories(ctx, jql, { max: j.search.maxStories, api: j.search.api });
  const out: StoryInput[] = [];
  for (const f of found) {
    if (skippedBeforeReading(c, f)) out.push({ key: f.key, title: f.summary, status: f.status, issueType: f.issueType, labels: f.labels, url: `${ctx.baseUrl}/browse/${f.key}`, text: "", source: "jira" });
    else out.push(await fetchOne(f.key));
  }
  return out;
}

/** Stories from markdown files in a folder (no Jira): the key comes from the file name or the first heading. */
export function inputsFromDir(c: Config, dir: string): StoryInput[] {
  const out: StoryInput[] = [];
  for (const name of fs.readdirSync(dir).filter((n) => n.endsWith(".md")).sort()) {
    const text = fs.readFileSync(path.join(dir, name), "utf8");
    const title = text.match(/^#\s+(.+)$/m)?.[1];
    const key = extractStoryKey(c.requirements.storyKeyPattern, name, title, text);
    if (!key) {
      log.warn(`${name}: no story key found (${c.requirements.storyKeyPattern}); skipped`);
      continue;
    }
    out.push({ key, title: title?.replace(new RegExp(`^${key}\\s*:?\\s*`), ""), labels: [], text, source: "story-file" });
  }
  return out;
}

export function jiraFor(c: Config, env: NodeJS.ProcessEnv = process.env): JiraContext {
  const ctx = jiraContext(c.requirements.jira.baseUrl, env);
  if (!ctx) throw new Error("Jira is not set up here: set requirements.jira.baseUrl and JIRA_EMAIL + JIRA_API_TOKEN (Cloud) or JIRA_PAT (Server/Data Center). Or pass --stories-dir to read stories from files.");
  return ctx;
}

async function codeState(c: Config, cwd: string, key: string, gitlab: GitLabContext | undefined): Promise<CodeState> {
  const reachable = c.workspace.services.some((s) => fs.existsSync(path.resolve(cwd, s.path)) || (gitlab && s.gitlabProject));
  if (!reachable) return "unknown";
  try {
    const m = await assembleFeature({ c, cwd, story: key, gitlab });
    return m.status === "no-changes-found" ? "none" : m.status === "in-development" ? "unmerged" : "merged";
  } catch {
    return "unknown";
  }
}

export interface GatherContext {
  cwd: string;
  c: Config;
  store: RecordStore;
  policy: JobPolicy;
  budgets: Budgets;
  records: StoryRecord[];
  gitlab?: GitLabContext;
  now?: Date;
}

/** Everything `assessStory` needs for one story. Reads only; nothing is changed. */
export async function gatherFacts(g: GatherContext, input: StoryInput, shared: { index: IndexedTest[]; manual: ReturnType<typeof readManualCards> }): Promise<StoryFacts> {
  const { c, cwd } = g;
  const now = g.now ?? new Date();
  const key = input.key;
  const approved = input.source === "story-file" ? true : isApprovedStatus(c, input.status);
  const feature = isFeature(c, { issueType: input.issueType });
  const s = c.requirements.jira.search;
  const skipping = skippedBeforeReading(c, { status: input.status, issueType: input.issueType, labels: input.labels }) && input.source === "jira";
  const acs = skipping || !input.text ? [] : parseStoryFor(c, input.text).acceptanceCriteria.map((a) => ({ id: a.id, text: a.text }));
  const base = { key, title: input.title, source: input.source, url: input.url, status: input.status, approved, issueType: input.issueType, isFeature: feature, labels: input.labels, skipLabels: s.skipLabels, onlyLabels: s.onlyLabels, acs, expectationsMode: c.tests.expectations };
  if (skipping || !acs.length) return { ...base, expected: {}, trace: [], code: "unknown", limits: {} };

  let expected: StoryFacts["expected"] = {};
  try {
    const file = readExpected(cwd, expectedDirOf(c.tests.expectedDir), key.toUpperCase());
    expected = file ? { file } : {};
  } catch (e) {
    expected = { error: (e as Error).message };
  }
  const trace = traceStory(shared.index, key, acs, shared.manual).acs;
  const code = await codeState(c, cwd, key, g.gitlab);

  // What would stop an AI step from starting: its own job, or the budget.
  const rec = g.records.find((r) => r.key === key) ?? (await g.store.load(key));
  const hashes = acs.map((a) => acHash(a.text));
  const limits: StoryFacts["limits"] = {};
  const needed = expected.error ? [] : acsNeedingProposal(expected.file, acs).filter((a) => a.needsProposal);
  if (needed.length) {
    const jk = specJobKey(key, needed.map((a) => acHash(a.text)));
    const gate = jobGate(jk, rec?.jobs[jk], g.policy, now);
    if (!gate.ok) limits.spec = gate.reason === "done" ? `the requirements pass already ran for these ACs (${rec!.jobs[jk].outcome ?? "done"}) but its result is not in ${c.tests.expectedDir}/ on this branch: was the file committed and merged?` : gate.message;
  }
  const bs = (kind: "spec" | "generate") => budgetStatus(g.budgets, g.records, rec, MIN_USEFUL_USD[kind], now).message;
  limits.spec ??= needed.length ? bs("spec") : undefined;
  const acDigest = digest([...hashes].sort());
  const gens = Object.values(rec?.jobs ?? {}).filter((j) => j.kind === "generate" && j.key.endsWith(`:${acDigest}`));
  const failed = gens.find((j) => j.state === "failed" && j.attempts >= g.policy.maxAttempts);
  if (failed) limits.generate = `${failed.key} failed ${failed.attempts} times (last: ${failed.outcome ?? failed.error ?? "unknown"}); fix the cause or run with --force`;
  limits.generate ??= bs("generate");
  const generateSettled = gens.some((j) => j.state === "done" && j.outcome === "no-changes-needed");
  return { ...base, expected, trace, code, limits: Object.fromEntries(Object.entries(limits).filter(([, v]) => v)), generateSettled };
}

export function sharedFacts(cwd: string, c: Config) {
  return { index: indexTests(cwd, c), manual: readManualCards(cwd, c.tests.manualDir) };
}
