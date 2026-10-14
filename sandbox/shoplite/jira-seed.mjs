#!/usr/bin/env node
// Create the ShopLite stories in Jira Cloud and move them to "In Progress" (= approved for qa-sentinel).
//
//   export JIRA_BASE_URL=https://you.atlassian.net
//   export JIRA_EMAIL=you@example.com
//   export JIRA_API_TOKEN=…                  # https://id.atlassian.com/manage-profile/security/api-tokens
//   export JIRA_PROJECT=SHOP                 # a Scrum or Kanban project you created in the Jira UI
//   node sandbox/shoplite/jira-seed.mjs [--work ./shoplite-gitlab] [--dry-run]
//
// Writes <work>/.jira-keys.json (SHOP-101 → the real Jira key), used by dev.mjs and setup-gitlab.mjs.
import fs from "node:fs";
import path from "node:path";
import { die, flags, log } from "./lib.mjs";
import { SCENARIOS } from "./scenarios.mjs";

const f = flags(process.argv.slice(2));
const work = path.resolve(typeof f.work === "string" ? f.work : "shoplite-gitlab");
const { JIRA_BASE_URL: base, JIRA_EMAIL: email, JIRA_API_TOKEN: token, JIRA_PROJECT: project = "SHOP" } = process.env;
if (!base || !email || !token) die("Set JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN.");
const auth = `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`;

async function jira(method, route, body) {
  if (f["dry-run"]) {
    log(`[dry-run] ${method} ${route}`);
    return method === "POST" && route === "/rest/api/2/issue" ? { key: `${project}-?` } : { transitions: [], issueTypes: [] };
  }
  const res = await fetch(`${base.replace(/\/$/, "")}${route}`, {
    method,
    headers: { Authorization: auth, Accept: "application/json", "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Jira ${method} ${route}: ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

/** Markdown-ish story → Jira wiki markup (numbered AC become "# item"). */
const toWiki = (md) =>
  md
    .split("\n")
    .map((l) => l.replace(/^##\s+(.*)$/, "h2. $1").replace(/^\d+\.\s+/, "# "))
    .join("\n");

async function main() {
  const meta = await jira("GET", `/rest/api/2/project/${project}`);
  const types = (meta.issueTypes ?? []).map((t) => t.name);
  const issueType = types.includes("Story") ? "Story" : types.includes("Task") ? "Task" : types[0] ?? "Story";
  log(`project ${project}: creating ${SCENARIOS.length} ${issueType}s`);
  const keys = fs.existsSync(path.join(work, ".jira-keys.json")) ? JSON.parse(fs.readFileSync(path.join(work, ".jira-keys.json"), "utf8")) : {};

  for (const s of SCENARIOS) {
    if (s.storyKey) continue; // part 2 of a story: same Jira issue as part 1
    if (keys[s.id] && !f.force) {
      log(`${s.id} already seeded as ${keys[s.id]} (use --force to create again)`);
      continue;
    }
    const issue = await jira("POST", "/rest/api/2/issue", {
      fields: { project: { key: project }, issuetype: { name: issueType }, summary: s.title.replace(/^SHOP-\d+:\s*/, ""), description: toWiki(s.story) },
    });
    keys[s.id] = issue.key;
    // "In Progress" is in the sandbox's approvedStatuses, so qa-sentinel treats these AC as approved.
    const { transitions = [] } = await jira("GET", `/rest/api/2/issue/${issue.key}/transitions`);
    const t = transitions.find((x) => /in progress/i.test(x.name) || /in progress/i.test(x.to?.name ?? ""));
    if (t) await jira("POST", `/rest/api/2/issue/${issue.key}/transitions`, { transition: { id: t.id } });
    log(`${s.id} → ${issue.key}${t ? " (In Progress)" : " (left in its first status: approval will show as unverified)"}`);
  }
  fs.mkdirSync(work, { recursive: true });
  fs.writeFileSync(path.join(work, ".jira-keys.json"), JSON.stringify(keys, null, 2));
  log(`saved ${path.join(work, ".jira-keys.json")}. Re-run setup-gitlab.mjs with the JIRA_* variables set to switch qa-sentinel to Jira.`);
}

main().catch((e) => die(e.message));
