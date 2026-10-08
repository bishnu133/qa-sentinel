import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Root of the bundled templates directory (works from src/ via tsx and from dist/). */
export function templatesRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const candidate of [path.join(here, "..", "templates"), path.join(here, "..", "..", "templates")]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error("qa-sentinel templates directory not found");
}

export type TemplateVars = Record<string, string | number | boolean | undefined>;

/**
 * Minimal renderer:
 *  - {{name}} substitutes a variable (unknown variables are left visible as {{name}} so mistakes show up)
 *  - {{#if name}} ... {{/if}} keeps the block when the variable is truthy
 *  - {{#unless name}} ... {{/unless}} keeps the block when it is falsy
 */
export function render(template: string, vars: TemplateVars): string {
  let out = template.replace(
    /\{\{#(if|unless) (\w+)\}\}([\s\S]*?)\{\{\/\1\}\}\n?/g,
    (_m, kind: string, name: string, body: string) => {
      const truthy = Boolean(vars[name]);
      return (kind === "if" ? truthy : !truthy) ? body : "";
    },
  );
  out = out.replace(/\{\{(\w+)\}\}/g, (m, name: string) => {
    const v = vars[name];
    return v === undefined ? m : String(v);
  });
  return out;
}

export function readTemplate(rel: string): string {
  return fs.readFileSync(path.join(templatesRoot(), rel), "utf8");
}

/** List all files under a template subdirectory, relative to that subdirectory. */
export function listTemplateDir(rel: string): string[] {
  const base = path.join(templatesRoot(), rel);
  const out: string[] = [];
  const visit = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) visit(p);
      else out.push(path.relative(base, p).split(path.sep).join("/"));
    }
  };
  if (fs.existsSync(base)) visit(base);
  return out.sort();
}
