# Using another AI engine: `agent.engine: command`

qa-sentinel runs Claude Code by default. If you want a different AI program to do the planning and writing, you can plug it in as a command. qa-sentinel ships **no** vendor engine and **no** Agent SDK engine; this is only the plug. Nothing here has been tried with a real AI program other than the scripted test fixture.

```yaml
agent:
  engine: command
  command: "node my-engine.mjs"      # or: "my-engine --task {taskFile}"
```

## What your program gets

qa-sentinel starts the command in the test repo (a shell command, so quoting works as in your terminal) and writes one JSON object to its **stdin**. If the command contains `{taskFile}`, that is replaced by the path of a temporary file (`0600`, deleted afterwards) holding the same JSON. Write it **without quotes** (`my-engine --task {taskFile}`): qa-sentinel quotes the path itself, and the config refuses a quoted `{taskFile}`. The file is under `<test repo>/.qa-sentinel/engine-*/` (git-ignored), so a wrapper that mounts the repo can read it; stdin works everywhere.

```json
{
  "version": 1,
  "kind": "plan | repair-plan | author | learn | review | story-review | tag | lessons | spec",
  "cwd": "/abs/path/of/the/test/repo",
  "prompt": "what to do",
  "readOnlyDirs": ["/abs/service/repo"],
  "readDeny": ["/abs/dirs/it must not read"],
  "write": { "allowed": ["tests/**"], "blocked": ["wdio.conf.ts"] },
  "bash": ["npx playwright test --project=api *"],
  "maxTurns": 60,
  "maxBudgetUsd": 5,
  "timeoutMs": 1800000,
  "model": null,
  "envNames": ["PATH", "QA_API_URL"]
}
```

- `write: null` means a read-only task: change nothing.
- `envNames` are only the **names** of the variables your program was started with. Their values are in its environment, not in the JSON.
- The program's environment is the cleaned environment a test run gets: no `ANTHROPIC_*`, `CLAUDE_*`, Bedrock (`AWS_*`) or Vertex (`GOOGLE_*`) credentials, whatever the Claude route is, unless you list the variable in `guardrails.passEnv`. If your engine needs its own key, list that variable in `guardrails.passEnv`. A login inside `QA_APPIUM_URL` and `QA_APPIUM_CAPS` are not passed either (see docs/MOBILE-DEVICES.md).

## What your program must print

One JSON object on **stdout** (it may print other lines before it; the last line that is a JSON object is used). Stderr is shown to the person running qa-sentinel.

```json
{ "ok": true, "status": "ok", "result": "final message", "costUsd": 0.12, "turns": 7, "durationMs": 40000, "denials": [] }
```

- At least one of `result`, `ok` or `status` must be there; a JSON object with none of them (a stray log line such as `{"level":"info"}`) is an error. `result` (text) is the final message. The rest is optional.
- `status` is one of `ok`, `error`, `timeout`, `max-turns`, `max-budget`. If you leave out `ok` or `status`, the other is worked out from it (`ok: false` alone means `error`).
- `costUsd` and `turns` are optional. They go into the usage line and metrics. If they are higher than the task's `maxBudgetUsd` / `maxTurns`, qa-sentinel reports `max-budget` / `max-turns` instead of ok. **It cannot stop your program half way for these, so your program must stop itself**; this is only a check afterwards.
- Exit code: anything other than 0 is an error, even if the JSON says ok.
- Output that is not a JSON object, or has the wrong shape, is an error with a message.

## Time limit

The task's `timeoutMs` (from `agent.timeoutMinutes`) is enforced by qa-sentinel: it stops the whole process group (SIGTERM, then SIGKILL after 10 s) and reports `timeout`. A run is finished when the command itself exits (plus a quarter second for its output); a child it left running in the background, even one in its own session, does not delay the result and does not turn it into a timeout. Such a child is **not** stopped. Only the last 1 MB of stdout and of stderr is kept.

## Safety: what stays in code

qa-sentinel checks **after** the program has run, exactly as for Claude Code: write paths (`guardrails`), blocked files, secrets in the diff, deleted tests, removed assertions, the expected-behaviour lock, and the verification run. A program that writes a tracked or new file outside its `write.allowed` is caught there. Because git does not list ignored files, qa-sentinel also notes, before and after the run, the size and time of every git-ignored file (except test-run output such as `test-results/` and `.qa-sentinel/`) and the content of `.git/config` and `.git/hooks`, and fails the run (`error`) if any of them changed. So your program's own permission system is only a second layer.

**Not checked:** anything outside the test repository (your home folder, other repositories), what the program reads, the network, processes it leaves running, and changes inside the ignored test-run folders listed above. With Claude Code, its permission rules stop some of these; a command engine has none, so use `verification.wrapCommand` with a container when that matters.

- `verification.wrapCommand` (for example a container) wraps the engine command the same way it wraps test commands. `{cmd}` becomes your command as one quoted word. With Docker, remember `-i`, or the program will not get stdin, and mount the repo so that its changes are visible.
- `agent.sandbox` is Claude Code's own sandbox and does **not** cover a command engine. With `agent.sandbox.enabled: true` and `failIfUnavailable: true` (the default) and no `verification.wrapCommand`, qa-sentinel refuses to run the command, and `doctor` fails. Either set a wrapper that isolates the program or set `failIfUnavailable: false` to accept running it unsandboxed.
- `doctor` checks that the first word of the command exists, and the sandbox rule above. It cannot check your engine's credentials or cost; run one cheap task.
- `qa-sentinel gap-report --dry-run` (and other `--dry-run` runs) print the command line and run nothing.
- `qa-sentinel learn` does not use the engine setting and still calls Claude Code.

## Try your engine against the conformance kit

`test/helpers/engineConformance.ts` runs four situations against any `AgentEngine`: a read-only task, a write inside the policy, a write outside it (the guardrail must flag it), and the limits (cost, turns, time, unusable output). `test/engineConformance.test.ts` runs it against `test/fixtures/engine-fixture.mjs`, a scripted program that does exactly what the first line of the prompt says (`MODE write tests/x.spec.ts`). A real AI will not follow such lines to the letter, so for a real engine read the kit as the four situations to check by hand, with a real task.
