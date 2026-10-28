import type { Config } from "../config.js";
import { currentUser, getRepo, githubContext } from "./github.js";

interface GhCheck {
  level: "ok" | "warn" | "fail";
  label: string;
  hint?: string;
}

/** `doctor --online` on GitHub: proves the token reaches the test repo and may push to it. Not yet run against real GitHub. */
export async function githubOnlineChecks(c: Config, env: NodeJS.ProcessEnv): Promise<GhCheck[]> {
  const ctx = githubContext(c.ci.githubApiUrl, env);
  if (!ctx) return [{ level: "fail", label: "GitHub token available for online checks", hint: "set QA_SENTINEL_GITHUB_TOKEN" }];
  const checks: GhCheck[] = [];
  try {
    const u = await currentUser(ctx);
    checks.push({ level: "ok", label: `GitHub token works (user ${u.login})` });
  } catch (e) {
    // The workflow token (GITHUB_TOKEN) may not read /user; that is not a failure by itself.
    checks.push({ level: "warn", label: "GitHub /user not readable with this token", hint: `${(e as Error).message.slice(0, 120)} (normal for the Actions GITHUB_TOKEN; the repository check below decides)` });
  }
  if (!c.ci.testRepoProject) return checks;
  try {
    const r = await getRepo(ctx, c.ci.testRepoProject);
    if (r.permissions && r.permissions.push === false) checks.push({ level: "fail", label: `test repo (${c.ci.testRepoProject}): write access to push branches and open PRs`, hint: "the token has no push permission" });
    else checks.push({ level: "ok", label: `test repo (${c.ci.testRepoProject}) reachable` });
  } catch (e) {
    checks.push({ level: "fail", label: `test repo (${c.ci.testRepoProject}) reachable with the token`, hint: (e as Error).message.slice(0, 160) });
  }
  return checks;
}
