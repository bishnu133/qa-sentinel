import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Config } from "../config.js";
import { gitlabToken } from "../scm/gitlab.js";
import { log } from "../log.js";
import { redact } from "../generation/storyBranch.js";

/**
 * A scheduled CI job starts with the test repo only, but a story's code lives in the service repos. This clones each
 * service that has a `gitlabProject` and is not at its configured `path` yet, then removes the remote so no token stays
 * in `.git/config` where an agent could read it. Services that are already there are left alone.
 */
export interface CloneResult {
  cloned: string[];
  skipped: string[];
  failed: string[];
}

export interface CloneOptions {
  /** Where a project is cloned from (tests point this at local folders). Default: the GitLab server with the CI job token, else the GitLab token. */
  urlFor?: (project: string) => string | undefined;
}

export function serviceCloneUrl(c: Config, project: string, env: NodeJS.ProcessEnv): string | undefined {
  const host = new URL(env.CI_SERVER_URL ?? c.ci.gitlabUrl);
  const user = env.CI_JOB_TOKEN ? { name: "gitlab-ci-token", token: env.CI_JOB_TOKEN } : gitlabToken(env) ? { name: "oauth2", token: gitlabToken(env)! } : undefined;
  if (!user) return undefined;
  return `${host.protocol}//${user.name}:${encodeURIComponent(user.token)}@${host.host}/${project.replace(/^\/|\.git$/g, "")}.git`;
}

export function cloneServices(c: Config, cwd: string, env: NodeJS.ProcessEnv = process.env, o: CloneOptions = {}): CloneResult {
  const out: CloneResult = { cloned: [], skipped: [], failed: [] };
  for (const s of c.workspace.services) {
    if (!s.gitlabProject) continue;
    const dest = path.resolve(cwd, s.path);
    if (fs.existsSync(path.join(dest, ".git"))) {
      out.skipped.push(s.name);
      continue;
    }
    const url = o.urlFor ? o.urlFor(s.gitlabProject) : serviceCloneUrl(c, s.gitlabProject, env);
    if (!url) {
      out.failed.push(`${s.name} (no CI_JOB_TOKEN or QA_SENTINEL_GITLAB_TOKEN to clone with)`);
      continue;
    }
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      execFileSync("git", ["clone", "-q", url, dest], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env, GIT_TERMINAL_PROMPT: "0" } });
      // The clone is for reading: its remote (and with it the token) goes, as in the generate job.
      execFileSync("git", ["-C", dest, "remote", "remove", "origin"], { stdio: "ignore" });
      out.cloned.push(s.name);
    } catch (e) {
      out.failed.push(`${s.name} (${redact((e as Error).message.split("\n")[0])})`);
      log.dim(`  ${s.name}: ${redact((e as Error).message.split("\n").slice(0, 2).join(" "))}`);
    }
  }
  return out;
}
