import { execFileSync } from "node:child_process";
import { maskSecrets } from "../secrets.js";
import { redact } from "./storyBranch.js";

/** `git push --force <remote> HEAD:refs/heads/<branch>`; a failure's message is masked (git prints the remote URL, which carries the token). */
export function forcePush(cwd: string, remote: string, branch: string, env?: NodeJS.ProcessEnv): void {
  try {
    execFileSync("git", ["push", "--force", remote, `HEAD:refs/heads/${branch}`], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: env ?? process.env });
  } catch (e) {
    const err = e as { stderr?: string; message: string };
    throw new Error(redact(maskSecrets(String(err.stderr || err.message).split("\n").map((l) => l.trim()).filter(Boolean)[0] ?? "git push failed")));
  }
}
