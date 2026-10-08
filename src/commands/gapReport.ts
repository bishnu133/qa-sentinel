import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../config.js";
import { changeSet, isGitRepo } from "../git.js";
import { matchesAny } from "../fsutil.js";
import { formatUsage, runClaude } from "../claude.js";
import { READ_TOOLS, cleanAgentAnswer, createRunDir, findService, readStory } from "../run.js";
import { gitlabContext, gitlabMrFromEnv, upsertMrNote } from "../scm/gitlab.js";
import { log } from "../log.js";

export interface GapReportOptions {
  cwd: string;
  service: string;
  servicePath?: string;
  base?: string;
  head?: string;
  storyFile?: string;
  out?: string;
  post?: boolean;
  dryRun?: boolean;
}

export async function gapReportCommand(o: GapReportOptions): Promise<{ report: string; skipped: boolean }> {
  const cwd = path.resolve(o.cwd);
  const c = loadConfig(cwd);
  const service = findService(c, o.service, cwd, o.servicePath);
  const repo = path.resolve(cwd, service.path);
  if (!isGitRepo(repo)) throw new Error(`${repo} is not a git repository`);

  const mr = gitlabMrFromEnv();
  const base = o.base ?? mr.base ?? `origin/${c.ci.targetBranch}`;
  const head = o.head ?? "HEAD";
  const cs = changeSet(repo, base, head);
  const relevant = cs.files.filter((f) => !matchesAny(f, c.agent.skipPaths));

  const out = path.resolve(cwd, o.out ?? "qa-gap-report.md");
  if (relevant.length === 0) {
    const report = `### QA impact – ${service.name}\nNo test-relevant changes (${cs.files.length} file(s) changed, all docs/config). Nothing to check.`;
    fs.writeFileSync(out, report + "\n");
    log.ok("no test-relevant changes; skipped agent run");
    return { report, skipped: true };
  }

  const run = createRunDir(cwd, `gap-${service.name}`);
  fs.writeFileSync(path.join(run.dir, "change.diff"), cs.diff);
  fs.writeFileSync(path.join(run.dir, "story.md"), readStory({ storyFile: o.storyFile, title: mr.title, description: mr.description }));
  fs.writeFileSync(
    path.join(run.dir, "context.json"),
    JSON.stringify({ kind: "gap-report", service, serviceRepo: service.path, base, head, changedFiles: relevant }, null, 2),
  );
  log.step(`${service.name}: ${relevant.length} relevant file(s) changed; running gap analysis`);

  const prompt = [
    "Use the qa-gap-report skill.",
    `Run context: ${run.rel}/context.json, diff: ${run.rel}/change.diff, story: ${run.rel}/story.md.`,
    "Return ONLY the final markdown report as your answer. Do not modify any files.",
  ].join("\n");

  const res = await runClaude({
    cwd,
    prompt,
    maxTurns: c.agent.maxTurns.gapReport,
    allowedTools: READ_TOOLS,
    addDirs: [path.resolve(cwd, service.path), ...c.workspace.services.filter((s) => service.dependsOn.includes(s.name)).map((s) => path.resolve(cwd, s.path))],
    model: c.agent.model,
    dryRun: o.dryRun,
  });

  if (!res.ok) throw new Error(`Gap analysis failed: ${res.result.slice(0, 500)}`);
  const usage = formatUsage(res);
  const report = `${cleanAgentAnswer(res.result)}\n\n<sub>qa-sentinel gap report${usage ? ` · ${usage}` : ""}</sub>\n`;
  fs.writeFileSync(out, report);
  fs.writeFileSync(path.join(run.dir, "report.md"), report);
  log.ok(`report written to ${path.relative(cwd, out)}${usage ? ` (${usage})` : ""}`);

  if (o.post && !o.dryRun) {
    const ctx = gitlabContext(c.ci.gitlabUrl);
    if (!ctx) log.warn("--post: set QA_SENTINEL_GITLAB_TOKEN (or GITLAB_TOKEN) to comment on the MR");
    else if (!mr.project || !mr.mrIid) log.warn("--post: no merge request context (CI_PROJECT_ID / CI_MERGE_REQUEST_IID) found");
    else {
      const r = await upsertMrNote(ctx, mr.project, mr.mrIid, report);
      log.ok(`MR !${mr.mrIid}: comment ${r.action}`);
    }
  }
  return { report, skipped: false };
}
