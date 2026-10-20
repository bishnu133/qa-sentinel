import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Which way Claude Code reaches the model, so `doctor` and error messages can say what is used and what is missing:
 * Amazon Bedrock, Google Vertex AI, an organisation's gateway (ANTHROPIC_BASE_URL, possibly set by managed
 * settings), the Anthropic API with a key, or the developer's own Claude login.
 */
export type RouteKind = "bedrock" | "vertex" | "gateway" | "api-key" | "login";

export interface ModelRoute {
  kind: RouteKind;
  /** Where requests go, for gateways (host only). */
  host?: string;
  /** Set by the organisation's managed settings (Claude Code ignores local overrides of these). */
  managed?: string;
  /** Variables the route needs that are missing. */
  missing: string[];
  /** Things that can't be checked from here and may be fine (e.g. an instance role instead of AWS keys). */
  unsure?: string[];
  /** One line for doctor. */
  label: string;
}

const truthy = (v?: string) => Boolean(v) && !/^(0|false|no)$/i.test(v!);

/** Managed settings locations Claude Code reads (macOS, Linux/WSL, Windows). */
export function managedSettingsPaths(platform = process.platform): string[] {
  if (platform === "darwin") return ["/Library/Application Support/ClaudeCode/managed-settings.json"];
  if (platform === "win32") return [path.join(process.env.ProgramData ?? "C:\\ProgramData", "ClaudeCode", "managed-settings.json")];
  return ["/etc/claude-code/managed-settings.json"];
}

export function readManagedEnv(paths = managedSettingsPaths()): { file?: string; env: Record<string, string>; helper: boolean } {
  for (const file of paths) {
    try {
      const j = JSON.parse(fs.readFileSync(file, "utf8"));
      return { file, env: Object.fromEntries(Object.entries(j?.env ?? {}).map(([k, v]) => [k, String(v)])), helper: Boolean(j?.apiKeyHelper) };
    } catch {
      // not there or not readable
    }
  }
  return { env: {}, helper: false };
}

const hostOf = (u: string) => {
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
};

export function modelRoute(env: NodeJS.ProcessEnv = process.env, managed = readManagedEnv(), home = os.homedir()): ModelRoute {
  // Managed settings win over the shell: Claude Code applies them last.
  const e: Record<string, string | undefined> = { ...env, ...managed.env };
  const by = managed.file && Object.keys(managed.env).length ? managed.file : undefined;
  if (truthy(e.CLAUDE_CODE_USE_BEDROCK)) {
    const creds = ["AWS_ACCESS_KEY_ID", "AWS_PROFILE", "AWS_BEARER_TOKEN_BEDROCK", "AWS_WEB_IDENTITY_TOKEN_FILE", "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", "AWS_CONTAINER_CREDENTIALS_FULL_URI"].some((k) => e[k]) || fs.existsSync(path.join(home, ".aws", "credentials"));
    const missing = e.AWS_REGION || e.AWS_DEFAULT_REGION ? [] : ["AWS_REGION"];
    // No keys in sight may still be fine: an EC2/ECS role or SSO cache provides them at run time.
    const unsure = creds ? [] : ["no AWS credentials in the environment or ~/.aws/credentials (fine with an instance role or SSO)"];
    return { kind: "bedrock", managed: by, missing, unsure, label: `Amazon Bedrock${e.AWS_REGION ? ` (${e.AWS_REGION})` : ""}` };
  }
  if (truthy(e.CLAUDE_CODE_USE_VERTEX)) {
    const missing = [...(e.CLOUD_ML_REGION ? [] : ["CLOUD_ML_REGION"]), ...(e.ANTHROPIC_VERTEX_PROJECT_ID ? [] : ["ANTHROPIC_VERTEX_PROJECT_ID"])];
    return { kind: "vertex", managed: by, missing, label: `Google Vertex AI${e.ANTHROPIC_VERTEX_PROJECT_ID ? ` (project ${e.ANTHROPIC_VERTEX_PROJECT_ID}, ${e.CLOUD_ML_REGION ?? "no region"})` : ""}` };
  }
  if (e.ANTHROPIC_BASE_URL && !/(^|\.)anthropic\.com$/.test(hostOf(e.ANTHROPIC_BASE_URL))) {
    return { kind: "gateway", host: hostOf(e.ANTHROPIC_BASE_URL), managed: by, missing: [], label: `a gateway at ${hostOf(e.ANTHROPIC_BASE_URL)}${by ? " (set by your organisation's managed settings)" : ""}` };
  }
  if (e.ANTHROPIC_API_KEY || e.ANTHROPIC_AUTH_TOKEN || managed.helper) return { kind: "api-key", managed: managed.helper ? managed.file : by, missing: [], label: managed.helper ? "the Anthropic API, key from your organisation's apiKeyHelper" : "the Anthropic API with ANTHROPIC_API_KEY" };
  return { kind: "login", missing: [], label: "your Claude login (no key in the environment)" };
}

/** What to tell someone whose agent run failed to authenticate, for their route. */
export function authHint(r: ModelRoute = modelRoute()): string {
  switch (r.kind) {
    case "bedrock":
      return `Claude Code uses Amazon Bedrock: check AWS_REGION, the AWS credentials, and that the account has access to the Claude model${[...r.missing, ...(r.unsure ?? [])].length ? ` (${[...r.missing.map((m) => `missing: ${m}`), ...(r.unsure ?? [])].join("; ")})` : ""}. Test with: claude -p "reply with OK"`;
    case "vertex":
      return `Claude Code uses Google Vertex AI: check CLOUD_ML_REGION, ANTHROPIC_VERTEX_PROJECT_ID and gcloud credentials (gcloud auth application-default login, or GOOGLE_APPLICATION_CREDENTIALS)${r.missing.length ? ` (missing: ${r.missing.join(", ")})` : ""}. Test with: claude -p "reply with OK"`;
    case "gateway":
      return `Claude Code sends requests to ${r.host}${r.managed ? ` (set in ${r.managed})` : ""}: that gateway refused the credentials. A personal Anthropic key won't work there; ask its owners, or use a setup without it. Test with: claude -p "reply with OK"`;
    case "api-key":
      return 'Claude Code has no valid credentials. Check ANTHROPIC_API_KEY (length: echo ${#ANTHROPIC_API_KEY}; it starts with sk-ant-) and test with: claude -p "reply with OK". If you meant to use your Claude login instead, an old key in the environment overrides it: run `unset ANTHROPIC_API_KEY`.';
    default:
      return 'Claude Code is not logged in. Run `claude`, then /login, or set ANTHROPIC_API_KEY; test with: claude -p "reply with OK"';
  }
}
