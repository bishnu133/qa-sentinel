import type { Config } from "../config.js";
import { gitlabContext, type gitlabMrFromEnv, upsertMrNote } from "../scm/gitlab.js";
import { capForJira, jiraContext, markdownToJiraWiki } from "../scm/jira.js";
import { postToStory } from "./statusComment.js";
import { log } from "../log.js";

/** The last line of the gap report note on a merge request: how reviewers say whether it helped (counted by `metrics --online`). */
export const VOTE_LINE = "<sub>Was this useful? 👍 / 👎 on this comment</sub>";

/**
 * Publish the report to every configured target. Publishing never fails the job: a missing token, MR or
 * story key is a warning, because the report itself is already written and kept as a CI artifact.
 */
export async function publish(
  c: Config,
  i: { /** Told which note was written on the merge request (project, iid, note id), so a run can remember it for the usefulness votes. */ onMrNote?: (n: { project: string; iid: string; noteId: number }) => void; report: string; jiraSummary?: string; service: string; storyKey?: string; /** Where the story record is, for the basis. */ cwd?: string; /** Hidden stamp for the MR comment only (see plan/fingerprint.ts). */ stamp?: string; mr: Partial<ReturnType<typeof gitlabMrFromEnv>>; targets?: Config["reporting"]["targets"] },
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  const done: string[] = [];
  for (const target of i.targets ?? c.reporting.targets) {
    try {
      if (target === "gitlab-mr") {
        const ctx = gitlabContext(c.ci.gitlabUrl, env);
        if (!ctx) log.warn("--post (gitlab-mr): set QA_SENTINEL_GITLAB_TOKEN (or GITLAB_TOKEN) to comment on the MR");
        else if (!i.mr.project || !i.mr.mrIid) log.warn("--post (gitlab-mr): no merge request context (CI_PROJECT_ID / CI_MERGE_REQUEST_IID)");
        else {
          const withVotes = c.reporting.votes ? `${i.report}\n${VOTE_LINE}\n` : i.report;
          const r = await upsertMrNote(ctx, i.mr.project, i.mr.mrIid, i.stamp ? `${withVotes}\n${i.stamp}\n` : withVotes);
          log.ok(`MR !${i.mr.mrIid}: comment ${r.action}`);
          if (typeof r.id === "number") i.onMrNote?.({ project: String(i.mr.project), iid: String(i.mr.mrIid), noteId: r.id });
          done.push("gitlab-mr");
        }
      } else if (target === "jira") {
        const ctx = jiraContext(c.requirements.jira, env);
        if (!ctx) log.warn("--post (jira): set requirements.jira.baseUrl and JIRA_EMAIL + JIRA_API_TOKEN (Cloud) or JIRA_PAT (Server/DC)");
        else if (!i.storyKey) log.warn("--post (jira): no story key found in the MR title, branch or commits; nothing to comment on");
        else {
          const artifact = env.CI_JOB_URL ? `${env.CI_JOB_URL}/artifacts/file/qa-gap-report.md` : undefined;
          const source = c.reporting.jira.format === "summary" && i.jiraSummary ? i.jiraSummary : i.report;
          const body = capForJira(markdownToJiraWiki(source), c.reporting.jira.maxChars, artifact);
          const r = await postToStory(c, ctx, i.storyKey, { name: `gap-report:${i.service}`, wiki: body, legacyKind: i.service, cwd: i.cwd, env });
          if (r.action === "skipped") log.warn(`Jira ${i.storyKey}: nothing posted (see the warning above)`);
          else {
            log.ok(`Jira ${i.storyKey}: comment ${r.action} (${r.url})`);
            done.push("jira");
          }
        }
      }
    } catch (e) {
      log.warn(`--post (${target}) failed: ${(e as Error).message}`);
    }
  }
  return done;
}
