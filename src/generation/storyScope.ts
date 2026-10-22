import type { Config } from "../config.js";
import type { ExpectedFile } from "../expected/format.js";
import { acWriteReadiness, mergedHeadsOf, type AcWriteReadiness } from "../feature/readiness.js";
import type { ServicePart } from "../feature/manifest.js";
import type { StoryRecord } from "../stories/record.js";
import { digest } from "../stories/jobs.js";

/**
 * Which acceptance criteria of a story are written in this run, and which wait (and for what). Fixed rules, from
 * facts: the merged work, the services each AC needs, the Jira status, what an earlier run already wrote. No AI.
 */
export interface StoryScope {
  readiness: AcWriteReadiness[];
  /** The ACs to plan now, in the story's order. */
  acScope: string[];
  /** The others, with what each waits for. */
  heldAcs: Map<string, string>;
  /** Of `acScope`, the ones that need several services. */
  crossInScope: string[];
  /** The services' merged commits the cross ACs in scope are written against (sorted "service:sha"). */
  heads: string[];
  /** Asked for with `--acs` but waiting (refused unless forced). */
  refused: string[];
  /** Ready, but their tests were already written for these commits and this AC text (planned again only with `force`). */
  alreadyWritten: string[];
  /** The services' merged commits of every AC in scope (cross or not): what the run's job key stands for. */
  allHeads: string[];
  /** The ids named in `only` that the story does not have. */
  unknown: string[];
}

export interface StoryScopeInput {
  c: Config;
  acs: { id: string; text: string }[];
  expected?: ExpectedFile;
  parts: ServicePart[];
  rec?: StoryRecord;
  /** A merge of this service started the run: its own single-service ACs are written, other single ACs wait for their service. Absent: the whole story (CLI). */
  service?: string;
  jiraReady?: boolean;
  components?: string[];
  /** `--acs`: only these. A waiting AC among them is refused unless `force`. */
  only?: string[];
  force?: boolean;
  now?: Date;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** The digest of the commits an AC's tests are written against (its needed services' merged work). */
export const headsDigest = (parts: ServicePart[], services: string[]) => digest(mergedHeadsOf(parts, services));

/** Has an earlier run already written this AC's tests (cross-service or not) for the same commits and the same AC text? */
export function acWritten(rec: StoryRecord | undefined, row: AcWriteReadiness, parts: ServicePart[], text: string, hashOf: (t: string) => string): boolean {
  const w = (row.kind === "cross" ? rec?.crossService : rec?.singleService)?.[row.ac];
  return w?.state === "written" && w.heads === headsDigest(parts, row.services) && w.acHash === hashOf(text);
}
export const crossWritten = acWritten;

export function storyScope(i: StoryScopeInput, hashOf: (t: string) => string): StoryScope {
  const ids = i.acs.map((a) => a.id);
  const text = new Map(i.acs.map((a) => [a.id, a.text]));
  const readiness = acWriteReadiness(i.parts, i.expected, ids, { jiraReady: i.jiraReady, mode: i.c.generation.crossService, components: i.components, overrides: i.rec?.overrides, staleDays: i.c.generation.staleMrDays, now: i.now });
  const held = new Map<string, string>();
  const wanted: string[] = [];
  const alreadyWritten: string[] = [];
  const unknown = (i.only ?? []).filter((x) => !ids.some((id) => same(id, x)));
  for (const r of readiness) {
    if (i.only?.length && !i.only.some((x) => same(x, r.ac))) {
      held.set(r.ac, "a run that asks for it (--acs)");
      continue;
    }
    if (r.state !== "ready") {
      held.set(r.ac, r.waitingFor || r.reason);
      continue;
    }
    // A merge writes the tests of the ACs that only its own service builds; another service's single ACs were or will be written at its merge.
    if (r.kind === "single" && i.service && !r.services.some((s) => same(s, i.service!))) {
      held.set(r.ac, `${r.services.join(", ")}'s own merge (its tests are written then)`);
      continue;
    }
    // Already written for these commits and this AC text: not planned again, however the run was started (only --force does).
    if (!i.force && acWritten(i.rec, r, i.parts, text.get(r.ac) ?? "", hashOf)) {
      alreadyWritten.push(r.ac);
      held.set(r.ac, r.kind === "cross" ? "a new change in one of its services (its end-to-end tests are already written for these commits)" : "a new change in its service (its tests are already written for these commits)");
      continue;
    }
    wanted.push(r.ac);
  }
  // --acs names ACs that are waiting: refused, unless forced (then they are planned as they are).
  const refused = (i.only ?? []).filter((x) => readiness.some((r) => same(r.ac, x) && r.state !== "ready"));
  if (i.force) for (const x of refused) {
    const r = readiness.find((y) => same(y.ac, x))!;
    held.delete(r.ac);
    if (!wanted.includes(r.ac)) wanted.push(r.ac);
  }
  const ordered = ids.filter((id) => wanted.includes(id));
  const acScope = ordered.slice(0, i.c.generation.maxAcsPerRun);
  for (const id of ordered.slice(i.c.generation.maxAcsPerRun)) held.set(id, `the next run (at most ${i.c.generation.maxAcsPerRun} ACs are planned per run: generation.maxAcsPerRun)`);
  const crossInScope = acScope.filter((id) => readiness.find((r) => r.ac === id)?.kind === "cross");
  const heads = [...new Set(crossInScope.flatMap((id) => mergedHeadsOf(i.parts, readiness.find((r) => r.ac === id)!.services)))].sort();
  const allHeads = [...new Set(acScope.flatMap((id) => mergedHeadsOf(i.parts, readiness.find((r) => r.ac === id)!.services)))].sort();
  return { readiness, acScope, heldAcs: held, crossInScope, heads, refused: i.force ? [] : refused, alreadyWritten, allHeads, unknown };
}
