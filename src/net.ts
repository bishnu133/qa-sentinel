/**
 * fetch with a useful error. Node's fetch says only "fetch failed"; the reason (DNS, proxy, TLS certificate…) is
 * in error.cause. On networks that inspect HTTPS, Node doesn't trust the company certificate that browsers and
 * curl use from the OS store: NODE_OPTIONS=--use-system-ca (Node 22.15+) fixes that.
 */
export async function netFetch(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (e) {
    const c = ((e as { cause?: { code?: string; message?: string } }).cause ?? {}) as { code?: string; message?: string };
    const why = [c.code, c.message].filter(Boolean).join(": ") || (e as Error).message;
    const hint = /CERT|certificate|SELF_SIGNED|UNABLE_TO/i.test(why)
      ? " (this network inspects HTTPS: run with NODE_OPTIONS=--use-system-ca so Node trusts the OS certificates)"
      : /ENOTFOUND|EAI_AGAIN/.test(why)
        ? " (DNS: check the URL and your network)"
        : "";
    throw new Error(`${init?.method ?? "GET"} ${new URL(url).origin}${new URL(url).pathname} failed: ${why}${hint}`);
  }
}

/** True when an answer is a web page (a login or SSO proxy page) and not data. */
export function looksLikeHtml(text: string, contentType: string | null | undefined): boolean {
  return /html/i.test(contentType ?? "") || /^\s*<(!doctype|html|head|body)/i.test(text);
}

/**
 * Parse an API answer as JSON with a clear error. A login or SSO page in front of the service is the usual cause
 * of a "not JSON" answer, and the raw SyntaxError ("Unexpected token <") hides that.
 */
export function parseJsonAnswer(text: string, contentType: string | null | undefined, who: string, hint: string): any {
  if (!text) return undefined;
  if (looksLikeHtml(text, contentType)) throw new Error(`${who} answered with a web page, not JSON (${hint})`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${who} answered something that is not JSON (${hint}): ${text.slice(0, 80).replace(/\s+/g, " ")}`);
  }
}
