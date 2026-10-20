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

/** Messages that say the environment, not the product, failed. Kept narrow: anything else stays unclassified. */
const ENVIRONMENT = [
  /\bE(?:CONNREFUSED|CONNRESET|NOTFOUND|AI_AGAIN|TIMEDOUT|HOSTUNREACH|NETUNREACH)\b/,
  /socket hang up/i,
  /net::ERR_(?:CONNECTION|NAME_NOT_RESOLVED|INTERNET|ADDRESS|TIMED_OUT|CERT)/,
  /\b(?:UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT_IN_CHAIN|DEPTH_ZERO_SELF_SIGNED_CERT|CERT_HAS_EXPIRED)\b|self[- ]signed certificate/i,
  /\bInvalid URL\b/,
  /\b(?:502 Bad Gateway|503 Service Unavailable|504 Gateway Time-?out)\b/i,
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
