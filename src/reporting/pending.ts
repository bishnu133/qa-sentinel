import type { StoryRecord } from "../stories/record.js";
import { overrideLines } from "../stories/overrides.js";

/**
 * The "pending" section of the status comment: what is waiting on people or on a mismatch, with no AI. Held
 * cross-service ACs and the reason, a story that looks done to one side but not the other, and every `/qa ready`
 * override in use with who gave it. Null when there is nothing to say.
 */
export function pendingWiki(rec: Pick<StoryRecord, "crossService" | "acEvidence" | "overrides">, o: { jiraReady?: boolean; jiraStatus?: string; state?: string }): string | null {
  const lines: string[] = [];
  for (const [ac, x] of Object.entries(rec.crossService).sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true })))
    if (x.state === "held") lines.push(`* ${ac}: end-to-end tests are held${x.reason ? `: ${x.reason}` : ""}`);
  if (o.jiraReady) {
    for (const [ac, e] of Object.entries(rec.acEvidence).sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true })))
      if (e.status === "not-found") lines.push(`* ${ac} looks not built, but the story status is ${o.jiraStatus ?? "ready"}`);
  } else if (o.state === "covered" && o.jiraReady === false) {
    lines.push(`* Every AC has a passing test, but the story status is ${o.jiraStatus ?? "not ready"}`);
  }
  for (const l of overrideLines(rec.overrides)) lines.push(`* ${l}`);
  return lines.length ? `h3. Waiting\n${lines.join("\n")}` : null;
}
