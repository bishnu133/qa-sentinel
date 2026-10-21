import path from "node:path";
import { loadConfig } from "../config.js";
import { isGitRepo } from "../git.js";
import { storyKeysBetween } from "../release/git.js";
import { log } from "../log.js";

/**
 * `qa-sentinel release-features --tag v3.4 [--from v3.3]` (no AI): which stories a release contains, by the story
 * keys in the commit messages of each service repo between two tags. The answer to "what is on UAT?" before a
 * release is tested.
 */
export function releaseFeaturesCommand(o: { cwd: string; tag: string; from?: string; json?: boolean }): number {
  const cwd = path.resolve(o.cwd);
  const c = loadConfig(cwd);
  if (!c.workspace.services.length) throw new Error("No workspace.services in the config: nothing to look in");
  const by = new Map<string, Map<string, number>>();
  const notes: string[] = [];
  for (const s of c.workspace.services) {
    const repo = path.resolve(cwd, s.path);
    if (!isGitRepo(repo)) {
      notes.push(`${s.name}: ${repo} is not a git repository`);
      continue;
    }
    try {
      for (const k of storyKeysBetween(repo, o.from, o.tag, c.requirements.storyKeyPattern)) by.set(k.key, (by.get(k.key) ?? new Map()).set(s.name, k.commits.length));
    } catch (e) {
      notes.push(`${s.name}: ${(e as Error).message.split("\n")[0]}`);
    }
  }
  const rows = [...by].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true })).map(([story, svc]) => ({ story, services: Object.fromEntries(svc) }));
  if (o.json) {
    process.stdout.write(JSON.stringify({ tag: o.tag, from: o.from, stories: rows, notes }, null, 2) + "\n");
    return 0;
  }
  log.title(`${o.tag}${o.from ? ` (since ${o.from})` : ""}: ${rows.length} stor${rows.length === 1 ? "y" : "ies"}`);
  for (const r of rows) log.info(`${r.story}  ${Object.entries(r.services).map(([s, n]) => `${s} (${n})`).join(", ")}`);
  notes.forEach((n) => log.warn(n));
  return 0;
}
