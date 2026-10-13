/**
 * API evidence goes to Jira, where Biz users read it: request and response bodies are shown, secrets are not.
 * Values under keys that name a secret are replaced, and bearer tokens / JWTs inside strings are masked.
 */
const SECRET_KEY = /(pass(word|wd|phrase)?|secret|token|api[-_]?key|authori[sz]ation|cookie|session[-_]?id|credential|private[-_]?key|otp|pin|cvv|cvc|card[-_]?number)$/i;
const JWT = /\beyJ[\w-]{6,}\.[\w-]{6,}\.[\w-]{6,}\b/g;
const BEARER = /\b(Bearer|Basic)\s+[\w.~+/=-]{8,}/gi;

export function redact<T>(value: T, depth = 0): T {
  if (depth > 20) return value;
  if (typeof value === "string") return value.replace(JWT, "[redacted jwt]").replace(BEARER, "$1 [redacted]") as T;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEY.test(k) && v !== null && v !== "" ? "[redacted]" : redact(v, depth + 1);
    return out as T;
  }
  return value;
}
