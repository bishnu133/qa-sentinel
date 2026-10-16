import { z } from "zod";

/** Where a service's agreed API spec lives (spec-first teams). Kept apart from contracts.ts so config.ts imports no I/O code. */
export const ContractSourceSchema = z
  .object({
    /** A file next to the tests (relative to the test repo) or an absolute path. */
    file: z.string().optional(),
    /** A local clone of a specs repository (relative to the test repo), with `path` inside it and an optional `ref`. */
    repo: z.string().optional(),
    /** A GitLab project holding the spec (e.g. group/api-specs), with `path` and an optional `ref` (default: main). */
    gitlabProject: z.string().optional(),
    path: z.string().optional(),
    ref: z.string().optional(),
    /** A URL serving the spec. `urlHeaderEnv` names an environment variable holding an Authorization header value. */
    url: z.string().url().optional(),
    urlHeaderEnv: z.string().optional(),
    /** An attachment on the Jira story, by file name glob, e.g. "orders-api*.yaml". */
    jiraAttachment: z.string().optional(),
  })
  .superRefine((s, ctx) => {
    const sources = ["file", "repo", "gitlabProject", "url", "jiraAttachment"].filter((k) => s[k as keyof typeof s] !== undefined);
    if (sources.length !== 1) ctx.addIssue({ code: "custom", message: `contract: set exactly one of file, repo, gitlabProject, url, jiraAttachment (got ${sources.join(", ") || "none"})` });
    if ((s.repo || s.gitlabProject) && !s.path) ctx.addIssue({ code: "custom", message: "contract: repo and gitlabProject need `path` (the spec file inside that repository)" });
    if (s.ref && !(s.repo || s.gitlabProject)) ctx.addIssue({ code: "custom", message: "contract: ref only applies with repo or gitlabProject" });
    if (s.urlHeaderEnv && !s.url) ctx.addIssue({ code: "custom", message: "contract: urlHeaderEnv only applies with url" });
  });
export type ContractSource = z.infer<typeof ContractSourceSchema>;
