import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { describe, expect, it } from "vitest";
import { initCommand } from "../src/commands/init.js";
import { runChecks } from "../src/commands/doctor.js";
import { ConfigSchema, loadConfig } from "../src/config.js";
import { ENGINE_CONTRACT_VERSION, CommandEngine, parseEngineOutput, taskJson } from "../src/engines/CommandEngine.js";
import { engineFor } from "../src/engines/ClaudeCodeEngine.js";
import { runProcess } from "../src/proc.js";
import { scratchRepo, taskFor } from "./helpers/engineConformance.js";

const fixture = path.resolve(__dirname, "fixtures/engine-fixture.mjs");
const cmd = `${JSON.stringify(process.execPath)} ${JSON.stringify(fixture)}`;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "qas-ceng-"));
const limits = { maxTurns: 10, maxBudgetUsd: 1 };

describe("command engine: reading the result", () => {
  it("accepts a full result, and derives ok / status from each other", () => {
    expect(parseEngineOutput('{"ok":true,"status":"ok","result":"r","costUsd":0.5,"turns":3,"durationMs":9,"denials":[1]}', 0, limits)).toEqual({ ok: true, status: "ok", result: "r", costUsd: 0.5, turns: 3, durationMs: 9, denials: [1] });
    expect(parseEngineOutput('{"result":"r"}', 0, limits)).toMatchObject({ ok: true, status: "ok" });
    expect(parseEngineOutput('{"ok":false,"result":"r"}', 0, limits)).toMatchObject({ ok: false, status: "error" });
    expect(parseEngineOutput('{"status":"timeout","result":"r"}', 0, limits)).toMatchObject({ ok: false, status: "timeout" });
    expect(parseEngineOutput('{"ok":false,"status":"ok","result":"r"}', 0, limits)).toMatchObject({ ok: false, status: "error" });
  });
  it("takes the last JSON object when the program logged first", () => {
    expect(parseEngineOutput('log line\n{"x":\nmore\n{"result":"last"}\n', 0, limits).result).toBe("last");
  });
  it("is never ok for a non-zero exit, a cost over the budget or too many turns", () => {
    expect(parseEngineOutput('{"ok":true,"result":"r"}', 2, limits)).toMatchObject({ ok: false, status: "error", result: expect.stringContaining("exited with code 2") });
    expect(parseEngineOutput('{"result":"r","costUsd":1.01}', 0, limits)).toMatchObject({ ok: false, status: "max-budget" });
    expect(parseEngineOutput('{"result":"r","costUsd":1}', 0, limits)).toMatchObject({ ok: true });
    expect(parseEngineOutput('{"result":"r","turns":11}', 0, limits)).toMatchObject({ ok: false, status: "max-turns" });
  });
  it("says what is wrong with output that is not a result, without throwing", () => {
    expect(parseEngineOutput("", 0, limits)).toMatchObject({ ok: false, status: "error", result: expect.stringContaining("no JSON object") });
    expect(parseEngineOutput("[1,2]", 0, limits).status).toBe("error");
    expect(parseEngineOutput('{"result":5,"costUsd":-1}', 0, limits).result).toContain("not an AgentResult");
    expect(parseEngineOutput('{"status":"fancy"}', 0, limits).status).toBe("error");
  });
});

describe("command engine: running it", () => {
  it("gives the task on stdin and as {taskFile}; the JSON has env names, never values; the file is removed after", async () => {
    const repo = scratchRepo();
    const task = taskFor(repo, "MODE inspect", { env: { PATH: process.env.PATH ?? "", MY_TOKEN: "super-secret-value", ANTHROPIC_API_KEY: "sk-ant-x", CLAUDE_CODE_USE_BEDROCK: "1" } });
    const json = taskJson(task);
    expect(json).toMatchObject({ version: ENGINE_CONTRACT_VERSION, kind: "plan", cwd: repo, write: null, envNames: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_USE_BEDROCK", "MY_TOKEN", "PATH"] });
    expect(JSON.stringify(json)).not.toContain("super-secret-value");
    expect(JSON.stringify(json)).not.toContain("sk-ant-x");
    const eng = new CommandEngine({ command: `${cmd} {taskFile}` });
    const r = await eng.run(task);
    const seen = JSON.parse(r.result);
    expect(seen).toMatchObject({ version: 1, fileMatchesStdin: true, leaksValue: false, hasPathEnv: true });
    // Claude's own credentials do not go to a foreign program unless the team lists them in guardrails.passEnv.
    expect(seen.hasAnthropicKey).toBe(false);
    const listed = JSON.parse((await new CommandEngine({ command: cmd, passEnv: ["ANTHROPIC_API_KEY"] }).run(task)).result);
    expect(listed.hasAnthropicKey).toBe(true);
    expect(fs.realpathSync(seen.cwd)).toBe(fs.realpathSync(repo));
  });

  it("puts the command inside verification.wrapCommand, like the test commands", async () => {
    const eng = new CommandEngine({ command: "my-engine {taskFile}", wrapCommand: "sh -c {cmd}" });
    expect(eng.commandLine("/tmp/it's/task.json")).toBe(`sh -c 'my-engine '\\''/tmp/it'\\''\\'\\'''\\''s/task.json'\\'''`);
    // and it still runs, with the output and the exit code coming through
    const r = await new CommandEngine({ command: cmd, wrapCommand: "sh -c {cmd}" }).run(taskFor(scratchRepo(), "MODE plan"));
    expect(r.ok).toBe(true);
    const bad = await new CommandEngine({ command: `${cmd}`, wrapCommand: "sh -c {cmd}" }).run(taskFor(scratchRepo(), "MODE exit3"));
    expect(bad.status).toBe("error");
  });

  it("refuses to run when agent.sandbox is on but nothing isolates the program", async () => {
    const eng = new CommandEngine({ command: cmd, sandbox: { enabled: true, failIfUnavailable: true } });
    const r = await eng.run(taskFor(scratchRepo(), "MODE plan"));
    expect(r).toMatchObject({ ok: false, status: "error", result: expect.stringContaining("verification.wrapCommand") });
    expect((await new CommandEngine({ command: cmd, sandbox: { enabled: true, failIfUnavailable: true }, wrapCommand: "sh -c {cmd}" }).run(taskFor(scratchRepo(), "MODE plan"))).ok).toBe(true);
    expect((await new CommandEngine({ command: cmd, sandbox: { enabled: true, failIfUnavailable: false } }).run(taskFor(scratchRepo(), "MODE plan"))).ok).toBe(true);
  });

  it("dry run shows the command and runs nothing", async () => {
    const repo = scratchRepo();
    const r = await new CommandEngine({ command: `${cmd} {taskFile}` }).run(taskFor(repo, "MODE write tests/x.spec.ts", { dryRun: true }));
    expect(r.result).toContain("dry run");
    expect(fs.existsSync(path.join(repo, "tests/x.spec.ts"))).toBe(false);
  });

  it("noise before the JSON is fine; a missing program is an error with a message", async () => {
    expect((await new CommandEngine({ command: cmd }).run(taskFor(scratchRepo(), "MODE noisy"))).result).toBe("done after noise");
    const missing = await new CommandEngine({ command: "definitely-not-a-program-qas" }).run(taskFor(scratchRepo(), "MODE plan"));
    expect(missing.ok).toBe(false);
    expect(new CommandEngine({ command: "definitely-not-a-program-qas" }).available().ok).toBe(false);
    expect(new CommandEngine({ command: "node {taskFile}" }).available().ok).toBe(true);
  });

  it("stdin may stay unread (the program exits at once)", async () => {
    const r = await runProcess("true", [], { cwd: tmp(), env: process.env, timeoutMs: 5000, shell: true, input: "x".repeat(2_000_000) });
    expect(r.code).toBe(0);
  });
});

describe("agent.engine: command in the config", () => {
  const scaffold = async () => {
    const repo = path.join(tmp(), "qa");
    fs.mkdirSync(repo);
    await initCommand({ cwd: repo, yes: true, mode: "scratch", ci: "gitlab", level: "maintenance", name: "x" });
    return repo;
  };
  const edit = (repo: string, f: (d: YAML.Document) => void) => {
    const file = path.join(repo, "qa-sentinel.config.yaml");
    const d = YAML.parseDocument(fs.readFileSync(file, "utf8"));
    f(d);
    fs.writeFileSync(file, d.toString());
  };

  it("needs agent.command; the default engine is still claude-code", async () => {
    const repo = await scaffold();
    const c = loadConfig(repo);
    expect(c.agent.engine).toBe("claude-code");
    expect(engineFor(c).name).toBe("claude-code");
    edit(repo, (d) => d.setIn(["agent", "engine"], "command"));
    expect(() => loadConfig(repo)).toThrow(/agent\.command is required/);
    edit(repo, (d) => d.setIn(["agent", "command"], cmd));
    const c2 = loadConfig(repo);
    expect(engineFor(c2).name).toBe("command");
    expect(ConfigSchema.safeParse({ ...c2, agent: { ...c2.agent, engine: "other" } }).success).toBe(false);
  });

  it("doctor: checks the program, the sandbox rule and says learn still uses Claude; no Claude checks", async () => {
    const repo = await scaffold();
    edit(repo, (d) => {
      d.setIn(["agent", "engine"], "command");
      d.setIn(["agent", "command"], "definitely-not-a-program-qas {taskFile}");
    });
    let checks = runChecks(repo, {});
    expect(checks.find((x) => x.label.startsWith("agent.command: definitely-not-a-program-qas"))?.level).toBe("fail");
    expect(checks.some((x) => x.label.startsWith("Claude Code CLI") || x.label.startsWith("model route"))).toBe(false);
    expect(checks.find((x) => x.label.includes("`qa-sentinel learn` still calls Claude Code"))).toBeTruthy();
    edit(repo, (d) => {
      d.setIn(["agent", "command"], cmd);
      d.setIn(["agent", "sandbox", "enabled"], true);
    });
    checks = runChecks(repo, {});
    expect(checks.find((x) => x.label === "agent.engine: command (" + JSON.stringify(process.execPath) + " found)") ?? checks.find((x) => x.label.startsWith("agent.engine: command"))).toBeTruthy();
    expect(checks.find((x) => x.label === "agent.sandbox covers only Claude Code")?.level).toBe("fail");
    edit(repo, (d) => d.setIn(["verification", "wrapCommand"], "sh -c {cmd}"));
    checks = runChecks(repo, {});
    expect(checks.some((x) => x.label === "agent.sandbox covers only Claude Code")).toBe(false);
    expect(checks.find((x) => x.label === "the engine command runs inside verification.wrapCommand")?.level).toBe("ok");
  });
});
