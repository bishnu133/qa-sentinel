/**
 * Environment scrubbing. Agents and test runs get an allowlisted environment, so credentials such as the
 * GitLab token (used only by the CLI to publish) never reach model-driven code or generated tests.
 */

const BASE_NAMES = new Set([
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LANGUAGE", "TERM", "TZ", "TMPDIR", "TMP", "TEMP",
  "CI", "NODE_ENV", "NODE_OPTIONS", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
  "PLAYWRIGHT_BROWSERS_PATH", "PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME",
]);
const BASE_PREFIXES = ["LC_"];

/** Names that look like credentials. Never forwarded unless explicitly listed in guardrails.passEnv. */
export const SECRET_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE|CREDENTIAL|API_?KEY|AUTH|COOKIE|SESSION)/i;

/** Variables Claude Code itself needs to authenticate and reach its provider. */
function claudeAuthNames(env: NodeJS.ProcessEnv): string[] {
  const names = Object.keys(env).filter((k) => k.startsWith("ANTHROPIC_") || k.startsWith("CLAUDE_") || k === "DISABLE_AUTOUPDATER");
  if (env.CLAUDE_CODE_USE_BEDROCK) names.push(...Object.keys(env).filter((k) => k.startsWith("AWS_")));
  if (env.CLAUDE_CODE_USE_VERTEX) names.push(...Object.keys(env).filter((k) => k.startsWith("GOOGLE_") || k.startsWith("CLOUD_ML_") || k.startsWith("VERTEX_")));
  return names;
}

export interface EnvOptions {
  baseUrlEnv: string;
  passEnv: string[];
  /** Include Claude Code auth variables (agent process only, never test runs). */
  forAgent: boolean;
}

export function scrubbedEnv(o: EnvOptions, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  const explicit = new Set([o.baseUrlEnv, ...o.passEnv]);
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    const base = BASE_NAMES.has(k) || BASE_PREFIXES.some((p) => k.startsWith(p));
    if (explicit.has(k) || (base && !SECRET_NAME.test(k))) out[k] = v;
  }
  if (o.forAgent) for (const k of claudeAuthNames(env)) if (env[k] !== undefined) out[k] = env[k];
  // Belt and braces: these are publisher-only credentials.
  for (const k of ["QA_SENTINEL_GITLAB_TOKEN", "GITLAB_TOKEN", "CI_JOB_TOKEN", "GITHUB_TOKEN", "GH_TOKEN", "JIRA_API_TOKEN", "JIRA_PAT", "JIRA_EMAIL"]) {
    if (!o.passEnv.includes(k)) delete out[k];
  }
  return out;
}
