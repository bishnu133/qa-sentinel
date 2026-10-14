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
  /** First line of the failure, when failed. */
  error?: string;
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
        const err = last?.error?.message ?? last?.errors?.[0]?.message;
        out.push({ file: spec.file, line: spec.line, title: spec.title, status, evidence, ...(status === "failed" && err ? { error: String(err).replace(/\u001b\[[0-9;]*m/g, "").split("\n").slice(0, 3).join(" ").slice(0, 300) } : {}) });
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

/** Mobile evidence hooks write one `<test>.result.json` per test (already in RunResult form). */
function fromResultDir(dir: string): RunResult[] {
  const out: RunResult[] = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".result.json")).sort()) {
    try {
      const r = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as RunResult;
      if (!r.title || !r.status) continue;
      out.push({ ...r, evidence: (r.evidence ?? []).map((e) => ({ ...e, path: path.resolve(dir, e.path) })) });
    } catch {
      /* partial file from a killed run */
    }
  }
  // A re-run of the same test writes a new file: keep the latest per test.
  const latest = new Map<string, RunResult>();
  for (const r of out) latest.set(`${r.file ?? ""}::${r.title}`, r);
  return [...latest.values()];
}

/** A report file (Playwright JSON, JUnit) or a folder of mobile result files. */
export function readRunResults(file: string): RunResult[] {
  if (fs.statSync(file).isDirectory()) return fromResultDir(file);
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
