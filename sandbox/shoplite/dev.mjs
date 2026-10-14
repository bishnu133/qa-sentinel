#!/usr/bin/env node
// Play the developer in the GitLab sandbox.
//
//   node sandbox/shoplite/dev.mjs list
//   node sandbox/shoplite/dev.mjs open SHOP-101     # branch + change + merge request (triggers the QA gap report)
//   node sandbox/shoplite/dev.mjs merge SHOP-101    # merge it (at level maintenance this triggers test generation)
//   node sandbox/shoplite/dev.mjs close SHOP-101    # close the MR and delete the branch, to run it again
//
// Uses GITLAB_TOKEN / GITLAB_GROUP / GITLAB_URL like setup-gitlab.mjs, and the same --work folder.
// If jira-seed.mjs has run, MR titles use the real Jira keys and leave the acceptance criteria to Jira.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { die, flags, git, gitlab, log, makeChange, scenario, sh } from "./lib.mjs";
import { SCENARIOS } from "./scenarios.mjs";

const f = flags(process.argv.slice(2));
const [cmd, id] = f._;
const work = path.resolve(typeof f.work === "string" ? f.work : "shoplite-gitlab");
const group = process.env.GITLAB_GROUP;
const jiraKeys = fs.existsSync(path.join(work, ".jira-keys.json")) ? JSON.parse(fs.readFileSync(path.join(work, ".jira-keys.json"), "utf8")) : {};
const enc = encodeURIComponent;

async function findMr(gl, s) {
  const mrs = await gl.api("GET", `/projects/${enc(`${group}/${s.service}`)}/merge_requests?source_branch=${enc(s.branch)}&state=opened`);
  return mrs[0];
}

async function main() {
  if (cmd === "list" || !cmd) {
    for (const s of SCENARIOS) console.log(`${s.id.padEnd(9)} ${(jiraKeys[s.id] ?? "").padEnd(9)} ${s.service.padEnd(22)} ${s.title.replace(/^SHOP-\d+:\s*/, "")}\n          expect: ${s.expect}\n`);
    return;
  }
  if (!group) die("Set GITLAB_GROUP (and GITLAB_TOKEN).");
  const gl = gitlab();
  const s = scenario(id);
  const key = jiraKeys[s.storyKey ?? s.id];
  const title = key ? s.title.replace(/^SHOP-\d+/, key) : s.title;

  if (cmd === "open") {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `shoplite-${s.service}-`));
    sh("git", ["clone", "-q", gl.remote(`${group}/${s.service}`), dir]);
    makeChange(dir, s, { storyKey: key });
    git(dir, "push", "-q", "--force", "origin", `HEAD:refs/heads/${s.branch}`);
    const description = key
      ? `Implements ${key}. Acceptance criteria are in Jira.`
      : `${s.story}\n\n---\n_ShopLite sandbox scenario ${s.id}. Expected QA findings: ${s.expect}_`;
    const existing = await findMr(gl, s);
    const mr = existing
      ? await gl.api("PUT", `/projects/${enc(`${group}/${s.service}`)}/merge_requests/${existing.iid}`, { title, description })
      : await gl.api("POST", `/projects/${enc(`${group}/${s.service}`)}/merge_requests`, {
          source_branch: s.branch,
          target_branch: "main",
          title,
          description,
          remove_source_branch: true,
        });
    fs.rmSync(dir, { recursive: true, force: true });
    log(`merge request ${existing ? "updated" : "opened"}: ${mr.web_url}`);
    log(`the "qa-gap-report" job will comment on it in a few minutes. Expect: ${s.expect}`);
    return;
  }

  const mr = await findMr(gl, s);
  if (!mr) die(`no open merge request for ${s.id} (branch ${s.branch}); run: dev.mjs open ${s.id}`);
  const route = `/projects/${enc(`${group}/${s.service}`)}/merge_requests/${mr.iid}`;
  if (cmd === "merge") {
    try {
      const merged = await gl.api("PUT", `${route}/merge`, { should_remove_source_branch: true });
      log(`merged: ${merged.web_url}`);
      log(`at level maintenance, ${group}/qa-tests now runs "qa-generate" and opens a QA agent merge request.`);
    } catch (e) {
      die(`could not merge (${e.status}). If the MR pipeline is still running, wait for it or merge in the UI: ${mr.web_url}`);
    }
  } else if (cmd === "close") {
    await gl.api("PUT", route, { state_event: "close" });
    await gl.api("DELETE", `/projects/${enc(`${group}/${s.service}`)}/repository/branches/${enc(s.branch)}`).catch(() => {});
    log(`closed ${mr.web_url} and deleted ${s.branch}`);
  } else die(`unknown command ${cmd}`);
}

main().catch((e) => die(e.message));
