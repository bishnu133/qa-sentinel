/**
 * Historical replay: score qa-sentinel against tests real developers actually wrote.
 *
 * For each commit C that changed both code and tests in a repo:
 *   1. build a synthetic "head" = C's code changes only (the developer's test changes are hidden),
 *   2. build a test repo from the tests as they were BEFORE C,
 *   3. run the real `gap-report` (planning phase),
 *   4. compare the plan with what the developer did in C: which test files changed, which tests were added.
 *
 *   npm run replay -- --repo ../some-api --auto 10                 # last 10 commits that touched code + tests
 *   npm run replay -- --repo ../some-api --commits abc123,def456 --spec openapi.yaml
 *
 * Options: --tests "<glob,glob>" (default: common test locations), --code "<glob,…>" (default: everything else
 * except docs), --spec <path in repo>, --parallel 2, --out bench/replay-results
 *
 * Scores: commit-level gap detection (did qa-sentinel ask for test work when the developer wrote tests?),
 * test-file overlap (did it point at the files the developer changed?), and a side-by-side of the developer's
 * new test titles and qa-sentinel's proposed scenarios for human judgement.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { matchesAny } from "../src/fsutil.js";
import { initCommand } from "../src/commands/init.js";
import { gapReportCommand } from "../src/commands/gapReport.js";
import { quietly } from "./quiet.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (k: string) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

const DEFAULT_TESTS = ["**/*.spec.*", "**/*.test.*", "test/**", "tests/**", "**/__tests__/**", "e2e/**", "spec/**"];
const IGNORE = ["**/*.md", "docs/**", "**/*.lock", "**/package-lock.json", "**/yarn.lock", "**/pnpm-lock.yaml", ".github/**", ".gitlab-ci.yml", "**/*.png", "**/*.svg"];

const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }).trim();

export interface ReplayCommit {
  sha: string;
  subject: string;
  codeFiles: string[];
  testFiles: string[];
}

/** Commits (newest first) that touched both code and tests. */
export function findCommits(repo: string, n: number, testGlobs: string[], codeGlobs?: string[]): ReplayCommit[] {
  const shas = git(repo, "log", "--no-merges", "--format=%H", "-n", "400").split("\n").filter(Boolean);
  const out: ReplayCommit[] = [];
  for (const sha of shas) {
    if (out.length >= n) break;
    const c = describeCommit(repo, sha, testGlobs, codeGlobs);
    if (c && c.codeFiles.length && c.testFiles.length && c.codeFiles.length <= 30) out.push(c);
  }
  return out;
}

export function describeCommit(repo: string, sha: string, testGlobs: string[], codeGlobs?: string[]): ReplayCommit | undefined {
  let files: string[];
  try {
    files = git(repo, "diff", "--name-only", `${sha}~1`, sha).split("\n").filter(Boolean);
  } catch {
    return undefined; // root commit
  }
  const testFiles = files.filter((f) => matchesAny(f, testGlobs));
  const codeFiles = files.filter((f) => !testFiles.includes(f) && !matchesAny(f, IGNORE) && (!codeGlobs || matchesAny(f, codeGlobs)));
  return { sha, subject: git(repo, "log", "-1", "--format=%s", sha), codeFiles, testFiles };
}

/** Test titles added in a commit (it/test/describe strings on added lines). */
export function addedTestTitles(repo: string, sha: string, testFiles: string[]): string[] {
  if (!testFiles.length) return [];
  const diff = git(repo, "diff", "-U0", `${sha}~1`, sha, "--", ...testFiles);
  const titles: string[] = [];
  for (const line of diff.split("\n")) {
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    const m = line.match(/\b(?:it|test|describe|context|scenario)(?:\.\w+)?\s*\(\s*(['"`])(.+?)\1/);
    if (m) titles.push(m[2]);
  }
  return titles;
}

interface ReplayResult {
  sha: string;
  subject: string;
  devTestFiles: string[];
  devNewTests: string[];
  planValid: boolean;
  risk?: string;
  gaps: number; // update/create/review decisions
  decisions: string[];
  planTestFiles: string[]; // files the plan says to update / are impacted
  fileHit: boolean;
  proposed: string[];
  costUsd?: number;
  error?: string;
}

async function replayOne(repo: string, c: ReplayCommit, testGlobs: string[], spec?: string): Promise<ReplayResult> {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "qas-replay-"));
  const svc = path.join(ws, "service");
  const tests = path.join(ws, "tests");
  const result: ReplayResult = { sha: c.sha, subject: c.subject, devTestFiles: c.testFiles, devNewTests: addedTestTitles(repo, c.sha, c.testFiles), planValid: false, gaps: 0, decisions: [], planTestFiles: [], fileHit: false, proposed: [] };

  // 1. Service: base = C~1, synthetic head = C's code changes only (tests stay as before C).
  git(ws, "clone", "-q", "--no-checkout", repo, svc);
  git(svc, "checkout", "-q", "-b", "replay-base", `${c.sha}~1`);
  git(svc, "checkout", "-q", "-b", "replay-head");
  for (const f of c.codeFiles) {
    try {
      git(svc, "checkout", c.sha, "--", f);
    } catch {
      git(svc, "rm", "-q", "--ignore-unmatch", f); // deleted in C
    }
  }
  git(svc, "-c", "user.name=replay", "-c", "user.email=replay@x", "commit", "-q", "--allow-empty", "-m", `replay of ${c.sha.slice(0, 8)}: ${c.subject}`);

  // 2. Test repo: the tests as they were before C (+ package.json so the framework is detected).
  fs.mkdirSync(tests);
  const allTests = git(svc, "ls-files").split("\n").filter((f) => matchesAny(f, testGlobs));
  for (const f of allTests) {
    fs.mkdirSync(path.dirname(path.join(tests, f)), { recursive: true });
    fs.copyFileSync(path.join(svc, f), path.join(tests, f));
  }
  if (fs.existsSync(path.join(svc, "package.json"))) fs.copyFileSync(path.join(svc, "package.json"), path.join(tests, "package.json"));
  await quietly(() => initCommand({ cwd: tests, yes: true, mode: "existing", ci: "gitlab", workspace: ws, name: "replay" }));
  // Point the config at the service; hide the service's own test files from the analysed diff.
  const cfgPath = path.join(tests, "qa-sentinel.config.yaml");
  const YAML = (await import("yaml")).default;
  const cfg = YAML.parse(fs.readFileSync(cfgPath, "utf8"));
  cfg.workspace.services = [{ name: "service", path: "../service", ...(spec ? { openapi: spec } : {}), dependsOn: [] }];
  cfg.agent.skipPaths = [...cfg.agent.skipPaths, ...testGlobs];
  fs.writeFileSync(cfgPath, YAML.stringify(cfg));
  git(tests, "init", "-q", "-b", "main");
  git(tests, "add", "-A");
  git(tests, "-c", "user.name=replay", "-c", "user.email=replay@x", "commit", "-q", "-m", "tests before the commit");

  // 3. Real planning phase. Story = the commit subject only (open-source commits rarely carry AC).
  const story = path.join(ws, "story.md");
  fs.writeFileSync(story, `# ${c.subject}\n\n(Replayed commit ${c.sha}; no acceptance criteria available.)\n`);
  try {
    await quietly(() => gapReportCommand({ cwd: tests, service: "service", base: "replay-base", head: "replay-head", storyFile: story, out: path.join(ws, "report.md") }));
  } catch (e) {
    result.error = (e as Error).message;
  }

  // 4. Compare with what the developer did.
  const runDir = fs.readdirSync(path.join(tests, ".qa-sentinel/runs")).map((d) => path.join(tests, ".qa-sentinel/runs", d))[0];
  const manifest = runDir ? JSON.parse(fs.readFileSync(path.join(runDir, "manifest.json"), "utf8")) : {};
  result.costUsd = manifest.agent?.costUsd;
  const validated = runDir && path.join(runDir, "test-plan.validated.json");
  if (validated && fs.existsSync(validated)) {
    const plan = JSON.parse(fs.readFileSync(validated, "utf8"));
    result.planValid = true;
    result.risk = plan.risk.overall;
    result.decisions = plan.decisions.map((d: any) => d.decision);
    result.gaps = plan.decisions.filter((d: any) => ["update", "create", "review"].includes(d.decision)).length;
    result.planTestFiles = [...new Set<string>([...plan.decisions.flatMap((d: any) => d.existingTests), ...plan.impactedTests.map((t: any) => t.file)])];
    result.fileHit = result.planTestFiles.some((f) => c.testFiles.includes(f));
    result.proposed = plan.decisions.flatMap((d: any) => d.proposedScenarios.map((s: any) => s.title));
  } else result.error ??= "no valid plan";
  const keep = path.join(here, "replay-results", "runs", c.sha.slice(0, 10));
  fs.mkdirSync(keep, { recursive: true });
  if (runDir) fs.cpSync(runDir, keep, { recursive: true });
  if (fs.existsSync(path.join(ws, "report.md"))) fs.copyFileSync(path.join(ws, "report.md"), path.join(keep, "report.md"));
  fs.rmSync(ws, { recursive: true, force: true });
  return result;
}

function report(repo: string, rs: ReplayResult[]): string {
  const valid = rs.filter((r) => r.planValid);
  const detected = valid.filter((r) => r.gaps > 0).length;
  const withExisting = valid.filter((r) => r.devTestFiles.length && r.planTestFiles.length);
  const hits = valid.filter((r) => r.fileHit).length;
  const cost = rs.reduce((a, r) => a + (r.costUsd ?? 0), 0);
  const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : "–");
  const lines = [
    `# Replay – ${path.basename(path.resolve(repo))} – ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`,
    "",
    `**${rs.length} commits** (each changed code and tests) · plan valid ${pct(valid.length, rs.length)} · **asked for test work on ${pct(detected, valid.length)}** of commits where the developer wrote tests · **pointed at a test file the developer changed: ${pct(hits, withExisting.length)}** (of commits where both named files) · $${cost.toFixed(2)}`,
    "",
    "| Commit | Subject | Plan | Risk | Gaps | Dev changed | Plan pointed at | Hit |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rs.map(
      (r) =>
        `| ${r.sha.slice(0, 8)} | ${r.subject.replace(/\|/g, "/").slice(0, 60)} | ${r.planValid ? "✅" : "❌"} | ${r.risk ?? "–"} | ${r.gaps} (${r.decisions.join(", ") || "–"}) | ${r.devTestFiles.map((f) => `\`${f}\``).join("<br>")} | ${r.planTestFiles.map((f) => `\`${f}\``).join("<br>") || "–"} | ${r.fileHit ? "✅" : "–"} |`,
    ),
    "",
    "## Side by side (judge these by hand)",
    ...rs.flatMap((r) => [
      "",
      `### ${r.sha.slice(0, 8)} – ${r.subject}`,
      r.error ? `_error: ${r.error.slice(0, 300)}_` : "",
      "| Developer added | qa-sentinel proposed |",
      "| --- | --- |",
      ...Array.from({ length: Math.max(r.devNewTests.length, r.proposed.length, 1) }, (_, i) => `| ${r.devNewTests[i] ?? ""} | ${r.proposed[i] ?? ""} |`),
    ]),
    "",
    "Notes: open-source commits rarely carry acceptance criteria, so every replay runs with oracle `missing` (qa-sentinel may not claim approved behaviour). A developer not writing a test is not proof that none was needed, so only commits where the developer did write tests are replayed.",
  ];
  return lines.join("\n");
}

async function main() {
  const repo = path.resolve(opt("repo") ?? ".");
  if (!fs.existsSync(path.join(repo, ".git"))) throw new Error(`${repo} is not a git repository (use a full clone, not --depth 1)`);
  const testGlobs = opt("tests")?.split(",") ?? DEFAULT_TESTS;
  const codeGlobs = opt("code")?.split(",");
  const commits = opt("commits")
    ? opt("commits")!
        .split(",")
        .map((s) => describeCommit(repo, git(repo, "rev-parse", s), testGlobs, codeGlobs))
        .filter((c): c is ReplayCommit => Boolean(c))
    : findCommits(repo, Number(opt("auto") ?? 5), testGlobs, codeGlobs);
  if (!commits.length) throw new Error("no commits found that change both code and tests (adjust --tests / --code)");
  const parallel = Number(opt("parallel") ?? 2);
  const results: ReplayResult[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(parallel, commits.length) }, async () => {
      while (next < commits.length) {
        const c = commits[next++];
        process.stderr.write(`▶ ${c.sha.slice(0, 8)} ${c.subject.slice(0, 60)}\n`);
        const r = await replayOne(repo, c, testGlobs, opt("spec")).catch((e) => ({ sha: c.sha, subject: c.subject, devTestFiles: c.testFiles, devNewTests: [], planValid: false, gaps: 0, decisions: [], planTestFiles: [], fileHit: false, proposed: [], error: String(e) }) as ReplayResult);
        process.stderr.write(`✔ ${c.sha.slice(0, 8)}: plan ${r.planValid ? "valid" : "INVALID"} · gaps ${r.gaps} · hit ${r.fileHit} · $${r.costUsd?.toFixed(2) ?? "?"}\n`);
        results.push(r);
      }
    }),
  );
  results.sort((a, b) => commits.findIndex((c) => c.sha === a.sha) - commits.findIndex((c) => c.sha === b.sha));
  const outDir = path.resolve(opt("out") ?? path.join(here, "replay-results"));
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = `${path.basename(repo)}-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`;
  const md = report(repo, results);
  fs.writeFileSync(path.join(outDir, `${stamp}.md`), md + "\n");
  fs.writeFileSync(path.join(outDir, `${stamp}.json`), JSON.stringify(results, null, 2));
  console.log(md);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`✗ ${e.message}`);
    process.exit(1);
  });
}
