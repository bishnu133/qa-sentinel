// The shared part of demo-merge.mjs and demo-bugfix.mjs: make the developer's change for a card on a branch,
// open the merge request with the Jira key in its title, and (only with --merge) merge it.
// Works only on projects and cards listed in .demo-state.json. Writes to GitLab only with --yes.
import { DEFAULT_CONFIG, DEFAULT_STATE, applyEdits, enc, fail, loadCards, loadChange, loadConfig, loadState, makeGitLab, saveState, say } from "./lib.mjs";

/** What the person should look at next. Taken from the shipped docs and templates; NOT observed by the kit's author on a real system. */
export function watchText({ kind, card, key, project, testsProject, merged, hotfix, partial }) {
  const out = [];
  if (!merged) {
    out.push(`Watch the merge request in ${project}:`, `  - pipeline job "qa-gap-report" (it never blocks the merge; AI cost: about $0.10 to $0.40 per run, from docs/SANDBOX.md)`, `  - one comment on the merge request, first line <!-- qa-sentinel:gap-report --> (hidden in the page)`);
    out.push(`  - one comment on ${key} in Jira (a grey "qa-sentinel:" marker at the end), because reporting.targets includes jira`);
    if (card.id === "delivery-slot") out.push("  - expected from the sandbox notes: high risk, and a finding that the code allows 5 orders per slot while the card says 3 (AC-3)");
    if (card.id === "qty-limit") out.push("  - expected: a calm report, the change matches the card");
    out.push("Then merge it (the live script says how), or press Merge in GitLab.");
  } else if (hotfix) {
    out.push(`The hotfix is merged into the release branch of ${project}.`, "  - qa-sentinel treats hotfix/* and release/* specially: the gap report has a note, and NO tests are generated until the change reaches the main branch.", "  - run again with --cherry-pick to copy the fix to the main branch; that is when tests are generated.");
  } else {
    out.push(`Watch ${project}: pipeline on the default branch, job "qa-trigger-generation" starts a pipeline in ${testsProject}.`, `Watch ${testsProject}:`, '  - job "qa-generate" (AI cost: about $0.50 to $2 per run, from docs/SANDBOX.md)', `  - a NEW merge request with labels "qa-agent" and "qa-sentinel::<status>", branch qa-sentinel/story-${key} (it is a Draft unless the status is VERIFIED)`, '  - job "qa-agent-mr-checks" on that merge request (the gate: it blocks unless VERIFIED)');
    if (partial) out.push("  - this card needs another service too: the acceptance criteria that need both services WAIT (the test merge request description lists them). Merge the other part, then watch again.");
    if (kind === "bug") out.push(`  - the bug ${key} is linked to its story (Relates). Expected: the tests for the story are updated or re-run. This link-following is in the code and unit tests but was not run by the kit's author on real Jira.`);
  }
  return out;
}

export async function runChangeFlow({ kind, args = {}, env = process.env, configFile = DEFAULT_CONFIG, stateFile = DEFAULT_STATE, cardsFile, log = say }) {
  const wantBug = kind === "bug";
  const cardId = args.card;
  if (!cardId || cardId === true) fail(`Say which card: --card <id>. Cards: ${loadCards(cardsFile).cards.filter((c) => (c.type === "Bug") === wantBug).map((c) => c.id).join(", ")}`);
  const config = loadConfig(configFile);
  const state = loadState(stateFile);
  const card = loadCards(cardsFile).cards.find((c) => c.id === cardId);
  if (!card) fail(`Unknown card "${cardId}".`);
  if ((card.type === "Bug") !== wantBug) fail(`"${cardId}" is a ${card.type}. Use ${wantBug ? "demo-merge.mjs" : "demo-bugfix.mjs"} for it.`);
  const rec = state.cards[cardId];
  if (!rec) fail(`Card "${cardId}" is not in ${stateFile}. Run seed-jira.mjs first.`);
  if (!state.gitlab?.projects?.length) fail(`${stateFile} lists no GitLab projects. Run setup-gitlab.mjs first.`);

  for (const need of card.needsServices ?? []) if (!config.services.some((s) => s.name === need)) fail(`Card "${cardId}" needs the service "${need}", which is not in demo.config.json. Add the optional payments project, or pick another card.`);
  let changeName = card.changes[0];
  if (card.changes.length > 1) {
    const part = args.part;
    if (!part || part === true) fail(`Card "${cardId}" has ${card.changes.length} parts. Say which service: --part <${card.changes.map((c) => loadChange(c).service).join(" | ")}>`);
    changeName = card.changes.find((c) => loadChange(c).service === part);
    if (!changeName) fail(`No part of "${cardId}" for service "${part}".`);
  }
  const change = loadChange(changeName);
  const svc = config.services.find((s) => s.name === change.service);
  if (!svc) fail(`Service "${change.service}" is not in demo.config.json.`);
  if (!state.gitlab.projects.includes(svc.project)) fail(`Refusing: ${svc.project} is not one of the demo projects listed in ${stateFile}. Nothing was changed.`);
  const hotfix = Boolean(card.hotfix || change.hotfix);
  const base = hotfix ? state.gitlab.releaseBranch : state.gitlab.defaultBranch;
  const branch = `${hotfix ? "hotfix" : "demo"}/${rec.key}-${change.slug}`;
  const title = `${rec.key}: ${card.summary}`;
  const project = svc.project;
  const writing = Boolean(args.yes);
  const gl = makeGitLab(state.gitlab.url, env);
  if (new URL(gl.url).origin !== new URL(config.gitlabUrl).origin) fail("The GitLab address in demo.config.json is not the one the state was set up with. Nothing was changed.");
  const P = `/projects/${enc(project)}`;

  let mr = state.mrs.find((m) => m.project === project && m.branch === branch);
  if (mr) {
    const live = await gl.api("GET", `${P}/merge_requests/${mr.iid}`);
    mr.state = live.state;
    if (live.state === "closed") fail(`The merge request !${mr.iid} for this card was closed. Run reset.mjs --yes, then start again.`);
    if (live.state === "merged" && !args["cherry-pick"]) fail(`!${mr.iid} is already merged. To do it again, run reset.mjs --yes first.`);
  }

  log(`Card ${cardId} (${rec.key}) -> ${project}, branch ${branch} -> ${base}  ${writing ? "(WRITING)" : "(dry run: nothing is written; add --yes)"}`);
  // Read-only check that the change fits what is in GitLab now.
  const actions = [];
  if (!mr) {
    for (const [file, pairs] of Object.entries(change.edits)) {
      const old = await gl.rawFile(project, file, base);
      actions.push({ action: "update", file_path: file, content: applyEdits(old, pairs, `${project}:${file} on ${base}`) });
    }
    if (actions.length) log(`  change fits: ${actions.map((a) => a.file_path).join(", ")}`);
  }
  if (!writing) {
    log(`  would: create branch, commit "${change.commitMessage.replace("{KEY}", rec.key)}", open the merge request "${title}"${args.merge ? ", then merge it (squash)" : ""}`);
    return { dryRun: true };
  }

  if (!mr) {
    await gl.api("POST", `${P}/repository/branches`, { branch, ref: base });
    state.branches.push({ project, branch });
    saveState(stateFile, state);
    await gl.api("POST", `${P}/repository/commits`, { branch, commit_message: change.commitMessage.replace("{KEY}", rec.key), actions });
    const created = await gl.api("POST", `${P}/merge_requests`, { source_branch: branch, target_branch: base, title, description: `Implements ${rec.key}. The acceptance criteria are in Jira.\n\n_Opened by the qa-sentinel demo kit._`, remove_source_branch: true, squash: true });
    mr = { project, iid: created.iid, branch, target: base, cardId, key: rec.key, kind: hotfix ? "hotfix" : wantBug ? "bugfix" : "story", state: created.state ?? "opened", web_url: created.web_url };
    state.mrs.push(mr);
    saveState(stateFile, state);
    log(`  merge request !${mr.iid} opened: ${created.web_url}`);
  } else log(`  merge request !${mr.iid} is already open: ${mr.web_url ?? ""}`);

  const partial = card.changes.length > 1;
  const cherry = args["cherry-pick"];
  if (args.merge && mr.state !== "merged") {
    let merged;
    try {
      merged = await gl.api("PUT", `${P}/merge_requests/${mr.iid}/merge`, { squash: true, should_remove_source_branch: true, squash_commit_message: title });
    } catch (e) {
      if ([405, 406, 409, 422].includes(e.status)) fail(`GitLab would not merge !${mr.iid} yet (${e.status}): the pipeline may still be running, or an approval is needed. Wait, then run the same command again.`);
      throw e;
    }
    mr.state = merged.state;
    const sha = merged.merge_commit_sha ?? merged.squash_commit_sha ?? merged.sha;
    if (merged.state === "merged" && sha) {
      state.merges.push({ project, branch: base, sha, cardId, mrIid: mr.iid, kind: "merge" });
      mr.mergeSha = sha;
    }
    saveState(stateFile, state);
    log(`  merged !${mr.iid} (${merged.state})`);
  }
  if (cherry) {
    if (!hotfix) fail("--cherry-pick is only for the hotfix card.");
    if (mr.state !== "merged" || !mr.mergeSha) fail("Merge the hotfix into the release branch first (--merge).");
    if (state.merges.some((m) => m.project === project && m.kind === "cherry-pick" && m.cardId === cardId)) log("  already copied to the main branch");
    else {
      const picked = await gl.api("POST", `${P}/repository/commits/${mr.mergeSha}/cherry_pick`, { branch: state.gitlab.defaultBranch });
      state.merges.push({ project, branch: state.gitlab.defaultBranch, sha: picked.id, cardId, mrIid: mr.iid, kind: "cherry-pick" });
      saveState(stateFile, state);
      log(`  copied the fix to ${state.gitlab.defaultBranch} (${String(picked.id).slice(0, 8)})`);
    }
  }
  const merged = mr.state === "merged";
  for (const l of watchText({ kind, card, key: rec.key, project, testsProject: state.gitlab.testsProject, merged, hotfix: hotfix && !cherry && merged, partial })) log(l);
  return { dryRun: false, mr };
}
