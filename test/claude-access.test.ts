import { describe, expect, it } from "vitest";
import { accessProblem } from "../src/claude.js";

describe("accessProblem", () => {
  it("flags a missing login", () => {
    expect(accessProblem({ is_error: true, terminal_reason: "api_error", result: "Not logged in · Please run /login" })).toMatch(/ANTHROPIC_API_KEY/);
  });
  it("flags a workspace rate limit", () => {
    const json = { is_error: true, api_error_status: 429, terminal_reason: "api_error", result: "API Error: Request rejected (429) · would exceed the rate limit" };
    expect(accessProblem(json)).toMatch(/rate limit/);
  });
  it("leaves normal agent failures alone", () => {
    expect(accessProblem({ is_error: true, subtype: "error_max_turns", num_turns: 30, total_cost_usd: 0.4, result: "" })).toBeUndefined();
    expect(accessProblem({ is_error: false, subtype: "success", result: "done" })).toBeUndefined();
  });
});

import { beforeEach } from "vitest";
import { checkClaudeAccess, resetAccessMemo, staticAccessProblem } from "../src/claude.js";
import type { ProcResult } from "../src/proc.js";

const proc = (o: Partial<ProcResult>): ProcResult => ({ code: 0, stdout: "", stderr: "", timedOut: false, durationMs: 1200, ...o });
const okJson = JSON.stringify({ is_error: false, subtype: "success", result: "OK", total_cost_usd: 0.0004 });
const fake = (r: Partial<ProcResult>) => {
  const calls: string[][] = [];
  return { calls, run: (async (_c: string, args: string[]) => (calls.push(args), proc(r))) as any };
};

describe("staticAccessProblem", () => {
  it("accepts a normal key, a login and a gateway token", () => {
    expect(staticAccessProblem({ ANTHROPIC_API_KEY: "sk-ant-api03-abc" })).toBeUndefined();
    expect(staticAccessProblem({})).toBeUndefined();
    expect(staticAccessProblem({ ANTHROPIC_AUTH_TOKEN: "anything", ANTHROPIC_API_KEY: "gateway-key" })).toBeUndefined();
  });
  it("catches an empty key, a key with a line break or quotes, and one that is not an Anthropic key", () => {
    expect(staticAccessProblem({ ANTHROPIC_API_KEY: "" })).toMatch(/empty/);
    expect(staticAccessProblem({ ANTHROPIC_API_KEY: "sk-ant-abc\n" })).toMatch(/line break/);
    expect(staticAccessProblem({ ANTHROPIC_API_KEY: '"sk-ant-abc"' })).toMatch(/quote/);
    expect(staticAccessProblem({ ANTHROPIC_API_KEY: "abc123" })).toMatch(/unset ANTHROPIC_API_KEY/);
  });
  it("catches Bedrock without a region", () => {
    expect(staticAccessProblem({ CLAUDE_CODE_USE_BEDROCK: "1" })).toMatch(/AWS_REGION/);
  });
});

describe("checkClaudeAccess", () => {
  beforeEach(() => resetAccessMemo());
  const env = { ANTHROPIC_API_KEY: "sk-ant-api03-abc" };

  it("passes on an answer, asks for one turn with no tools, and remembers it", async () => {
    const f = fake({ stdout: okJson });
    const a = await checkClaudeAccess({ cwd: ".", env, run: f.run });
    expect(a).toMatchObject({ ok: true, costUsd: 0.0004 });
    expect(f.calls[0]).toEqual(expect.arrayContaining(["--max-turns", "1", "--tools", ""]));
    const b = await checkClaudeAccess({ cwd: ".", env, run: f.run });
    expect(b).toMatchObject({ ok: true, skipped: "already checked in this run" });
    expect(f.calls).toHaveLength(1);
  });
  it("checks again for another key or model", async () => {
    const f = fake({ stdout: okJson });
    await checkClaudeAccess({ cwd: ".", env, run: f.run });
    await checkClaudeAccess({ cwd: ".", env: { ANTHROPIC_API_KEY: "sk-ant-other" }, run: f.run });
    await checkClaudeAccess({ cwd: ".", env, model: "sonnet", run: f.run });
    expect(f.calls).toHaveLength(3);
  });
  it("does not remember a failure", async () => {
    const bad = fake({ stdout: JSON.stringify({ is_error: true, api_error_status: 401, result: "invalid x-api-key" }) });
    expect((await checkClaudeAccess({ cwd: ".", env, run: bad.run })).ok).toBe(false);
    const good = fake({ stdout: okJson });
    expect((await checkClaudeAccess({ cwd: ".", env, run: good.run })).ok).toBe(true);
  });
  it("reports a rejected key with the fix", async () => {
    const f = fake({ stdout: JSON.stringify({ is_error: true, api_error_status: 401, result: "invalid x-api-key" }) });
    const a = await checkClaudeAccess({ cwd: ".", env, run: f.run });
    expect(a.ok).toBe(false);
    expect(a.message).toMatch(/unset ANTHROPIC_API_KEY/);
  });
  it("reports a silence as a likely credential or network problem, and names the setting", async () => {
    const f = fake({ timedOut: true, code: null, durationMs: 60_000 });
    const a = await checkClaudeAccess({ cwd: ".", env, seconds: 45, run: f.run });
    expect(a.ok).toBe(false);
    expect(a.message).toMatch(/within 45s/);
    expect(a.message).toMatch(/accessCheckSeconds/);
  });
  it("reports a missing claude program", async () => {
    const a = await checkClaudeAccess({ cwd: ".", env, run: fake({ code: null, error: "spawn claude ENOENT" }).run });
    expect(a).toMatchObject({ ok: false });
    expect(a.message).toMatch(/Install Claude Code/);
  });
  it("reports unreadable output", async () => {
    const a = await checkClaudeAccess({ cwd: ".", env, run: fake({ stdout: "<html>proxy login</html>", code: 1 }).run });
    expect(a.ok).toBe(false);
    expect(a.message).toMatch(/unexpected/);
  });
  it("lets a temporary API error through with a warning, without remembering it", async () => {
    const f = fake({ stdout: JSON.stringify({ is_error: true, api_error_status: 529, result: "Overloaded", num_turns: 1, total_cost_usd: 0.001 }) });
    const a = await checkClaudeAccess({ cwd: ".", env, run: f.run });
    expect(a.ok).toBe(true);
    expect(a.warning).toMatch(/Overloaded/);
    await checkClaudeAccess({ cwd: ".", env, run: f.run });
    expect(f.calls).toHaveLength(2);
  });
  it("makes no call when switched off, or when a static problem is found", async () => {
    const f = fake({ stdout: okJson });
    expect(await checkClaudeAccess({ cwd: ".", env, seconds: 0, run: f.run })).toMatchObject({ ok: true, skipped: "switched off" });
    const bad = await checkClaudeAccess({ cwd: ".", env: { ANTHROPIC_API_KEY: "oops" }, run: f.run });
    expect(bad.ok).toBe(false);
    expect(f.calls).toHaveLength(0);
  });
});
