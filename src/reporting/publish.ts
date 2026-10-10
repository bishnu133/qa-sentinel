import type { Config } from "../config.js";
import { gitlabContext, type gitlabMrFromEnv, upsertMrNote } from "../scm/gitlab.js";
import { capForJira, jiraContext, markdownToJiraWiki, upsertIssueComment } from "../scm/jira.js";
import { log } from "../log.js";

/**
 * Publish the report to every configured target. Publishing never fails the job: a missing token, MR or
 * story key is a warning, because the report itself is already written and kept as a CI artifact.
 */
export async function publish(
  c: Config,
  i: { report: string; jiraSummary?: string; service: string; storyKey?: string; mr: Partial<ReturnType<typeof gitlabMrFromEnv>>; targets?: Config["reporting"]["targets"] },
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  const done: string[] = [];
  for (const target of i.targets ?? c.reporting.targets) {
    try {
      if (target === "gitlab-mr") {
        const ctx = gitlabContext(c.ci.gitlabUrl);
        if (!ctx) log.warn("--post (gitlab-mr): set QA_SENTINEL_GITLAB_TOKEN (or GITLAB_TOKEN) to comment on the MR");
        else if (!i.mr.project || !i.mr.mrIid) log.warn("--post (gitlab-mr): no merge request context (CI_PROJECT_ID / CI_MERGE_REQUEST_IID)");
        else {
          const r = await upsertMrNote(ctx, i.mr.project, i.mr.mrIid, i.report);
          log.ok(`MR !${i.mr.mrIid}: comment ${r.action}`);
          done.push("gitlab-mr");
        }
      } else if (target === "jira") {
        const ctx = jiraContext(c.requirements.jira.baseUrl, env);
        if (!ctx) log.warn("--post (jira): set requirements.jira.baseUrl and JIRA_EMAIL + JIRA_API_TOKEN (Cloud) or JIRA_PAT (Server/DC)");
        else if (!i.storyKey) log.warn("--post (jira): no story key found in the MR title, branch or commits; nothing to comment on");
        else {
          const artifact = env.CI_JOB_URL ? `${env.CI_JOB_URL}/artifacts/file/qa-gap-report.md` : undefined;
          const source = c.reporting.jira.format === "summary" && i.jiraSummary ? i.jiraSummary : i.report;
          const body = capForJira(markdownToJiraWiki(source), c.reporting.jira.maxChars, artifact);
          const r = await upsertIssueComment(ctx, i.storyKey, i.service, body, c.reporting.jira.visibility);
          log.ok(`Jira ${i.storyKey}: comment ${r.action} (${r.url})`);
          done.push("jira");
        }
      }
    } catch (e) {
      log.warn(`--post (${target}) failed: ${(e as Error).message}`);
    }
  }
  return done;
}
