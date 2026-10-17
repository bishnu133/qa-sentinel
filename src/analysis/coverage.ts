import YAML from "yaml";
import type { ServiceConfig } from "../config.js";
import type { RiskFactor, RiskLevel } from "../plan/schema.js";
import { normaliseEndpoint, riskOf } from "../plan/risk.js";
import { pathPrefix } from "./contractDiff.js";
import { type IndexedTest, normPage, type readTestMap } from "./testIndex.js";

/**
 * Coverage by endpoint (and by page for front ends): which tests exercise each operation in the spec, and which
 * operations nobody tests, ranked by risk. Deterministic and free: no agent. The risk of an untested endpoint is a
 * transparent heuristic over what the spec says about it (path, summary, tags, field names, method), using the same
 * factor → level rules as gap reports, so teams can read and adjust it.
 */

export type CoverageStatus = "untested" | "pending" | "weak" | "tested";

export interface SpecOperation {
  endpoint: string; // normalised "POST /orders/{}"
  /** With the spec's basePath/server path ("POST /api/v1/orders/{}"): tests may name it either way. */
  fullEndpoint: string;
  method: string;
  path: string; // as written in the spec
  summary?: string;
  statuses: string[];
  hasBody: boolean;
  deprecated: boolean;
  /** Words the risk heuristic reads: path, summary, description, operationId, tags, field names. */
  words: string;
}

export interface EndpointCoverage extends SpecOperation {
  service: string;
  tests: { id: string; status: IndexedTest["status"]; statusOnly: boolean }[];
  status: CoverageStatus;
  factors: RiskFactor[];
  risk: RiskLevel;
}

export interface PageCoverage {
  service: string;
  page: string;
  tests: { id: string; status: IndexedTest["status"] }[];
  status: Exclude<CoverageStatus, "weak">;
}

const METHODS = ["get", "put", "post", "delete", "patch"];

function fieldNames(node: any, root: any, out: Set<string>, depth = 0, seen = new Set<string>()): void {
  if (!node || typeof node !== "object" || depth > 6) return;
  if (typeof node.$ref === "string" && node.$ref.startsWith("#/")) {
    if (seen.has(node.$ref)) return;
    const target = node.$ref
      .slice(2)
      .split("/")
      .reduce((o: any, k: string) => o?.[k.replace(/~1/g, "/").replace(/~0/g, "~")], root);
    return fieldNames(target, root, out, depth + 1, new Set([...seen, node.$ref]));
  }
  for (const [k, v] of Object.entries<any>(node.properties ?? {})) {
    out.add(k);
    fieldNames(v, root, out, depth + 1, seen);
  }
  for (const key of ["items", "schema"]) if (node[key]) fieldNames(node[key], root, out, depth + 1, seen);
  for (const key of ["allOf", "oneOf", "anyOf"]) for (const s of node[key] ?? []) fieldNames(s, root, out, depth + 1, seen);
  for (const c of Object.values<any>(node.content ?? {})) fieldNames(c, root, out, depth + 1, seen);
}

/** Every operation in an OpenAPI (3.x or Swagger 2) document. */
export function specOperations(text: string): SpecOperation[] {
  const spec = YAML.parse(text);
  const prefix = pathPrefix(spec);
  const out: SpecOperation[] = [];
  for (const [p, item] of Object.entries<any>(spec?.paths ?? {})) {
    for (const m of METHODS) {
      const op = item?.[m];
      if (!op) continue;
      const names = new Set<string>();
      for (const prm of [...(item.parameters ?? []), ...(op.parameters ?? [])]) {
        if (prm?.name) names.add(prm.name);
        fieldNames(prm?.schema ?? prm, spec, names);
      }
      if (op.requestBody) fieldNames(op.requestBody, spec, names);
      for (const r of Object.values<any>(op.responses ?? {})) fieldNames(r, spec, names);
      out.push({
        endpoint: normaliseEndpoint(`${m.toUpperCase()} ${p}`),
        fullEndpoint: normaliseEndpoint(`${m.toUpperCase()} ${prefix}${p}`),
        method: m.toUpperCase(),
        path: p,
        summary: op.summary ?? op.description?.split("\n")[0],
        statuses: Object.keys(op.responses ?? {}),
        hasBody: Boolean(op.requestBody || (op.parameters ?? []).some((x: any) => x?.in === "body")),
        deprecated: Boolean(op.deprecated),
        words: [p, op.summary, op.description, op.operationId, ...(op.tags ?? []), ...names].filter(Boolean).join(" "),
      });
    }
  }
  return out;
}

// Signals in what the spec says about an operation. Kept small and readable on purpose.
const AUTH = /\b(auth\w*|login|logout|sign-?in|token|session|password|passcode|otp|mfa|2fa|role|roles|permission\w*|scope|oauth|sso|credential\w*)\b/i;
const MONEY = /\b(price\w*|amount|payment\w*|pay|refund\w*|charge\w*|invoice\w*|total|subtotal|fee\w*|tax\w*|discount\w*|balance|currency|wallet|billing|payout\w*|cost)\b/i;
const PERSONAL = /\b(email|phone|mobile|address\w*|date-?of-?birth|dateOfBirth|dob|birth\w*|nric|ssn|passport\w*|national-?id|firstName|lastName|fullName|gender)\b/i;

/** Splits camelCase and snake_case so "unitPrice" and "refund_amount" match the word lists. */
const spaced = (s: string) => s.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_/{}.:-]+/g, " ");

/** Operational endpoints (health checks, version, metrics): no business behaviour, whatever service they sit in. */
const OPS = /\/(health|healthz|healthcheck|ping|status|version|info|metrics|ready|readiness|live|liveness)\/?$/i;

export function endpointFactors(op: SpecOperation): RiskFactor[] {
  if (op.method === "GET" && OPS.test(op.path)) return ["read-only"];
  const w = `${spaced(op.words)} ${op.words}`;
  const f = new Set<RiskFactor>();
  if (AUTH.test(w)) f.add("auth");
  if (MONEY.test(w)) f.add("money");
  if (PERSONAL.test(w)) f.add("personal-data");
  if (op.method === "GET") f.add("read-only");
  else if (op.hasBody) f.add("validation");
  // Business-rule refusals on a write (conflict, unprocessable, precondition): the error path is behaviour to test.
  if (op.method !== "GET" && op.statuses.some((s) => s === "409" || s === "412" || s === "422")) f.add("write-path-error-handling");
  return [...f];
}

type TestMap = ReturnType<typeof readTestMap>;

/** Tests per endpoint: @endpoint tags, plus files test-map.yaml maps to the endpoint (their tests count too). */
export function endpointCoverage(service: ServiceConfig, ops: SpecOperation[], index: IndexedTest[], map: TestMap): EndpointCoverage[] {
  const mapped = new Map<string, string[]>();
  for (const [ep, files] of Object.entries(map?.services?.[service.name]?.endpoints ?? {})) mapped.set(normaliseEndpoint(ep), files ?? []);
  const mappedFiles = (op: SpecOperation) => [...(mapped.get(op.endpoint) ?? []), ...(mapped.get(op.fullEndpoint) ?? [])];
  return ops.map((op) => {
    const tests = index.filter((t) => {
      const tagged = t.endpoints.some((e) => normaliseEndpoint(e) === op.endpoint || normaliseEndpoint(e) === op.fullEndpoint) && (!t.services.length || t.services.includes(service.name));
      return tagged || mappedFiles(op).includes(t.file);
    });
    const active = tests.filter((t) => t.status === "active");
    const status: CoverageStatus = !tests.length ? "untested" : !active.length ? "pending" : active.every((t) => t.statusOnly) ? "weak" : "tested";
    const factors = endpointFactors(op);
    return {
      ...op,
      service: service.name,
      tests: tests.map((t) => ({ id: t.id, status: t.status, statusOnly: t.statusOnly })),
      status,
      factors,
      risk: op.deprecated ? "low" : riskOf(factors),
    };
  });
}

export function pageCoverage(service: ServiceConfig, index: IndexedTest[], map: TestMap): PageCoverage[] {
  const screens = new Map<string, string[]>();
  for (const [pg, files] of Object.entries(map?.services?.[service.name]?.screens ?? {})) screens.set(normPage(pg), files ?? []);
  return [...new Set([...service.routes.map(normPage), ...screens.keys()])].map((page) => {
    const tests = index.filter((t) => t.pages.includes(page) || (screens.get(page) ?? []).includes(t.file));
    const status = !tests.length ? "untested" : tests.some((t) => t.status === "active") ? "tested" : "pending";
    return { service: service.name, page, tests: tests.map((t) => ({ id: t.id, status: t.status })), status };
  });
}

const RANK: Record<RiskLevel, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const GAP: Record<CoverageStatus, number> = { untested: 0, pending: 1, weak: 2, tested: 3 };

/** The order to backfill in: riskiest first; untested before pending before weak; writes before reads. */
export function rankGaps(items: EndpointCoverage[]): EndpointCoverage[] {
  return items
    .filter((e) => e.status !== "tested" && !e.deprecated)
    .sort((a, b) => RANK[a.risk] - RANK[b.risk] || GAP[a.status] - GAP[b.status] || Number(a.method === "GET") - Number(b.method === "GET") || a.endpoint.localeCompare(b.endpoint));
}

export const atLeastRisk = (r: RiskLevel, min: RiskLevel) => RANK[r] <= RANK[min];

const ICON: Record<CoverageStatus, string> = { untested: "⛔ untested", pending: "⏸ only fixme/skip", weak: "🟠 status-only", tested: "✅ tested" };
const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : "–");

export function coverageMarkdown(r: { endpoints: EndpointCoverage[]; pages: PageCoverage[]; notes: string[] }): string {
  const out: string[] = ["# Test coverage", ""];
  const services = [...new Set([...r.endpoints.map((e) => e.service), ...r.pages.map((p) => p.service)])];
  out.push("| Service | Endpoints | Tested | Untested (critical / high / other) | Pages tested |", "| --- | --- | --- | --- | --- |");
  for (const s of services) {
    const eps = r.endpoints.filter((e) => e.service === s);
    const gaps = rankGaps(eps);
    const pages = r.pages.filter((p) => p.service === s);
    out.push(
      `| ${s} | ${eps.length} | ${pct(eps.filter((e) => e.status === "tested").length, eps.length)} | ${gaps.filter((g) => g.risk === "critical").length} / ${gaps.filter((g) => g.risk === "high").length} / ${gaps.filter((g) => g.risk !== "critical" && g.risk !== "high").length} | ${pages.length ? `${pages.filter((p) => p.status === "tested").length}/${pages.length}` : "–"} |`,
    );
  }
  for (const n of r.notes) out.push("", `_${n}_`);
  const gaps = rankGaps(r.endpoints);
  if (gaps.length) {
    out.push("", "## Gaps, riskiest first", "", "`qa-sentinel backfill --service <name>` writes tests for the top of this list in small reviewed batches.", "");
    out.push("| # | Risk | Service | Endpoint | Gap | Why risky |", "| --- | --- | --- | --- | --- | --- |");
    gaps.forEach((g, i) =>
      out.push(`| ${i + 1} | ${g.risk} | ${g.service} | ${g.method} ${g.path}${g.summary ? ` – ${g.summary.replace(/\|/g, "/").slice(0, 60)}` : ""} | ${ICON[g.status]} | ${g.factors.filter((f) => f !== "read-only").join(", ") || "–"} |`),
    );
  }
  const untestedPages = r.pages.filter((p) => p.status !== "tested");
  if (untestedPages.length) {
    out.push("", "## Pages without a running test", "", "| Service | Page | Gap |", "| --- | --- | --- |");
    for (const p of untestedPages) out.push(`| ${p.service} | ${p.page} | ${ICON[p.status]} |`);
  }
  const tested = r.endpoints.filter((e) => e.status === "tested");
  if (tested.length) {
    out.push("", "<details><summary>Tested endpoints</summary>", "", "| Service | Endpoint | Tests |", "| --- | --- | --- |");
    for (const e of tested) out.push(`| ${e.service} | ${e.method} ${e.path} | ${e.tests.map((t) => t.id).join(", ")} |`);
    out.push("", "</details>");
  }
  return out.join("\n") + "\n";
}
