import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { Config } from "../config.js";
import type { AgentEngine, AgentResult } from "../engines/AgentEngine.js";
import { collectKnowledge } from "../kb.js";
import { loadContract } from "../contracts.js";
import { type RequirementSnapshot, storyMarkdown } from "../requirements.js";
import { agentEnv } from "../run.js";
import { readTemplate } from "../templates.js";
import { log } from "../log.js";
import { type ExpectedFile, ExpectedFileSchema, acHash, freshness, mergeExpected } from "./format.js";
import { acTrailer } from "./commits.js";

/**
 * The requirements pass: expected behaviour per AC, written from the story alone.
 *
 * Code-blind by construction: the agent works in a fresh folder holding only the story, the team's domain rules,
 * the agreed API specs and the stored expectations; the test repository and the service repositories are denied
 * to it. Its proposal is validated in code before anything is written:
 * - every new or changed AC is covered (behaviours, or a reason it can't be tested);
 * - each ready behaviour quotes its basis, and the basis is found in those sources;
 * - every number and message in a ready behaviour's values appears in its basis: an invented value
 *   (a status code, a limit, an error text the requirements don't give) is rejected, with the instruction to
 *   mark it unspecified and ask the PO;
 * - ids it reuses belong to that AC in the stored file.
 * Then mergeExpected writes it: unchanged ACs keep their reviewed entries byte for byte.
 */

const ProposedBehaviour = z
  .object({
    id: z.string().regex(/^B\d+$/).optional(),
    kind: z.enum(["main", "edge", "boundary", "negative"]).default("main"),
    statement: z.string().min(1),
    expect: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))])).default({}),
    basis: z.string().optional(),
    state: z.enum(["ready", "unspecified"]).default("ready"),
    question: z.string().optional(),
  })
  .strict();

export const ProposalSchema = z
  .object({
    acs: z.array(
      z
        .object({
          id: z.string().min(1),
          services: z.array(z.string()).default([]),
          untestable: z.string().optional(),
          behaviours: z.array(ProposedBehaviour).default([]),
        })
        .strict(),
    ),
  })
  .strict();
export type Proposal = z.infer<typeof ProposalSchema>;

/** Text as compared for "is this quote in the sources?": case, markup and spacing don't count. */
const plain = (s: string) =>
  s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[*_`~>#|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Values a ready behaviour asserts that must come from its basis: numbers and texts (booleans are outcomes). */
function valuesToCheck(expect: Record<string, unknown>): string[] {
  const out: string[] = [];
  const visit = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(visit);
    else if (typeof v === "number") out.push(String(v));
    else if (typeof v === "string" && v.trim()) out.push(v.trim());
  };
  Object.values(expect).forEach(visit);
  return out;
}

/** Numbers written in a text, as numbers: "1,000" → 1000, "10.50" → 10.5. */
const numbersIn = (hay: string) => [...hay.matchAll(/-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|-?\d+(?:\.\d+)?/g)].map((m) => Number(m[0].replace(/,/g, "")));

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Is this value written in the text? Numbers compare as numbers; texts as whole words (closing punctuation ignored). */
const inText = (needle: string, hay: string) => {
  const n = plain(needle).replace(/[.!?;:,]+$/, "");
  if (/^-?\d+(?:\.\d+)?$/.test(n)) return numbersIn(hay).includes(Number(n));
  if (!n) return false;
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(n)}(?![\\p{L}\\p{N}])`, "u").test(hay);
};

export interface SpecAc {
  id: string;
  text: string;
  /** No stored expectation yet, its text changed, or the stored entry is an empty placeholder. */
  needsProposal: boolean;
}

export function validateProposal(raw: unknown, i: { acs: SpecAc[]; sources: string; stored?: ExpectedFile }): { proposal?: Proposal; errors: string[] } {
  // Entries for ACs that weren't asked for (e.g. copied from current.json) are dropped, not judged: qa-sentinel keeps
  // the stored entry for those anyway.
  const needed = new Set(i.acs.filter((a) => a.needsProposal).map((a) => a.id));
  const known0 = new Set(i.acs.map((a) => a.id));
  if (raw && typeof raw === "object" && Array.isArray((raw as { acs?: unknown }).acs))
    raw = { ...(raw as object), acs: (raw as { acs: { id?: unknown }[] }).acs.filter((a) => !(a && typeof a.id === "string" && known0.has(a.id) && !needed.has(a.id))) };
  const p = ProposalSchema.safeParse(raw);
  if (!p.success) return { errors: p.error.issues.map((x) => `${x.path.join(".") || "(root)"}: ${x.message}`) };
  const errors: string[] = [];
  const known = new Set(i.acs.map((a) => a.id));
  const hay = plain(i.sources);
  for (const ac of p.data.acs) if (!known.has(ac.id)) errors.push(`${ac.id} isn't an AC of this story (known: ${[...known].join(", ")}); leave it out`);
  for (const need of i.acs.filter((a) => a.needsProposal)) {
    const e = p.data.acs.find((a) => a.id === need.id);
    if (!e) errors.push(`${need.id} is missing: give its behaviours, or "untestable" with the reason`);
    else if (!e.behaviours.length && !e.untestable) errors.push(`${need.id}: no behaviours and no "untestable" reason`);
  }
  for (const ac of p.data.acs) {
    const storedIds = new Set(i.stored?.acs.find((a) => a.id === ac.id)?.behaviours.map((b) => b.id) ?? []);
    ac.behaviours.forEach((b, k) => {
      const where = `${ac.id} behaviour ${b.id ?? k + 1} ("${b.statement.slice(0, 60)}")`;
      if (b.id && !storedIds.has(b.id)) errors.push(`${where}: ${b.id} isn't one of ${ac.id}'s stored ids; leave "id" out for a new behaviour`);
      if (b.state === "unspecified") {
        if (!b.question) errors.push(`${where}: unspecified needs a "question" for the PO`);
        const vals = valuesToCheck(b.expect);
        if (vals.length) errors.push(`${where}: an unspecified behaviour has no values yet (found ${vals.map((v) => JSON.stringify(v)).join(", ")}); leave "expect" empty, or only true/false outcomes`);
        return;
      }
      if (!b.basis || plain(b.basis).split(" ").filter(Boolean).length < 3) {
        errors.push(`${where}: "basis" is missing or too short: quote at least a few words from story.md, knowledge.md or the agreed spec it comes from`);
        return;
      }
      if (!hay.includes(plain(b.basis))) errors.push(`${where}: basis "${b.basis.slice(0, 80)}" isn't in story.md, knowledge.md or the agreed spec; copy the words exactly`);
      // Numbers in the statement come from the basis too ("returns 409" can't hide an invented status code there).
      for (const v of numbersIn(plain(b.statement))) if (!numbersIn(plain(b.basis)).includes(v)) errors.push(`${where}: the statement says ${v}, which isn't in its basis; quote the words that give it, or leave it out`);
      for (const v of valuesToCheck(b.expect)) {
        if (!inText(v, plain(b.basis))) errors.push(`${where}: value ${JSON.stringify(v)} isn't in its basis. Quote words that contain it exactly as written (3 needs "3", not "three"), or, if the requirements don't give it, set "state": "unspecified", ask in "question", and leave the value out`);
      }
      for (const [k2, v] of Object.entries(b.expect)) if (v === null) errors.push(`${where}: ${k2} is null; a ready behaviour needs every value (or make it unspecified)`);
    });
  }
  return errors.length ? { errors } : { proposal: p.data, errors };
}

/** The proposal as an expected file: hash and text from the story, ids for new behaviours after the stored ones. */
export function proposalToFile(story: string, title: string | undefined, acs: SpecAc[], prop: Proposal, stored?: ExpectedFile): ExpectedFile {
  let next = Math.max(0, ...(stored?.acs ?? []).flatMap((a) => a.behaviours.map((b) => Number(b.id.slice(1)))), ...prop.acs.flatMap((a) => a.behaviours.map((b) => (b.id ? Number(b.id.slice(1)) : 0))));
  return ExpectedFileSchema.parse({
    version: 1,
    story,
    ...(title ? { title } : {}),
    acs: prop.acs.map((a) => {
      const text = acs.find((x) => x.id === a.id)?.text ?? "";
      return {
        id: a.id,
        hash: acHash(text),
        text,
        services: a.services,
        ...(a.untestable ? { untestable: a.untestable } : {}),
        behaviours: a.behaviours.map((b) => ({
          id: b.id ?? `B${++next}`,
          kind: b.kind,
          statement: b.statement,
          expect: b.state === "unspecified" ? Object.fromEntries(Object.entries(b.expect).filter(([, v]) => typeof v === "boolean")) : b.expect,
          state: b.state,
          ...(b.question ? { question: b.question } : {}),
          source: "ac",
          ...(b.basis ? { basis: b.basis } : {}),
        })),
      };
    }),
  });
}

export interface SpecResult {
  /** The merged file, when the pass produced one (undefined: nothing to do, or the pass failed). */
  file?: ExpectedFile;
  changes: string[];
  errors: string[];
  runs: AgentResult[];
  /** True when no AI run was needed (every AC already has a current, filled expectation). */
  skipped: boolean;
}

/**
 * Run the requirements pass for a story. `stored` is the expected file as it is now (undefined: none yet).
 * `denyRead` are the folders the agent must not see (the test repo, the service repos).
 */
export async function runSpecPass(i: { cwd: string; c: Config; engine: AgentEngine; req: RequirementSnapshot; story: string; stored?: ExpectedFile; runDir: string; denyRead: string[]; dryRun?: boolean }): Promise<SpecResult> {
  const acsNow = i.req.acceptanceCriteria.map((a) => ({ id: a.id, text: a.text }));
  if (!acsNow.length) return { changes: [], errors: ["the story has no acceptance criteria"], runs: [], skipped: true };
  const fresh = freshness(i.stored, acsNow);
  const filled = (id: string) => {
    const e = i.stored?.acs.find((a) => !a.removed && a.hash === acHash(acsNow.find((x) => x.id === id)!.text));
    return !!e && (e.behaviours.length > 0 || !!e.untestable);
  };
  const acs: SpecAc[] = acsNow.map((a) => ({ ...a, needsProposal: fresh.get(a.id) !== "current" || !filled(a.id) }));
  if (!acs.some((a) => a.needsProposal)) {
    // Nothing new to write: keep the stored file (merge also records ACs that left the story).
    return { ...checked(keepMissing(mergeExpected(i.stored, { version: 1, story: i.story, acs: [] }, acsNow), i.stored, acsNow)), runs: [], skipped: true };
  }

  // A fresh folder with only the requirements in it.
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "qas-spec-"));
  const sources: string[] = [];
  const files: string[] = [];
  const put = (name: string, text: string, isSource = false) => {
    fs.mkdirSync(path.dirname(path.join(ws, name)), { recursive: true });
    fs.writeFileSync(path.join(ws, name), text);
    if (isSource) sources.push(text);
    if (!name.startsWith(".")) files.push(name);
  };
  put("story.md", storyMarkdown(i.req), true);
  sources.push(i.req.rawText);
  const kb = collectKnowledge(i.cwd, i.c);
  if (kb) put("knowledge.md", kb.markdown, true);
  const codeRepos = specDenyRead(i.cwd, i.c, i.denyRead).map((d) => path.resolve(d));
  for (const s of i.c.workspace.services) {
    // A spec read from a service's own checkout without a pinned ref may be generated from the code: not a requirement.
    if (s.contract?.repo && !s.contract.ref && codeRepos.some((d) => path.resolve(i.cwd, s.contract!.repo!).startsWith(d))) {
      log.warn(`requirements pass: ${s.name}'s agreed spec is read from a code checkout without a ref; left out (set contract.ref to the agreed version)`);
      continue;
    }
    if (!s.contract || !new RegExp(`\\b${s.name.replace(/[-]/g, "[- ]?")}\\b`, "i").test(i.req.rawText)) continue;
    const { contract } = await loadContract(i.c, s.contract, { cwd: i.cwd, storyKey: i.story, env: process.env }).catch(() => ({ contract: undefined }));
    if (contract) put(`agreed-spec-${s.name}${/^\s*[{[]/.test(contract.text) ? ".json" : ".yaml"}`, contract.text, true);
  }
  if (i.stored) put("current.json", JSON.stringify(i.stored, null, 2));
  put("acs.json", JSON.stringify(acs.map((a) => ({ id: a.id, text: a.text, changed: fresh.get(a.id) === "changed", new: fresh.get(a.id) === "new", needsProposal: a.needsProposal })), null, 2));
  put(".claude/skills/write-expectations/SKILL.md", readTemplate("skills/write-expectations/SKILL.md"));
  const out = "proposal.json";
  const keep = () => {
    for (const f of ["proposal.json", "acs.json", "current.json"]) if (fs.existsSync(path.join(ws, f))) fs.copyFileSync(path.join(ws, f), path.join(i.runDir, `requirements-pass-${f}`));
  };
  if (i.dryRun) {
    log.info(`dry run: the requirements pass would read ${fs.readdirSync(ws).join(", ")} (story ${i.story})`);
    fs.rmSync(ws, { recursive: true, force: true });
    return { changes: [], errors: [], runs: [], skipped: true };
  }

  const runs: AgentResult[] = [];
  const ask = (extra: string[] = []) =>
    i.engine.run({
      kind: "spec",
      cwd: ws,
      prompt: [
        "Use the write-expectations skill.",
        `Story ${i.story}. The files in this folder are all you may use: ${files.join(", ")}.`,
        `Write expectations only for the ACs in acs.json with "needsProposal": true. Leave the others out: qa-sentinel keeps them as stored.`,
        `Write the JSON to ${out}. That is the only file you may write. Then answer "done".`,
        ...extra,
      ].join("\n"),
      readOnlyDirs: [],
      readDeny: i.denyRead,
      write: { allowed: [out], blocked: [] },
      bash: [],
      maxTurns: i.c.agent.maxTurns.spec,
      maxBudgetUsd: i.c.agent.maxBudgetUsd.spec,
      timeoutMs: i.c.agent.timeoutMinutes.spec * 60_000,
      env: agentEnv(i.c),
      model: i.c.agent.model,
    });
  const read = () => {
    try {
      return JSON.parse(fs.readFileSync(path.join(ws, out), "utf8"));
    } catch {
      return undefined;
    }
  };
  const src = sources.join("\n");
  let v: ReturnType<typeof validateProposal>;
  try {
    const first = await ask();
    runs.push(first);
    if (!first.ok) return { changes: [], errors: [`agent run ${first.status}`], runs, skipped: false };
    v = validateProposal(read(), { acs, sources: src, stored: i.stored });
    if (!v.proposal) {
      const second = await ask(["Your previous proposal was rejected:", ...v.errors.slice(0, 20).map((e) => `- ${e}`), "Fix these and write the file again."]);
      runs.push(second);
      if (!second.ok) return { changes: [], errors: [`agent run ${second.status}`, ...v.errors], runs, skipped: false };
      v = validateProposal(read(), { acs, sources: src, stored: i.stored });
    }
  } finally {
    keep();
    fs.rmSync(ws, { recursive: true, force: true });
  }
  if (!v.proposal) return { changes: [], errors: v.errors, runs, skipped: false };
  const proposal = proposalToFile(i.story, i.req.title, acs, v.proposal, i.stored);
  return { ...checked(keepMissing(mergeExpected(i.stored, proposal, acsNow), i.stored, acsNow)), runs, skipped: false };
}

/**
 * An AC missing from the story's current list may be a parsing gap rather than a removal, so the lock keeps it
 * locked (see lock.ts) and qa-sentinel never retires it: its stored entry stays exactly as it was. A person retires
 * it (removed: true) in the merge request when the story really dropped it.
 */
function keepMissing(m: { file: ExpectedFile; changes: string[] }, stored: ExpectedFile | undefined, now: { id: string }[]): { file: ExpectedFile; changes: string[] } {
  if (!stored) return m;
  const gone = new Set<string>();
  const acs = m.file.acs.map((a) => {
    const was = stored.acs.find((x) => x.id === a.id && x.hash === a.hash);
    // Only an id that is absent from the story: an id still there with other text is a changed AC (renumbered or
    // reworded), which the lock opens, so marking the old entry removed is right.
    if (!a.removed || !was || was.removed || now.some((x) => x.id === a.id)) return a;
    gone.add(a.id);
    return was;
  });
  if (!gone.size) return m;
  const changes = m.changes.filter((x) => ![...gone].some((id) => x.startsWith(`${id} is no longer in the story`)));
  for (const id of gone) changes.push(`${id} isn't in the story's current list: its expectations stay as they are (still tested). If the story really dropped it, a QA engineer sets "removed: true" on it.`);
  return { file: { ...m.file, acs }, changes };
}

/** The merged file must still be a valid file: never hand on (or commit) one that can't be read back. */
function checked(m: { file: ExpectedFile; changes: string[] }): { file?: ExpectedFile; changes: string[]; errors: string[] } {
  const p = ExpectedFileSchema.safeParse(m.file);
  return p.success ? { file: p.data, changes: m.changes, errors: [] } : { changes: m.changes, errors: p.error.issues.map((x) => `merged file is invalid: ${x.path.join(".")}: ${x.message}`) };
}

/**
 * Folders the code-blind pass may not read: the test repository, every service checkout (configured, and the ones
 * this run uses), and the folders around them (sibling clones), plus the home folder. The pass works in the
 * system temp folder, which is never denied.
 */
export function specDenyRead(cwd: string, c: Config, extra: string[] = []): string[] {
  const tmp = path.resolve(os.tmpdir());
  const repos = [cwd, ...c.workspace.services.map((s) => path.resolve(cwd, s.path)), ...extra].map((d) => path.resolve(d));
  const around = [...repos.map((d) => path.dirname(d)), os.homedir()].map((d) => path.resolve(d));
  const covers = (d: string) => tmp === d || tmp.startsWith(d.endsWith(path.sep) ? d : d + path.sep);
  return [...new Set([...repos, ...around])].filter((d) => d !== path.parse(d).root && !covers(d));
}

/** The commit message for qa-sentinel's expected-behaviour commit (with the AC hashes it was written for). */
export function expectedCommitMessage(story: string, acs: { id: string; text: string }[], version: string, runId: string): string {
  const t = acTrailer(story, acs);
  return `test(expected): expected behaviour for ${story}\n\nGenerated by qa-sentinel ${version} from the story alone (requirements pass). Run: ${runId}${t ? `\n\n${t}` : ""}`;
}

/** Behaviours waiting for the PO, as "AC-2/B3: question". */
export function poQuestions(f: ExpectedFile): string[] {
  return f.acs.filter((a) => !a.removed).flatMap((a) => a.behaviours.filter((b) => b.state === "unspecified").map((b) => `${a.id}/${b.id}: ${b.question ?? "(no question)"}`));
}
