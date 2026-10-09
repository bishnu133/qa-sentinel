import { spawn } from "node:child_process";

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
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      shell: o.shell ?? false,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
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
    child.stdout.on("data", (d) => {
      stdout += d;
      if (o.echoStdout) process.stdout.write(d);
    });
    child.stderr.on("data", (d) => {
      stderr += d;
      if (o.echoStderr) process.stderr.write(d);
    });
    const finish = (code: number | null, error?: string) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({ code, stdout, stderr, timedOut, durationMs: Date.now() - started, error });
    };
    child.on("error", (err) => finish(null, err.message));
    child.on("close", (code) => {
      if (timedOut) killGroup("SIGKILL");
      finish(code);
    });
  });
}
