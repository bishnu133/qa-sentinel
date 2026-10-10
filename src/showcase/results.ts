import fs from "node:fs";
import path from "node:path";

/**
 * Test results with evidence attachments, read from a test run's report. Playwright's JSON reporter is preferred
 * (it has file, line, status and attachments per test); JUnit with [[ATTACHMENT|path]] lines is the fallback.
 */
export interface Evidence {
  kind: "video" | "trace" | "screenshot" | "api-log" | "other";
  name: string;
  path: string; // absolute
  contentType?: string;
}

export interface RunResult {
  file?: string; // as reported (often relative to the test dir)
  line?: number;
  title: string;
  status: "passed" | "failed" | "skipped";
  evidence: Evidence[];
}

export function kindOf(name: string, contentType = "", file = ""): Evidence["kind"] {
  if (contentType.startsWith("video/") || /\.(webm|mp4)$/i.test(file)) return "video";
  if (name === "trace" || /trace\.zip$/i.test(file)) return "trace";
  if (contentType.startsWith("image/") || name === "screenshot") return "screenshot";
  if (name === "api-log") return "api-log";
  return "other";
}

function fromPlaywrightJson(json: any, baseDir: string): RunResult[] {
  const out: RunResult[] = [];
  const walk = (suite: any) => {
    for (const s of suite.suites ?? []) walk(s);
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests ?? []) {
        const last = (t.results ?? []).at(-1);
        const status = t.status === "skipped" || last?.status === "skipped" ? "skipped" : t.status === "expected" || t.status === "flaky" ? "passed" : "failed";
        const evidence: Evidence[] = (last?.attachments ?? [])
          .filter((a: any) => a.path)
          .map((a: any) => ({ kind: kindOf(a.name, a.contentType, a.path), name: a.name, path: path.resolve(baseDir, a.path), contentType: a.contentType }));
        out.push({ file: spec.file, line: spec.line, title: spec.title, status, evidence });
      }
    }
  };
  walk(json);
  return out;
}

function fromJUnit(xml: string, baseDir: string): RunResult[] {
  const out: RunResult[] = [];
  for (const m of xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const attr = (k: string) => m[1].match(new RegExp(`${k}="([^"]*)"`))?.[1];
    const body = m[2] ?? "";
    const status = /<(failure|error)\b/.test(body) ? "failed" : /<skipped\b/.test(body) ? "skipped" : "passed";
    const evidence = [...body.matchAll(/\[\[ATTACHMENT\|([^\]]+)\]\]/g)].map((a) => {
      const p = path.resolve(baseDir, a[1].trim());
      return { kind: kindOf(path.basename(p).replace(/\.[^.]+$/, ""), "", p), name: path.basename(p), path: p };
    });
    out.push({ file: attr("file") ?? attr("classname"), title: (attr("name") ?? "").replace(/&quot;/g, '"').replace(/&amp;/g, "&"), status, evidence });
  }
  return out;
}

export function readRunResults(file: string): RunResult[] {
  const text = fs.readFileSync(file, "utf8");
  const base = path.dirname(path.resolve(file));
  // Playwright writes attachment paths absolute; relative ones are taken from the report's folder's parent (repo root).
  if (file.endsWith(".json")) return fromPlaywrightJson(JSON.parse(text), path.dirname(base));
  return fromJUnit(text, path.dirname(base));
}

/** Match a result to an indexed test: same file (suffix match, reports often drop the test dir) and line, else title. */
export function matchResult<T extends { file: string; line: number; title: string }>(results: RunResult[], t: T): RunResult | undefined {
  const byLine = results.find((r) => r.file && r.line && (t.file.endsWith(r.file) || r.file.endsWith(t.file)) && r.line === t.line);
  if (byLine) return byLine;
  return results.find((r) => (!r.file || t.file.endsWith(r.file) || r.file.endsWith(t.file)) && r.title.replace(/\s*@\S+/g, "").trim().endsWith(t.title));
}
