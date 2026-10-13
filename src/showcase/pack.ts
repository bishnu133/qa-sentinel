import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { Config } from "../config.js";
import type { IndexedTest } from "../analysis/testIndex.js";
import { layerConfig, layerOfFile } from "../layers.js";
import { runProcess } from "../proc.js";
import { matchResult, readRunResults, type RunResult } from "./results.js";
import type { EvidenceFile, StoryReadiness } from "./showcase.js";

/**
 * The Biz showcase pack: what replaces the manual "here's what we built" session.
 *
 *   <STORY>-showcase.mp4  one video: an intro card, then per acceptance criterion a title card and its test,
 *                         re-recorded in showcase mode (slowed down, the element being used highlighted, a hold
 *                         on the result). ACs proven by API tests get a card pointing to the PDF.
 *   <STORY>-showcase.pdf  the results per AC, a screenshot per UI test, and the API requests and responses.
 *
 * Built only when every AC passed (the caller checks), from tests that already passed in this run.
 * Needs a browser (cards, PDF, recording) and a full ffmpeg with libx264 (the video). Without ffmpeg the
 * PDF is still built and the caller falls back to the separate per-test videos.
 */

export interface ShowcasePick {
  ac: string;
  text?: string;
  test: IndexedTest;
  result?: RunResult;
  web: boolean;
}

/** One test per AC: the one tagged @showcase, else a passing web test (it shows something), else any passing test. */
export function pickShowcaseTests(c: Config, r: StoryReadiness): ShowcasePick[] {
  return r.acs.map((a) => {
    const passing = a.tests.filter((t) => t.result?.status === "passed");
    const isWeb = (t: IndexedTest) => layerOfFile(c, t.file) === "web";
    const chosen = passing.find((t) => t.test.tags.includes("showcase")) ?? passing.find((t) => isWeb(t.test)) ?? passing[0] ?? a.tests[0];
    return { ac: a.id, text: a.text, test: chosen.test, result: chosen.result, web: isWeb(chosen.test) };
  });
}

export interface PackMeta {
  title?: string;
  environment?: string;
  commit?: string;
  runUrl?: string;
  at: string;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
const clean = (title: string) => title.replace(/\s*@\S+/g, "").trim();

const CARD_CSS = `body{margin:0;width:1280px;height:720px;display:flex;flex-direction:column;justify-content:center;padding:0 110px;box-sizing:border-box;
font-family:-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;background:#0f2a1f;color:#fff}
.k{font-size:26px;letter-spacing:.08em;text-transform:uppercase;color:#9fd3b6;margin-bottom:22px}
h1{font-size:54px;line-height:1.15;margin:0 0 28px;font-weight:650}
p{font-size:30px;line-height:1.4;margin:0;color:#e3efe8}
.f{position:absolute;bottom:40px;left:110px;font-size:20px;color:#9fd3b6}`;

export function introCardHtml(story: string, meta: PackMeta, acCount: number): string {
  return `<!doctype html><meta charset="utf-8"><style>${CARD_CSS}</style><body>
<div class="k">Showcase · ${esc(story)}</div><h1>${esc(meta.title ?? story)}</h1>
<p>All ${acCount} acceptance criteria verified by automated tests${meta.environment ? ` on ${esc(meta.environment.toUpperCase())}` : ""}.</p>
<div class="f">${esc(meta.at)}${meta.commit ? ` · ${esc(meta.commit.slice(0, 8))}` : ""} · qa-sentinel</div></body>`;
}

export function acCardHtml(story: string, p: ShowcasePick, i: number, n: number): string {
  const how = p.web ? `Test: ${esc(clean(p.test.title))}` : `Verified through the API: ${esc(clean(p.test.title))}. Requests and responses are in the PDF, section ${esc(p.ac)}.`;
  return `<!doctype html><meta charset="utf-8"><style>${CARD_CSS}</style><body>
<div class="k">${esc(story)} · ${esc(p.ac)} (${i} of ${n})</div><h1>${esc(p.text ?? p.ac)}</h1><p>${how}</p></body>`;
}

interface ApiCall {
  method: string;
  path: string;
  status: number;
  request?: unknown;
  response?: unknown;
  ms?: number;
}

function apiCalls(result?: RunResult): ApiCall[] {
  const log = result?.evidence.find((e) => e.kind === "api-log");
  if (!log || !fs.existsSync(log.path)) return [];
  try {
    return (JSON.parse(fs.readFileSync(log.path, "utf8")).calls ?? []) as ApiCall[];
  } catch {
    return [];
  }
}

const json = (v: unknown, max = 1500) => {
  const s = typeof v === "string" ? v : JSON.stringify(v, null, 2);
  return esc(s.length > max ? `${s.slice(0, max)}…` : s);
};

/** The evidence PDF (as HTML, printed to PDF by the browser). */
export function evidenceHtml(r: StoryReadiness, picks: ShowcasePick[], meta: PackMeta, screenshotFor: (p: ShowcasePick) => string | undefined): string {
  const rows = r.acs
    .map((a) => `<tr><td><b>${esc(a.id)}</b> ${esc(a.text ?? "")}</td><td>${a.tests.map((t) => `${esc(clean(t.test.title))} <span class="ok">${esc(t.result?.status ?? "–")}</span>`).join("<br>")}</td></tr>`)
    .join("");
  const sections = r.acs
    .map((a) => {
      const pick = picks.find((p) => p.ac === a.id);
      const shot = pick ? screenshotFor(pick) : undefined;
      const calls = a.tests.flatMap((t) => apiCalls(t.result).map((call) => ({ t, call }))).slice(0, 12);
      return `<section><h2>${esc(a.id)} · ${esc(a.text ?? "")}</h2>
<p class="m">Tests: ${a.tests.map((t) => `${esc(clean(t.test.title))} (<code>${esc(t.test.file)}:${t.test.line}</code>)`).join("; ")}</p>
${shot ? `<img src="data:image/png;base64,${fs.readFileSync(shot).toString("base64")}" alt="${esc(a.id)} screenshot">` : ""}
${calls
  .map(
    ({ call }) => `<div class="call"><div class="h"><b>${esc(call.method)} ${esc(call.path)}</b> → <span class="${call.status < 400 ? "ok" : "warn"}">${call.status}</span>${call.ms !== undefined ? ` · ${call.ms} ms` : ""}</div>
${call.request !== undefined ? `<div class="l">Request</div><pre>${json(call.request)}</pre>` : ""}${call.response !== undefined ? `<div class="l">Response</div><pre>${json(call.response)}</pre>` : ""}</div>`,
  )
  .join("")}</section>`;
    })
    .join("");
  return `<!doctype html><meta charset="utf-8"><title>${esc(r.story)} showcase</title><style>
body{font-family:-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#1d1d1f;margin:0;font-size:12px}
header{background:#0f2a1f;color:#fff;padding:22px 28px}header h1{margin:4px 0 6px;font-size:22px}header .k{color:#9fd3b6;font-size:11px;letter-spacing:.08em;text-transform:uppercase}
main{padding:18px 28px}table{border-collapse:collapse;width:100%;margin:8px 0 18px}td,th{border:1px solid #d9dee3;padding:6px 8px;vertical-align:top;text-align:left}th{background:#f3f5f7}
.ok{color:#1f7a45;font-weight:600}.warn{color:#b3261e;font-weight:600}section{page-break-inside:avoid;margin-bottom:18px}h2{font-size:15px;margin:14px 0 4px}
.m{color:#555;margin:0 0 8px}img{max-width:100%;border:1px solid #d9dee3;margin:6px 0}code{font-size:11px}
.call{border:1px solid #e3e7eb;border-radius:4px;margin:6px 0;padding:6px 8px}.l{color:#666;font-size:10px;text-transform:uppercase;margin-top:4px}
pre{background:#f6f8fa;padding:6px;margin:2px 0;white-space:pre-wrap;word-break:break-word;font-size:10px}</style>
<header><div class="k">Showcase · ${esc(r.story)}</div><h1>${esc(meta.title ?? r.story)}</h1>
<div>All ${r.acs.length} acceptance criteria passed${meta.environment ? ` on ${esc(meta.environment.toUpperCase())}` : ""} · ${esc(meta.at)}${meta.commit ? ` · commit ${esc(meta.commit.slice(0, 8))}` : ""}${meta.runUrl ? ` · run: ${esc(meta.runUrl)}` : ""}</div></header>
<main><table><tr><th>Acceptance criterion</th><th>Automated tests</th></tr>${rows}</table>${sections}
<p class="m">Generated by qa-sentinel from an automated test run. The video attached to this story shows each acceptance criterion in order.</p></main>`;
}

// ---------------------------------------------------------------------------------------------
// Browser work (cards, PDF) runs as a small script inside the test repo, where @playwright/test is installed.

export const RENDER_SCRIPT = `
import fs from "node:fs";
const { chromium } = await import("@playwright/test");
const job = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const launch = process.env.QA_BROWSER_PATH ? { executablePath: process.env.QA_BROWSER_PATH } : process.env.QA_BROWSER_CHANNEL ? { channel: process.env.QA_BROWSER_CHANNEL } : {};
const browser = await chromium.launch(launch);
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
for (const c of job.cards) {
  await page.setContent(fs.readFileSync(c.html, "utf8"));
  await page.screenshot({ path: c.png });
}
if (job.pdf) {
  const p = await browser.newPage();
  await p.setContent(fs.readFileSync(job.pdf.html, "utf8"), { waitUntil: "load" });
  await p.pdf({ path: job.pdf.out, format: "A4", printBackground: true, margin: { top: "0", bottom: "12mm", left: "0", right: "0" } });
}
await browser.close();
`;

/** A full ffmpeg (with libx264): config, QA_FFMPEG, PATH, then the ffmpeg-static package in the test repo. */
export async function findFfmpeg(c: Config, cwd: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const candidates = [c.showcase.video.ffmpeg, env.QA_FFMPEG, "ffmpeg"];
  try {
    const req = createRequire(path.join(cwd, "package.json"));
    candidates.push(req("ffmpeg-static") as string);
  } catch {
    /* not installed */
  }
  for (const bin of candidates.filter((x): x is string => Boolean(x))) {
    const r = await runProcess(bin, ["-hide_banner", "-encoders"], { cwd, env, timeoutMs: 15_000 });
    if (r.code === 0 && /libx264/.test(r.stdout)) return bin;
  }
  return undefined;
}

export interface PackResult {
  files: EvidenceFile[];
  notes: string[];
  /** True when the single video was built; false means the caller should attach the per-test videos instead. */
  video: boolean;
}

export async function buildShowcasePack(i: {
  cwd: string;
  c: Config;
  r: StoryReadiness;
  meta: PackMeta;
  workDir: string;
  env: NodeJS.ProcessEnv;
}): Promise<PackResult> {
  const { c, r, cwd } = i;
  const notes: string[] = [];
  fs.rmSync(i.workDir, { recursive: true, force: true });
  fs.mkdirSync(i.workDir, { recursive: true });
  const picks = pickShowcaseTests(c, r);

  // 1. Showcase recording of the chosen web tests: slowed down, highlighted, holding on the result.
  const recorded = new Map<string, RunResult>();
  const webPicks = picks.filter((p) => p.web);
  if (webPicks.length && c.showcase.video.record && c.tests.web.enabled) {
    const l = layerConfig(c, "web");
    const json = path.join(i.workDir, "recording.json");
    const files = [...new Set(webPicks.map((p) => `${p.test.file}:${p.test.line}`))];
    const r2 = await runProcess(`${l.runCommand} ${files.join(" ")} --workers=1 --retries=0 --reporter=json --output=${JSON.stringify(path.join(i.workDir, "recording"))}`, [], {
      cwd,
      shell: true,
      timeoutMs: 15 * 60_000,
      env: {
        ...i.env,
        QA_SHOWCASE_MODE: "1",
        QA_SHOWCASE_SLOWMO: String(c.showcase.video.slowMoMs),
        QA_SHOWCASE_HOLD: String(c.showcase.video.holdMs),
        QA_VIDEO: "on",
        QA_HEALING: "off",
        PLAYWRIGHT_JSON_OUTPUT_NAME: json,
      },
    });
    if (fs.existsSync(json)) {
      const results = readRunResults(json);
      for (const p of webPicks) {
        const m = matchResult(results, p.test);
        if (m?.status === "passed" && m.evidence.some((e) => e.kind === "video")) recorded.set(p.test.id, m);
      }
    }
    if (recorded.size < webPicks.length) notes.push(`showcase recording: ${recorded.size}/${webPicks.length} test(s) recorded${r2.code ? ` (exit ${r2.code})` : ""}; the run's own videos are used for the rest`);
  }
  const videoOf = (p: ShowcasePick) => (recorded.get(p.test.id) ?? p.result)?.evidence.find((e) => e.kind === "video" && fs.existsSync(e.path))?.path;
  const screenshotOf = (p: ShowcasePick) => {
    const ev = (recorded.get(p.test.id) ?? p.result)?.evidence.filter((e) => e.kind === "screenshot" && fs.existsSync(e.path)) ?? [];
    return ev.at(-1)?.path;
  };

  // 2. Cards and the PDF.
  const card = (name: string, html: string) => {
    fs.writeFileSync(path.join(i.workDir, `${name}.html`), html);
    return { html: path.join(i.workDir, `${name}.html`), png: path.join(i.workDir, `${name}.png`) };
  };
  const cards = [card("00-intro", introCardHtml(r.story, i.meta, r.acs.length)), ...picks.map((p, k) => card(`${String(k + 1).padStart(2, "0")}-${p.ac}`, acCardHtml(r.story, p, k + 1, picks.length)))];
  const pdfHtml = path.join(i.workDir, "evidence.html");
  const pdfOut = path.join(i.workDir, `${r.story}-showcase.pdf`);
  fs.writeFileSync(pdfHtml, evidenceHtml(r, picks, i.meta, screenshotOf));
  const job = path.join(i.workDir, "render.json");
  fs.writeFileSync(job, JSON.stringify({ cards, pdf: { html: pdfHtml, out: pdfOut } }));
  const script = path.join(i.workDir, "render-showcase.mjs");
  fs.writeFileSync(script, RENDER_SCRIPT);
  // The script must resolve @playwright/test from the test repo: run it from a file inside the repo.
  const inRepo = path.join(cwd, ".qa-sentinel", `render-showcase-${process.pid}.mjs`);
  fs.mkdirSync(path.dirname(inRepo), { recursive: true });
  fs.copyFileSync(script, inRepo);
  const rr = await runProcess("node", [inRepo, job], { cwd, env: i.env, timeoutMs: 180_000 });
  fs.rmSync(inRepo, { force: true });
  const files: EvidenceFile[] = [];
  if (fs.existsSync(pdfOut)) files.push({ name: `${r.story}-showcase.pdf`, data: fs.readFileSync(pdfOut), contentType: "application/pdf", source: pdfOut });
  else notes.push(`evidence PDF not built: ${(rr.stderr || rr.stdout).trim().split("\n").slice(-2).join(" ").slice(0, 200)}`);

  // 3. One video: intro card, then per AC its card and its recording.
  const ffmpeg = await findFfmpeg(c, cwd, i.env);
  if (!ffmpeg) {
    notes.push("no full ffmpeg (with libx264) found: install ffmpeg, set QA_FFMPEG, or npm i -D ffmpeg-static. Attaching the per-test videos instead");
    return { files, notes, video: false };
  }
  if (!cards.every((x) => fs.existsSync(x.png))) {
    notes.push("title cards were not rendered; attaching the per-test videos instead");
    return { files, notes, video: false };
  }
  const T = c.showcase.video.titleSeconds;
  const norm = "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=white,fps=25,format=yuv420p";
  const segments: string[] = [];
  const seg = async (args: string[], out: string) => {
    const r3 = await runProcess(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", ...args, "-vf", norm, "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", out], { cwd, env: i.env, timeoutMs: 180_000 });
    if (r3.code !== 0) throw new Error(`ffmpeg: ${(r3.stderr || r3.stdout).trim().slice(0, 300)}`);
    segments.push(out);
  };
  try {
    await seg(["-loop", "1", "-t", String(T), "-i", cards[0].png], path.join(i.workDir, "seg-00.mp4"));
    for (const [k, p] of picks.entries()) {
      const v = p.web ? videoOf(p) : undefined;
      await seg(["-loop", "1", "-t", String(v ? T : T + 2), "-i", cards[k + 1].png], path.join(i.workDir, `seg-${k + 1}a.mp4`));
      if (v) await seg(["-i", v], path.join(i.workDir, `seg-${k + 1}b.mp4`));
      else if (p.web) notes.push(`${p.ac}: no video for "${clean(p.test.title)}"; the card is shown alone`);
    }
    const list = path.join(i.workDir, "segments.txt");
    fs.writeFileSync(list, segments.map((s) => `file '${s.replace(/'/g, "'\\''")}'`).join("\n") + "\n");
    const out = path.join(i.workDir, `${r.story}-showcase.mp4`);
    const r4 = await runProcess(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", "-movflags", "+faststart", out], { cwd, env: i.env, timeoutMs: 180_000 });
    if (r4.code !== 0 || !fs.existsSync(out)) throw new Error(`ffmpeg concat: ${(r4.stderr || r4.stdout).trim().slice(0, 300)}`);
    files.unshift({ name: `${r.story}-showcase.mp4`, data: fs.readFileSync(out), contentType: "video/mp4", source: out });
    return { files, notes, video: true };
  } catch (e) {
    notes.push(`${(e as Error).message}; attaching the per-test videos instead`);
    return { files, notes, video: false };
  }
}
