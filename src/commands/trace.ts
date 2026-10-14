import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../config.js";
import { buildTestIndex, checkTestMap, readTestMap, traceMarkdown, traceStory } from "../analysis/testIndex.js";
import { parseAcceptanceCriteria } from "../requirements.js";
import { log } from "../log.js";

export interface TraceOptions {
  cwd: string;
  story?: string;
  storyFile?: string;
  json?: boolean;
}

/**
 * `qa-sentinel trace`: the test index built from tags, its consistency with test-map.yaml and, for a story,
 * which tests prove each acceptance criterion.
 */
export async function traceCommand(o: TraceOptions): Promise<number> {
  const cwd = path.resolve(o.cwd);
  const c = loadConfig(cwd);
  const index = buildTestIndex(cwd, c.tests.api.dir);
  const mapFindings = checkTestMap(index, readTestMap(cwd), cwd);
  const acs = o.storyFile ? parseAcceptanceCriteria(fs.readFileSync(path.resolve(cwd, o.storyFile), "utf8")) : [];
  const story = o.story ?? (o.storyFile ? fs.readFileSync(path.resolve(cwd, o.storyFile), "utf8").match(new RegExp(c.requirements.storyKeyPattern))?.[0] : undefined);
  // Without a story file, list the ACs the tests themselves claim for this story.
  const acList = acs.length ? acs : [...new Set(index.filter((t) => story && t.stories.includes(story)).flatMap((t) => t.acs))].sort().map((id) => ({ id, text: "" }));
  const trace = traceStory(index, story, acList);

  if (o.json) {
    process.stdout.write(JSON.stringify({ tests: index, testMap: mapFindings, story, trace }, null, 2) + "\n");
    return 0;
  }
  const tagged = index.filter((t) => t.endpoints.length).length;
  const withAc = index.filter((t) => t.acs.length).length;
  const pending = index.filter((t) => t.status !== "active").length;
  log.title(`Test index: ${index.length} tests in ${new Set(index.map((t) => t.file)).size} files`);
  log.info(`  @endpoint tags: ${tagged}/${index.length} · @ac tags: ${withAc}/${index.length} · fixme/skip: ${pending}`);
  if (mapFindings.length) {
    log.title("test-map.yaml vs test tags");
    for (const f of mapFindings) log[f.level === "warning" ? "warn" : "dim"](`${f.file}: ${f.message}`);
  } else log.ok("test-map.yaml agrees with the test tags");
  if (story) {
    log.title(`Traceability for ${story}`);
    log.info(traceMarkdown(story, trace) || `no acceptance criteria found for ${story}; pass --story-file`);
  }
  return mapFindings.some((f) => f.level === "warning") ? 2 : 0;
}
