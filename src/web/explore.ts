import fs from "node:fs";
import path from "node:path";
import type { Config } from "../config.js";
import type { TestPlan } from "../plan/schema.js";
import { runProcess } from "../proc.js";

/**
 * Before the agent writes web tests, qa-sentinel opens the affected pages itself and saves what is on them:
 * the accessibility tree (roles and names: what good locators are built from) and a screenshot. The agent reads
 * files instead of driving a browser, so exploration is deterministic, cheap and needs no extra agent tools.
 *
 * Routes with :params are opened by following a matching link from a page already visited (e.g. the first
 * /orders/:id link on /orders); when none is found the page is listed as not opened and the agent relies on
 * Playwright's error-context.md from its own runs.
 */

export interface PageSnapshot {
  route: string;
  url?: string;
  aria?: string;
  screenshot?: string;
  error?: string;
}

/** Pages a plan's web scenarios and UI changes touch, plus the service's known routes as a fallback. */
export function pagesToExplore(plan: TestPlan, fallback: string[], max = 8): string[] {
  const out = new Set<string>();
  for (const d of plan.decisions) {
    if (!["create", "update", "review"].includes(d.decision)) continue;
    for (const s of d.proposedScenarios) if (s.layer === "web" && s.page) out.add(s.page);
    const ch = plan.changes.find((c) => c.id === d.changeId);
    if (ch?.page && d.proposedScenarios.some((s) => s.layer === "web")) out.add(ch.page);
  }
  if (!out.size) for (const r of fallback) out.add(r);
  return [...out].slice(0, max);
}

export const slug = (route: string) => route.replace(/^\/+|\/+$/g, "").replace(/[:/]+/g, "_").replace(/[^\w.-]/g, "") || "home";

export const SNAPSHOT_SCRIPT = `
import fs from "node:fs";
import path from "node:path";
const { chromium } = await import("@playwright/test");
const [, , inFile] = process.argv;
const job = JSON.parse(fs.readFileSync(inFile, "utf8"));
const launch = process.env.QA_BROWSER_PATH ? { executablePath: process.env.QA_BROWSER_PATH } : process.env.QA_BROWSER_CHANNEL ? { channel: process.env.QA_BROWSER_CHANNEL } : {};
const browser = await chromium.launch(launch);
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const base = job.baseUrl.replace(/\\/?$/, "/");
const seen = new Set();
const out = [];
const toRe = (r) => new RegExp("^" + r.replace(/[.*+?^\${}()|[\\]\\\\]/g, "\\\\$&").replace(/:\\w+/g, "[^/?#]+") + "/?(?:[?#].*)?$");
const pathOf = (u) => { const p = new URL(u).pathname; const b = new URL(base).pathname; return "/" + (p.startsWith(b) ? p.slice(b.length) : p).replace(/^\\//, ""); };
async function visit(route, url) {
  const r = { route, url };
  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: 15000 });
    r.aria = await page.locator("body").ariaSnapshot();
    const shot = path.join(job.outDir, job.slugs[route] + ".png");
    await page.screenshot({ path: shot, fullPage: true });
    r.screenshot = shot;
    for (const href of await page.$$eval("a[href]", (as) => as.map((a) => a.href))) seen.add(href);
  } catch (e) { r.error = String(e.message || e).split("\\n")[0]; }
  out.push(r);
}
// Pages without :params are opened directly; the service's other known pages are opened as link sources.
const plain = [...new Set([...job.routes, ...(job.sources ?? [])])].filter((r) => !r.includes(":"));
const params = job.routes.filter((r) => r.includes(":"));
for (const r of plain.length ? plain : ["/"]) await visit(r, new URL(r.replace(/^\\//, ""), base).href);
for (const r of params) {
  const re = toRe(r);
  // A link to another known page (e.g. /orders/new for /orders/:id) is not an instance of this route.
  const hit = [...seen].find((u) => { try { const p = pathOf(u).replace(/\\/$/, "") || "/"; return !plain.includes(p) && re.test(p); } catch { return false; } });
  if (hit) await visit(r, hit);
  else out.push({ route: r, error: "not opened: no link to a page like " + r + " on the pages visited (the agent can run a spec and read its error-context.md)" });
}
await browser.close();
fs.writeFileSync(path.join(job.outDir, "snapshots.json"), JSON.stringify(out.filter((r) => job.routes.includes(r.route)), null, 2));
`;

/** Snapshot the pages into <runDir>/page-snapshots; returns what was captured (never throws). */
export async function snapshotPages(o: { cwd: string; c: Config; runDir: string; routes: string[]; sources?: string[]; env: NodeJS.ProcessEnv }): Promise<PageSnapshot[]> {
  const baseUrl = o.env[o.c.tests.web.baseUrlEnv];
  const outDir = path.join(o.runDir, "page-snapshots");
  fs.mkdirSync(outDir, { recursive: true });
  if (!baseUrl) return o.routes.map((route) => ({ route, error: `${o.c.tests.web.baseUrlEnv} is not set` }));
  const slugs = Object.fromEntries(o.routes.map((r) => [r, slug(r)]));
  const job = path.join(outDir, "job.json");
  for (const r of o.sources ?? []) slugs[r] ??= slug(r);
  fs.writeFileSync(job, JSON.stringify({ baseUrl, routes: o.routes, sources: o.sources ?? [], outDir, slugs }));
  // The script lives in the run dir inside the test repo, so `@playwright/test` resolves from the repo's node_modules.
  const script = path.join(o.runDir, "snapshot-pages.mjs");
  fs.writeFileSync(script, SNAPSHOT_SCRIPT);
  const r = await runProcess("node", [script, job], { cwd: o.cwd, env: o.env, timeoutMs: 120_000 });
  const file = path.join(outDir, "snapshots.json");
  if (!fs.existsSync(file)) {
    const why = (r.stderr || r.stdout || `exit ${r.code}`).trim().split("\n").slice(-3).join(" ").slice(0, 300);
    return o.routes.map((route) => ({ route, error: `snapshot failed: ${why}` }));
  }
  const snaps: PageSnapshot[] = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const s of snaps) if (s.aria) fs.writeFileSync(path.join(outDir, `${slugs[s.route]}.aria.yaml`), s.aria + "\n");
  fs.writeFileSync(path.join(outDir, "README.md"), snapshotIndex(snaps, slugs));
  return snaps;
}

function snapshotIndex(snaps: PageSnapshot[], slugs: Record<string, string>): string {
  return [
    "# Page snapshots (taken by qa-sentinel before authoring)",
    "",
    "Each page: `<name>.aria.yaml` is the accessibility tree (use its roles and names for getByRole/getByLabel locators), `<name>.png` a screenshot.",
    "",
    ...snaps.map((s) => (s.error ? `- \`${s.route}\`: ${s.error}` : `- \`${s.route}\` (${s.url}): \`${slugs[s.route]}.aria.yaml\`, \`${slugs[s.route]}.png\``)),
    "",
  ].join("\n");
}
