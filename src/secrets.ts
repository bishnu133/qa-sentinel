import { SECRET_NAME } from "./env.js";

/**
 * Last line of defence for what qa-sentinel publishes (MR descriptions and notes, Jira comments, bug cards, text
 * attachments). Agents and test runs need some credentials (a device farm's key inside QA_APPIUM_URL, a token in
 * guardrails.passEnv), so a credential can end up in agent-written text. Before anything leaves for GitLab or
 * Jira, the values of credential-like variables and the user:password part of any URL are masked.
 */
const MIN = 8; // shorter values would mask ordinary words
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:"'<>]+:[^\s/@"'<>]+@/gi;

/** Credential values in the environment: secret-named variables, and the userinfo of URL-valued variables. */
export function secretValues(env: NodeJS.ProcessEnv = process.env): string[] {
  const out = new Set<string>();
  for (const [k, v] of Object.entries(env)) {
    if (!v) continue;
    if (SECRET_NAME.test(k) && v.length >= MIN) out.add(v);
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) {
      try {
        const u = new URL(v);
        for (const part of [u.password, decodeURIComponent(u.password)]) if (part.length >= MIN) out.add(part);
      } catch {
        // not a URL after all
      }
    }
  }
  return [...out].sort((a, b) => b.length - a.length);
}

export function maskSecrets(text: string, env: NodeJS.ProcessEnv = process.env): string {
  let out = text.replace(URL_CREDENTIALS, "$1[redacted]@");
  for (const s of secretValues(env)) out = out.split(s).join("[redacted]");
  return out;
}

/** For display (doctor, logs): a URL without its credentials. */
export function safeUrl(url: string): string {
  return url.replace(URL_CREDENTIALS, "$1[redacted]@");
}
