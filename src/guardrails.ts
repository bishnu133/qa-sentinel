import fs from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import type { Config } from "./config.js";
import { matchesAny } from "./fsutil.js";
import { type FileChange, showFile, workingChanges } from "./git.js";

export interface Finding {
  level: "violation" | "warning";
  rule: "blocked-path" | "outside-allowed" | "service-repo-modified" | "url-host" | "secret" | "assertion-removed" | "test-deleted";
  file: string;
  message: string;
}

export interface WritePolicy {
  allowed: string[];
  blocked: string[];
}

export const TEST_FILE = /\.(spec|test)\.(ts|tsx|js|mjs|cjs)$/;

/** Globs the agent may change in `generate`. */
export function generatePolicy(c: Config): WritePolicy {
  const t = c.tests.api;
  const derived = [`${t.dir}/**`, `${t.helpersDir}/**`, ...t.extraWritePaths, "test-map.yaml"];
  return {
    allowed: c.guardrails.allowedWritePaths.length ? c.guardrails.allowedWritePaths : derived,
    blocked: c.guardrails.blockedWritePaths,
  };
}

/** `learn` may only touch the three knowledge files it is responsible for. */
export const LEARN_FILES = [".claude/skills/write-api-test/SKILL.md", "test-map.yaml", ".claude/qa-sentinel.md"];
export function learnPolicy(): WritePolicy {
  return { allowed: LEARN_FILES, blocked: [] };
}

/** Path rules: blocked always wins; everything else must be allowed. Deletions and both sides of renames count. */
export function checkPaths(changes: FileChange[], policy: WritePolicy): Finding[] {
  const findings: Finding[] = [];
  const touched = changes.flatMap((c) => (c.from && c.status === "R" ? [c.path, c.from] : [c.path]));
  for (const f of new Set(touched)) {
    if (policy.blocked.length && matchesAny(f, policy.blocked)) {
      findings.push({ level: "violation", rule: "blocked-path", file: f, message: "changes to this path are blocked" });
    } else if (!matchesAny(f, policy.allowed)) {
      findings.push({ level: "violation", rule: "outside-allowed", file: f, message: "outside the paths the agent may change" });
    }
  }
  return findings;
}

const URL_RE = /\bhttps?:\/\/([a-zA-Z0-9.-]+)(?::\d+)?/g;
const SECRET_PATTERNS: [string, RegExp][] = [
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["GitLab token", /\bglpat-[A-Za-z0-9_-]{20,}\b/],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ["Anthropic key", /\bsk-ant-[A-Za-z0-9_-]{20,}\b/],
  ["Slack token", /\bxox[abpors]-[A-Za-z0-9-]{10,}\b/],
  ["JWT", /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
  ["hard-coded bearer token", /Bearer\s+[A-Za-z0-9._~+/-]{24,}/],
];

/** Lines added in a file compared with `ref` (whole file for new files). */
export function addedLines(repo: string, ref: string, file: string): string[] {
  const now = readSafe(path.join(repo, file));
  if (now === undefined) return [];
  const before = showFile(repo, ref, file);
  if (before === undefined) return now.split("\n");
  const old = new Map<string, number>();
  for (const l of before.split("\n")) old.set(l, (old.get(l) ?? 0) + 1);
  const added: string[] = [];
  for (const l of now.split("\n")) {
    const n = old.get(l) ?? 0;
    if (n > 0) old.set(l, n - 1);
    else added.push(l);
  }
  return added;
}

function readSafe(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

export function hostAllowed(host: string, allowed: string[]): boolean {
  const h = host.toLowerCase();
  return allowed.some((a) => {
    const x = a.toLowerCase();
    return x.startsWith("*.") ? h.endsWith(x.slice(1)) || h === x.slice(2) : h === x;
  });
}

/** One match per assertion statement (expect(...).toBe counts once). */
const ASSERTION_RE = /\bexpect(?:\.soft)?\s*\(|\bassert(?:\.\w+)?\s*\(|\.should\s*\(|\bexpectSchema\s*\(/g;
export const countAssertions = (src: string) => (src.match(ASSERTION_RE) ?? []).length;

export interface ContentCheckOptions {
  repo: string;
  ref: string; // what the agent started from
  allowedHosts: string[];
  baseUrl?: string;
  assertionRemoval: "warn" | "fail";
}

/** Content rules on what the agent added: URL hosts, secrets, assertion removal, deleted tests. */
export function checkContent(changes: FileChange[], o: ContentCheckOptions): Finding[] {
  const findings: Finding[] = [];
  const hosts = [...o.allowedHosts];
  if (o.baseUrl) {
    try {
      hosts.push(new URL(o.baseUrl).hostname);
    } catch {
      /* ignore malformed base URL */
    }
  }
  const assertionLevel = o.assertionRemoval === "fail" ? "violation" : "warning";
  for (const ch of changes) {
    if (ch.status === "D") {
      if (TEST_FILE.test(ch.path)) findings.push({ level: assertionLevel, rule: "test-deleted", file: ch.path, message: "test file deleted" });
      continue;
    }
    const added = addedLines(o.repo, o.ref, ch.path);
    for (const line of added) {
      for (const m of line.matchAll(URL_RE)) {
        if (!hostAllowed(m[1], hosts)) {
          findings.push({ level: "violation", rule: "url-host", file: ch.path, message: `URL host "${m[1]}" is not in guardrails.allowedHosts` });
        }
      }
      for (const [name, re] of SECRET_PATTERNS) {
        if (re.test(line)) findings.push({ level: "violation", rule: "secret", file: ch.path, message: `looks like a ${name}` });
      }
    }
    if (TEST_FILE.test(ch.path)) {
      const before = showFile(o.repo, o.ref, ch.from ?? ch.path);
      const after = readSafe(path.join(o.repo, ch.path));
      if (before !== undefined && after !== undefined) {
        const b = countAssertions(before);
        const a = countAssertions(after);
        if (a < b) findings.push({ level: assertionLevel, rule: "assertion-removed", file: ch.path, message: `assertions went from ${b} to ${a}` });
      }
    }
  }
  return dedupe(findings);
}

export type TreeSnapshot = Map<string, string>;

/**
 * Fingerprint of a working tree: HEAD plus every uncommitted/untracked path with its status, size and mtime.
 * Taken before and after an agent run, so pre-existing local changes (node_modules, build output) are not blamed on it.
 */
export function snapshotTree(repo: string): TreeSnapshot {
  const snap: TreeSnapshot = new Map();
  try {
    snap.set("\0HEAD", execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim());
  } catch {
    /* no commits */
  }
  for (const c of workingChanges(repo)) {
    let sig = c.status;
    try {
      const st = fs.statSync(path.join(repo, c.path));
      sig += `:${st.size}:${st.mtimeMs}`;
    } catch {
      sig += ":gone";
    }
    snap.set(c.path, sig);
  }
  return snap;
}

/** Paths whose state differs between two snapshots (added, changed or reverted). */
export function diffSnapshots(before: TreeSnapshot, after: TreeSnapshot): string[] {
  const out = new Set<string>();
  for (const [k, v] of after) if (before.get(k) !== v) out.add(k);
  for (const k of before.keys()) if (!after.has(k)) out.add(k);
  return [...out].map((k) => (k === "\0HEAD" ? "(HEAD moved)" : k));
}

/** The service checkout must be untouched by the agent run (compared with a snapshot taken before it). */
export function checkServiceUntouched(serviceRepo: string, label: string, before?: TreeSnapshot): Finding[] {
  const changed = before ? diffSnapshots(before, snapshotTree(serviceRepo)) : workingChanges(serviceRepo).map((c) => c.path);
  return changed.map((p) => ({
    level: "violation" as const,
    rule: "service-repo-modified" as const,
    file: `${label}/${p}`,
    message: "the agent changed the service repo, which must stay read-only",
  }));
}

function dedupe(fs_: Finding[]): Finding[] {
  const seen = new Set<string>();
  return fs_.filter((f) => {
    const k = `${f.rule}|${f.file}|${f.message}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export const violations = (f: Finding[]) => f.filter((x) => x.level === "violation");

export function findingsMarkdown(f: Finding[]): string {
  if (!f.length) return "";
  return ["| Level | Rule | File | Detail |", "| --- | --- | --- | --- |", ...f.map((x) => `| ${x.level} | ${x.rule} | \`${x.file}\` | ${x.message} |`)].join("\n");
}

/**
 * Claude Code permission settings for a run. Defence in depth only: the post-run checks above are what
 * actually decide whether a change is accepted.
 */
export function claudePermissions(o: { write: WritePolicy | undefined; bash: string[]; readOnlyDirs: string[] }) {
  const allow = ["Read", "Grep", "Glob", "Agent"];
  if (o.write) for (const g of o.write.allowed) allow.push(`Edit(${g.replace(/^\.\//, "")})`);
  for (const b of o.bash) allow.push(`Bash(${b})`);
  const deny = [
    "Read(.env*)",
    "Read(**/*.pem)",
    "Read(**/*.key)",
    "Read(~/.ssh/**)",
    "Read(~/.aws/**)",
    "Read(~/.config/gcloud/**)",
    "Read(~/.netrc)",
    "Read(~/.git-credentials)",
    "Read(//**/.git/config)",
    "Bash(curl *)",
    "Bash(wget *)",
    "Bash(env)",
    "Bash(printenv*)",
    "WebFetch",
    "WebSearch",
    ...(o.write?.blocked ?? []).map((g) => `Edit(${g})`),
    ...o.readOnlyDirs.map((d) => `Edit(/${path.resolve(d)}/**)`),
  ];
  return { allow, deny };
}
