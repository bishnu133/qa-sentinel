/**
 * What a failing requirement test means, in one word the whole team uses (docs/GLOSSARY.md). The default is
 * "unclassified": qa-sentinel never calls a failure a product defect on its own; a person confirms that.
 */
export type ResultCategory = "product-defect" | "unclassified" | "environment" | "not-built" | "not-deployed";

export const CATEGORY: Record<ResultCategory, { label: string; meaning: string }> = {
  "product-defect": { label: "🐞 product defect", meaning: "QA confirmed the product doesn't do what the requirement says (test.fail with a bug link)" },
  unclassified: { label: "❓ unclassified – needs triage", meaning: "a requirement test fails and nobody has said why yet: a person decides" },
  environment: { label: "🌐 environment", meaning: "the test couldn't reach or use the test environment (network, certificates, gateway errors)" },
  "not-built": { label: "🚧 not built", meaning: "no code in the story's services does it yet (from the plan; suspected until confirmed)" },
  "not-deployed": { label: "⏳ not deployed", meaning: "the change isn't running in the environment the test ran against yet" },
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

export function classifyFailure(i: { message?: string; waitingForDeployment?: boolean; knownDefect?: boolean; notBuilt?: boolean }): ResultCategory {
  if (i.knownDefect) return "product-defect";
  if (i.waitingForDeployment) return "not-deployed";
  if (i.message && ENVIRONMENT.some((r) => r.test(i.message!))) return "environment";
  if (i.notBuilt) return "not-built";
  return "unclassified";
}
