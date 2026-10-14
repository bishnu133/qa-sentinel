import fs from "node:fs";
import path from "node:path";

/**
 * Healed steps: page-object actions that failed on their own locator in a run with QA_HEALING=bubblegum and were
 * performed by Bubblegum from their intent instead. The test passed, but the page object is out of date. qa-sentinel
 * lists them (`qa-sentinel healed`), keeps them in qa-healed.json, and hands them to the next generation run as
 * page-object fixes to make. They are never counted as a clean pass.
 */
export interface HealedStep {
  test: string;
  file: string;
  at?: string;
  intent: string;
  failedLocator: string;
  status: string;
  healedTo?: string;
  resolver?: string;
  confidence?: number;
  error?: string;
}

export const HEALED_JSON = "qa-healed.json";
export const HEALED_MD = "qa-healed.md";

/** Collect "healed-step" attachments from a Playwright JSON report. */
export function healedFromResults(file: string): HealedStep[] {
  const json = JSON.parse(fs.readFileSync(file, "utf8"));
  const out: HealedStep[] = [];
  const walk = (suite: any) => {
    for (const s of suite.suites ?? []) walk(s);
    for (const spec of suite.specs ?? [])
      for (const t of spec.tests ?? [])
        for (const r of t.results ?? [])
          for (const a of r.attachments ?? []) {
            if (a.name !== "healed-step") continue;
            try {
              const body = a.body ? Buffer.from(a.body, "base64").toString("utf8") : a.path && fs.existsSync(a.path) ? fs.readFileSync(a.path, "utf8") : "";
              if (body) out.push(JSON.parse(body));
            } catch {
              /* unreadable attachment: skip */
            }
          }
  };
  walk(json);
  return out;
}

export const isHealed = (s: HealedStep) => s.status === "recovered" || s.status === "passed";

/** One entry per page-object call site: the same broken locator heals in every test that uses it. */
export function groupBySite(steps: HealedStep[]): { site: string; intent: string; failedLocator: string; healedTo?: string; confidence?: number; tests: string[]; healed: boolean }[] {
  const m = new Map<string, ReturnType<typeof groupBySite>[number]>();
  for (const s of steps) {
    const site = s.at ?? s.file;
    const key = `${site}|${s.failedLocator}`;
    const g = m.get(key) ?? { site, intent: s.intent, failedLocator: s.failedLocator, healedTo: s.healedTo, confidence: s.confidence, tests: [], healed: isHealed(s) };
    if (!g.tests.includes(s.test)) g.tests.push(s.test);
    m.set(key, g);
  }
  return [...m.values()];
}

export function healedMarkdown(steps: HealedStep[]): string {
  const groups = groupBySite(steps);
  if (!groups.length) return "**Runtime healing:** no healed steps in this run.";
  const healed = groups.filter((g) => g.healed);
  const failed = groups.filter((g) => !g.healed);
  const clean = (t: string) => t.replace(/\s*@\S+/g, "").trim().replace(/\|/g, "\\|");
  return [
    `### Runtime healing: ${healed.length} page-object locator(s) to fix${failed.length ? `, ${failed.length} Bubblegum could not heal` : ""}`,
    "_Tests passed only because Bubblegum found the element from the step's intent. Update the page objects; the next qa-sentinel generation run gets this list._",
    "",
    "| Page object | Step | Old locator | Bubblegum used | Tests |",
    "| --- | --- | --- | --- | --- |",
    ...groups.map(
      (g) =>
        `| \`${g.site}\` | ${g.intent.replace(/\|/g, "\\|")} | \`${g.failedLocator.replace(/\|/g, "\\|")}\` | ${g.healed ? `\`${g.healedTo ?? "?"}\`${g.confidence !== undefined ? ` (${Math.round(g.confidence * 100)}%)` : ""}` : "❌ not healed"} | ${g.tests.map(clean).join("<br>")} |`,
    ),
  ].join("\n");
}

export function readHealed(cwd: string): HealedStep[] {
  const f = path.join(cwd, HEALED_JSON);
  if (!fs.existsSync(f)) return [];
  try {
    return (JSON.parse(fs.readFileSync(f, "utf8")) as HealedStep[]).filter(isHealed);
  } catch {
    return [];
  }
}
