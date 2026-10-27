#!/usr/bin/env node
// Put the demo back to its starting state, so you can run it again.   COSTS NO AI.  WRITES TO JIRA AND GITLAB (with --yes).
//
//   node demo/scripts/reset.mjs --tests-dir ~/work/shoplite-tests                # DRY RUN (default): prints exactly what it would do
//   node demo/scripts/reset.mjs --tests-dir … --yes --i-know-this-is-a-test-project <KEY>   # does it
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
import { DEFAULT_CONFIG, DEFAULT_STATE, HERE, JIRA_PROPERTIES, KEY_RE, MARKER, DemoError, demoCardProblem, enc, fail, isMain, loadCards, loadConfig, loadState, makeGitLab, makeJira, needTestFlag, runCli, sameUser, saveState, say, wantsWrite } from "./lib.mjs";

/** Files qa-sentinel writes in the test repo folder. They can hold Jira text, so they are removed. A name ending in * matches the start of a name. */
export const LOCAL_PATHS = [".qa-sentinel", ".qa-data", "qa-stories.md", "qa-post-deploy.md", "qa-sentinel-summary.md", "qa-gap-report.md", "qa-story-review.md", "qa-story-check.md", "qa-showcase.md", "qa-showcase", "qa-metrics.md", "qa-lessons.md", "qa-suite.md", "qa-suite.txt", "qa-verify.md", "qa-regression.txt", "qa-feature-*", "qa-coverage.md", "qa-coverage.json", "qa-healed.md", "qa-healed.json", "qa-contract-check.md", "qa-data-sweep.md"];

function localMatches(dir) {
  const names = fs.readdirSync(dir);
  const out = [];
  for (const pat of LOCAL_PATHS) {
    if (pat.endsWith("*")) out.push(...names.filter((n) => n.startsWith(pat.slice(0, -1))));
    else if (names.includes(pat)) out.push(pat);
  }
  return [...new Set(out)];
}

export const CANNOT_UNDO = [
  "Jira keeps its history: the History tab still shows the comments, status changes and property changes (deleted comments are gone from the page, not from the audit log). A card moved back from Done may keep its Resolution field set.",
  "AI money that was spent is spent. Reset costs nothing, but it cannot give back the cost of the gap reports and generation runs.",
  "Jira notifications and e-mails already sent (watchers, mentions) stay sent.",
  "GitLab pipelines and their logs and artifacts stay (they expire on their own). Closed merge requests stay as closed (--delete-mrs tries to delete them; GitLab only allows that for owners/admins).",
  "Each revert is a push to the default branch, so GitLab starts a pipeline for it (the trigger job may start a test-repo pipeline that stops before any AI call). Wait until the runners are idle before the next demo, or add --cancel-pipelines. The Revert API cannot add [ci skip].",
  "The CI runner cache of the test repo (key qa-sentinel-records) is NOT cleared by reset. In the test repo: Build > Pipelines > Clear runner caches. Otherwise old story records, job keys and spend counts come back in the next run.",
  "Bug cards that qa-sentinel created itself are not deleted unless you add --delete-bugs.",
  "A merge commit that GitLab cannot revert through the API is reported as MANUAL. The fallback is on the screen and in demo/README.md.",
];

const seg = (v) => encodeURIComponent(String(v));

/** Read what is there now and list what has to change. Nothing is written here. */
export async function planReset({ args = {}, env = process.env, configFile = DEFAULT_CONFIG, stateFile = DEFAULT_STATE, cardsFile, log = say }) {
  const state = loadState(stateFile);
  const hasGitlab = Boolean(state.gitlab?.projects?.length);
  const hasJira = Object.keys(state.cards ?? {}).length > 0;
  if (!hasGitlab && !hasJira) fail(`${stateFile} lists no projects and no cards. There is nothing to reset.`);
  const config = loadConfig(configFile); // required: the state file alone is not trusted
  const writing = wantsWrite(args);
  const testKey = state.jira?.project ?? config.jira?.project;
  if (hasJira && !env.DEMO_JIRA_PROJECT) fail("Set DEMO_JIRA_PROJECT to the key of your Jira TEST project.");
  if (hasJira && (env.DEMO_JIRA_PROJECT !== state.jira?.project || env.DEMO_JIRA_PROJECT !== config.jira?.project)) fail(`DEMO_JIRA_PROJECT is "${env.DEMO_JIRA_PROJECT}", the state file is for "${state.jira?.project}" and demo.config.json for "${config.jira?.project}". They must all be the same. Nothing was changed.`);
  if (writing) needTestFlag(args, testKey, "change anything (this is a clean-up of a TEST Jira project and test GitLab projects)");
  else if (args["i-know-this-is-a-test-project"] !== undefined && args["i-know-this-is-a-test-project"] !== testKey) fail(`--i-know-this-is-a-test-project ${args["i-know-this-is-a-test-project"]} does not match the project ${testKey}. Nothing was changed.`);

  const actions = [];
  const notes = [];
  const skipped = [];
  const add = (area, text, run, project) => actions.push({ area, text, run, project });

  // ---------------------------------------------------------------- GitLab
  let gl;
  if (hasGitlab) {
    gl = makeGitLab(state.gitlab.url, env);
    if (new URL(config.gitlabUrl).origin !== new URL(gl.url).origin) fail("demo.config.json and the state file point to different GitLab servers. Nothing was changed.");
    // Only projects the config names, and only when the tag demo-baseline is still the commit that setup recorded.
    const known = new Set([config.testsProject, ...config.services.map((x) => x.project)]);
    if (state.gitlab.testsProject !== config.testsProject) fail(`The state file's test repo (${state.gitlab.testsProject}) is not the one in demo.config.json (${config.testsProject}). Nothing was changed.`);
    for (const project of state.gitlab.projects) {
      if (!known.has(project)) fail(`Refusing: ${project} is in the state file but not in demo.config.json. Nothing was changed.`);
      const want = state.gitlab.baselines?.[project];
      if (!want) fail(`Refusing: the state file has no baseline commit for ${project}. Nothing was changed.`);
      const tag = await gl.api("GET", `/projects/${enc(project)}/repository/tags/demo-baseline`).catch((e) => (e.status === 404 ? undefined : Promise.reject(e)));
      if (!tag) fail(`Refusing: ${project} has no tag demo-baseline. It is not a project made by setup-gitlab.mjs. Nothing was changed.`);
      if (!String(tag.commit?.id ?? "").startsWith(want)) fail(`Refusing: the tag demo-baseline in ${project} points to ${String(tag.commit?.id).slice(0, 8)}, but setup recorded ${want.slice(0, 8)}. This is not the project that was set up. Nothing was changed.`);
    }
    const me = await gl.api("GET", "/user");
    const branches = [state.gitlab.defaultBranch, state.gitlab.releaseBranch].filter(Boolean);
    for (const project of state.gitlab.projects) {
      const P = `/projects/${enc(project)}`;
      // 1. merge requests to close
      const open = await gl.getAll(`${P}/merge_requests?state=opened`);
      const recorded = new Set(state.mrs.filter((m) => m.project === project).map((m) => m.iid));
      const toClose = open.filter((m) => recorded.has(m.iid) || String(m.source_branch).startsWith("qa-sentinel/") || state.branches.some((b) => b.project === project && b.branch === m.source_branch));
      for (const m of toClose) add("gitlab", `${project}: close merge request !${m.iid} "${m.title}" (${m.source_branch})`, () => gl.api("PUT", `${P}/merge_requests/${seg(m.iid)}`, { state_event: "close" }), project);
      // 2. comments to delete: marker + written by me
      const mrIids = new Set([...recorded, ...toClose.map((m) => m.iid)]);
      for (const iid of mrIids) {
        const notes_ = await gl.getAll(`${P}/merge_requests/${seg(iid)}/notes?sort=asc`).catch((e) => (e.status === 404 ? [] : Promise.reject(e)));
        for (const n of notes_) {
          if (n.system || typeof n.body !== "string" || !n.body.includes(MARKER)) continue;
          if (n.author?.id !== me.id) {
            skipped.push(`${project} !${iid}: a comment with the marker was written by "${n.author?.username}", not by the token user "${me.username}": left alone`);
            continue;
          }
          add("gitlab", `${project}: delete comment ${n.id} on !${iid} (qa-sentinel marker, written by ${me.username})`, () => gl.api("DELETE", `${P}/merge_requests/${seg(iid)}/notes/${seg(n.id)}`), project);
        }
      }
      if (args["delete-mrs"]) for (const iid of recorded) add("gitlab", `${project}: try to delete merge request !${iid}`, () => gl.api("DELETE", `${P}/merge_requests/${seg(iid)}`), project);

      // 3. reverts: every demo merge on the default and release branches, newest first
      const planned = [];
      for (const branch of branches) {
        const exists = await gl.api("GET", `${P}/repository/branches/${enc(branch)}`).then(() => true, (e) => (e.status === 404 ? false : Promise.reject(e)));
        if (!exists) continue;
        const same = await gl.api("GET", `${P}/repository/compare?from=demo-baseline&to=${enc(branch)}&straight=true`).then((c) => (c.diffs ?? []).length === 0, () => undefined);
        if (same === true) continue; // the files already equal the baseline: nothing to revert
        const log_ = await gl.getAll(`${P}/repository/commits?ref_name=${enc(branch)}`, 10);
        const have = (sha) => log_.some((c) => String(c.message ?? c.title ?? "").includes(sha));
        const pos = (sha) => log_.findIndex((c) => String(c.id).startsWith(sha));
        const shas = new Set(state.merges.filter((m) => m.project === project && m.branch === branch).map((m) => m.sha));
        // A merge done with GitLab's own Merge button is not in state.merges: ask GitLab about every merge request we know.
        for (const m of state.mrs.filter((x) => x.project === project && x.target === branch)) {
          const live = await gl.api("GET", `${P}/merge_requests/${seg(m.iid)}`).catch((e) => (e.status === 404 ? undefined : Promise.reject(e)));
          const sha = live?.state === "merged" ? (live.merge_commit_sha ?? live.squash_commit_sha) : undefined;
          if (sha) shas.add(sha);
        }
        // merged qa-sentinel/* merge requests (a test merge request someone merged by hand) count too
        if (project === state.gitlab.testsProject) {
          const merged = await gl.getAll(`${P}/merge_requests?state=merged&target_branch=${enc(branch)}&updated_after=${enc(state.gitlab.setupAt ?? "1970-01-01T00:00:00Z")}`);
          for (const m of merged.filter((x) => String(x.source_branch).startsWith("qa-sentinel/"))) {
            const sha = m.merge_commit_sha ?? m.squash_commit_sha;
            if (sha) shas.add(sha);
          }
        }
        const found = [];
        for (const sha of shas) {
          if (have(sha)) continue; // a revert commit already names it
          if (pos(sha) < 0) {
            notes.push(`${project}: commit ${sha.slice(0, 8)} is not on ${branch} (or older than the last 1000 commits): not reverted`);
            continue;
          }
          found.push({ branch, sha, at: pos(sha) });
        }
        planned.push(...found.sort((a, b) => a.at - b.at));
        if (same === false && !shas.size) notes.push(`${project}: ${branch} differs from demo-baseline but no demo merge is recorded for it. Left alone. Compare in GitLab: ${gl.url}/${project}/-/compare/demo-baseline...${branch}`);
      }
      for (const r of planned) {
        add("gitlab", `${project}: revert ${r.sha.slice(0, 8)} on ${r.branch} (a new commit; history is not rewritten)`, async () => {
          try {
            await gl.api("POST", `${P}/repository/commits/${seg(r.sha)}/revert`, { branch: r.branch });
          } catch (e) {
            throw new DemoError(`MANUAL: GitLab would not revert ${r.sha.slice(0, 8)} on ${project}/${r.branch} (${e.message}). Do it by hand: git revert ${r.sha} (add -m 1 for a merge commit), or put the branch back to the tag: git push --force-with-lease origin demo-baseline:${r.branch} (needs force-push allowed on that branch).`);
          }
        }, project);
      }
      // 4. branches
      const names = new Set(state.branches.filter((b) => b.project === project).map((b) => b.branch));
      const foundB = await gl.getAll(`${P}/repository/branches?search=${enc("^qa-sentinel/")}`).catch(() => []);
      for (const b of foundB) if (String(b.name).startsWith("qa-sentinel/")) names.add(b.name);
      for (const name of names) {
        if (branches.includes(name)) continue;
        const b = await gl.api("GET", `${P}/repository/branches/${enc(name)}`).catch((e) => (e.status === 404 ? undefined : Promise.reject(e)));
        if (!b) continue;
        if (b.protected) {
          skipped.push(`${project}: branch ${name} is protected: left alone`);
          continue;
        }
        add("gitlab", `${project}: delete branch ${name}`, () => gl.api("DELETE", `${P}/repository/branches/${enc(name)}`), project);
      }
      // 5. pipelines started by the reverts (optional)
      if (args["cancel-pipelines"]) {
        add("gitlab", `${project}: cancel pipelines that are running or waiting (the ones the reverts started)`, async () => {
          for (const st of ["running", "pending", "created"]) for (const pl of await gl.getAll(`${P}/pipelines?status=${st}`)) await gl.api("POST", `${P}/pipelines/${seg(pl.id)}/cancel`);
        }, project);
      }
    }
  }

  // ---------------------------------------------------------------- Jira
  if (hasJira) {
    const jira = makeJira(state.jira.baseUrl, config.jira?.auth ?? "auto", env);
    if (new URL(config.jira.baseUrl).origin !== new URL(state.jira.baseUrl).origin) fail("demo.config.json and the state file point to different Jira sites. Nothing was changed.");
    const project = state.jira.project;
    const defs = loadCards(cardsFile).cards;
    let me;
    try {
      me = await jira.me();
    } catch (e) {
      notes.push(`Jira comments are NOT touched: ${e.message}`);
    }
    for (const [id, card] of Object.entries(state.cards)) {
      const key = card.key;
      const issue = await jira.api("GET", `/rest/api/2/issue/${encodeURIComponent(key)}?fields=status,labels,summary,attachment`).catch((e) => (e.status === 404 ? undefined : Promise.reject(e)));
      if (!issue) {
        notes.push(`${key} (${id}) no longer exists in Jira: skipped`);
        continue;
      }
      // Only a card that is the demo's own: key shape, label and summary must all fit.
      const def = defs.find((d) => d.id === id);
      const problem = demoCardProblem({ key, project, issue, summary: def?.summary });
      if (problem) {
        skipped.push(`${key} (${id}): NOT touched, ${problem}`);
        continue;
      }
      const comments = [];
      for (let startAt = 0; ; ) {
        const page = await jira.api("GET", `/rest/api/2/issue/${encodeURIComponent(key)}/comment?startAt=${startAt}&maxResults=100`);
        const cs = page.comments ?? [];
        comments.push(...cs);
        startAt += cs.length;
        if (!cs.length || startAt >= (page.total ?? 0)) break;
      }
      for (const c of comments) {
        if (typeof c.body === "string" && /^\s*\/qa\s+ready/im.test(c.body)) notes.push(`${key}: comment ${c.id} by ${c.author?.displayName ?? "someone"} contains "/qa ready". It still marks acceptance criteria as ready in the next run. Reset does not delete people's comments: delete it by hand.`);
      }
      if (me) {
        for (const c of comments) {
          if (typeof c.body !== "string" || !c.body.includes(MARKER)) continue;
          if (!sameUser(c.author, me)) {
            skipped.push(`${key}: a comment with the marker was written by "${c.author?.displayName ?? "someone else"}", not by the login: left alone`);
            continue;
          }
          add("jira", `${key}: delete comment ${c.id} (qa-sentinel marker, written by the login)`, () => jira.api("DELETE", `/rest/api/2/issue/${encodeURIComponent(key)}/comment/${seg(c.id)}`));
        }
      }
      const bugRefs = new Map((state.raisedBugs ?? []).filter((b) => b.story === key).map((b) => [b.key, b.item]));
      for (const prop of JIRA_PROPERTIES) {
        const p = await jira.api("GET", `/rest/api/2/issue/${encodeURIComponent(key)}/properties/${encodeURIComponent(prop)}`).catch((e) => (e.status === 404 ? undefined : Promise.reject(e)));
        if (!p) continue;
        if (prop === "qa-sentinel.showcase") {
          // The property can be edited by anyone: delete an attachment only if it is on this card and the login added it.
          for (const a of p.value?.attachments ?? []) {
            const onCard = (issue.fields?.attachment ?? []).find((x) => String(x.id) === String(a.id));
            if (!me || !onCard || !sameUser(onCard.author, me)) {
              skipped.push(`${key}: attachment ${a.id} from the showcase record is not on this card or was not added by the login: left alone`);
              continue;
            }
            add("jira", `${key}: delete attachment ${onCard.filename} (listed in the showcase record, added by the login)`, () => jira.api("DELETE", `/rest/api/2/attachment/${seg(onCard.id)}`).catch((e) => (e.status === 404 ? undefined : Promise.reject(e))));
          }
        }
        if (prop === "qa-sentinel.bugs") for (const [item, b] of Object.entries(p.value ?? {})) if (b?.key) bugRefs.set(b.key, item);
        add("jira", `${key}: remove issue property ${prop}`, () => jira.api("DELETE", `/rest/api/2/issue/${encodeURIComponent(key)}/properties/${encodeURIComponent(prop)}`));
      }
      // Bug cards that qa-sentinel raised from this story. They stay unless --delete-bugs; their keys are remembered in the state file.
      for (const [bugKey, item] of bugRefs) {
        if (!KEY_RE.test(bugKey) || !bugKey.startsWith(`${project}-`)) {
          skipped.push(`${key}: the record names "${bugKey}", which is not a card of project ${project}: left alone`);
          continue;
        }
        if (!args["delete-bugs"]) {
          notes.push(`${key}: qa-sentinel raised bug ${bugKey} (${item}). It stays in Jira; add --delete-bugs to delete it (only if it is in project ${project}, has the qa-sentinel label and the login created it).`);
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
    for (const rel of localMatches(testsDir)) {
      const p = path.join(testsDir, rel);
      add("local", `remove ${p}`, () => fs.rmSync(p, { recursive: true, force: true }));
    }
    if (!args["skip-doctor"]) add("local", `run \`qa-sentinel doctor\` in ${testsDir}`, () => runDoctor(testsDir, env));
  } else notes.push("No --tests-dir given: local files (.qa-sentinel/, qa-stories.md) and `doctor` are skipped.");

  // ---------------------------------------------------------------- the end: is GitLab back at the baseline?
  const verify = async () => {
    const lines = [];
    const differing = new Set();
    if (!gl) return { lines, differing };
    for (const project of state.gitlab.projects) {
      for (const branch of [state.gitlab.defaultBranch, state.gitlab.releaseBranch]) {
        const P = `/projects/${enc(project)}`;
        const exists = await gl.api("GET", `${P}/repository/branches/${enc(branch)}`).then(() => true, () => false);
        if (!exists) continue;
        const c = await gl.api("GET", `${P}/repository/compare?from=demo-baseline&to=${enc(branch)}&straight=true`).catch(() => undefined);
        if (!c) {
          differing.add(project);
          lines.push(`${project} ${branch}: could not be compared with demo-baseline`);
          continue;
        }
        if ((c.diffs ?? []).length) differing.add(project);
        lines.push(`${project} ${branch}: ${(c.diffs ?? []).length === 0 ? "same files as demo-baseline" : `STILL DIFFERENT from demo-baseline in ${(c.diffs ?? []).map((d) => d.new_path).join(", ")}`}`);
      }
    }
    return { lines, differing };
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
  const writing = wantsWrite(args);
  log(writing ? "RESET (WRITING)\n" : "RESET: DRY RUN. Nothing is changed. Add --yes --i-know-this-is-a-test-project <KEY> to do it.\n");
  if (!plan.actions.length) log("Nothing to do: everything is already back at the start.");
  plan.actions.forEach((a, i) => log(`  ${String(i + 1).padStart(2)}. [${a.area}] ${a.text}`));
  for (const s of plan.skipped) log(`  skip: ${s}`);
  for (const n of plan.notes) log(`  note: ${n}`);
  let failures = 0;
  const failedProjects = new Set();
  if (writing) {
    log("");
    for (const [i, a] of plan.actions.entries()) {
      try {
        await a.run();
        log(`  ${String(i + 1).padStart(2)}. ok`);
      } catch (e) {
        failures++;
        if (a.project) failedProjects.add(a.project);
        log(`  ${String(i + 1).padStart(2)}. FAILED: ${e.message}`);
      }
    }
    const { lines, differing } = await plan.verify();
    for (const l of lines) log(`  check: ${l}`);
    // Records are forgotten per project, and only for a project whose actions worked and whose files equal the baseline again.
    const clean = (p) => !failedProjects.has(p) && !differing.has(p);
    const st = plan.state;
    st.mrs = st.mrs.filter((m) => !clean(m.project));
    st.merges = st.merges.filter((m) => !clean(m.project));
    st.branches = st.branches.filter((b) => !clean(b.project));
    saveState(stateFile, st);
    if (differing.size) {
      failures++;
      log(`\nNOT FINISHED: ${[...differing].join(", ")} still differs from demo-baseline. The records for it are kept. Look at the lines above, do the MANUAL step if there is one, then run reset again.`);
    } else if (failures) log(`\nReset finished with ${failures} problem(s). The records of projects that failed are kept. Fix them (or do the MANUAL steps), then run reset again: it is safe to repeat.`);
    else log("\nReset finished. demo/.demo-state.json keeps the projects and cards, so you can run the demo again.");
    log("Now, by hand: in the test repo, Build > Pipelines > Clear runner caches (reset cannot do that), and wait until the runners are idle.");
  }
  log("\nWhat reset cannot undo:");
  for (const c of CANNOT_UNDO) log(`  - ${c}`);
  return failures ? 1 : 0;
}

if (isMain(import.meta.url)) await runCli((args) => reset({ args }));
