import YAML from "yaml";
import { normaliseEndpoint } from "../plan/risk.js";

/**
 * Deterministic OpenAPI (3.x, and Swagger 2 bodies/responses where shapes match) diff between two spec versions.
 * No LLM: structural facts about the contract are computed, and the AI is asked only what they mean for tests.
 */

export type ContractChangeKind =
  | "operation-added"
  | "operation-removed"
  | "param-added"
  | "param-removed"
  | "param-required"
  | "param-optional"
  | "field-added"
  | "field-removed"
  | "field-required"
  | "field-optional"
  | "type-changed"
  | "nullable-added"
  | "nullable-removed"
  | "enum-values-added"
  | "enum-values-removed"
  | "constraint-tightened"
  | "constraint-loosened"
  | "status-added"
  | "status-removed"
  | "body-added"
  | "body-removed";

export interface ContractChange {
  endpoint: string; // "POST /orders" (path params normalised to {})
  kind: ContractChangeKind;
  /** e.g. request.body.deliverySlot, response.201.body.items[].price, query.limit */
  location: string;
  detail: string;
  breaking: boolean;
}

export interface ContractDiff {
  status: "compared" | "unchanged" | "spec-added" | "spec-removed" | "no-spec" | "unparseable";
  changes: ContractChange[];
  note?: string;
}

const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];
type Json = any;

function parse(text: string | undefined): Json | undefined {
  if (text === undefined) return undefined;
  return YAML.parse(text);
}

/** Resolve local $refs (#/components/…, #/definitions/…) with a cycle guard. */
function deref(node: Json, root: Json, seen = new Set<string>()): Json {
  if (!node || typeof node !== "object") return node;
  if (typeof node.$ref === "string" && node.$ref.startsWith("#/")) {
    if (seen.has(node.$ref)) return {};
    const target = node.$ref
      .slice(2)
      .split("/")
      .map((p: string) => p.replace(/~1/g, "/").replace(/~0/g, "~"))
      .reduce((o: Json, k: string) => (o == null ? undefined : o[k]), root);
    return deref(target ?? {}, root, new Set([...seen, node.$ref]));
  }
  return node;
}

interface Op {
  params: Map<string, Json>; // "query:limit" → param
  body?: Json; // JSON request schema
  bodyRequired: boolean;
  responses: Map<string, Json | undefined>; // status → JSON schema
}

function jsonSchemaOf(content: Json, root: Json): Json | undefined {
  if (!content) return undefined;
  const c = deref(content, root);
  const media = c["application/json"] ?? Object.entries(c).find(([k]) => /json/.test(k))?.[1] ?? Object.values(c)[0];
  return media ? deref((media as Json).schema, root) : undefined;
}

function operations(spec: Json): Map<string, Op> {
  const out = new Map<string, Op>();
  for (const [p, item0] of Object.entries<Json>(spec?.paths ?? {})) {
    const item = deref(item0, spec);
    const shared: Json[] = (item.parameters ?? []).map((x: Json) => deref(x, spec));
    for (const m of METHODS) {
      const op = item[m];
      if (!op) continue;
      const params = new Map<string, Json>();
      for (const prm of [...shared, ...(op.parameters ?? []).map((x: Json) => deref(x, spec))]) {
        if (prm.in === "body") continue; // Swagger 2 body param handled below
        params.set(`${prm.in}:${prm.name}`, prm);
      }
      const rb = op.requestBody ? deref(op.requestBody, spec) : undefined;
      const swaggerBody = (op.parameters ?? []).map((x: Json) => deref(x, spec)).find((x: Json) => x.in === "body");
      const responses = new Map<string, Json | undefined>();
      for (const [code, r0] of Object.entries<Json>(op.responses ?? {})) {
        const r = deref(r0, spec);
        responses.set(String(code), r.content ? jsonSchemaOf(r.content, spec) : r.schema ? deref(r.schema, spec) : undefined);
      }
      out.set(normaliseEndpoint(`${m.toUpperCase()} ${p}`), {
        params,
        body: rb ? jsonSchemaOf(rb.content, spec) : swaggerBody ? deref(swaggerBody.schema, spec) : undefined,
        bodyRequired: Boolean(rb?.required ?? swaggerBody?.required),
        responses,
      });
    }
  }
  return out;
}

const typesOf = (s: Json): string[] => {
  if (!s) return [];
  const t = Array.isArray(s.type) ? s.type : s.type ? [s.type] : [];
  return t.filter((x: string) => x !== "null").sort();
};
const nullable = (s: Json) => Boolean(s?.nullable) || (Array.isArray(s?.type) && s.type.includes("null"));

const NUMERIC_TIGHTEN: [string, "min" | "max"][] = [
  ["minimum", "min"],
  ["exclusiveMinimum", "min"],
  ["minLength", "min"],
  ["minItems", "min"],
  ["maximum", "max"],
  ["exclusiveMaximum", "max"],
  ["maxLength", "max"],
  ["maxItems", "max"],
];

/**
 * Compare two schemas. `dir` decides what breaks clients:
 *  request  – new required fields, removed enum values, tighter constraints, type changes break callers
 *  response – removed fields, new nullability, new enum values, type changes break consumers
 */
function compareSchema(a: Json, b: Json, rootA: Json, rootB: Json, dir: "request" | "response", loc: string, endpoint: string, out: ContractChange[], depth = 0): void {
  if (depth > 8) return;
  a = deref(a, rootA);
  b = deref(b, rootB);
  if (!a || !b) return;
  const add = (kind: ContractChangeKind, detail: string, breaking: boolean) => out.push({ endpoint, kind, location: loc, detail, breaking });

  const ta = typesOf(a).join("|");
  const tb = typesOf(b).join("|");
  if (ta && tb && ta !== tb) add("type-changed", `${ta} → ${tb}`, true);
  if (!nullable(a) && nullable(b)) add("nullable-added", "may now be null", dir === "response");
  if (nullable(a) && !nullable(b)) add("nullable-removed", "no longer nullable", dir === "request");

  if (Array.isArray(a.enum) || Array.isArray(b.enum)) {
    const ea = new Set((a.enum ?? []).map(String));
    const eb = new Set((b.enum ?? []).map(String));
    const added = [...eb].filter((x) => !ea.has(x));
    const removed = [...ea].filter((x) => !eb.has(x));
    if (added.length && a.enum) add("enum-values-added", `+${added.join(", ")}`, dir === "response");
    if (removed.length && b.enum) add("enum-values-removed", `-${removed.join(", ")}`, dir === "request");
    if (!a.enum && b.enum) add("constraint-tightened", `now restricted to ${[...eb].join(", ")}`, dir === "request");
  }

  for (const [key, side] of NUMERIC_TIGHTEN) {
    const va = a[key];
    const vb = b[key];
    if (va === vb || (typeof va !== "number" && typeof vb !== "number")) continue;
    const tighter = va === undefined ? true : vb === undefined ? false : side === "min" ? vb > va : vb < va;
    add(tighter ? "constraint-tightened" : "constraint-loosened", `${key}: ${va ?? "none"} → ${vb ?? "none"}`, dir === "request" && tighter);
  }
  if (a.pattern !== b.pattern && (a.pattern || b.pattern)) add("constraint-tightened", `pattern: ${a.pattern ?? "none"} → ${b.pattern ?? "none"}`, dir === "request" && Boolean(b.pattern));
  if (a.format !== b.format && b.format) add("constraint-tightened", `format: ${a.format ?? "none"} → ${b.format}`, dir === "request");

  const pa = a.properties ?? {};
  const pb = b.properties ?? {};
  const ra = new Set<string>(a.required ?? []);
  const rb = new Set<string>(b.required ?? []);
  for (const k of Object.keys(pb)) {
    const l = loc ? `${loc}.${k}` : k;
    if (!(k in pa)) {
      out.push({ endpoint, kind: "field-added", location: l, detail: rb.has(k) ? "required" : "optional", breaking: dir === "request" && rb.has(k) });
    } else {
      if (!ra.has(k) && rb.has(k)) out.push({ endpoint, kind: "field-required", location: l, detail: "now required", breaking: dir === "request" });
      if (ra.has(k) && !rb.has(k)) out.push({ endpoint, kind: "field-optional", location: l, detail: "no longer required", breaking: dir === "response" });
      compareSchema(pa[k], pb[k], rootA, rootB, dir, l, endpoint, out, depth + 1);
    }
  }
  for (const k of Object.keys(pa)) {
    if (!(k in pb)) out.push({ endpoint, kind: "field-removed", location: loc ? `${loc}.${k}` : k, detail: "removed", breaking: dir === "response" });
  }
  if (a.items || b.items) compareSchema(a.items, b.items, rootA, rootB, dir, `${loc}[]`, endpoint, out, depth + 1);
}

export function diffSpecs(baseText: string | undefined, headText: string | undefined): ContractDiff {
  if (baseText === undefined && headText === undefined) return { status: "no-spec", changes: [] };
  let a: Json;
  let b: Json;
  try {
    a = parse(baseText);
    b = parse(headText);
  } catch (e) {
    return { status: "unparseable", changes: [], note: (e as Error).message };
  }
  if (a === undefined) return { status: "spec-added", changes: [], note: "the spec did not exist at the base commit" };
  if (b === undefined) return { status: "spec-removed", changes: [], note: "the spec was deleted" };
  if (baseText === headText) return { status: "unchanged", changes: [] };

  const out: ContractChange[] = [];
  const oa = operations(a);
  const ob = operations(b);
  for (const [ep, opB] of ob) {
    const opA = oa.get(ep);
    if (!opA) {
      out.push({ endpoint: ep, kind: "operation-added", location: "", detail: "new operation", breaking: false });
      continue;
    }
    for (const [k, pB] of opB.params) {
      const pA = opA.params.get(k);
      if (!pA) out.push({ endpoint: ep, kind: "param-added", location: k, detail: pB.required ? "required" : "optional", breaking: Boolean(pB.required) });
      else {
        if (!pA.required && pB.required) out.push({ endpoint: ep, kind: "param-required", location: k, detail: "now required", breaking: true });
        if (pA.required && !pB.required) out.push({ endpoint: ep, kind: "param-optional", location: k, detail: "no longer required", breaking: false });
        compareSchema(pA.schema ?? pA, pB.schema ?? pB, a, b, "request", k, ep, out);
      }
    }
    for (const k of opA.params.keys()) if (!opB.params.has(k)) out.push({ endpoint: ep, kind: "param-removed", location: k, detail: "removed", breaking: false });

    if (!opA.body && opB.body) out.push({ endpoint: ep, kind: "body-added", location: "request.body", detail: opB.bodyRequired ? "required" : "optional", breaking: opB.bodyRequired });
    else if (opA.body && !opB.body) out.push({ endpoint: ep, kind: "body-removed", location: "request.body", detail: "removed", breaking: false });
    else if (opA.body && opB.body) compareSchema(opA.body, opB.body, a, b, "request", "request.body", ep, out);

    for (const [code, sB] of opB.responses) {
      if (!opA.responses.has(code)) {
        out.push({ endpoint: ep, kind: "status-added", location: `response.${code}`, detail: `new ${code} response`, breaking: false });
        continue;
      }
      const sA = opA.responses.get(code);
      if (sA && sB) compareSchema(sA, sB, a, b, "response", `response.${code}.body`, ep, out);
      else if (!sA && sB) out.push({ endpoint: ep, kind: "body-added", location: `response.${code}.body`, detail: "response schema documented", breaking: false });
    }
    for (const code of opA.responses.keys()) {
      if (!opB.responses.has(code)) out.push({ endpoint: ep, kind: "status-removed", location: `response.${code}`, detail: `${code} no longer documented`, breaking: /^2/.test(code) });
    }
  }
  for (const ep of oa.keys()) if (!ob.has(ep)) out.push({ endpoint: ep, kind: "operation-removed", location: "", detail: "operation removed", breaking: true });

  return { status: out.length ? "compared" : "unchanged", changes: out };
}

export const breakingEndpoints = (d: ContractDiff) => new Set(d.changes.filter((c) => c.breaking).map((c) => c.endpoint));

export function contractDiffMarkdown(d: ContractDiff, specPath?: string): string {
  const head = `**Contract changes (computed from \`${specPath ?? "OpenAPI spec"}\`, base → head):**`;
  switch (d.status) {
    case "no-spec":
      return `${head} no OpenAPI spec configured for this service.`;
    case "unchanged":
      return `${head} the spec is unchanged in this diff.`;
    case "spec-added":
    case "spec-removed":
    case "unparseable":
      return `${head} ${d.status}${d.note ? ` (${d.note})` : ""}.`;
  }
  const rows = d.changes.map((c) => `| ${c.breaking ? "⚠️ breaking" : "compatible"} | ${c.endpoint} | ${c.kind} | \`${c.location || "–"}\` | ${c.detail} |`);
  return [head, "", "| Impact | Endpoint | Change | Where | Detail |", "| --- | --- | --- | --- | --- |", ...rows].join("\n");
}
