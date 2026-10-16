import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { Config, ServiceConfig } from "./config.js";
import YAML from "yaml";
import { type ContractChange, type ContractChangeKind, diffSpecs, pathPrefix } from "./analysis/contractDiff.js";
import { globToRegExp } from "./fsutil.js";
import { netFetch } from "./net.js";
import { gitlabContext } from "./scm/gitlab.js";
import { jiraContext, storyAttachments, downloadAttachment } from "./scm/jira.js";
import { log } from "./log.js";

/**
 * Spec-first teams agree the API spec before the code is written, and that spec — not whatever the code ends up
 * generating — is the source of truth. It often lives outside the service repo: a specs repo, a URL (an API portal,
 * a raw file), or an attachment on the Jira story. `contract` says where; qa-sentinel loads it and compares the
 * service's implemented spec with it field by field, error responses included.
 */
export { ContractSourceSchema, type ContractSource } from "./contractSource.js";
import type { ContractSource } from "./contractSource.js";

export interface LoadedContract {
  text: string;
  /** Where it came from, for reports: "file specs/orders.yaml", "jira SHOP-12 orders-api.yaml", … */
  from: string;
}

export function describeSource(s: ContractSource, storyKey?: string): string {
  if (s.file) return `file ${s.file}`;
  if (s.repo) return `repo ${s.repo}${s.ref ? `@${s.ref}` : ""}:${s.path}`;
  if (s.gitlabProject) return `GitLab ${s.gitlabProject}@${s.ref ?? "main"}:${s.path}`;
  if (s.url) return `URL ${safeOrigin(s.url)}`;
  return `Jira ${storyKey ?? "story"} attachment ${s.jiraAttachment}`;
}

const safeOrigin = (u: string) => {
  try {
    const x = new URL(u);
    return `${x.origin}${x.pathname}`;
  } catch {
    return "(invalid URL)";
  }
};

export interface LoadOptions {
  cwd: string;
  storyKey?: string;
  env?: NodeJS.ProcessEnv;
}

/** Load the agreed spec. Returns undefined (with a reason) instead of throwing: a missing contract must not stop a gap report. */
export async function loadContract(c: Config, s: ContractSource, o: LoadOptions): Promise<{ contract?: LoadedContract; reason?: string }> {
  const env = o.env ?? process.env;
  const from = describeSource(s, o.storyKey);
  try {
    if (s.file) {
      const p = path.resolve(o.cwd, s.file);
      if (!fs.existsSync(p)) return { reason: `${from}: file not found` };
      return { contract: { text: fs.readFileSync(p, "utf8"), from } };
    }
    if (s.repo) {
      const repo = path.resolve(o.cwd, s.repo);
      if (!fs.existsSync(repo)) return { reason: `${from}: repository not found (clone it next to the tests, or use gitlabProject)` };
      const text = execFileSync("git", ["show", `${s.ref ?? "HEAD"}:${s.path!.replace(/^\.?\//, "")}`], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      return { contract: { text, from } };
    }
    if (s.gitlabProject) {
      const ctx = gitlabContext(c.ci.gitlabUrl, env);
      if (!ctx) return { reason: `${from}: no GitLab token (QA_SENTINEL_GITLAB_TOKEN)` };
      const route = `/projects/${encodeURIComponent(s.gitlabProject)}/repository/files/${encodeURIComponent(s.path!.replace(/^\.?\//, ""))}/raw?ref=${encodeURIComponent(s.ref ?? "main")}`;
      const res = await netFetch(`${ctx.apiUrl}${route}`, { headers: { "PRIVATE-TOKEN": ctx.token } });
      if (!res.ok) return { reason: `${from}: GitLab answered ${res.status}` };
      return { contract: { text: await res.text(), from } };
    }
    if (s.url) {
      const header = s.urlHeaderEnv ? env[s.urlHeaderEnv] : undefined;
      if (s.urlHeaderEnv && !header) return { reason: `${from}: ${s.urlHeaderEnv} is not set` };
      const res = await netFetch(s.url, { headers: header ? { Authorization: header } : {} });
      if (!res.ok) return { reason: `${from}: answered ${res.status}` };
      return { contract: { text: await res.text(), from } };
    }
    if (s.jiraAttachment) {
      if (!o.storyKey) return { reason: `${from}: no story for this change` };
      const ctx = jiraContext(c.requirements.jira.baseUrl, env);
      if (!ctx) return { reason: `${from}: no Jira credentials` };
      const re = globToRegExp(s.jiraAttachment);
      const matches = (await storyAttachments(ctx, o.storyKey)).filter((a) => re.test(a.filename));
      if (!matches.length) return { reason: `${from}: no attachment matches` };
      // Several versions attached: the newest one is the agreed spec.
      const newest = matches.sort((a, b) => (b.created ?? "").localeCompare(a.created ?? ""))[0];
      return { contract: { text: await downloadAttachment(ctx, newest.content, newest.size), from: `Jira ${o.storyKey} attachment ${newest.filename}` } };
    }
  } catch (e) {
    return { reason: `${from}: ${(e as Error).message.split("\n")[0]}` };
  }
  return { reason: "contract: no source" };
}

// ---------------------------------------------------------------------------------------------
// Conformance: the implemented spec against the agreed one.

export interface Deviation {
  /** Under the specs' base paths ("GET /api/v1/orders/{}"), so differently written specs compare. */
  endpoint: string;
  /** As the service's own spec names it, without its base path: how gap reports, plans and tests name it. */
  localEndpoint: string;
  /** mismatch: a client built to the agreed spec breaks, or a promised response (errors included) is missing. extra: the code does more than agreed. */
  severity: "mismatch" | "extra";
  location: string;
  /** Plain words, from the agreed spec's point of view. */
  detail: string;
  kind: ContractChangeKind;
}

export interface ContractCheck {
  service: string;
  status: "checked" | "conforms" | "no-contract" | "no-implementation-spec" | "unparseable";
  from?: string;
  deviations: Deviation[];
  note?: string;
}

/** Kinds that are a mismatch even when the diff calls them compatible: the agreed spec promised something the code doesn't do. */
const ALWAYS_MISMATCH = new Set<ContractChangeKind>(["status-removed", "param-removed", "body-removed", "operation-removed", "field-removed"]);

const WORDS: Record<ContractChangeKind, (c: ContractChange) => string> = {
  "operation-added": () => "implemented, but not in the agreed spec",
  "operation-removed": () => "in the agreed spec, not implemented",
  "param-added": (c) => `the code has a ${c.detail} parameter the agreed spec doesn't`,
  "param-removed": () => "agreed parameter not implemented",
  "param-required": () => "the code requires it; the agreed spec makes it optional",
  "param-optional": () => "the agreed spec requires it; the code makes it optional",
  "field-added": (c) => `the code has a ${c.detail} field the agreed spec doesn't`,
  "field-removed": () => "agreed field missing in the code",
  "field-required": () => "the code requires it; the agreed spec makes it optional",
  "field-optional": () => "the agreed spec requires it; the code makes it optional",
  "type-changed": (c) => `type differs (agreed → code: ${c.detail})`,
  "nullable-added": () => "the code allows null; the agreed spec doesn't",
  "nullable-removed": () => "the agreed spec allows null; the code doesn't",
  "enum-values-added": (c) => `the code allows extra values (${c.detail.replace(/^\+/, "")})`,
  "enum-values-removed": (c) => `agreed values missing in the code (${c.detail.replace(/^-/, "")})`,
  "constraint-tightened": (c) => `the code is stricter (agreed → code: ${c.detail})`,
  "constraint-loosened": (c) => `the code is looser (agreed → code: ${c.detail})`,
  "status-added": (c) => `the code documents a response the agreed spec doesn't (${c.location.replace("response.", "")})`,
  "status-removed": (c) => `agreed response not in the code (${c.location.replace("response.", "")})`,
  "body-added": () => "the code has a body the agreed spec doesn't",
  "body-removed": () => "agreed body not in the code",
};

/**
 * Compare the implemented spec with the agreed one. Reusing the base→head diff with base = agreed and head = code
 * gives exactly the right question: what breaks for a client written against the agreed spec.
 */
export function checkContract(service: string, agreed: LoadedContract | undefined, implemented: string | undefined, reason?: string): ContractCheck {
  if (!agreed) return { service, status: "no-contract", deviations: [], note: reason };
  if (implemented === undefined)
    return {
      service,
      status: "no-implementation-spec",
      from: agreed.from,
      deviations: [],
      note: "the service has no OpenAPI spec of its own (set openapi, and openapiCommand if it is generated), so the code is checked against the agreed spec by the tests only",
    };
  const d = diffSpecs(agreed.text, implemented, { fullPaths: true });
  // Multi-file specs: references to other files aren't followed, so fields behind them weren't compared.
  const external = [agreed.text, implemented].some((t) => /\$ref["']?\s*:\s*["']?(?!#)[^\s"']+/.test(t));
  const partial = external ? "references to other files ($ref) aren't followed: fields defined there were not compared" : undefined;
  if (d.status === "unparseable") return { service, status: "unparseable", from: agreed.from, deviations: [], note: d.note };
  if (d.status === "unchanged") return { service, status: "conforms", from: agreed.from, deviations: [], note: partial };
  let prefix = "";
  try {
    prefix = pathPrefix(YAML.parse(implemented));
  } catch {
    // unparseable is reported above
  }
  const local = (ep: string) => (prefix && ep.includes(` ${prefix}/`) ? ep.replace(` ${prefix}/`, " /") : ep);
  const deviations = d.changes.map((c) => ({
    endpoint: c.endpoint,
    localEndpoint: local(c.endpoint),
    kind: c.kind,
    location: c.location,
    severity: c.breaking || ALWAYS_MISMATCH.has(c.kind) ? ("mismatch" as const) : ("extra" as const),
    detail: WORDS[c.kind](c),
  }));
  return { service, status: deviations.length ? "checked" : "conforms", from: agreed.from, deviations, note: partial };
}

/** Deviations on the endpoints a change touches (all of them when `touched` is not given: `contract-check`). */
export const deviationsIn = (k: ContractCheck, touched?: Set<string>) => (touched ? k.deviations.filter((d) => touched.has(d.endpoint) || touched.has(d.localEndpoint)) : k.deviations);

/**
 * Per MR (`touched` given, possibly empty): only the endpoints the change touches are listed, the rest are counted,
 * so a report stays about the MR. Without `touched`: every deviation.
 */
export function contractCheckMarkdown(checks: ContractCheck[], touched?: Set<string>): string {
  const lines: string[] = [];
  for (const k of checks) {
    const head = `**Agreed API contract — ${k.service}**${k.from ? ` (${k.from})` : ""}:`;
    if (k.status === "no-contract") {
      lines.push(`${head} could not be loaded${k.note ? `: ${k.note}` : ""}.`);
      continue;
    }
    if (k.status === "conforms") {
      lines.push(`${head} the implemented spec matches it${k.note ? ` (${k.note})` : ""}.`);
      continue;
    }
    if (k.status !== "checked") {
      lines.push(`${head} ${k.note ?? k.status}.`);
      continue;
    }
    const inScope = deviationsIn(k, touched);
    const others = k.deviations.length - inScope.length;
    const mismatches = inScope.filter((d) => d.severity === "mismatch").length;
    lines.push(
      `${head} ${mismatches} mismatch${mismatches === 1 ? "" : "es"} and ${inScope.length - mismatches} extra${touched ? " on the endpoints this change touches" : ""}.`,
    );
    if (k.note) lines.push("", `_${k.note}._`);
    if (inScope.length) {
      lines.push("", "| | Endpoint | Where | Agreed spec vs code |", "| --- | --- | --- | --- |");
      for (const d of inScope.sort((a, b) => (a.severity === b.severity ? a.endpoint.localeCompare(b.endpoint) : a.severity === "mismatch" ? -1 : 1)))
        lines.push(`| ${d.severity === "mismatch" ? "❌ mismatch" : "➕ extra"} | ${touched ? d.localEndpoint : d.endpoint} | \`${d.location || "–"}\` | ${d.detail} |`);
    }
    if (others > 0) lines.push("", `${others} more deviation${others === 1 ? "" : "s"} on endpoints this change doesn't touch (\`qa-sentinel contract-check\` lists them all).`);
    lines.push("");
  }
  return lines.join("\n").trim();
}

/** Services with a contract, for loops. */
export const contractServices = (c: Config): ServiceConfig[] => c.workspace.services.filter((s) => s.contract);

export function warnContract(service: string, reason: string | undefined): void {
  if (reason) log.warn(`${service}: agreed contract not loaded (${reason})`);
}
