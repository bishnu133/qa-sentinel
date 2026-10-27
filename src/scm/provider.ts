/**
 * One face for the CI provider (GitLab or GitHub): the few things the core flow needs from a merge/pull request.
 * `ci.provider` picks it; the default is GitLab, so nothing changes for existing setups. Each method is a thin
 * adapter over src/scm/gitlab.ts or src/scm/github.ts (no logic is copied). Commands not listed here still use
 * GitLab only (README, "GitHub").
 */
import type { Config } from "../config.js";
import * as gl from "./gitlab.js";
import * as gh from "./github.js";

export type CiProvider = "gitlab" | "github";

/** What the running CI job says about its merge/pull request (GitLab CI_* variables, or GitHub Actions variables and event payload). */
export interface ChangeRequestEnv {
  project?: string;
  mrIid?: string;
  base?: string;
  targetBranch?: string;
  title?: string;
  description?: string;
  sourceBranch?: string;
  url?: string;
}

export interface ChangeRequestOptions {
  source: string;
  target: string;
  title: string;
  description: string;
  labels?: string[];
}

export interface ChangeRequestRef {
  iid: number;
  web_url: string;
  /** "opened", "merged" or "closed" on both providers. */
  state: string;
  title?: string;
}

export interface Scm {
  kind: CiProvider;
  /** "merge request" or "pull request", for messages. */
  noun: string;
  /** A token was found (QA_SENTINEL_*_TOKEN, GITLAB_TOKEN / GITHUB_TOKEN). The API methods need it. */
  hasToken: boolean;
  mrFromEnv(env?: NodeJS.ProcessEnv): ChangeRequestEnv;
  /** The project the test repo lives in (ci.testRepoProject, else the job's own project). */
  testProject(env?: NodeJS.ProcessEnv): string | undefined;
  getNoteBody(project: string | number, id: string | number): Promise<string | undefined>;
  upsertNote(project: string | number, id: string | number, body: string): Promise<{ action: "created" | "updated"; id: number }>;
  upsertMarkedNote(project: string | number, id: string | number, marker: string, body: string): Promise<"created" | "updated" | "same">;
  isDraft(project: string | undefined, id: string | undefined, titleFromEnv: string | undefined): Promise<boolean>;
  createOrUpdateChangeRequest(project: string | number, o: ChangeRequestOptions): Promise<{ web_url: string; iid: number; action: "created" | "updated" }>;
  latestForBranch(project: string | number, source: string, target?: string): Promise<ChangeRequestRef | undefined>;
  /** Normalised reaction names on a comment: "thumbsup", "thumbsdown", others as the provider names them. */
  noteReactions(project: string | number, id: string | number, noteId: number): Promise<{ name: string }[]>;
  /** HTTPS push URL with the token in it (built at push time only), or undefined. */
  pushUrl(projectPath: string | undefined, env?: NodeJS.ProcessEnv): string | undefined;
  /** The job's own project path for pushing (CI_PROJECT_PATH, GITHUB_REPOSITORY). */
  envProjectPath(env?: NodeJS.ProcessEnv): string | undefined;
  /** Files a change request touches. GitHub only so far (undefined on GitLab). */
  changedFiles?(project: string | number, id: string | number): Promise<{ path: string; status: string }[]>;
  /** Base and head commits and branches of a change request. GitHub only so far. */
  diffRefs?(project: string | number, id: string | number): Promise<{ baseSha: string; headSha: string; targetBranch: string; sourceBranch: string }>;
}

/** The provider the config asks for. `ci.provider` wins; the older `ci.scm: github` is read as the same choice. */
export function ciProvider(c: Pick<Config, "ci">): CiProvider {
  return c.ci.provider ?? (c.ci.scm === "github" ? "github" : "gitlab");
}

function gitlabScm(c: Config, env: NodeJS.ProcessEnv): Scm {
  const ctx = gl.gitlabContext(c.ci.gitlabUrl, env);
  const need = (): gl.GitLabContext => {
    if (!ctx) throw new Error("no GitLab token (QA_SENTINEL_GITLAB_TOKEN or GITLAB_TOKEN)");
    return ctx;
  };
  return {
    kind: "gitlab",
    noun: "merge request",
    hasToken: !!ctx,
    mrFromEnv: (e = env) => gl.gitlabMrFromEnv(e),
    testProject: (e = env) => c.ci.testRepoProject ?? e.CI_PROJECT_ID,
    getNoteBody: (p, id) => gl.getMrNoteBody(need(), p, id),
    upsertNote: (p, id, body) => gl.upsertMrNote(need(), p, id, body),
    upsertMarkedNote: (p, id, marker, body) => gl.upsertMarkedNote(need(), p, id, marker, body),
    isDraft: (p, id, title) => gl.mrIsDraft(ctx, p, id, title),
    createOrUpdateChangeRequest: (p, o) => gl.createOrUpdateMergeRequest(need(), p, o),
    latestForBranch: (p, s, t) => gl.latestMrForBranch(need(), p, s, t),
    noteReactions: async (p, id, noteId) => (await gl.noteAwards(need(), p, id, noteId)).map((a) => ({ name: a.name })),
    pushUrl: (path, e = env) => gl.pushUrl(c.ci.gitlabUrl, path, e),
    envProjectPath: (e = env) => e.CI_PROJECT_PATH,
  };
}

function githubScm(c: Config, env: NodeJS.ProcessEnv): Scm {
  const ctx = gh.githubContext(c.ci.githubApiUrl, env);
  const need = (): gh.GitHubContext => {
    if (!ctx) throw new Error("no GitHub token (QA_SENTINEL_GITHUB_TOKEN or GITHUB_TOKEN)");
    return ctx;
  };
  return {
    kind: "github",
    noun: "pull request",
    hasToken: !!ctx,
    mrFromEnv: (e = env) => gh.githubPrFromEnv(e),
    testProject: (e = env) => c.ci.testRepoProject ?? e.GITHUB_REPOSITORY,
    getNoteBody: (p, id) => gh.getPrCommentBody(need(), p, id),
    upsertNote: (p, id, body) => gh.upsertPrComment(need(), p, id, body),
    upsertMarkedNote: (p, id, marker, body) => gh.upsertMarkedPrComment(need(), p, id, marker, body),
    isDraft: (p, id, title) => gh.prIsDraft(ctx, p, id, title),
    createOrUpdateChangeRequest: (p, o) => gh.createOrUpdatePullRequest(need(), p, o),
    latestForBranch: (p, s, t) => gh.latestPrForBranch(need(), p, s, t),
    // GitHub's names for the two reactions are "+1" and "-1".
    noteReactions: async (p, _id, noteId) => (await gh.commentReactions(need(), p, noteId)).map((r) => ({ name: r.content === "+1" ? "thumbsup" : r.content === "-1" ? "thumbsdown" : r.content })),
    pushUrl: (path, e = env) => gh.githubPushUrl(ctx?.serverUrl ?? "https://github.com", path, e),
    envProjectPath: (e = env) => e.GITHUB_REPOSITORY,
    changedFiles: async (p, id) => (await gh.prFiles(need(), p, id)).map((f) => ({ path: f.filename, status: f.status })),
    diffRefs: (p, id) => gh.prDiffRefs(need(), p, id),
  };
}

/** The Scm for this config and environment. Always returns one; `hasToken` says whether API calls can be made. */
export function scmFor(c: Config, env: NodeJS.ProcessEnv = process.env): Scm {
  return ciProvider(c) === "github" ? githubScm(c, env) : gitlabScm(c, env);
}

/** For commands that only work on GitLab: a clear stop instead of a silent no-op when the config says GitHub. */
export function requireGitlab(c: Pick<Config, "ci">, what: string): void {
  if (ciProvider(c) === "github") throw new Error(`${what} works with GitLab only for now (ci.provider is github). See README, "GitHub".`);
}
