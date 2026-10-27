import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentEngine, AgentTask } from "../../src/engines/AgentEngine.js";
import { checkPaths, type WritePolicy } from "../../src/guardrails.js";
import { workingChanges } from "../../src/git.js";

/**
 * A conformance kit for agent engines: the same four tasks against any AgentEngine. The tasks tell the engine what to do on the
 * first line of the prompt ("MODE ..."), which a scripted engine (test/fixtures/engine-fixture.mjs) obeys exactly. A real AI
 * engine would not follow it to the letter; for one, read these as the four situations it has to handle correctly:
 *   1. read-only task: answers, changes nothing.
 *   2. write inside the policy: the change passes qa-sentinel's path guardrail.
 *   3. write outside the policy: the engine is not trusted; qa-sentinel's guardrail (checkPaths) flags the file afterwards.
 *   4. limits: a cost over the budget, too many turns, a program that outlives its time, and output that is not a result are
 *      reported as max-budget, max-turns, timeout and error, never as ok.
 */

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };

export function scratchRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qas-engine-repo-"));
  const git = (...a: string[]) => execFileSync("git", ["-c", "commit.gpgsign=false", ...a], { cwd: dir, env: GIT_ENV, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  fs.mkdirSync(path.join(dir, "tests"));
  fs.writeFileSync(path.join(dir, "tests", "keep.spec.ts"), "// x\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  return dir;
}

export const POLICY: WritePolicy = { allowed: ["tests/**"], blocked: [] };

export function taskFor(cwd: string, prompt: string, o: Partial<AgentTask> = {}): AgentTask {
  return { kind: "plan", cwd, prompt, readOnlyDirs: [], bash: [], maxTurns: 10, maxBudgetUsd: 1, timeoutMs: 20_000, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" }, ...o };
}

export function describeEngineConformance(label: string, make: () => AgentEngine, o: { skipTimeout?: boolean } = {}): void {
  describe(`engine conformance: ${label}`, () => {
    it("1. read-only plan: ok, a result, no file changed", async () => {
      const repo = scratchRepo();
      const r = await make().run(taskFor(repo, "MODE plan\nPlan the tests."));
      expect(r).toMatchObject({ ok: true, status: "ok", result: "plan for plan" });
      expect(workingChanges(repo)).toEqual([]);
    });

    it("2. write within the policy: the change is there and the guardrail accepts it", async () => {
      const repo = scratchRepo();
      const r = await make().run(taskFor(repo, "MODE write tests/new.spec.ts", { kind: "author", write: POLICY }));
      expect(r.ok).toBe(true);
      const changes = workingChanges(repo);
      expect(changes.map((c) => c.path)).toEqual(["tests/new.spec.ts"]);
      expect(checkPaths(changes, POLICY)).toEqual([]);
    });

    it("3. write outside the policy: the guardrail rejects it (the engine's own permissions are only a second layer)", async () => {
      const repo = scratchRepo();
      await make().run(taskFor(repo, "MODE write src/app.ts", { kind: "author", write: POLICY }));
      const findings = checkPaths(workingChanges(repo), POLICY);
      expect(findings.map((f) => [f.file, f.rule, f.level])).toEqual([["src/app.ts", "outside-allowed", "violation"]]);
    });

    it("4a. a cost over the budget is max-budget, not ok", async () => {
      const r = await make().run(taskFor(scratchRepo(), "MODE over-budget", { maxBudgetUsd: 0.5 }));
      expect(r).toMatchObject({ ok: false, status: "max-budget", costUsd: 1.5 });
    });

    it("4b. more turns than allowed is max-turns", async () => {
      const r = await make().run(taskFor(scratchRepo(), "MODE too-many-turns", { maxTurns: 4 }));
      expect(r).toMatchObject({ ok: false, status: "max-turns", turns: 9 });
    });

    it.skipIf(o.skipTimeout)("4c. a program that outlives the time limit is stopped: timeout", async () => {
      const t0 = Date.now();
      const r = await make().run(taskFor(scratchRepo(), "MODE sleep", { timeoutMs: 1000 }));
      expect(r).toMatchObject({ ok: false, status: "timeout" });
      expect(Date.now() - t0).toBeLessThan(25_000);
    });

    it("4d. output that is not a result (text, wrong shape, non-zero exit) is an error", async () => {
      for (const mode of ["garbage", "bad-shape", "exit3"]) {
        const r = await make().run(taskFor(scratchRepo(), `MODE ${mode}`));
        expect(r.ok, mode).toBe(false);
        expect(r.status, mode).toBe("error");
      }
    });
  });
}
