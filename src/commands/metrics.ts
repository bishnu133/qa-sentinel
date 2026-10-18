import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { loadConfig } from "../config.js";
import { fromRoot, git } from "../git.js";
import type { Manifest } from "../run.js";
import { log } from "../log.js";

/**
 * Is the tool earning its keep? Two sources, both already there:
 * - run manifests (.qa-sentinel/runs/*, or CI artifacts downloaded into a folder): outcomes, cost, verification,
 *   plan repairs, guardrails;
 * - the test repo's git history: which agent commits reached the target branch, and whether a human changed the
 *   agent's files before they did ("merged without edits" is the number that says the reviews are cheap).
 */

export interface AgentCommit {
  sha: string;
  runId?: string;
  date: string;
  files: string[];
  state: "merged-unedited" | "merged-edited" | "merged-unknown" | "open" | "not-merged";
  mergedBy?: string;
}

export interface Metrics {
  since?: string;
  runs: number;
  byKind: Record<string, { runs: number; outcomes: Record<string, number>; costUsd: number; avgCostUsd: number; avgDurationS: number }>;
  /** Cost by change size (diff lines), per command: how cost grows, and the budget the runs suggest. */
  bySize: { kind: string; bucket: string; runs: number; avgCostUsd: number; p90CostUsd: number; hitBudget: number }[];
  suggestedBudgets: { kind: string; runs: number; p90CostUsd: number; suggestedUsd: number }[];
  costUsd: number;
  generate: { reachedVerification: number; verified: number; verificationRate: number | null };
  plans: { total: number; repaired: number; repairRate: number | null; invalid: number; risk: Record<string, number> };
  guardrails: { runsWithViolations: number; deniedToolCalls: number };
  mergeRequests: { total: number; mergedUnedited: number; mergedEdited: number; mergedUnknown: number; open: number; notMerged: number; mergedWithoutEditsRate: number | null };
  /** Merged-without-edits per month of the agent's commit: is the team's review getting lighter as lessons accumulate? */
  byMonth: { month: string; merged: number; unedited: number; rate: number | null }[];
}

/** manifest.json files under the given folders (run dirs or downloaded CI artifacts), one per run id. */
export function collectManifests(dirs: string[], since?: Date): Manifest[] {
  const out = new Map<string, Manifest>();
  const walk = (d: string, depth: number) => {
    if (depth > 6 || !fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name !== "node_modules" && e.name !== ".git") walk(p, depth + 1);
      } else if (e.name === "manifest.json") {
        try {
          const m = JSON.parse(fs.readFileSync(p, "utf8")) as Manifest;
          if (!m.runId || !m.kind) continue;
          if (since && new Date(m.startedAt) < since) continue;
          out.set(m.runId, m);
        } catch {
          /* not one of ours */
        }
      }
    }
  };
  for (const d of dirs) walk(d, 0);
  return [...out.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

const ok = (repo: string, args: string[]) => {
  try {
    git(repo, args);
    return true;
  } catch {
    return false;
  }
};
const tryGit = (repo: string, args: string[]) => {
  try {
    return git(repo, args);
  } catch {
    return "";
  }
};

/** The target branch as it is on the remote when there is one (CI clones are often detached). */
export function targetRef(repo: string, branch: string): string | undefined {
  for (const r of [`origin/${branch}`, branch]) if (ok(repo, ["rev-parse", "--verify", "--quiet", `${r}^{commit}`])) return r;
  return undefined;
}

/** Where the review refs are kept locally (GitLab MR heads, GitHub PR heads): they outlive deleted source branches. */
export const REVIEW_REFS = "refs/qa-sentinel/review";

/**
 * Fetch every MR's (or PR's) head commit from origin. GitLab keeps refs/merge-requests/<iid>/head, and GitHub
 * refs/pull/<n>/head, after the source branch is deleted, so the agent's original commit and the reviewer's later
 * commits can still be compared for squash and fast-forward merges. Best effort: no remote, no fetch.
 */
export function fetchReviewRefs(repo: string): boolean {
  if (!tryGit(repo, ["remote"]).split("\n").includes("origin")) return false;
  let any = false;
  for (const spec of [`+refs/merge-requests/*/head:${REVIEW_REFS}/mr-*`, `+refs/pull/*/head:${REVIEW_REFS}/pr-*`]) {
    try {
      execFileSync("git", ["fetch", "-q", "--no-tags", "origin", spec], { cwd: repo, stdio: "ignore", timeout: 120_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
      any = true;
    } catch {
      // the host doesn't have that kind of ref
    }
  }
  return any;
}

/**
 * The review (MR/PR) head of the agent's own MR: of the heads that contain the agent's commit, the one with the fewest
 * commits after it. A later, unrelated MR branched from the target after the fast-forward contains the agent's commit
 * too, but always with more commits after it (the target's, plus its own).
 */
function reviewHead(repo: string, shas: string[]): { head: string; agentSha: string } | undefined {
  let best: { head: string; agentSha: string; n: number } | undefined;
  for (const sha of shas) {
    for (const ref of tryGit(repo, ["for-each-ref", "--format=%(refname)", "--contains", sha, `${REVIEW_REFS}/`]).split("\n").filter(Boolean)) {
      const head = tryGit(repo, ["rev-parse", ref]).trim();
      const n = Number(tryGit(repo, ["rev-list", "--count", `${sha}..${head}`]).trim() || "0");
      if (!best || n < best.n) best = { head, agentSha: sha, n };
    }
  }
  return best && { head: best.head, agentSha: best.agentSha };
}

/** The subjects qa-sentinel gives its own commits (generate, tag). Squash and merge commits that quote them are not originals. */
const ORIGINAL_SUBJECT = /^test(\([^)]*\))?: (QA agent updates|add traceability tags)/;

/** A diff's patch-id: equal for the same change, whatever the line numbers (git patch-id --stable). */
function patchId(repo: string, from: string, to: string, files: string[]): string {
  const diff = tryGit(repo, ["diff", from, to, "--", ...files]);
  if (!diff) return "";
  try {
    return execFileSync("git", ["patch-id", "--stable"], { cwd: repo, input: diff + "\n", encoding: "utf8" }).split(" ")[0];
  } catch {
    return "";
  }
}

/**
 * qa-sentinel's commits (generate and tag) and what became of them on the target branch:
 * - merge commit: edited when the MR branch has commits after the agent's that touch its files;
 * - squash: edited when the squashed change differs from the agent's change (patch-id, ignoring line numbers);
 * - fast-forward / rebase: the agent's commit is on the main line; edited when the MR's head (fetched review ref)
 *   has commits after the agent's that touch its files. Without review refs it counts as unedited.
 * Squash merges whose branch was deleted are resolved through the review refs too; without them, "edits unknown".
 */
export function agentCommits(repo: string, target: string, since?: Date): AgentCommit[] {
  const raw = tryGit(repo, ["log", "--all", "--fixed-strings", "--grep=Generated by qa-sentinel", ...(since ? [`--since=${since.toISOString()}`] : []), "--format=%H%x1f%cI%x1f%P%x1f%B%x1e", "--", "."]); // this folder only (a monorepo may hold several test repos)
  const all = raw
    .split("\x1e")
    .map((r) => r.trim())
    .filter(Boolean)
    .map((rec) => {
      const [sha, date, parents, body] = rec.split("\x1f");
      return { sha, date, parents: parents.split(" ").filter(Boolean), body, subject: body.split("\n")[0], runId: /Run: (\S+)/.exec(body)?.[1] };
    });
  const firstParent = tryGit(repo, ["rev-list", "--first-parent", target]).split("\n").filter(Boolean);
  const onMainline = new Set(firstParent);
  const reachable = (sha: string) => ok(repo, ["merge-base", "--is-ancestor", sha, target]);

  // One entry per agent run: a rebased (fast-forward) copy on the target wins over the branch's original.
  const groups = new Map<string, typeof all>();
  for (const x of all.filter((y) => ORIGINAL_SUBJECT.test(y.subject))) {
    const k = x.runId ?? x.sha;
    groups.set(k, [...(groups.get(k) ?? []), x]);
  }
  const out: AgentCommit[] = [];
  const seenRuns = new Set<string>();
  for (const [k, xs] of groups) {
    const x = xs.find((y) => onMainline.has(y.sha)) ?? xs.find((y) => reachable(y.sha)) ?? xs[0];
    seenRuns.add(k);
    const files = tryGit(repo, ["diff-tree", "--no-commit-id", "--name-only", "-r", "--root", x.sha]).split("\n").filter(Boolean).map((f) => fromRoot(repo, f));
    let state: AgentCommit["state"];
    let mergedBy: string | undefined;
    if (onMainline.has(x.sha)) {
      // Fast-forward or rebase merge: the reviewer's commits (if any) are on the MR's head after the agent's.
      const review = reviewHead(repo, xs.map((y) => y.sha));
      const later = review && files.length ? tryGit(repo, ["rev-list", `${review.agentSha}..${review.head}`, "--", ...files]).trim() : "";
      [state, mergedBy] = [later ? "merged-edited" : "merged-unedited", x.sha];
    }
    else if (reachable(x.sha)) {
      const descendants = new Set(tryGit(repo, ["rev-list", "--ancestry-path", `${x.sha}..${target}`]).split("\n").filter(Boolean));
      mergedBy = [...firstParent].reverse().find((c) => descendants.has(c));
      const branchTip = mergedBy ? tryGit(repo, ["rev-parse", "--verify", "--quiet", `${mergedBy}^2`]) : "";
      const later = branchTip && files.length ? tryGit(repo, ["rev-list", `${x.sha}..${branchTip}`, "--", ...files]) : "";
      state = later ? "merged-edited" : "merged-unedited";
    } else {
      const squash = all.filter((y) => y.runId && y.runId === x.runId && !ORIGINAL_SUBJECT.test(y.subject) && onMainline.has(y.sha)).at(-1);
      if (squash) {
        mergedBy = squash.sha;
        const same = files.length && patchId(repo, `${squash.sha}^`, squash.sha, files) === patchId(repo, `${x.sha}^`, x.sha, files);
        state = same ? "merged-unedited" : "merged-edited";
      } else state = tryGit(repo, ["branch", "-a", "--contains", x.sha]).trim() ? "open" : "not-merged";
    }
    out.push({ sha: x.sha, runId: x.runId, date: x.date, files, state, mergedBy });
  }
  // Squash commits whose branch is gone: merged, but whether a reviewer changed the tests can't be told.
  for (const y of all) {
    if (ORIGINAL_SUBJECT.test(y.subject) || !y.runId || seenRuns.has(y.runId) || !onMainline.has(y.sha)) continue;
    seenRuns.add(y.runId);
    out.push({ sha: y.sha, runId: y.runId, date: y.date, files: [], state: "merged-unknown", mergedBy: y.sha });
  }
  return out;
}

const rate = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : null);
const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

export function computeMetrics(manifests: Manifest[], commits: AgentCommit[], since?: string): Metrics {
  const byKind: Metrics["byKind"] = {};
  for (const m of manifests) {
    const k = (byKind[m.kind] ??= { runs: 0, outcomes: {}, costUsd: 0, avgCostUsd: 0, avgDurationS: 0 });
    k.runs++;
    const o = m.outcome ?? (m.finishedAt ? "finished" : "unfinished");
    k.outcomes[o] = (k.outcomes[o] ?? 0) + 1;
    k.costUsd += m.agent?.costUsd ?? 0;
    k.avgDurationS += (m.agent?.durationMs ?? 0) / 1000;
  }
  for (const k of Object.values(byKind)) {
    k.avgCostUsd = round(k.costUsd / k.runs, 3);
    k.avgDurationS = round(k.avgDurationS / k.runs, 0);
    k.costUsd = round(k.costUsd);
  }
  // B6: cost against the size of the change, and budgets from what runs really cost (p90 with headroom).
  const BUCKETS: [string, number][] = [["< 50 lines", 50], ["50–300", 300], ["300–1000", 1000], ["> 1000", Infinity]];
  const p90 = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil(xs.length * 0.9) - 1)] : 0);
  const bySize: Metrics["bySize"] = [];
  const sized = manifests.filter((m) => m.size && m.agent?.costUsd !== undefined);
  for (const kind of [...new Set(sized.map((m) => m.kind))]) {
    let lower = 0;
    for (const [bucket, upper] of BUCKETS) {
      const xs = sized.filter((m) => m.kind === kind && m.size!.diffLines >= lower && m.size!.diffLines < upper);
      lower = upper;
      if (!xs.length) continue;
      const costs = xs.map((m) => m.agent!.costUsd!);
      bySize.push({ kind, bucket, runs: xs.length, avgCostUsd: round(costs.reduce((a, b) => a + b, 0) / xs.length, 3), p90CostUsd: round(p90(costs), 3), hitBudget: xs.filter((m) => /budget/.test(m.agent?.status ?? "") || /max-budget/.test(m.outcome ?? "")).length });
    }
  }
  const suggestedBudgets = [...new Set(sized.map((m) => m.kind))]
    .map((kind) => {
      const costs = sized.filter((m) => m.kind === kind).map((m) => m.agent!.costUsd!);
      const p = p90(costs);
      return { kind, runs: costs.length, p90CostUsd: round(p, 3), suggestedUsd: round(Math.max(0.5, Math.ceil(p * 1.5 * 4) / 4), 2) };
    })
    .filter((x) => x.runs >= 10);
  const gens = manifests.filter((m) => m.kind === "generate");
  const reached = gens.filter((m) => /^(committed|not-pushed)-/.test(m.outcome ?? ""));
  const verified = reached.filter((m) => m.verification?.status === "VERIFIED");
  const plans = manifests.filter((m) => m.plan);
  const risk: Record<string, number> = {};
  for (const m of plans) if (m.plan?.risk) risk[m.plan.risk] = (risk[m.plan.risk] ?? 0) + 1;
  const count = (s: AgentCommit["state"]) => commits.filter((c) => c.state === s).length;
  const merged = count("merged-unedited") + count("merged-edited");
  return {
    since,
    runs: manifests.length,
    byKind,
    bySize,
    suggestedBudgets,
    costUsd: round(manifests.reduce((s, m) => s + (m.agent?.costUsd ?? 0), 0)),
    generate: { reachedVerification: reached.length, verified: verified.length, verificationRate: rate(verified.length, reached.length) },
    plans: {
      total: plans.length,
      repaired: plans.filter((m) => (m.plan?.corrections ?? 0) > 0).length,
      repairRate: rate(plans.filter((m) => (m.plan?.corrections ?? 0) > 0).length, plans.length),
      invalid: plans.filter((m) => m.plan?.status === "invalid").length,
      risk,
    },
    guardrails: {
      runsWithViolations: manifests.filter((m) => (m.guardrails?.violations ?? 0) > 0).length,
      deniedToolCalls: manifests.reduce((s, m) => s + (m.agent?.deniedToolCalls ?? 0), 0),
    },
    mergeRequests: {
      total: commits.length,
      mergedUnedited: count("merged-unedited"),
      mergedEdited: count("merged-edited"),
      mergedUnknown: count("merged-unknown"),
      open: count("open"),
      notMerged: count("not-merged"),
      mergedWithoutEditsRate: rate(count("merged-unedited"), merged),
    },
    byMonth: [...new Set(commits.filter((c) => c.state === "merged-unedited" || c.state === "merged-edited").map((c) => c.date.slice(0, 7)))]
      .sort()
      .map((month) => {
        const inMonth = commits.filter((c) => c.date.slice(0, 7) === month && (c.state === "merged-unedited" || c.state === "merged-edited"));
        const unedited = inMonth.filter((c) => c.state === "merged-unedited").length;
        return { month, merged: inMonth.length, unedited, rate: rate(unedited, inMonth.length) };
      }),
  };
}

const pct = (n: number | null) => (n === null ? "–" : `${n}%`);

export function metricsMarkdown(m: Metrics): string {
  const lines = [
    `# qa-sentinel metrics${m.since ? ` · since ${m.since}` : ""}`,
    "",
    "| Measure | Value |",
    "| --- | --- |",
    `| Runs | ${m.runs} |`,
    `| Agent cost | $${m.costUsd.toFixed(2)} |`,
    `| Generated changes verified (tests pass against the environment) | ${pct(m.generate.verificationRate)} (${m.generate.verified}/${m.generate.reachedVerification}) |`,
    `| Test changes merged without human edits | ${pct(m.mergeRequests.mergedWithoutEditsRate)} (${m.mergeRequests.mergedUnedited}/${m.mergeRequests.mergedUnedited + m.mergeRequests.mergedEdited}) |`,
    ...(m.mergeRequests.mergedUnknown ? [`| Merged by squash, branch deleted (edits unknown) | ${m.mergeRequests.mergedUnknown} |`] : []),
    `| Agent branches still open / never merged | ${m.mergeRequests.open} / ${m.mergeRequests.notMerged} |`,
    `| Plans needing a repair round | ${pct(m.plans.repairRate)} (${m.plans.repaired}/${m.plans.total}); invalid after repair: ${m.plans.invalid} |`,
    `| Runs stopped by guardrails · denied tool calls | ${m.guardrails.runsWithViolations} · ${m.guardrails.deniedToolCalls} |`,
  ];
  if (Object.keys(m.plans.risk).length)
    lines.push(`| Risk of analysed changes | ${["critical", "high", "medium", "low"].filter((r) => m.plans.risk[r]).map((r) => `${r} ${m.plans.risk[r]}`).join(", ")} |`);
  if (m.byMonth.length > 1) {
    lines.push("", "## Merged without edits, by month", "", "| Month | Merged | Without edits |", "| --- | --- | --- |");
    for (const x of m.byMonth) lines.push(`| ${x.month} | ${x.merged} | ${pct(x.rate)} (${x.unedited}) |`);
    lines.push("", "_A rising rate means reviews are getting lighter; `qa-sentinel lessons` turns reviewer edits into rules the agents follow._");
  }
  if (Object.keys(m.byKind).length) {
    lines.push("", "## By command", "", "| Command | Runs | Avg cost | Avg agent time | Outcomes |", "| --- | --- | --- | --- | --- |");
    for (const [k, v] of Object.entries(m.byKind))
      lines.push(`| ${k} | ${v.runs} | $${v.avgCostUsd.toFixed(3)} | ${v.avgDurationS}s | ${Object.entries(v.outcomes).sort((a, b) => b[1] - a[1]).map(([o, n]) => `${o} ${n}`).join(", ")} |`);
  }
  if (m.bySize.length) {
    lines.push("", "## Cost by size of the change", "", "| Command | Change size | Runs | Avg cost | p90 cost | Stopped at the budget |", "| --- | --- | --- | --- | --- | --- |");
    for (const x of m.bySize) lines.push(`| ${x.kind} | ${x.bucket} | ${x.runs} | $${x.avgCostUsd.toFixed(3)} | $${x.p90CostUsd.toFixed(3)} | ${x.hitBudget} |`);
    if (m.suggestedBudgets.length)
      lines.push("", `**Budgets these runs suggest** (p90 × 1.5): ${m.suggestedBudgets.map((b) => `${b.kind} $${b.suggestedUsd.toFixed(2)} (${b.runs} runs)`).join(", ")}. Set them in \`agent.maxBudgetUsd\` (gapReport, generate, …).`);
    else lines.push("", "_Budget suggestions appear once a command has 10 runs with sizes recorded._");
  }
  lines.push(
    "",
    "_Merged without edits: no reviewer commits on the agent's files before the merge (merge commits), or the squashed change equals the agent's (squash). Fast-forward merges and squash merges with deleted branches are judged from the merge requests' heads (fetched from origin); without them, fast-forward counts as unedited. Runs come from manifests in the folders read; in CI, download the job artifacts into one folder and pass it with `--runs`._",
  );
  return lines.join("\n") + "\n";
}

/** "30d", "12w" or an ISO date. */
export function parseSince(s?: string): Date | undefined {
  if (!s) return undefined;
  const m = /^(\d+)([dw])$/.exec(s.trim());
  if (m) return new Date(Date.now() - Number(m[1]) * (m[2] === "w" ? 7 : 1) * 86_400_000);
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new Error(`--since: use 30d, 12w or a date (got "${s}")`);
  return d;
}

export async function metricsCommand(o: { cwd: string; runs?: string[]; since?: string; out?: string; json?: boolean; fetch?: boolean }): Promise<number> {
  const c = loadConfig(o.cwd);
  if (o.fetch !== false && fetchReviewRefs(o.cwd)) log.dim("fetched merge request heads (for fast-forward and squash merges)");
  const since = parseSince(o.since);
  const dirs = [path.join(o.cwd, ".qa-sentinel/runs"), ...(o.runs ?? []).map((d) => path.resolve(o.cwd, d))];
  const manifests = collectManifests(dirs, since);
  const target = targetRef(o.cwd, c.ci.targetBranch);
  if (!target) log.warn(`target branch ${c.ci.targetBranch} not found; merge statistics are skipped (fetch it first)`);
  const commits = target ? agentCommits(o.cwd, target, since) : [];
  const m = computeMetrics(manifests, commits, o.since);
  if (o.json) {
    process.stdout.write(JSON.stringify(m, null, 2) + "\n");
    return 0;
  }
  const md = metricsMarkdown(m);
  const out = path.resolve(o.cwd, o.out ?? "qa-metrics.md");
  fs.writeFileSync(out, md);
  process.stdout.write(md);
  log.ok(`wrote ${path.relative(o.cwd, out)} (${manifests.length} run(s), ${commits.length} agent commit(s))`);
  return 0;
}
