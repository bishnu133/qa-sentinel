import { layers } from "./layers.js";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import type { Config } from "./config.js";
import { matchesAny } from "./fsutil.js";
import { type FileChange, showFile, workingChanges } from "./git.js";

export interface Finding {
  level: "violation" | "warning";
  rule: "blocked-path" | "outside-allowed" | "service-repo-modified" | "url-host" | "secret" | "assertion-removed" | "test-deleted" | "traceability" | "test-data" | "fixed-wait" | "expectation-changed" | "expectation-removed" | "expected-file-invalid" | "ac-test-disabled" | "expectation-override" | "known-defect-by-agent" | "expected-value-missing" | "symlink" | "submodule" | "artifact-committed";
  file: string;
  message: string;
}

export interface WritePolicy {
  allowed: string[];
  blocked: string[];
}

export const TEST_FILE = /\.(spec|test)\.(ts|tsx|js|mjs|cjs)$/;

/** Globs the agent may change in `generate`. */
/**
 * Web scaffold files that decide whether healing runs and how page-object actions fail. Verification relies on
 * them (QA_HEALING=off must mean "no healing"), so the agent may never change them.
 */
export const PROTECTED_WEB_FILES = ["src/web/healing.ts", "src/web/ui.ts", "src/fixtures/web.ts"];
/** Mobile scaffold files that produce the evidence and pick the device: the agent may not change them either. */
export const PROTECTED_MOBILE_FILES = ["wdio.conf.ts", "src/mobile/evidence.ts", "src/mobile/ui.ts", "src/fixtures/mobile.ts"];

export function generatePolicy(c: Config): WritePolicy {
  const derived = [...layers(c).flatMap((t) => [`${t.dir}/**`, `${t.helpersDir}/**`, ...t.extraWritePaths]), "test-map.yaml"];
  return {
    // Manual test cards (qa-sentinel writes them from the plan) are part of every agent MR.
    // The expected-behaviour files too: the lock (expected/lock.ts) decides which of their changes are accepted.
    allowed: [...(c.guardrails.allowedWritePaths.length ? c.guardrails.allowedWritePaths : derived), `${c.tests.manualDir}/**`, `${c.tests.expectedDir}/**`],
    blocked: [...c.guardrails.blockedWritePaths, ...(c.tests.web.enabled ? PROTECTED_WEB_FILES : []), ...(c.tests.mobile.enabled ? PROTECTED_MOBILE_FILES : [])],
  };
}

/** `learn` may only touch the three knowledge files it is responsible for. */
export const LEARN_FILES = [".claude/skills/write-api-test/SKILL.md", "test-map.yaml", ".claude/qa-sentinel.md"];
/** With the web layer on, `learn` also writes the web conventions into the write-web-test skill. */
export function learnPolicy(c?: Config): WritePolicy {
  return {
    allowed: [...LEARN_FILES, ...(c?.tests.web.enabled ? [".claude/skills/write-web-test/SKILL.md"] : []), ...(c?.tests.mobile.enabled ? [".claude/skills/write-mobile-test/SKILL.md"] : [])],
    blocked: [],
  };
}

/** Symbolic links and submodule links added by an agent: they can point outside the repository or pull in other code, so they are never allowed. */
export function checkSpecialModes(found: { path: string; kind: "symlink" | "submodule" }[]): Finding[] {
  return found.map((f) => ({ level: "violation" as const, rule: f.kind, file: f.path, message: f.kind === "symlink" ? "a symbolic link (mode 120000) may not be added by the agent" : "a submodule link (mode 160000) may not be added by the agent" }));
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
    // A symbolic link is never followed: its target may be a file outside the repo (and the link itself is refused by checkSpecialModes).
    if (fs.lstatSync(file).isSymbolicLink()) return undefined;
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
  /** Other base URLs whose hosts are allowed too (e.g. the web front end). */
  extraBaseUrls?: string[];
  assertionRemoval: "warn" | "fail";
}

/** Content rules on what the agent added: URL hosts, secrets, assertion removal, deleted tests. */
/** waitForTimeout(3000), sleep(2000), setTimeout(r, 5000), Thread.sleep(…), time.sleep(…): waits of a second or more. */
const FIXED_WAIT = /\b(?:waitForTimeout|sleep|delay|pause)\s*\(\s*(?:[1-9]\d{3,}|[1-9]\d*_?\d{3}|\d+\s*\*\s*1000)\s*\)|\bsetTimeout\s*\([^,]+,\s*(?:[1-9]\d{3,})\s*\)|\b(?:Thread|time)\.sleep\s*\(/;

export function checkContent(changes: FileChange[], o: ContentCheckOptions): Finding[] {
  const findings: Finding[] = [];
  const hosts = [...o.allowedHosts];
  for (const u of [o.baseUrl, ...(o.extraBaseUrls ?? [])]) {
    if (!u) continue;
    try {
      hosts.push(new URL(u).hostname);
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
      // Fixed sleeps make async tests slow and flaky: poll for the state instead (pollUntil, expect.poll).
      if (TEST_FILE.test(ch.path) || /\/(api|helpers?|support|pages|screens)\//.test(ch.path)) {
        const wait = line.match(FIXED_WAIT);
        if (wait && !/QA_SHOWCASE|showcase/i.test(line)) findings.push({ level: "warning", rule: "fixed-wait", file: ch.path, message: `fixed wait \`${wait[0].trim()}\`: poll for the expected state instead (pollUntil / expect.poll)` });
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
export function claudePermissions(o: { write: WritePolicy | undefined; bash: string[]; readOnlyDirs: string[]; readDeny?: string[] }) {
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
    // Read rules also govern Grep and Glob.
    ...(o.readDeny ?? []).map((d) => `Read(/${path.resolve(d)}/**)`),
  ];
  return { allow, deny };
}

/** `test.fail(...)` in any form (declaration, `test.fail()` / `test.fail(cond)` inside a test, `test.describe.fail`): expected to fail. Only a person marks one, after triage. */
export const KNOWN_DEFECT = /(?<![\w$.])(?!(?:assert|expect|chai|should|Promise|promise)\b)[A-Za-z_$][\w$]*(?:\.describe)?\.fail(?:\.only)?\s*\(/;
const CODE_FILE = /\.[cm]?[jt]sx?$/;

/**
 * An AI run may not mark a test as a known defect (`test.fail`): that says "QA confirmed a product defect, here is
 * the bug", which only a person can say. The agent writes `test.fixme` with a `// QA-AGENT:` note instead.
 */
export function checkKnownDefectMarkers(changes: FileChange[], repo: string, ref: string, added: (file: string) => string[] = (f) => addedLines(repo, ref, f)): Finding[] {
  const out: Finding[] = [];
  for (const ch of changes) {
    // Any code file: a test.fail() in a shared fixture or hook marks every test that uses it.
    if (ch.status === "D" || !CODE_FILE.test(ch.path)) continue;
    const n = added(ch.path).filter((l) => KNOWN_DEFECT.test(l)).length;
    if (n)
      out.push({
        level: "violation",
        rule: "known-defect-by-agent",
        file: ch.path,
        message: `${n} test(s) marked as a known defect (test.fail). Only a QA engineer does that, after triage, with the bug link; write test.fixme with a "// QA-AGENT:" note instead`,
      });
  }
  return out;
}
