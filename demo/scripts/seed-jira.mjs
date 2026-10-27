#!/usr/bin/env node
// Create the demo cards in YOUR Jira TEST project.   COSTS NO AI.  WRITES TO JIRA (with --yes).
//
//   export DEMO_JIRA_PROJECT=<KEY>            # must equal jira.project in demo.config.json
//   export JIRA_EMAIL=… JIRA_API_TOKEN=…      # Jira Cloud   (or JIRA_PAT=… for Server / Data Center)
//   node demo/scripts/seed-jira.mjs                                                   # dry run: shows what it would create
//   node demo/scripts/seed-jira.mjs --yes --i-know-this-is-a-test-project             # really creates the cards
//
// It writes demo/.demo-state.json (git-ignored) with the keys it created, so reset.mjs can find them again.
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_CONFIG, DEFAULT_STATE, DEMO_DIR, fail, isMain, loadCards, loadConfig, loadState, makeJira, runCli, saveState, say, toWiki } from "./lib.mjs";

/** The checks that must pass before anything is written. Throws a plain message when one fails. */
export function checkSeedGuards({ config, args, env }) {
  const want = env.DEMO_JIRA_PROJECT;
  if (!want) fail("Set DEMO_JIRA_PROJECT to the key of your Jira TEST project (and the same key as jira.project in demo.config.json).");
  const jira = config.jira ?? {};
  if (!jira.baseUrl || !jira.project || /<.*>/.test(`${jira.baseUrl}${jira.project}`)) fail('demo.config.json: "jira.baseUrl" and "jira.project" must be filled in.');
  if (want !== jira.project) fail(`DEMO_JIRA_PROJECT is "${want}" but demo.config.json says jira.project is "${jira.project}". They must be the same. Nothing was changed.`);
  if (env.JIRA_BASE_URL && new URL(env.JIRA_BASE_URL).origin !== new URL(jira.baseUrl).origin) fail(`JIRA_BASE_URL (${new URL(env.JIRA_BASE_URL).origin}) is not the Jira in demo.config.json (${new URL(jira.baseUrl).origin}). Nothing was changed.`);
  const flag = args["i-know-this-is-a-test-project"];
  const writing = Boolean(args.yes);
  if (writing && !flag) fail(`Refusing to write to ${new URL(jira.baseUrl).host} project ${jira.project}. Add --i-know-this-is-a-test-project to say this is a TEST project.`);
  if (typeof flag === "string" && flag !== jira.project) fail(`--i-know-this-is-a-test-project ${flag} does not match the project ${jira.project}. Nothing was changed.`);
  return { baseUrl: jira.baseUrl.replace(/\/+$/, ""), project: jira.project, writing };
}

export async function seedJira({ args = {}, env = process.env, configFile = DEFAULT_CONFIG, stateFile = DEFAULT_STATE, cardsFile, log = say } = {}) {
  const config = loadConfig(configFile);
  const { baseUrl, project, writing } = checkSeedGuards({ config, args, env });
  const cards = loadCards(cardsFile);
  const state = loadState(stateFile);
  if (state.jira?.baseUrl && (state.jira.baseUrl !== baseUrl || state.jira.project !== project)) fail(`${stateFile} belongs to ${state.jira.baseUrl} / ${state.jira.project}. Run reset first, or delete that file on purpose, before seeding another project.`);

  log(`Jira: ${new URL(baseUrl).host}  project: ${project}  ${writing ? "(WRITING)" : "(dry run: nothing is written; add --yes to write)"}`);
  if (!writing) {
    for (const c of cards.cards) log(`  would create ${c.type.padEnd(5)} "${c.summary}"${c.startStatus ? ` and move it to "${c.startStatus}"` : ""}${c.linksTo ? ` and link it to "${c.linksTo.card}"` : ""}`);
    return { dryRun: true, state };
  }

  const jira = makeJira(baseUrl, config.jira.auth ?? "auto", env);
  await jira.me(); // proves the login before anything is created
  const meta = await jira.api("GET", `/rest/api/2/project/${encodeURIComponent(project)}`);
  const types = (meta.issueTypes ?? []).filter((t) => !t.subtask).map((t) => t.name);
  if (!types.length) fail(`Jira project ${project} has no issue types I can use.`);
  const pick = (want) => (types.includes(want) ? { name: want, extra: [] } : { name: types.includes("Task") ? "Task" : types[0], extra: want === "Bug" ? ["bug"] : [] });

  state.jira = { baseUrl, project };
  state.createdAt ??= new Date().toISOString();
  saveState(stateFile, state);

  for (const c of cards.cards) {
    const known = state.cards[c.id];
    if (known) {
      const still = await jira.api("GET", `/rest/api/2/issue/${known.key}?fields=status`).catch((e) => (e.status === 404 ? undefined : Promise.reject(e)));
      if (still) {
        log(`  ${c.id}: already created as ${known.key}`);
        continue;
      }
    }
    const t = pick(c.type);
    const story = fs.readFileSync(path.join(DEMO_DIR, c.storyFile), "utf8");
    const issue = await jira.api("POST", "/rest/api/2/issue", { fields: { project: { key: project }, issuetype: { name: t.name }, summary: c.summary, description: toWiki(story), labels: [...(cards.labels ?? []), ...t.extra] } });
    state.cards[c.id] = { key: issue.key, type: c.type, startStatus: null, hotfix: Boolean(c.hotfix) };
    saveState(stateFile, state); // write at once: a later failure must not lose a created key
    log(`  ${c.id}: created ${issue.key} (${t.name})`);
  }

  for (const c of cards.cards) {
    const rec = state.cards[c.id];
    if (c.linksTo && !rec.linked) {
      const other = state.cards[c.linksTo.card];
      await jira.api("POST", "/rest/api/2/issueLink", { type: { name: c.linksTo.linkType ?? "Relates" }, inwardIssue: { key: rec.key }, outwardIssue: { key: other.key } });
      rec.linked = other.key;
      log(`  linked ${rec.key} to ${other.key} (${c.linksTo.linkType ?? "Relates"})`);
    }
    if (c.startStatus && !rec.startStatus) {
      const { transitions = [] } = await jira.api("GET", `/rest/api/2/issue/${rec.key}/transitions`);
      const t = transitions.find((x) => x.to?.name?.toLowerCase() === c.startStatus.toLowerCase() || x.name?.toLowerCase() === c.startStatus.toLowerCase());
      if (t) await jira.api("POST", `/rest/api/2/issue/${rec.key}/transitions`, { transition: { id: t.id } });
      else log(`  WARNING ${rec.key}: no way to "${c.startStatus}" from the first status. Move it by hand: qa-sentinel only treats approved statuses as ready.`);
    }
    const now = await jira.api("GET", `/rest/api/2/issue/${rec.key}?fields=status`);
    rec.startStatus = now.fields?.status?.name ?? null; // what reset will put the card back to
    saveState(stateFile, state);
  }
  log(`Done. Keys saved in ${stateFile} (git-ignored; do not commit it).`);
  for (const [id, r] of Object.entries(state.cards)) log(`  ${id.padEnd(18)} ${r.key}  (${r.startStatus})`);
  log(`Next: put ${project} in requirements.jira.projectKeys of the test repo config, then run setup-gitlab.mjs.`);
  return { dryRun: false, state };
}

if (isMain(import.meta.url)) await runCli((args) => seedJira({ args }));
