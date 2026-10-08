import fs from "node:fs";
import path from "node:path";

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".next",
  "target",
  "playwright-report",
  "test-results",
  ".qa-sentinel",
]);

/** Walk a directory tree, yielding file paths relative to root. */
export function walk(root: string, maxDepth = 8): string[] {
  const out: string[] = [];
  const visit = (dir: string, depth: number) => {
    if (depth > maxDepth) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (IGNORED_DIRS.has(e.name)) continue;
        visit(path.join(dir, e.name), depth + 1);
      } else if (e.isFile()) {
        out.push(path.relative(root, path.join(dir, e.name)).split(path.sep).join("/"));
      }
    }
  };
  visit(root, 0);
  return out;
}

/** Convert a simple glob (supports **, *, ?) to a RegExp matched against "/"-separated paths. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        const slash = glob[i + 2] === "/";
        re += slash ? "(?:.*/)?" : ".*";
        i += slash ? 2 : 1;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (".+^${}()|[]\\".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

export function matchesAny(file: string, globs: string[]): boolean {
  return globs.some((g) => globToRegExp(g).test(file));
}

export function readJson<T = any>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

/** Write a file unless it exists (or force). Returns what happened. */
export function writeFileSafe(
  file: string,
  content: string,
  force = false,
): "created" | "overwritten" | "skipped" {
  const exists = fs.existsSync(file);
  if (exists && !force) return "skipped";
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, content);
  return exists ? "overwritten" : "created";
}
