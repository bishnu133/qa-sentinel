import fs from "node:fs";
import path from "node:path";
import type { Config } from "../config.js";
import { git } from "../git.js";
import { indexSource } from "../analysis/testIndex.js";
import { openMrsWithLabel, type GitLabContext } from "../scm/gitlab.js";
import { fetchBranch, remoteFor } from "./storyBranch.js";

/**
 * Per-merge generation (generation.scope: service) opens one merge request for each merge, and none of them knows the
 * others: the second would write the tests the first is about to add. So before planning, the open merge requests of the
 * QA agent (label qa-agent) in the test repo are listed with the spec files they ADD; the planner is told, and a
 * "create" of a file one of them adds is rejected in code.
 */
export interface OpenAgentMr {
  iid: number;
  url: string;
  branch: string;
  /** Files the merge request adds (not on the main branch). */
  added: string[];
  /** Tests in those files: file and title. */
  tests: { file: string; title: string }[];
}

export async function listOpenAgentMrs(cwd: string, c: Config, o: { gitlab: GitLabContext; project: string | number; ownBranch: string; env?: NodeJS.ProcessEnv }): Promise<OpenAgentMr[]> {
  const mrs = (await openMrsWithLabel(o.gitlab, o.project, "qa-agent")).filter((m) => m.source_branch !== o.ownBranch);
  const remote = remoteFor(c, o.env ?? process.env);
  const target = fetchBranch(cwd, remote, c.ci.targetBranch);
  const targetRef = target.sha ? target.ref : c.ci.targetBranch;
  const out: OpenAgentMr[] = [];
  for (const m of mrs) {
    const b = fetchBranch(cwd, remote, m.source_branch);
    if (!b.sha) continue;
    let added: string[] = [];
    try {
      added = git(cwd, ["-c", "core.quotePath=false", "diff", "--relative", "--name-only", "--diff-filter=A", `${targetRef}...${b.ref}`]).split("\n").filter(Boolean);
    } catch {
      continue;
    }
    const tests = added.flatMap((f) => {
      try {
        return indexSource(f, git(cwd, ["show", `${b.ref}:./${f}`])).map((t) => ({ file: f, title: t.title }));
      } catch {
        return [];
      }
    });
    out.push({ iid: m.iid, url: m.web_url, branch: m.source_branch, added, tests });
  }
  return out;
}

/** The files the open merge requests add, by normalised path → "!12". The first merge request to add a file owns it. */
export function addedFiles(mrs: OpenAgentMr[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of mrs) for (const f of m.added) if (!out.has(path.posix.normalize(f))) out.set(path.posix.normalize(f), `!${m.iid}`);
  return out;
}

export function openAgentMrsMarkdown(mrs: OpenAgentMr[]): string {
  if (!mrs.length) return "# Open QA agent merge requests\n\nNone. Nothing is waiting to be merged.\n";
  return [
    "# Open QA agent merge requests",
    "",
    "These merge requests are not merged yet, so their tests are not on the main branch. They will be. Do not plan the same tests again; for a `create` decision set `targetFile`, and do not use a file listed here.",
    "",
    ...mrs.flatMap((m) => [`## !${m.iid} ${m.branch}`, "", m.url, "", "Adds:", ...(m.added.length ? m.added.map((f) => `- ${f}`) : ["- (no new files)"]), ...(m.tests.length ? ["", "Tests in them:", ...m.tests.map((t) => `- ${t.file}: ${t.title}`)] : []), ""]),
  ].join("\n");
}

export function writeOpenAgentMrs(runDir: string, mrs: OpenAgentMr[]): string {
  const file = path.join(runDir, "open-agent-mrs.md");
  fs.writeFileSync(file, openAgentMrsMarkdown(mrs));
  return file;
}
