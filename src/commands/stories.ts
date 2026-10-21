import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../config.js";
import { log } from "../log.js";
import { type Assessment, assessStory, storiesMarkdown, storiesText } from "../stories/assess.js";
import { gatherFacts, inputsFromDir, inputsFromJira, jiraFor, sharedFacts, type StoryInput } from "../stories/gather.js";
import { jobPolicy } from "../stories/jobs.js";
import { type RecordStore, type StoryRecord, SAFE_KEY, emptyRecord } from "../stories/record.js";
import { openStore } from "../stories/start.js";
import { acHash } from "../expected/format.js";
import { gitlabContext } from "../scm/gitlab.js";

export interface StoriesOptions {
  cwd: string;
  /** Check these Jira stories instead of searching. */
  story?: string[];
  /** Read stories from markdown files in this folder instead of Jira. */
  storiesDir?: string;
  /** Print JSON (one object per story) instead of the table. */
  json?: boolean;
  /** Also list the stories that are left alone (opted out, not approved, not a feature). */
  all?: boolean;
  out?: string;
  /** Don't update the story records. */
  noRecord?: boolean;
  env?: NodeJS.ProcessEnv;
  now?: Date;
}

/** What changed in the ACs since the record was last written, in words. */
export function acChanges(prev: StoryRecord["acs"], now: { id: string; hash: string }[]): string[] {
  if (!prev.length) return [];
  const before = new Map(prev.map((a) => [a.id, a.hash]));
  const after = new Map(now.map((a) => [a.id, a.hash]));
  return [
    ...now.filter((a) => before.has(a.id) && before.get(a.id) !== a.hash).map((a) => `${a.id} changed since the last check`),
    ...now.filter((a) => !before.has(a.id)).map((a) => `${a.id} is new since the last check`),
    ...prev.filter((a) => !after.has(a.id)).map((a) => `${a.id} is gone since the last check`),
  ];
}

/** Store what this check saw, only when something differs (a scheduled check must not rewrite every story's record every time). */
async function remember(store: RecordStore, key: string, input: StoryInput, a: Assessment, acs: { id: string; hash: string }[], now: Date): Promise<void> {
  if (!SAFE_KEY.test(key)) return;
  await store.locked(key, async () => {
    const rec = (await store.load(key)) ?? emptyRecord(key, now);
    const jira = input.source === "jira" ? { status: input.status, issueType: input.issueType, url: input.url, labels: input.labels, ...(rec.jira?.updated ? { updated: rec.jira.updated } : {}) } : rec.jira;
    const lastCheck = { at: now.toISOString(), state: a.state, next: a.next, reasons: a.reasons };
    const unchanged = JSON.stringify([rec.jira, rec.acs, rec.lastCheck && { ...rec.lastCheck, at: "" }]) === JSON.stringify([jira, acs, { ...lastCheck, at: "" }]);
    if (unchanged) return;
    // The ACs are only replaced when the story was readable; an unreadable story keeps the last good copy.
    await store.save({ ...rec, jira, acs: acs.length ? acs : rec.acs, lastCheck, updatedAt: now.toISOString() });
  });
}

/**
 * `qa-sentinel stories`: the background check. For each story (given, found by the Jira search, or read from
 * files) it works out where the story stands (expected behaviour, tests, QA tasks) and what comes next, with no AI
 * and no changes to the repo. A scheduled job can run it and act on `--json`; people read the table.
 */
export async function storiesCommand(o: StoriesOptions): Promise<number> {
  if (!o.json) return storiesRun(o);
  // JSON goes to stdout alone, so a pipeline can parse it; progress and warnings go to stderr.
  const out = console.log;
  console.log = console.error;
  try {
    return await storiesRun(o);
  } finally {
    console.log = out;
  }
}

async function storiesRun(o: StoriesOptions): Promise<number> {
  const cwd = path.resolve(o.cwd);
  const c = loadConfig(cwd);
  const env = o.env ?? process.env;
  const now = o.now ?? new Date();
  let inputs: StoryInput[];
  if (o.storiesDir) {
    const dir = path.resolve(cwd, o.storiesDir);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`--stories-dir ${o.storiesDir} is not a folder`);
    inputs = inputsFromDir(c, dir);
  } else if (o.story?.length || c.requirements.source === "jira") {
    const ctx = jiraFor(c, env);
    log.step(o.story?.length ? `checking ${o.story.join(", ")} in Jira` : "searching Jira for stories (requirements.jira.search)");
    inputs = await inputsFromJira(c, ctx, { keys: o.story });
  } else throw new Error('Nothing to check: set requirements.source: jira (and the Jira settings), pass --story KEY, or pass --stories-dir <folder> to read story files.');
  if (!inputs.length) {
    log.ok("no stories found");
    return 0;
  }

  const store = openStore(cwd, c, env);
  const records = await store.list();
  const shared = sharedFacts(cwd, c);
  const gitlab = gitlabContext(c.ci.gitlabUrl, env);
  const policy = jobPolicy(c, {}, env);
  const list: Assessment[] = [];
  const changes = new Map<string, string[]>();
  for (const input of inputs) {
    const facts = await gatherFacts({ cwd, c, store, policy, budgets: c.automation.budgets, records, gitlab, now }, input, shared);
    const a = { ...assessStory(facts), ...(facts.jiraReady !== undefined ? { jiraReady: facts.jiraReady } : {}), ...(facts.services ? { services: facts.services } : {}), ...(facts.unmappedComponents ? { unmappedComponents: facts.unmappedComponents } : {}), ...(facts.resolvedFrom ? { resolvedFrom: facts.resolvedFrom } : {}) };
    list.push(a);
    const acs = facts.acs.map((x) => ({ id: x.id, hash: acHash(x.text) }));
    if (a.state !== "skipped") {
      changes.set(a.key, acChanges(records.find((r) => r.key === a.key)?.acs ?? [], acs));
      if (!o.noRecord) await remember(store, a.key, input, a, acs, now).catch((e) => log.warn(`story record for ${a.key} not updated: ${(e as Error).message}`));
    }
  }
  const shown = o.all ? list : list.filter((a) => a.state !== "skipped");
  const hidden = list.length - shown.length;
  const md = storiesMarkdown(shown, now);
  const outFile = path.resolve(cwd, o.out ?? "qa-stories.md");
  fs.writeFileSync(outFile, md + "\n");
  if (o.json) {
    process.stdout.write(JSON.stringify(shown.map((a) => ({ ...a, changes: changes.get(a.key) ?? [] })), null, 2) + "\n");
    return 0;
  }
  log.title(`Stories: ${list.length} looked at${hidden ? `, ${hidden} left alone (--all lists them)` : ""}`);
  if (shown.length) log.info(storiesText(shown, changes));
  const count = (s: Assessment["state"]) => list.filter((a) => a.state === s).length;
  log.info(`\n${count("covered")} covered · ${count("needs-expectations")} need expected behaviour · ${count("needs-tests")} need tests · ${count("needs-triage")} need QA triage · ${count("needs-attention")} need attention`);
  log.dim(`written to ${path.relative(cwd, outFile)}${store.kind === "jira" || o.noRecord ? "" : `; story records in ${store.where}`}`);
  return 0;
}
