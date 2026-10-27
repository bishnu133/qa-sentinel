#!/usr/bin/env node
// Put the demo back to its starting state, so you can run it again.   COSTS NO AI.  WRITES TO JIRA AND GITLAB (with --yes).
//
//   node demo/scripts/reset.mjs --tests-dir ~/work/shoplite-tests                # DRY RUN (default): prints exactly what it would do
//   node demo/scripts/reset.mjs --tests-dir … --yes --i-know-this-is-a-test-project   # does it
//
// What it touches (and nothing else):
//   GitLab, only the projects listed in demo/.demo-state.json:
//     - closes the demo merge requests it opened, and the open ones from branches named qa-sentinel/*
//     - reverts (new commits, no history rewriting) the demo merges on the default and release branches
//     - deletes the demo branches it made and the branches named qa-sentinel/*
//     - deletes merge request comments that carry the "qa-sentinel:" marker AND were written by the token's user
//   Jira, only the cards listed in the state file:
//     - deletes comments that carry the marker AND were written by the login's user
//     - removes qa-sentinel's issue properties (qa-sentinel.record, .showcase, .bugs) and the showcase attachments they list
//     - moves each card back to the status it had after seeding
//   Your test repo folder (--tests-dir): removes .qa-sentinel/, qa-stories.md and the other generated files, then runs `qa-sentinel doctor`
// Safe to run again: it looks at what is there now, and does nothing when there is nothing left to do.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_CONFIG, DEFAULT_STATE, HERE, JIRA_PROPERTIES, MARKER, DemoError, enc, fail, isMain, loadConfig, loadState, makeGitLab, makeJira, runCli, saveState, say, sameUser } from "./lib.mjs";

/** Files qa-sentinel writes in the test repo folder. They can hold Jira text, so they are removed. */
export const LOCAL_PATHS = [".qa-sentinel", "qa-stories.md", "qa-post-deploy.md", "qa-sentinel-summary.md", "qa-gap-report.md", "qa-story-review.md", "qa-story-check.md", "qa-showcase.md", "qa-showcase", "qa-metrics.md", "qa-lessons.md", "qa-suite.md", "qa-suite.txt", "qa-verify.md", "qa-regression.txt"];

export const CANNOT_UNDO = [
  "Jira keeps its history: the \"history\" tab still shows the comments, status changes and property changes (deleted comments are gone from the page, not from the audit log).",
  "AI money that was spent is spent. Reset costs nothing, but it cannot give back the cost of the gap reports and generation runs.",
  "Jira notifications and e-mails already sent (watchers, mentions) stay sent.",
  "GitLab pipelines and their logs and artifacts stay (they expire on their own). Closed merge requests stay as closed (add --delete-mrs to try to delete them; GitLab only allows that for owners/admins).",
  "Bug cards that qa-sentinel created itself are not deleted unless you add --delete-bugs.",
  "A merge commit that GitLab cannot revert through the API is reported as MANUAL. The fallback is on the screen and in demo/README.md.",
];

/** Read what is there now and list what has to change. Nothing is written here. */
export async function planReset({ args = {}, env = process.env, configFile = DEFAULT_CONFIG, stateFile = DEFAULT_STATE, log = say }) {
  const state = loadState(stateFile);
  const hasGitlab = Boolean(state.gitlab?.projects?.length);
  const hasJira = Object.keys(state.cards ?? {}).length > 0;
  if (!hasGitlab && !hasJira) fail(`${stateFile} lists no projects and no cards. There is nothing to reset.`);
  let config;
  try {
    config = loadConfig(configFile);
  } catch {
    config = undefined; // the state file is enough to find everything
  }
  if (hasJira && !env.DEMO_JIRA_PROJECT) fail("Set DEMO_JIRA_PROJECT to the key of your Jira TEST project.");
  if (hasJira && env.DEMO_JIRA_PROJECT !== state.jira?.project) fail(`DEMO_JIRA_PROJECT is "${env.DEMO_JIRA_PROJECT}" but the state file is for project "${state.jira?.project}". Nothing was changed.`);
  const flag = args["i-know-this-is-a-test-project"];
  if (args.yes && !flag) fail("Refusing to change anything without --i-know-this-is-a-test-project (this is a clean-up of a TEST Jira project and test GitLab projects).");
  if (typeof flag === "string" && state.jira?.project && flag !== state.jira.project) fail(`--i-know-this-is-a-test-project ${flag} does not match the project ${state.jira.project}. Nothing was changed.`);

  const actions = [];
  const notes = [];
  const add = (area, text, run) => actions.push({ area, text, run });
  const skipped = [];

  // ---------------------------------------------------------------- GitLab
  let gl;
  if (hasGitlab) {
    gl = makeGitLab(state.gitlab.url, env);
    if (config && new URL(config.gitlabUrl).origin !== new URL(gl.url).origin) fail("demo.config.json and the state file point to different GitLab servers. Nothing was changed.");
    const me = await gl.api("GET", "/user");
    const branches = [state.gitlab.defaultBranch, state.gitlab.releaseBranch].filter(Boolean);
    for (const project of state.gitlab.projects) {
      const P = `/projects/${enc(project)}`;
      // 1. merge requests to close
      const open = await gl.getAll(`${P}/merge_requests?state=opened`);
      const recorded = new Set(state.mrs.filter((m) => m.project === project).map((m) => m.iid));
      const toClose = open.filter((m) => recorded.has(m.iid) || String(m.source_branch).startsWith("qa-sentinel/") || state.branches.some((b) => b.project === project && b.branch === m.source_branch));
      for (const m of toClose) add("gitlab", `${project}: close merge request !${m.iid} "${m.title}" (${m.source_branch})`, () => gl.api("PUT", `${P}/merge_requests/${m.iid}`, { state_event: "close" }));
      // 2. comments to delete: marker + written by me, on every merge request we know of (recorded ones, and the ones we close)
      const mrIids = new Set([...recorded, ...toClose.map((m) => m.iid)]);
      for (const iid of mrIids) {
        const notes_ = await gl.getAll(`${P}/merge_requests/${iid}/notes?sort=asc`).catch((e) => (e.status === 404 ? [] : Promise.reject(e)));
        for (const n of notes_) {
          if (n.system || typeof n.body !== "string" || !n.body.includes(MARKER)) continue;
          if (n.author?.id !== me.id) {
            skipped.push(`${project} !${iid}: a comment with the marker was written by "${n.author?.username}", not by the token user "${me.username}": left alone`);
            continue;
          }
          add("gitlab", `${project}: delete comment ${n.id} on !${iid} (qa-sentinel marker, written by ${me.username})`, () => gl.api("DELETE", `${P}/merge_requests/${iid}/notes/${n.id}`));
        }
      }
      if (args["delete-mrs"]) for (const iid of recorded) add("gitlab", `${project}: try to delete merge request !${iid}`, () => gl.api("DELETE", `${P}/merge_requests/${iid}`));

      // 3. reverts: the demo merges on the default and release branches
      const planned = [];
      for (const branch of branches) {
        if (project !== state.gitlab.testsProject && branch === state.gitlab.releaseBranch && !state.merges.some((m) => m.project === project && m.branch === branch)) continue;
        const exists = await gl.api("GET", `${P}/repository/branches/${enc(branch)}`).then(() => true, (e) => (e.status === 404 ? false : Promise.reject(e)));
        if (!exists) continue;
        const same = await gl.api("GET", `${P}/repository/compare?from=demo-baseline&to=${enc(branch)}&straight=true`).then((c) => (c.diffs ?? []).length === 0, () => undefined);
        if (same === true) continue; // the files already equal the baseline: nothing to revert
        const log_ = await gl.api("GET", `${P}/repository/commits?ref_name=${enc(branch)}&per_page=100`);
        const have = (sha) => log_.some((c) => String(c.message ?? c.title ?? "").includes(sha));
        const shas = state.merges.filter((m) => m.project === project && m.branch === branch).map((m) => m.sha);
        // merged qa-sentinel/* merge requests (the test merge request the demo's owner merged by hand) count too
        if (project === state.gitlab.testsProject) {
          const merged = await gl.getAll(`${P}/merge_requests?state=merged&target_branch=${enc(branch)}&updated_after=${enc(state.gitlab.setupAt ?? "1970-01-01T00:00:00Z")}`);
          for (const m of merged.filter((x) => String(x.source_branch).startsWith("qa-sentinel/")).sort((a, b) => String(a.merged_at).localeCompare(String(b.merged_at)))) {
            const sha = m.merge_commit_sha ?? m.squash_commit_sha;
            if (sha && !shas.includes(sha)) shas.push(sha);
          }
        }
        for (const sha of [...shas].reverse()) {
          if (have(sha)) continue; // a revert commit already names it
          planned.push({ branch, sha });
        }
        if (same === false && !shas.length) notes.push(`${project}: ${branch} differs from demo-baseline but no demo merge is recorded for it. Left alone. Compare in GitLab: ${gl.url}/${project}/-/compare/demo-baseline...${branch}`);
      }
      for (const r of planned) {
        add("gitlab", `${project}: revert ${r.sha.slice(0, 8)} on ${r.branch} (a new commit; history is not rewritten)`, async () => {
          try {
            await gl.api("POST", `${P}/repository/commits/${r.sha}/revert`, { branch: r.branch });
          } catch (e) {
            throw new DemoError(`MANUAL: GitLab would not revert ${r.sha.slice(0, 8)} on ${project}/${r.branch} (${e.message}). Do it by hand: git revert ${r.sha} (add -m 1 for a merge commit), or put the branch back to the tag: git push --force-with-lease origin demo-baseline:${r.branch} (needs force-push allowed on that branch).`);
          }
        });
      }
      // 4. branches
      const names = new Set(state.branches.filter((b) => b.project === project).map((b) => b.branch));
      const found = await gl.getAll(`${P}/repository/branches?search=${enc("^qa-sentinel/")}`).catch(() => []);
      for (const b of found) if (String(b.name).startsWith("qa-sentinel/")) names.add(b.name);
      for (const name of names) {
        if (branches.includes(name)) continue;
        const b = await gl.api("GET", `${P}/repository/branches/${enc(name)}`).catch((e) => (e.status === 404 ? undefined : Promise.reject(e)));
        if (!b) continue;
        if (b.protected) {
          skipped.push(`${project}: branch ${name} is protected: left alone`);
          continue;
        }
        add("gitlab", `${project}: delete branch ${name}`, () => gl.api("DELETE", `${P}/repository/branches/${enc(name)}`));
      }
    }
  }

  // ---------------------------------------------------------------- Jira
  if (hasJira) {
    const jira = makeJira(state.jira.baseUrl, config?.jira?.auth ?? "auto", env);
    if (config?.jira?.baseUrl && new URL(config.jira.baseUrl).origin !== new URL(state.jira.baseUrl).origin) fail("demo.config.json and the state file point to different Jira sites. Nothing was changed.");
    let me;
    try {
      me = await jira.me();
    } catch (e) {
      notes.push(`Jira comments are NOT touched: ${e.message}`);
    }
    for (const [id, card] of Object.entries(state.cards)) {
      const key = card.key;
      const issue = await jira.api("GET", `/rest/api/2/issue/${encodeURIComponent(key)}?fields=status,labels`).catch((e) => (e.status === 404 ? undefined : Promise.reject(e)));
      if (!issue) {
        notes.push(`${key} (${id}) no longer exists in Jira: skipped`);
        continue;
      }
      if (me) {
        const comments = [];
        for (let startAt = 0; ; ) {
          const page = await jira.api("GET", `/rest/api/2/issue/${encodeURIComponent(key)}/comment?startAt=${startAt}&maxResults=100`);
          const cs = page.comments ?? [];
          comments.push(...cs);
          startAt += cs.length;
          if (!cs.length || startAt >= (page.total ?? 0)) break;
        }
        for (const c of comments) {
          if (typeof c.body !== "string" || !c.body.includes(MARKER)) continue;
          if (!sameUser(c.author, me)) {
            skipped.push(`${key}: a comment with the marker was written by "${c.author?.displayName ?? "someone else"}", not by the login: left alone`);
            continue;
          }
          add("jira", `${key}: delete comment ${c.id} (qa-sentinel marker, written by the login)`, () => jira.api("DELETE", `/rest/api/2/issue/${encodeURIComponent(key)}/comment/${c.id}`));
        }
      }
      const bugRefs = new Map((state.raisedBugs ?? []).filter((b) => b.story === key).map((b) => [b.key, b.item]));
      for (const prop of JIRA_PROPERTIES) {
        const p = await jira.api("GET", `/rest/api/2/issue/${encodeURIComponent(key)}/properties/${encodeURIComponent(prop)}`).catch((e) => (e.status === 404 ? undefined : Promise.reject(e)));
        if (!p) continue;
        if (prop === "qa-sentinel.showcase") for (const a of p.value?.attachments ?? []) add("jira", `${key}: delete attachment ${a.filename} (listed in the showcase record)`, () => jira.api("DELETE", `/rest/api/2/attachment/${encodeURIComponent(a.id)}`).catch((e) => (e.status === 404 ? undefined : Promise.reject(e))));
        if (prop === "qa-sentinel.bugs") for (const [item, b] of Object.entries(p.value ?? {})) if (b?.key) bugRefs.set(b.key, item);
        add("jira", `${key}: remove issue property ${prop}`, () => jira.api("DELETE", `/rest/api/2/issue/${encodeURIComponent(key)}/properties/${encodeURIComponent(prop)}`));
      }
      // Bug cards that qa-sentinel raised from this story. They stay unless --delete-bugs; their keys are remembered in the state file.
      for (const [bugKey, item] of bugRefs) {
        if (!args["delete-bugs"]) {
          notes.push(`${key}: qa-sentinel raised bug ${bugKey} (${item}). It stays in Jira; add --delete-bugs to delete it (only if it has the qa-sentinel label and the login created it).`);
          if (!(state.raisedBugs ?? []).some((b) => b.key === bugKey)) add("local", `remember the bug ${bugKey} in the state file (so --delete-bugs can find it later)`, () => void (state.raisedBugs = [...(state.raisedBugs ?? []), { story: key, key: bugKey, item }]));
          continue;
        }
        const bug = await jira.api("GET", `/rest/api/2/issue/${encodeURIComponent(bugKey)}?fields=labels,reporter`).catch((e) => (e.status === 404 ? undefined : Promise.reject(e)));
        if (!bug) {
          add("local", `forget the bug ${bugKey} (it no longer exists)`, () => void (state.raisedBugs = (state.raisedBugs ?? []).filter((b) => b.key !== bugKey)));
          continue;
        }
        if (!(bug.fields?.labels ?? []).includes("qa-sentinel") || !me || !sameUser(bug.fields?.reporter, me)) {
          skipped.push(`${bugKey}: not deleted (no qa-sentinel label, or not created by the login)`);
          continue;
        }
        add("jira", `${key}: delete the bug ${bugKey} that qa-sentinel raised`, async () => {
          await jira.api("DELETE", `/rest/api/2/issue/${encodeURIComponent(bugKey)}`);
          state.raisedBugs = (state.raisedBugs ?? []).filter((b) => b.key !== bugKey);
        });
      }
      const now = issue.fields?.status?.name;
      if (card.startStatus && now && now.toLowerCase() !== String(card.startStatus).toLowerCase()) {
        const { transitions = [] } = await jira.api("GET", `/rest/api/2/issue/${encodeURIComponent(key)}/transitions`);
        const t = transitions.find((x) => x.to?.name?.toLowerCase() === String(card.startStatus).toLowerCase());
        if (t) add("jira", `${key}: move from "${now}" back to "${card.startStatus}"`, () => jira.api("POST", `/rest/api/2/issue/${encodeURIComponent(key)}/transitions`, { transition: { id: t.id } }));
        else notes.push(`${key}: is "${now}" and should be "${card.startStatus}", but Jira has no direct move. Do it by hand in Jira.`);
      }
    }
  }

  // ---------------------------------------------------------------- local files
  const testsDir = typeof args["tests-dir"] === "string" ? path.resolve(args["tests-dir"]) : undefined;
  if (testsDir) {
    if (!fs.existsSync(path.join(testsDir, "qa-sentinel.config.yaml"))) fail(`--tests-dir ${testsDir} has no qa-sentinel.config.yaml. It must be the folder of the demo test repo.`);
    for (const rel of LOCAL_PATHS) {
      const p = path.join(testsDir, rel);
      if (fs.existsSync(p)) add("local", `remove ${p}`, () => fs.rmSync(p, { recursive: true, force: true }));
    }
    if (!args["skip-doctor"]) add("local", `run \`qa-sentinel doctor\` in ${testsDir}`, () => runDoctor(testsDir, env));
  } else notes.push("No --tests-dir given: local files (.qa-sentinel/, qa-stories.md) and `doctor` are skipped.");

  // ---------------------------------------------------------------- the end: is GitLab back at the baseline?
  const verify = async () => {
    const out = [];
    if (!gl) return out;
    for (const project of state.gitlab.projects) {
      for (const branch of [state.gitlab.defaultBranch, state.gitlab.releaseBranch]) {
        const P = `/projects/${enc(project)}`;
        const exists = await gl.api("GET", `${P}/repository/branches/${enc(branch)}`).then(() => true, () => false);
        if (!exists) continue;
        const c = await gl.api("GET", `${P}/repository/compare?from=demo-baseline&to=${enc(branch)}&straight=true`).catch(() => undefined);
        if (c) out.push(`${project} ${branch}: ${(c.diffs ?? []).length === 0 ? "same files as demo-baseline" : `STILL DIFFERENT from demo-baseline in ${(c.diffs ?? []).map((d) => d.new_path).join(", ")}`}`);
      }
    }
    return out;
  };
  return { actions, notes, skipped, state, verify, testsDir };
}

function runDoctor(dir, env) {
  const local = path.resolve(HERE, "../../dist/cli.js");
  const bin = env.QA_SENTINEL_BIN ? env.QA_SENTINEL_BIN.split(" ") : fs.existsSync(local) ? ["node", local] : ["qa-sentinel"];
  try {
    const out = execFileSync(bin[0], [...bin.slice(1), "doctor"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env });
    say(out.split("\n").map((l) => `    ${l}`).join("\n"));
  } catch (e) {
    throw new DemoError(`doctor reported a problem (exit ${e.status}):\n${String(e.stdout ?? "").split("\n").map((l) => `    ${l}`).join("\n")}`);
  }
}

export async function reset(opts = {}) {
  const { args = {}, stateFile = DEFAULT_STATE, log = say } = opts;
  const plan = await planReset(opts);
  const writing = Boolean(args.yes);
  log(writing ? "RESET (WRITING)\n" : "RESET: DRY RUN. Nothing is changed. Add --yes --i-know-this-is-a-test-project to do it.\n");
  if (!plan.actions.length) log("Nothing to do: everything is already back at the start.");
  plan.actions.forEach((a, i) => log(`  ${String(i + 1).padStart(2)}. [${a.area}] ${a.text}`));
  for (const s of plan.skipped) log(`  skip: ${s}`);
  for (const n of plan.notes) log(`  note: ${n}`);
  let failures = 0;
  const failedAreas = new Set();
  if (writing) {
    log("");
    for (const [i, a] of plan.actions.entries()) {
      try {
        await a.run();
        log(`  ${String(i + 1).padStart(2)}. ok`);
      } catch (e) {
        failures++;
        failedAreas.add(a.area);
        log(`  ${String(i + 1).padStart(2)}. FAILED: ${e.message}`);
      }
    }
    for (const l of await plan.verify()) log(`  check: ${l}`);
    saveState(stateFile, plan.state); // bug keys that were remembered or forgotten
    if (!failures) {
      // The demo's own records are cleaned only when everything worked, so a second run can finish the job.
      plan.state.mrs = [];
      plan.state.merges = [];
      plan.state.branches = [];
      saveState(stateFile, plan.state);
      log("\nReset finished. demo/.demo-state.json keeps the projects and cards, so you can run the demo again.");
    } else log(`\nReset finished with ${failures} problem(s). Fix them (or do the MANUAL steps), then run reset again: it is safe to repeat.`);
  }
  log("\nWhat reset cannot undo:");
  for (const c of CANNOT_UNDO) log(`  - ${c}`);
  return failures ? 1 : 0;
}

if (isMain(import.meta.url)) await runCli((args) => reset({ args }));
