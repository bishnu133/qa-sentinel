import type { Config } from "../config.js";
import { matchesAny } from "../fsutil.js";
import { git } from "../git.js";

/**
 * Change types found in the code, no AI: a database migration, a config or feature-toggle file, a dependency
 * change. They are looked up from the changed file names (globs in `risk.changeTypes`) over ALL changed files, not only
 * the "relevant" ones (lock files and docs are skipped for planning, but a dependency file is not).
 * For package.json the section matters: a changed script or version field is not a dependency change, and a
 * major version jump (^1 to ^2) is flagged.
 */
export type ChangeKind = "migration" | "config" | "toggle" | "dependency";

export interface ChangeKindFinding {
  kind: ChangeKind;
  file: string;
  /** Story mode: the service the file is in. */
  service?: string;
  /** Dependency changes: a major version went up (or a dependency was added or removed in a way that needs a look). */
  major?: boolean;
  /** Short plain description, e.g. "express ^4.21 to ^5.0 (major)". */
  detail?: string;
}

const DEP_SECTIONS = ["dependencies", "devDependencies", "peerDependencies"] as const;

/** First number in a version range: "^1.2.3" gives 1, ">=2 <3" gives 2, "workspace:*" gives undefined. */
export function majorOf(range: string): number | undefined {
  const m = range.match(/(\d+)/);
  return m ? Number(m[1]) : undefined;
}

export interface DependencyChange {
  name: string;
  section: string;
  from?: string;
  to?: string;
  major: boolean;
}

/** Dependency entries that differ between two package.json texts. Unreadable JSON counts as no entries. */
export function packageJsonDependencyChanges(before: string | undefined, after: string | undefined): DependencyChange[] {
  const read = (t: string | undefined): Record<string, any> => {
    try {
      return t ? (JSON.parse(t) as Record<string, any>) : {};
    } catch {
      return {};
    }
  };
  const a = read(before);
  const b = read(after);
  const out: DependencyChange[] = [];
  for (const section of DEP_SECTIONS) {
    const x: Record<string, string> = a[section] && typeof a[section] === "object" ? a[section] : {};
    const y: Record<string, string> = b[section] && typeof b[section] === "object" ? b[section] : {};
    for (const name of new Set([...Object.keys(x), ...Object.keys(y)])) {
      if (x[name] === y[name]) continue;
      const from = x[name];
      const to = y[name];
      const f = from === undefined ? undefined : majorOf(String(from));
      const t = to === undefined ? undefined : majorOf(String(to));
      out.push({ name, section, from, to, major: f !== undefined && t !== undefined && t > f });
    }
  }
  return out;
}

const describe = (d: DependencyChange) => (d.from === undefined ? `${d.name} added (${d.to})` : d.to === undefined ? `${d.name} removed` : `${d.name} ${d.from} to ${d.to}${d.major ? " (major)" : ""}`);

/** The file text at a commit, or undefined when it did not exist there. Paths are relative to the repo folder. */
function showAt(repo: string, sha: string, file: string): string | undefined {
  try {
    return git(repo, ["show", `${sha}:./${file}`]);
  } catch {
    return undefined;
  }
}

/**
 * Change types for one change set. `files` are the changed files (relative to `repo`); `base` and `head` are the
 * commits, used to read package.json before and after.
 */
export function changeKinds(c: Pick<Config, "risk">, i: { repo: string; base: string; head: string; files: string[]; service?: string }): ChangeKindFinding[] {
  const t = c.risk.changeTypes;
  const out: ChangeKindFinding[] = [];
  const tag = (f: Omit<ChangeKindFinding, "service">) => out.push(i.service ? { ...f, service: i.service } : f);
  for (const file of [...new Set(i.files)].sort()) {
    if (matchesAny(file, t.migration)) tag({ kind: "migration", file });
    if (matchesAny(file, t.config)) tag({ kind: "config", file });
    if (matchesAny(file, t.toggle)) tag({ kind: "toggle", file });
    if (matchesAny(file, t.dependency)) {
      if (/(^|\/)package\.json$/.test(file)) {
        const changes = packageJsonDependencyChanges(showAt(i.repo, i.base, file), showAt(i.repo, i.head, file));
        // A package.json whose dependency sections did not change (a script, a version field) is not a dependency change.
        if (!changes.length) continue;
        tag({ kind: "dependency", file, major: changes.some((x) => x.major), detail: changes.slice(0, 6).map(describe).join("; ") + (changes.length > 6 ? `; and ${changes.length - 6} more` : "") });
      } else tag({ kind: "dependency", file });
    }
  }
  return out;
}

export const KIND_LABEL: Record<ChangeKind, string> = {
  migration: "Database migration",
  config: "Configuration change",
  toggle: "Feature toggle change",
  dependency: "Dependency change",
};

/** Risk factors the findings imply (the rules in RISK_RULES give each its level). */
export function factorsOfKinds(findings: ChangeKindFinding[]): ("db-migration" | "config-change" | "toggle-change" | "dependency-bump" | "dependency-major")[] {
  const f = new Set<"db-migration" | "config-change" | "toggle-change" | "dependency-bump" | "dependency-major">();
  for (const x of findings) {
    if (x.kind === "migration") f.add("db-migration");
    else if (x.kind === "config") f.add("config-change");
    else if (x.kind === "toggle") f.add("toggle-change");
    else {
      f.add("dependency-bump");
      if (x.major) f.add("dependency-major");
    }
  }
  return [...f];
}

/** Markdown for the report: what was found, by file. Empty when nothing was found. */
export function changeKindsMarkdown(findings: ChangeKindFinding[]): string {
  if (!findings.length) return "";
  return [
    "**Change types found in the code (no AI)**",
    "",
    ...findings.map((x) => `- ${KIND_LABEL[x.kind]}${x.major ? " (major version)" : ""}: \`${x.service ? `${x.service}/` : ""}${x.file}\`${x.detail ? ` – ${x.detail}` : ""}`),
    "",
    "_A database migration is high risk; a config, toggle or dependency change is medium (a major dependency version is high). qa-sentinel adds this risk itself; the agent does not choose it._",
  ].join("\n");
}
