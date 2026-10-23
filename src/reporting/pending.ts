import type { StoryRecord } from "../stories/record.js";
import { escapeWiki, overrideLines } from "../stories/overrides.js";

const byAc = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

export interface PendingFacts {
  jiraReady?: boolean;
  jiraStatus?: string;
  state?: string;
  /** Write-time readiness per AC (what each waiting AC waits for, and what an override covers). */
  waits?: { ac: string; state: string; reason: string; waitingFor?: string }[];
  /** `/qa ready` comments naming an AC the story does not have. */
  unknownOverrides?: string[];
}

/**
 * The "pending" section of the status comment: what is waiting on people or on a mismatch, with no AI. Held
 * cross-service ACs, ACs waiting for a merge or a status (and for what), a test branch that cannot take main, a
 * story that looks done to one side but not the other, and every `/qa ready` in use: with who gave it and WHAT it
 * covers (an override can hide a service with no change). Null when there is nothing to say.
 */
export function pendingWiki(rec: Pick<StoryRecord, "crossService" | "acEvidence" | "overrides" | "conflict">, o: PendingFacts): string | null {
  const lines: string[] = [];
  if (rec.conflict) lines.push(`* The test branch ${escapeWiki(rec.conflict.branch)} cannot take the main branch (${escapeWiki(rec.conflict.message.slice(0, 200))}). A person must resolve it.`);
  for (const [ac, x] of Object.entries(rec.crossService).sort(([a], [b]) => byAc(a, b)))
    if (x.state === "held") lines.push(`* ${ac}: end-to-end tests are held${x.reason ? `: ${x.reason}` : ""}`);
  const overridden = new Set(rec.overrides.map((x) => x.ac.toUpperCase()));
  for (const w of [...(o.waits ?? [])].sort((a, b) => byAc(a.ac, b.ac)))
    if (w.state !== "ready" && !overridden.has(w.ac.toUpperCase())) lines.push(`* ${w.ac}: tests wait${w.waitingFor ? ` for ${w.waitingFor}` : `: ${w.reason}`}`);
  if (o.jiraReady) {
    for (const [ac, e] of Object.entries(rec.acEvidence).sort(([a], [b]) => byAc(a, b)))
      if (e.status === "not-found") lines.push(`* ${ac} looks not built, but the story status is ${o.jiraStatus ?? "ready"}`);
  } else if (o.state === "covered" && o.jiraReady === false) {
    lines.push(`* Every AC has a passing test, but the story status is ${o.jiraStatus ?? "not ready"}`);
  }
  const rows = new Map((o.waits ?? []).map((w) => [w.ac.toUpperCase(), w]));
  for (const [i, l] of overrideLines(rec.overrides).entries()) {
    const row = rows.get(rec.overrides[i].ac.toUpperCase());
    const covers = row && /^marked ready by a person/.test(row.reason) ? /\((.+)\)\s*$/.exec(row.reason)?.[1] ?? row.reason : undefined;
    lines.push(`* ${l}${covers ? `; this skips: ${escapeWiki(covers)}` : ""}`);
  }
  for (const ac of (o.unknownOverrides ?? []).sort(byAc)) lines.push(`* ${escapeWiki(ac)} was marked ready, but this story has no such AC (ignored)`);
  return lines.length ? `h3. Waiting\n${lines.join("\n")}` : null;
}
