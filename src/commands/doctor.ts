import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { CONFIG_FILE, configPath, loadConfig } from "../config.js";
import { claudeAvailable } from "../claude.js";
import { isGitRepo } from "../git.js";
import { log } from "../log.js";
import { SECRET_NAME } from "../env.js";
import { currentUser, getProject, gitlabContext } from "../scm/gitlab.js";

type Level = "ok" | "warn" | "fail";
export interface Check {
  level: Level;
  label: string;
  hint?: string;
}

export function runChecks(cwd: string, env: NodeJS.ProcessEnv = process.env): Check[] {
  const checks: Check[] = [];
  const add = (level: Level, label: string, hint?: string) => checks.push({ level, label, hint });

  if (!fs.existsSync(configPath(cwd))) {
    add("fail", `${CONFIG_FILE} present`, "run `qa-sentinel init`");
    return checks;
  }
  let c;
  try {
    c = loadConfig(cwd);
    add("ok", `${CONFIG_FILE} valid`);
  } catch (e) {
    add("fail", `${CONFIG_FILE} valid`, (e as Error).message);
    return checks;
  }

  const claude = claudeAvailable();
  if (claude.ok) add("ok", `Claude Code CLI (${claude.version})`);
  else add("fail", "Claude Code CLI installed", "npm i -g @anthropic-ai/claude-code");

  if (env.ANTHROPIC_API_KEY) add("ok", "ANTHROPIC_API_KEY set");
  else add("warn", "ANTHROPIC_API_KEY set", "required in CI; locally `claude` may use your login");

  isGitRepo(cwd) ? add("ok", "test repo is a git repository") : add("fail", "test repo is a git repository", "git init");

  for (const f of [".claude/agents/change-analyzer.md", ".claude/skills/qa-gap-report/SKILL.md", ".claude/skills/write-api-test/SKILL.md"]) {
    fs.existsSync(path.join(cwd, f)) ? add("ok", `${f}`) : add("fail", `${f}`, "rerun `qa-sentinel init --force`");
  }

  const skill = path.join(cwd, ".claude/skills/write-api-test/SKILL.md");
  if (fs.existsSync(skill) && fs.readFileSync(skill, "utf8").includes("<!-- conventions:pending -->")) {
    add("warn", "conventions learned", "run `qa-sentinel learn` and review the result");
  }

  if (c.workspace.services.length === 0) add("warn", "services configured", "add workspace.services in the config");
  for (const s of c.workspace.services) {
    const dir = path.resolve(cwd, s.path);
    if (!fs.existsSync(dir)) add("fail", `service ${s.name}: ${s.path} exists`, "check the path or clone the repo into the workspace");
    else if (!isGitRepo(dir)) add("fail", `service ${s.name}: is a git repo`);
    else if (!s.openapi) add("warn", `service ${s.name}: OpenAPI spec`, "add one (or `openapi:` path) for much better API tests");
    else if (!fs.existsSync(path.join(dir, s.openapi))) add("warn", `service ${s.name}: ${s.openapi} found`);
    else add("ok", `service ${s.name} (OpenAPI: ${s.openapi})`);
  }

  const mapFile = path.join(cwd, "test-map.yaml");
  if (!fs.existsSync(mapFile)) add("warn", "test-map.yaml present", "run `qa-sentinel learn`");
  else {
    const map = YAML.parse(fs.readFileSync(mapFile, "utf8")) ?? {};
    const services = Object.values<any>(map.services ?? {});
    const mapped = services.filter((s) => Object.keys(s?.endpoints ?? {}).length > 0).length;
    const level: Level = services.length && mapped === services.length ? "ok" : "warn";
    add(level, `test-map: ${mapped}/${services.length} services have endpoints mapped`, level === "warn" ? "run `qa-sentinel learn`" : undefined);
  }

  if (env[c.tests.api.baseUrlEnv]) add("ok", `${c.tests.api.baseUrlEnv} set`);
  else add("warn", `${c.tests.api.baseUrlEnv} set`, "needed for the agent to run tests against your QA environment");

  if (c.ci.scm === "gitlab") {
    if (env.QA_SENTINEL_GITLAB_TOKEN || env.GITLAB_TOKEN) add("ok", "GitLab token set");
    else add("warn", "GitLab token set", "QA_SENTINEL_GITLAB_TOKEN with api scope, to post MR comments and open MRs");
    if (!c.ci.testRepoProject) add("warn", "ci.testRepoProject configured", "e.g. my-group/qa-tests, used to open MRs");
  }

  if (c.requirements.source === "none") add("warn", "requirements source", "without stories/AC, tests only check what the code does");

  const leaked = Object.keys(env).filter((k) => c.guardrails.passEnv.includes(k) && SECRET_NAME.test(k));
  if (leaked.length) add("warn", `passEnv forwards credential-like variables to agents: ${leaked.join(", ")}`, "only list what generated tests truly need");
  if (c.guardrails.allowedWritePaths.some((g) => g === "**" || g === "**/*")) add("fail", "guardrails.allowedWritePaths is not a catch-all", "list the test, helper and fixture folders explicitly");
  if (c.workspace.services.length && c.ci.scm === "gitlab" && c.workspace.services.some((s) => !s.gitlabProject)) {
    add("warn", "services have gitlabProject set", "needed after merge to fetch the MR's acceptance criteria (or set QA_SERVICE_PROJECT in CI)");
  }
  return checks;
}

/** Calls GitLab to prove the token can reach the projects, rather than only checking a variable exists. */
export async function onlineChecks(cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<Check[]> {
  const checks: Check[] = [];
  const c = loadConfig(cwd);
  const ctx = gitlabContext(c.ci.gitlabUrl, env);
  if (!ctx) return [{ level: "fail", label: "GitLab token available for online checks", hint: "set QA_SENTINEL_GITLAB_TOKEN" }];
  try {
    const u = await currentUser(ctx);
    checks.push({ level: "ok", label: `GitLab token works (user ${u.username})` });
  } catch (e) {
    return [{ level: "fail", label: "GitLab token accepted", hint: (e as Error).message.slice(0, 200) }];
  }
  const targets = [
    ...(c.ci.testRepoProject ? [{ label: "test repo", project: c.ci.testRepoProject, needWrite: true }] : []),
    ...c.workspace.services.filter((s) => s.gitlabProject).map((s) => ({ label: `service ${s.name}`, project: s.gitlabProject!, needWrite: false })),
  ];
  for (const t of targets) {
    try {
      const p = await getProject(ctx, t.project);
      const level = Math.max(p.permissions?.project_access?.access_level ?? 0, p.permissions?.group_access?.access_level ?? 0);
      if (t.needWrite && level < 30) checks.push({ level: "fail", label: `${t.label} (${t.project}): Developer access to push branches and open MRs`, hint: `token has access level ${level}` });
      else checks.push({ level: "ok", label: `${t.label} (${t.project}) reachable` });
    } catch (e) {
      checks.push({ level: "fail", label: `${t.label} (${t.project}) reachable with the token`, hint: (e as Error).message.slice(0, 160) });
    }
  }
  checks.push({
    level: "warn",
    label: "CI job-token allowlists cannot be checked from here",
    hint: "in each service project: Settings › CI/CD › Job token permissions › allow the test repo (and vice versa)",
  });
  return checks;
}

export async function doctorCommand(cwd: string, o: { online?: boolean } = {}): Promise<number> {
  log.title("qa-sentinel doctor");
  const checks = runChecks(path.resolve(cwd));
  if (o.online && !checks.some((c) => c.level === "fail" && c.label.includes("valid"))) checks.push(...(await onlineChecks(path.resolve(cwd))));
  for (const ch of checks) {
    const line = ch.hint ? `${ch.label}  — ${ch.hint}` : ch.label;
    if (ch.level === "ok") log.ok(line);
    else if (ch.level === "warn") log.warn(line);
    else log.fail(line);
  }
  const fails = checks.filter((c) => c.level === "fail").length;
  const warns = checks.filter((c) => c.level === "warn").length;
  log.info(`\n${fails} failing, ${warns} warning(s).`);
  return fails > 0 ? 1 : 0;
}
