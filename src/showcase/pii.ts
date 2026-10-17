/**
 * Personal data guard for evidence. A test environment may hold real people's data (copied from production, or a
 * shared UAT). Before evidence leaves for Jira, its text (API requests and responses, the PDF and title cards, step
 * captions, summaries) is scanned for values shaped like personal data. What is found is reported with the value
 * masked, and by default nothing is attached. Test data that only looks real can be allowed by pattern.
 */

export type PiiKind = "nric" | "email" | "phone" | "card" | "custom";

export interface PiiFinding {
  kind: PiiKind | string;
  /** Masked: enough to find it, not enough to leak it ("S12****7D", "ja***@gmail.com"). */
  value: string;
  where: string;
}

export interface PiiOptions {
  detect: string[];
  /** Regexes for values that are known test data (matched against the raw value). */
  allow: string[];
  /** Email domains that are test domains. */
  allowEmailDomains: string[];
  custom: { name: string; pattern: string }[];
}

/** Card networks' published test numbers (Stripe, Adyen, Braintree…): payment tests use them on purpose. */
const TEST_CARDS = new Set(["4111111111111111", "4242424242424242", "4000056655665556", "4012888888881881", "5555555555554444", "5105105105105100", "2223003122003222", "378282246310005", "371449635398431", "6011111111111117", "3530111333300000", "6200000000000005"]);

export const DEFAULT_TEST_EMAIL_DOMAINS = ["example.com", "example.org", "example.net", "example", "test", "invalid", "localhost", "local"];

// Singapore NRIC/FIN with its checksum letter (S, T, F, G, M series), so ids that merely look alike don't count.
const NRIC = /\b([STFGM])(\d{7})([A-Z])\b/gi;
const EMAIL = /\b[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)\b/g;
// Phones only in international form (+country code): bare digit runs are mostly ids, amounts and timestamps.
const PHONE = /(?<![\w+])\+\d{1,3}[\s-]?\d{3,4}[\s-]?\d{3,4}(?:[\s-]?\d{2,4})?(?!\d)/g;
const CARD = /(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g;
/** JSON keys whose digit values are phone numbers even without a country code. */
const PHONE_KEY = /^(phone|mobile|tel|telephone|contact_?(no|number)|msisdn|handphone|hp)(_?(no|number))?$/i;

export function nricValid(prefix: string, digits: string, check: string): boolean {
  const w = [2, 7, 6, 5, 4, 3, 2];
  const p = prefix.toUpperCase();
  let sum = digits.split("").reduce((a, d, i) => a + Number(d) * w[i], 0);
  if (p === "T" || p === "G") sum += 4;
  if (p === "M") sum += 3;
  const table = p === "S" || p === "T" ? "JZIHGFEDCBA" : p === "M" ? "XWUTRQPNJLK" : "XWUTRQPNMLK";
  return table[sum % 11] === check.toUpperCase();
}

/** Card networks' number ranges and lengths (Visa, Mastercard, Amex, JCB, Discover, UnionPay): long ids rarely fit both these and Luhn. */
const CARD_IIN = /^(4\d{12}(\d{3}){0,2}|5[1-5]\d{14}|2(22[1-9]|2[3-9]\d|[3-6]\d{2}|7[01]\d|720)\d{12}|3[47]\d{13}|35\d{14}|6(011|5\d{2})\d{12}|62\d{14,17})$/;

const luhn = (digits: string) => {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
    sum += d;
  }
  return sum % 10 === 0;
};

export const maskValue = (v: string) => {
  if (v.includes("@")) {
    const [u, d] = v.split("@");
    return `${u.slice(0, 2)}***@${d}`;
  }
  const s = v.replace(/\s+/g, "");
  return s.length <= 4 ? "****" : `${s.slice(0, 3)}${"*".repeat(Math.max(2, s.length - 5))}${s.slice(-2)}`;
};

export function scanText(text: string, where: string, o: PiiOptions): PiiFinding[] {
  const out: PiiFinding[] = [];
  const allowed = o.allow.map((a) => new RegExp(a, "i"));
  const ok = (v: string) => allowed.some((re) => re.test(v));
  const add = (kind: string, v: string) => {
    if (!ok(v) && !out.some((f) => f.kind === kind && f.value === maskValue(v))) out.push({ kind, value: maskValue(v), where });
  };
  const on = (k: string) => o.detect.includes(k);
  if (on("nric")) for (const m of text.matchAll(NRIC)) if (nricValid(m[1], m[2], m[3])) add("nric", m[0]);
  if (on("email"))
    for (const m of text.matchAll(EMAIL)) {
      const domain = m[1].toLowerCase();
      const test = [...DEFAULT_TEST_EMAIL_DOMAINS, ...o.allowEmailDomains].some((d) => domain === d || domain.endsWith(`.${d}`));
      if (!test) add("email", m[0]);
    }
  if (on("phone")) for (const m of text.matchAll(PHONE)) add("phone", m[0].trim());
  if (on("card"))
    for (const m of text.matchAll(CARD)) {
      const d = m[0].replace(/\D/g, "");
      if (CARD_IIN.test(d) && !TEST_CARDS.has(d) && !/^(\d)\1+$/.test(d) && luhn(d)) add("card", m[0]);
    }
  for (const c of o.custom) for (const m of text.matchAll(new RegExp(c.pattern, "g"))) add(c.name, m[0]);
  return out;
}

/** Structured evidence (API logs): also phone numbers under phone-like keys, and the JSON path in `where`. */
export function scanJson(value: unknown, where: string, o: PiiOptions, depth = 0): PiiFinding[] {
  if (depth > 20 || value == null) return [];
  if (typeof value === "string") return scanText(value, where, o);
  if (typeof value === "number") return scanText(String(value), where, o).filter((f) => f.kind === "card");
  if (Array.isArray(value)) return value.flatMap((v, i) => scanJson(v, `${where}[${i}]`, o, depth + 1));
  if (typeof value === "object") {
    const out: PiiFinding[] = [];
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const at = `${where}.${k}`;
      if (o.detect.includes("phone") && PHONE_KEY.test(k) && /\d{6,}/.test(String(v ?? "").replace(/[\s-]/g, "")) && !o.allow.some((a) => new RegExp(a, "i").test(String(v)))) {
        out.push({ kind: "phone", value: maskValue(String(v)), where: at });
        continue;
      }
      out.push(...scanJson(v, at, o, depth + 1));
    }
    return out;
  }
  return [];
}

/** Text evidence files and HTML (the PDF's source, title cards): tags stripped so attributes don't hide values. */
export function scanEvidence(items: { where: string; text: string; json?: boolean }[], o: PiiOptions): PiiFinding[] {
  return items.flatMap((i) => {
    if (i.json) {
      try {
        return scanJson(JSON.parse(i.text), i.where, o);
      } catch {
        // not JSON after all
      }
    }
    const text = /<\/?[a-z][\s\S]*>/i.test(i.text) ? i.text.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&#64;|&commat;/g, "@").replace(/&amp;/g, "&") : i.text;
    return scanText(text, i.where, o);
  });
}

export function piiMarkdown(findings: PiiFinding[]): string {
  return [
    "| Kind | Value (masked) | Where |",
    "| --- | --- | --- |",
    ...findings.slice(0, 50).map((f) => `| ${f.kind} | \`${f.value}\` | ${f.where} |`),
    ...(findings.length > 50 ? [`| … | ${findings.length - 50} more | |`] : []),
  ].join("\n");
}
