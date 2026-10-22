import type { Config } from "./config.js";

/** The whole command as ONE shell word (single-quoted; a quote inside becomes '\''). */
export const quoteWord = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Put a test command inside the configured wrapper (`verification.wrapCommand`, e.g. `docker run … sh -c {cmd}`).
 * `{cmd}` becomes the full command as one shell-quoted word, so the wrapper decides how to run it (`sh -c {cmd}`).
 * No wrapper set: the command is returned unchanged. This is not a sandbox by itself: what the wrapper isolates is
 * the wrapper's job (see docs/SECURITY.md).
 */
export function wrapTestCommand(c: Pick<Config, "verification">, cmd: string): string {
  const tpl = c.verification.wrapCommand;
  if (!tpl) return cmd;
  return tpl.split("{cmd}").join(quoteWord(cmd));
}
