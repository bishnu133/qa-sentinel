import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { ServiceConfig } from "./config.js";
import { repoPrefix, resolveSha, showFile } from "./git.js";
import { runProcess } from "./proc.js";
import { log } from "./log.js";

/**
 * A service's OpenAPI spec at a commit. Committed specs are read from git. Services that generate their spec at build
 * time (tsoa, swagger-jsdoc, NestJS, …) set `openapiCommand`: qa-sentinel checks the commit out in a throwaway worktree,
 * runs the command in the service's folder there and reads the file it writes, so the spec doesn't have to be committed.
 *
 * The command comes from the team's config but runs on the MR's code, so it gets the test environment (no publishing
 * credentials), git hooks are off for the checkout, and the whole process group is killed at the time limit.
 */
const cache = new Map<string, string | undefined>();

export interface SpecOptions {
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

type SpecService = Pick<ServiceConfig, "name" | "openapi" | "openapiCommand">;

export async function specAt(repo: string, ref: string, service: SpecService, o: SpecOptions): Promise<string | undefined> {
  if (!service.openapi) return undefined;
  if (!service.openapiCommand) return showFile(repo, ref, service.openapi);
  let sha: string;
  try {
    sha = resolveSha(repo, ref);
  } catch {
    return undefined;
  }
  const key = `${path.resolve(repo)}@${sha}@${service.openapiCommand}@${service.openapi}`;
  if (cache.has(key)) return cache.get(key);
  const spec = await generate(repo, sha, service, o);
  cache.set(key, spec);
  return spec;
}

/** git with hooks off and only the scrubbed environment: a checkout must not run the MR's hooks with CI secrets. */
function quietGit(repo: string, args: string[], env: NodeJS.ProcessEnv): string {
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd: repo,
    encoding: "utf8",
    env: { ...env, GIT_LFS_SKIP_SMUDGE: "1", GIT_TERMINAL_PROMPT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** node_modules in the service folder or any folder up to the repository root (workspaces hoist them). */
function linkDependencies(repo: string, dir: string, prefix: string): void {
  const parts = prefix ? prefix.split("/") : [];
  for (let i = parts.length; i >= 0; i--) {
    const rel = parts.slice(0, i).join("/");
    const root = path.resolve(repo, ...Array(parts.length).fill(".."));
    const from = path.join(root, rel, "node_modules");
    const to = path.join(dir, rel, "node_modules");
    if (fs.existsSync(from) && !fs.existsSync(to) && fs.existsSync(path.dirname(to))) fs.symlinkSync(from, to, "dir");
  }
}

async function generate(repo: string, sha: string, service: SpecService, o: SpecOptions): Promise<string | undefined> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qas-spec-"));
  const short = sha.slice(0, 8);
  // A service that is a folder of a monorepo: the worktree has the whole repository, the command runs in the folder.
  const prefix = repoPrefix(repo);
  const where = path.join(dir, prefix);
  try {
    quietGit(repo, ["worktree", "add", "--detach", "--force", dir, sha], o.env);
    linkDependencies(repo, dir, prefix);
    const r = await runProcess(service.openapiCommand!, [], { cwd: where, env: o.env, timeoutMs: o.timeoutMs ?? 180_000, shell: true });
    const out = path.join(where, service.openapi!);
    if (r.timedOut || r.code !== 0 || !fs.existsSync(out)) {
      const why = r.timedOut ? `no result within ${Math.round((o.timeoutMs ?? 180_000) / 1000)} s` : r.code !== 0 ? `exit ${r.code}: ${(r.stderr || r.stdout || "").trim().split("\n").slice(-3).join(" ")}` : `${service.openapi} was not written`;
      log.warn(`${service.name}@${short}: openapiCommand failed (${why}); no spec for this commit`);
      return undefined;
    }
    return fs.readFileSync(out, "utf8");
  } catch (e) {
    log.warn(`${service.name}@${short}: could not generate the spec (${(e as Error).message.split("\n")[0]})`);
    return undefined;
  } finally {
    try {
      quietGit(repo, ["worktree", "remove", "--force", dir], o.env);
    } catch {
      // already gone
    }
    fs.rmSync(dir, { recursive: true, force: true });
    try {
      quietGit(repo, ["worktree", "prune"], o.env);
    } catch {
      // best effort
    }
  }
}

/** Tests only. */
export function clearSpecCache(): void {
  cache.clear();
}
