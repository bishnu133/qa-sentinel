/**
 * The bench workspace for one scenario: the base orders service with the developer's change committed on top, and a
 * test repo (qa-sentinel init + the base tests + the scenario's extras). Used by the gap-report benchmark (run.ts)
 * and the generation benchmark (generateBench.ts).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { BASE_SERVICE, BASE_TESTS, type Scenario } from "./scenarios.js";
import { initCommand } from "../src/commands/init.js";
import { quietly } from "./quiet.js";

export const write = (root: string, files: Record<string, string | null>) => {
  for (const [rel, content] of Object.entries(files)) {
    const f = path.join(root, rel);
    if (content === null) fs.rmSync(f, { force: true });
    else {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, content);
    }
  }
};
export const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
export const commitAll = (cwd: string, msg: string) => {
  git(cwd, "add", "-A");
  git(cwd, "-c", "user.email=bench@x", "-c", "user.name=bench", "commit", "-qm", msg);
};

export interface Workspace {
  ws: string;
  svc: string;
  tests: string;
}

/** Build the workspace in a new temp folder. Throws when a scenario's change does not change the base (a replace that did not match). */
export async function buildWorkspace(s: Scenario, prefix = "qas-bench"): Promise<Workspace> {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-${s.id}-`));
  const svc = path.join(ws, "orders-service");
  const tests = path.join(ws, "qa-tests");
  fs.mkdirSync(svc);
  fs.mkdirSync(tests);
  write(svc, BASE_SERVICE);
  git(svc, "init", "-q", "-b", "main");
  commitAll(svc, "base");
  write(svc, s.change);
  for (const [f, c] of Object.entries(s.change)) {
    if (c !== null && BASE_SERVICE[f] === c) throw new Error(`${s.id}: change to ${f} is identical to the base (a replace did not match)`);
  }
  commitAll(svc, `${s.id}: developer change`);

  await quietly(() => initCommand({ cwd: tests, yes: true, mode: "scratch", ci: "gitlab", workspace: ws, name: "bench" }));
  write(tests, { ...BASE_TESTS, ...(s.tests ?? {}) });
  if (s.story) write(tests, { "story.md": s.story });
  git(tests, "init", "-q", "-b", "main");
  commitAll(tests, "tests");
  return { ws, svc, tests };
}
