import fs from "node:fs";
import path from "node:path";

/**
 * Run folders come from the analysis job, which runs code a model wrote: they may hold symbolic links. The publish job holds the write
 * tokens and is more trusted than the folder, so it never follows a link in it: it refuses a folder that has one, and writes with O_NOFOLLOW.
 */

/** Throws when `dir` is a symbolic link or anything in it (at any depth) is one. */
export function assertNoLinks(dir: string): void {
  const top = fs.lstatSync(dir);
  if (top.isSymbolicLink()) throw new Error(`${path.basename(dir)} is a symbolic link; refused`);
  const walk = (d: string, depth: number) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isSymbolicLink()) throw new Error(`the run folder holds a symbolic link (${path.relative(dir, full).slice(0, 80)}); refused`);
      if (e.isDirectory() && depth < 12) walk(full, depth + 1);
    }
  };
  walk(dir, 0);
}

/** Write a file without following a link at the final path (it fails with ELOOP if there is one). */
export function writeFileNoFollow(file: string, data: string): void {
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, 0o644);
  try {
    fs.writeFileSync(fd, data);
  } finally {
    fs.closeSync(fd);
  }
}

/** Read a file without following a link at the final path. */
export function readFileNoFollow(file: string): string {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    return fs.readFileSync(fd, "utf8");
  } finally {
    fs.closeSync(fd);
  }
}
