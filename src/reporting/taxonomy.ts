/**
 * What a failing requirement test means, in one word the whole team uses (docs/GLOSSARY.md). The default is
 * "unclassified": qa-sentinel never calls a failure a product defect on its own; a person confirms that.
 */
export type ResultCategory = "product-defect" | "defect-fixed" | "unclassified" | "environment" | "not-built" | "not-deployed";

export const CATEGORY_LABEL: Record<ResultCategory, string> = {
  "product-defect": "🐞 product defect",
  "defect-fixed": "✅ known defect now passes (the bug looks fixed: remove `test.fail` and the `QA-BUG` line)",
  unclassified: "❓ unclassified – needs triage",
  environment: "🌐 environment",
  "not-built": "🚧 not built",
  "not-deployed": "⏳ not deployed",
};

/**
 * Errors from the test's own connection, not the product's answer: a socket-level code next to the call that failed
 * ("connect ECONNREFUSED", "getaddrinfo ENOTFOUND"), the browser's network errors, TLS certificate errors. Response
 * statuses (502, 503) and texts on the page are the product's answer: they stay unclassified.
 */
const ENVIRONMENT = [
  /\b(?:connect|getaddrinfo|read|write|socket)\s+E(?:CONNREFUSED|CONNRESET|NOTFOUND|AI_AGAIN|TIMEDOUT|HOSTUNREACH|NETUNREACH)\b/,
  /\bsocket hang up\b/i,
  /\bnet::ERR_(?:CONNECTION|NAME_NOT_RESOLVED|INTERNET|ADDRESS|TIMED_OUT|CERT)/,
  /\b(?:UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT_IN_CHAIN|DEPTH_ZERO_SELF_SIGNED_CERT|CERT_HAS_EXPIRED)\b/,
];

/** Playwright's message when a test.fail test passes. */
const FAIL_PASSED = /Expected to fail, but passed/i;

export function classifyFailure(i: { message?: string; waitingForDeployment?: boolean; knownDefect?: boolean; notBuilt?: boolean }): ResultCategory {
  if (i.message && FAIL_PASSED.test(i.message)) return "defect-fixed";
  if (i.knownDefect) return "product-defect";
  if (i.waitingForDeployment) return "not-deployed";
  if (i.message && ENVIRONMENT.some((r) => r.test(i.message!))) return "environment";
  if (i.notBuilt) return "not-built";
  return "unclassified";
}
