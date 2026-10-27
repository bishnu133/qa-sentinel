// A scripted engine for tests and for trying `agent.engine: command` without any AI.
// Reads the AgentTask JSON on stdin, does what the FIRST LINE of the prompt says, prints an AgentResult JSON on stdout.
//   MODE plan                 read-only answer with usage
//   MODE write <path>         writes <path> inside the task's cwd
//   MODE over-budget          reports a cost above the task's budget
//   MODE too-many-turns       reports more turns than allowed
//   MODE sleep                waits 30 s (for the time limit)
//   MODE garbage              prints text that is not JSON
//   MODE bad-shape            prints JSON that is not an AgentResult
//   MODE exit3                prints an ok result but exits with code 3
//   MODE noisy                logs lines to stdout and stderr before the JSON
//   MODE inspect              reports what it received (env names, taskFile argument, whether stdin and file agree)
import fs from "node:fs";
import path from "node:path";

const stdin = fs.readFileSync(0, "utf8");
const task = JSON.parse(stdin);
const [mode, arg] = task.prompt.split("\n")[0].replace(/^MODE\s+/, "").split(/\s+/);
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");

if (mode === "plan") out({ ok: true, status: "ok", result: `plan for ${task.kind}`, costUsd: 0.01, turns: 2, durationMs: 5 });
else if (mode === "write") {
  fs.mkdirSync(path.dirname(path.join(task.cwd, arg)), { recursive: true });
  fs.writeFileSync(path.join(task.cwd, arg), "// written by the fixture engine\n");
  out({ ok: true, status: "ok", result: `wrote ${arg}`, costUsd: 0.02, turns: 3 });
} else if (mode === "over-budget") out({ ok: true, status: "ok", result: "done", costUsd: task.maxBudgetUsd * 3, turns: 1 });
else if (mode === "too-many-turns") out({ result: "done", turns: task.maxTurns + 5 });
else if (mode === "sleep") setTimeout(() => out({ ok: true, result: "late" }), 30_000);
else if (mode === "garbage") process.stdout.write("I am not JSON\n");
else if (mode === "bad-shape") out({ result: 42, costUsd: "free" });
else if (mode === "exit3") {
  out({ ok: true, status: "ok", result: "looked fine" });
  process.exit(3);
} else if (mode === "noisy") {
  console.log("starting up...");
  console.error("a warning on stderr");
  console.log("working {not json}");
  out({ result: "done after noise" });
} else if (mode === "inspect") {
  const file = process.argv[2];
  out({
    result: JSON.stringify({
      version: task.version,
      envNames: task.envNames,
      hasAnthropicKey: "ANTHROPIC_API_KEY" in process.env,
      hasPathEnv: "PATH" in process.env,
      fileMatchesStdin: file ? fs.readFileSync(file, "utf8") === stdin : null,
      leaksValue: stdin.includes("super-secret-value"),
      cwd: process.cwd(),
      taskFile: file ?? null,
    }),
  });
} else out({ ok: false, status: "error", result: `unknown mode ${mode}` });
