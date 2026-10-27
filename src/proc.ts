import { spawn } from "node:child_process";

/** Output kept per stream (the end of it). */
export const MAX_OUTPUT_CHARS = 1_000_000;
const EXIT_GRACE_MS = 250;

export interface ProcResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
  error?: string;
}

export interface ProcOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  /** Mirror stderr (and optionally stdout) to this process's output. */
  echoStderr?: boolean;
  echoStdout?: boolean;
  shell?: boolean;
  /** Written to the command's stdin, which is then closed. Without it stdin is closed at once. */
  input?: string;
}

/**
 * Run a command in its own process group with a hard timeout. On timeout the whole group gets SIGTERM,
 * then SIGKILL 10 s later, so test runners and their browsers do not outlive the job.
 */
export function runProcess(cmd: string, args: string[], o: ProcOptions): Promise<ProcResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: o.cwd,
      env: o.env,
      stdio: [o.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      shell: o.shell ?? false,
    });
    if (o.input !== undefined && child.stdin) {
      // A command that exits without reading its input closes the pipe: that is not an error of ours.
      child.stdin.on("error", () => undefined);
      child.stdin.end(o.input);
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let done = false;
    let killTimer: NodeJS.Timeout | undefined;
    let graceTimer: NodeJS.Timeout | undefined;
    // Only the last part of the output is kept: a program that prints without end must not fill our memory.
    const keep = (acc: string, d: Buffer | string) => {
      const next = acc + d;
      return next.length > MAX_OUTPUT_CHARS ? next.slice(next.length - MAX_OUTPUT_CHARS) : next;
    };
    const killGroup = (sig: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(process.platform === "win32" ? child.pid : -child.pid, sig);
      } catch {
        /* already gone */
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup("SIGTERM");
      killTimer = setTimeout(() => killGroup("SIGKILL"), 10_000);
    }, o.timeoutMs);
    child.stdout?.on("data", (d) => {
      stdout = keep(stdout, d);
      if (o.echoStdout) process.stdout.write(d);
    });
    child.stderr?.on("data", (d) => {
      stderr = keep(stderr, d);
      if (o.echoStderr) process.stderr.write(d);
    });
    const finish = (code: number | null, error?: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (graceTimer) clearTimeout(graceTimer);
      // A child that outlived the command may still hold the pipes open; we stop reading them.
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve({ code, stdout, stderr, timedOut, durationMs: Date.now() - started, error });
    };
    child.on("error", (err) => finish(null, err.message));
    // `exit` is the command itself ending. `close` waits for the pipes, which a background child can keep open for as long
    // as it lives: that must neither delay us nor turn a finished run into a timeout. So after `exit` we give the pipes a
    // moment to drain, then resolve.
    child.on("exit", (code) => {
      if (!timedOut) clearTimeout(timer);
      if (timedOut) killGroup("SIGKILL");
      graceTimer = setTimeout(() => finish(code), EXIT_GRACE_MS);
    });
    child.on("close", (code) => {
      if (timedOut) killGroup("SIGKILL");
      finish(code);
    });
  });
}
