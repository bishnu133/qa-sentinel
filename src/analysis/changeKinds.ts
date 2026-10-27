import type { Config } from "../config.js";
import { globToRegExp } from "../fsutil.js";
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

/** Runtime dependency sections. devDependencies are left out on purpose: a lint or test tool changes no behaviour of the service. */
const DEP_SECTIONS = ["dependencies", "peerDependencies", "optionalDependencies"] as const;

/** A glob list where "!glob" excludes, and every glob is case-insensitive (Application.yml, Migrations/). */
export function matchesKind(file: string, globs: string[]): boolean {
  const re = (g: string) => new RegExp(globToRegExp(g).source, "i");
  const yes = globs.filter((g) => !g.startsWith("!"));
  const no = globs.filter((g) => g.startsWith("!")).map((g) => g.slice(1));
  return yes.some((g) => re(g).test(file)) && !no.some((g) => re(g).test(file));
}

/**
 * What a version range says about breaking changes, or undefined when it says nothing we can compare:
 *   "^4.21.2" gives "4", "^0.3.1" gives "0.3" (a 0.x minor bump is breaking in semver), "latest" and "*" give "*",
 *   "workspace:^1" and "npm:alias@^2" are read as their version, "file:", "link:" and git URLs without a version are ignored.
 */
export function breakingKey(range: string): string | undefined {
  let r = range.trim();
  if (/^(latest|next|\*|x|)$/i.test(r)) return "*";
  if (/^workspace:[\^~*]?$/.test(r)) return undefined;
  r = r.replace(/^workspace:/, "");
  r = r.replace(/^npm:(?:@[^/]+\/)?[^@]+@/, "");
  if (/^(file:|link:|portal:|\.{0,2}\/)/.test(r)) return undefined;
  // git and URL specs: only a version in the #fragment counts ("github:org/lib2#v3.0"), the name never does.
  if (/^(git\+|git:|github:|gitlab:|bitbucket:|https?:|ssh:)|^[\w.-]+\/[\w.-]+(#|$)/i.test(r)) {
    const frag = r.split("#")[1]?.replace(/^semver:/, "");
    if (!frag) return undefined;
    r = frag;
  }
  const m = r.match(/(\d+)(?:\.(\d+))?/);
  if (!m) return /^[\^~<>=\s]*\*$/.test(r) ? "*" : undefined;
  return Number(m[1]) === 0 ? `0.${m[2] ?? "0"}` : String(Number(m[1]));
}

/** First number in a version range: "^1.2.3" gives 1, ">=2 <3" gives 2, "workspace:*" gives undefined. */
export function majorOf(range: string): number | undefined {
  const k = breakingKey(range);
  return k === undefined || k === "*" ? undefined : Number(k.split(".")[0]);
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
      const f = from === undefined ? undefined : breakingKey(String(from));
      const t = to === undefined ? undefined : breakingKey(String(to));
      // Any change of major counts, a downgrade too (^2 to ^1 breaks callers as well).
      out.push({ name, section, from, to, major: f !== undefined && t !== undefined && f !== t });
    }
  }
  return out;
}

/**
 * The lines of a dependency file that declare dependencies, so a release bump or a plugin change in pom.xml, a Gradle
 * script or Cargo.toml is not read as a dependency change. Test-scoped and dev dependencies are left out.
 * undefined: a format we do not know (a file the team added to risk.changeTypes.dependency): any change counts.
 */
export function dependencyLines(file: string, text: string | undefined): Set<string> | undefined {
  const base = file.split("/").pop()!.toLowerCase();
  const t = text ?? "";
  const norm = (l: string) => l.trim().replace(/\s+/g, " ");
  const lines = (re: RegExp) => new Set(t.split(/\r?\n/).map(norm).filter((l) => l && re.test(l)));
  if (base === "pom.xml") {
    const out = new Set<string>();
    for (const m of t.matchAll(/<(dependency|parent)>([\s\S]*?)<\/\1>/g)) if (!/<scope>\s*test\s*<\/scope>/.test(m[2])) out.add(norm(m[2].replace(/>\s+</g, "><")));
    for (const m of t.matchAll(/<([\w.-]*[vV]ersion)>([^<]*)<\/\1>/g)) if (m[1] !== "version" && m[1] !== "modelVersion") out.add(`${m[1]}=${m[2].trim()}`);
    return out;
  }
  if (/^build\.gradle(\.kts)?$/.test(base))
    return lines(/^(implementation|api|compile|runtimeOnly|compileOnly|annotationProcessor|kapt|classpath|developmentOnly)\b|^(id|kotlin)\s*[("']|\bversion\s*[("']|^(alias|platform)\b/);
  if (base === "libs.versions.toml") return lines(/=/);
  if (base === "go.mod") return lines(/^(require\s+)?[\w.-]+\.[\w.-]+\/?[\w./-]*\s+v\d/);
  if (/^requirements.*\.txt$/.test(base) || /(^|\/)requirements\/[^/]+\.txt$/i.test(file)) {
    if (/dev|test|lint/.test(base)) return new Set();
    return lines(/^[^#-]/);
  }
  if (base.endsWith(".csproj") || base === "directory.packages.props")
    return new Set([...t.matchAll(/<(PackageReference|ProjectReference|PackageVersion)\b[^>]*?(?:\/>|>[\s\S]*?<\/\1>)/g)].map((m) => norm(m[0])));
  if (base === "composer.json") {
    try {
      const j = JSON.parse(t || "{}");
      return new Set(Object.entries(j.require ?? {}).map(([k, v]) => `${k}@${v}`));
    } catch {
      return new Set();
    }
  }
  if (base === "gemfile") {
    const out = new Set<string>();
    let skip = 0;
    for (const l of t.split(/\r?\n/).map(norm)) {
      if (/^group\b.*\b(development|test)\b.*\bdo$/.test(l)) skip = 1;
      else if (skip && /\bdo$/.test(l)) skip++;
      else if (skip && l === "end") skip--;
      else if (!skip && /^gem\s/.test(l)) out.add(l);
    }
    return out;
  }
  if (base === "pipfile" || base === "cargo.toml" || base === "pyproject.toml") {
    const out = new Set<string>();
    let section = "";
    let open = false;
    for (const l of t.split(/\r?\n/).map(norm)) {
      const h = l.match(/^\[([^\]]+)\]$/);
      if (h) {
        section = h[1].toLowerCase();
        open = false;
        continue;
      }
      if (!l || l.startsWith("#")) continue;
      const devSection = /dev|test|lint|docs/.test(section);
      const depSection = base === "pipfile" ? section === "packages" : /(^|\.)(build-)?dependencies$/.test(section) && !devSection;
      if (depSection) out.add(`${section}: ${l}`);
      else if (base === "pyproject.toml" && section === "project") {
        if (/^dependencies\s*=\s*\[/.test(l)) open = true;
        if (open) out.add(l);
        if (open && l.includes("]")) open = false;
      }
    }
    return out;
  }
  return undefined;
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
    if (matchesKind(file, t.migration)) tag({ kind: "migration", file });
    if (matchesKind(file, t.config)) tag({ kind: "config", file });
    if (matchesKind(file, t.toggle)) tag({ kind: "toggle", file });
    if (matchesKind(file, t.dependency)) {
      if (/(^|\/)package\.json$/.test(file)) {
        const changes = packageJsonDependencyChanges(showAt(i.repo, i.base, file), showAt(i.repo, i.head, file));
        // A package.json whose dependency sections did not change (a script, a version field) is not a dependency change.
        if (!changes.length) continue;
        tag({ kind: "dependency", file, major: changes.some((x) => x.major), detail: changes.slice(0, 6).map(describe).join("; ") + (changes.length > 6 ? `; and ${changes.length - 6} more` : "") });
      } else {
        // Other build files: only the dependency declarations count (a release version, a plugin or a test dependency does not).
        const before = showAt(i.repo, i.base, file);
        const after = showAt(i.repo, i.head, file);
        // Neither version can be read (no history here): we cannot tell, so the file counts.
        if (before === undefined && after === undefined) {
          tag({ kind: "dependency", file });
          continue;
        }
        const x = dependencyLines(file, before);
        const y = dependencyLines(file, after);
        if (x === undefined || y === undefined) {
          if (before !== after) tag({ kind: "dependency", file });
          continue;
        }
        const changed = [...[...y].filter((l) => !x.has(l)), ...[...x].filter((l) => !y.has(l))];
        if (!changed.length) continue;
        tag({ kind: "dependency", file, detail: `${changed.length} dependency line(s) changed: ${changed.slice(0, 3).map((l) => l.slice(0, 70)).join("; ")}` });
      }
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
