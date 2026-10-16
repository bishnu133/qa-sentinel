import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { ServiceConfig } from "./config.js";
import { git, resolveSha, showFile } from "./git.js";
import { log } from "./log.js";

/**
 * A service's OpenAPI spec at a commit. Committed specs are read from git. Services that generate their spec at build
 * time (tsoa, swagger-jsdoc, springdoc, …) set `openapiCommand`: qa-sentinel checks the commit out in a throwaway
 * worktree, runs the command there and reads the file it writes, so the spec doesn't have to be committed.
 *
 * The command is the team's own build tooling, run by the CLI (never by an agent) with the test environment (no
 * publishing credentials), under a time limit.
 */
const cache = new Map<string, string | undefined>();

export interface SpecOptions {
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export function specAt(repo: string, ref: string, service: Pick<ServiceConfig, "name" | "openapi" | "openapiCommand">, o: SpecOptions): string | undefined {
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
  const spec = generate(repo, sha, service, o);
  cache.set(key, spec);
  return spec;
}

function generate(repo: string, sha: string, service: Pick<ServiceConfig, "name" | "openapi" | "openapiCommand">, o: SpecOptions): string | undefined {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qas-spec-"));
  const short = sha.slice(0, 8);
  try {
    git(repo, ["worktree", "add", "--detach", "--force", dir, sha]);
    // Build tools come from the service's installed dependencies: share them instead of installing per commit.
    for (const deps of ["node_modules"]) {
      const from = path.join(path.resolve(repo), deps);
      const to = path.join(dir, deps);
      if (fs.existsSync(from) && !fs.existsSync(to)) fs.symlinkSync(from, to, "dir");
    }
    const r = spawnSync("sh", ["-c", service.openapiCommand!], { cwd: dir, env: o.env, encoding: "utf8", timeout: o.timeoutMs ?? 180_000, maxBuffer: 32 * 1024 * 1024 });
    const out = path.join(dir, service.openapi!);
    if (r.status !== 0 || !fs.existsSync(out)) {
      const why = r.error ? r.error.message : r.status !== 0 ? `exit ${r.status}: ${(r.stderr || r.stdout || "").trim().split("\n").slice(-3).join(" ")}` : `${service.openapi} was not written`;
      log.warn(`${service.name}@${short}: openapiCommand failed (${why}); no spec for this commit`);
      return undefined;
    }
    return fs.readFileSync(out, "utf8");
  } catch (e) {
    log.warn(`${service.name}@${short}: could not generate the spec (${(e as Error).message.split("\n")[0]})`);
    return undefined;
  } finally {
    try {
      git(repo, ["worktree", "remove", "--force", dir]);
    } catch {
      // already gone
    }
    fs.rmSync(dir, { recursive: true, force: true });
    try {
      git(repo, ["worktree", "prune"]);
    } catch {
      // best effort
    }
  }
}

/** Tests only. */
export function clearSpecCache(): void {
  cache.clear();
}
