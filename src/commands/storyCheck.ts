import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../config.js";
import { extractStoryKey, jiraIssueText, parseStoryFor, serviceNamesOf } from "../requirements.js";
import { fetchIssue, issueFields, jiraContext } from "../scm/jira.js";
import { resolveFeature, servicesFromComponents, isReadyStatus } from "../stories/resolve.js";
import type { ParsedStory } from "../storyTemplate.js";
import { log } from "../log.js";

/**
 * `qa-sentinel story-check`: how qa-sentinel reads one of your stories, before (or while) onboarding a project.
 * Shows each heading and the role it got, the acceptance criteria, scope items, exclusions, context and the
 * services the story names, and what to change in requirements.template when something isn't recognised.
 * With --fields, lists the Jira issue's fields with their ids (to set acceptanceCriteriaField / scopeFields).
 */
export async function storyCheckCommand(o: { cwd: string; story?: string; storyFile?: string; fields?: boolean; json?: boolean; out?: string }): Promise<number> {
  const cwd = path.resolve(o.cwd);
  const c = loadConfig(cwd);
  if (!o.story && !o.storyFile) throw new Error("Pass --story KEY (from Jira) or --story-file path");
  let text: string;
  let title: string | undefined;
  let fields: { id: string; name: string; preview: string }[] | undefined;
  let tracked = "";
  const source = o.storyFile ? `file ${o.storyFile}` : `Jira ${o.story}`;
  if (o.storyFile) text = fs.readFileSync(path.resolve(cwd, o.storyFile), "utf8");
  else {
    const ctx = jiraContext(c.requirements.jira);
    if (!ctx) throw new Error("Jira is not configured: set requirements.jira.baseUrl and JIRA_EMAIL + JIRA_API_TOKEN (or JIRA_PAT)");
    const issue = await fetchIssue(ctx, o.story!, c.requirements.jira.acceptanceCriteriaField, c.requirements.jira.scopeFields.map((f) => f.field));
    title = issue.summary;
    text = jiraIssueText(c, issue);
    if (o.fields) fields = await issueFields(ctx, o.story!);
    // Which feature this card is tracked under (a bug, task or sub-task follows its story by the strict rules), and what Jira says about it.
    const r = await resolveFeature(c, issue, (k) => fetchIssue(ctx, k).catch(() => undefined));
    const comps = servicesFromComponents(c, issue.components);
    tracked = [
      "",
      "## Which feature this card belongs to",
      "",
      r.explain + (r.kind === "none" && !c.requirements.jira.featureIssueTypes.length ? "" : "."),
      ...(c.requirements.jira.featureIssueTypes.length ? [] : ["Every issue type counts as a feature because `requirements.jira.featureIssueTypes` is empty; set it (e.g. `[Story]`) to trace bugs and sub-tasks to their story."]),
      `Status "${issue.status}": ${isReadyStatus(c, issue.key, issue.status, issue.statusCategory) ? "a ready status" : "not a ready status"} for ${issue.key.replace(/-\d+$/, "")} (requirements.jira.workflow).`,
      ...(issue.components?.length ? [`Components: ${issue.components.join(", ")}${comps.services.length ? ` → services ${comps.services.join(", ")}` : ""}${comps.unmapped.length ? ` (not mapped: ${comps.unmapped.join(", ")}; see requirements.jira.components)` : ""}.`] : []),
      "",
    ].join("\n");
  }
  const parsed = parseStoryFor(c, text);
  if (o.json) {
    process.stdout.write(JSON.stringify({ source, title, ...parsed, ...(fields ? { fields } : {}) }, null, 2) + "\n");
    return parsed.acceptanceCriteria.length ? 0 : 1;
  }
  const md = storyCheckMarkdown({ c, source, title, story: o.story, parsed, fields, keyFound: extractStoryKey(c.requirements.storyKeyPattern, o.story, text) });
  const out = path.resolve(cwd, o.out ?? "qa-story-check.md");
  fs.writeFileSync(out, md + tracked);
  process.stdout.write(md + tracked);
  if (parsed.acceptanceCriteria.length) log.ok(`${parsed.acceptanceCriteria.length} AC (${parsed.acFormat}), ${parsed.scopeItems.length} scope item(s), ${parsed.outOfScope.length} out of scope · ${path.relative(cwd, out)}`);
  else log.fail(`no acceptance criteria found · see "What to change" in ${path.relative(cwd, out)}`);
  return parsed.acceptanceCriteria.length ? 0 : 1;
}

const one = (s: string, n = 140) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

export function storyCheckMarkdown(i: {
  c: ReturnType<typeof loadConfig>;
  source: string;
  title?: string;
  story?: string;
  parsed: ParsedStory;
  fields?: { id: string; name: string; preview: string }[];
  keyFound?: string;
}): string {
  const { c, parsed: p } = i;
  const L: string[] = [`# Story check${i.story ? ` · ${i.story}` : ""}${i.title ? ` — ${i.title}` : ""}`, "", `Read from ${i.source} with this project's \`requirements.template\`.`, ""];
  L.push("## Sections", "", "| Heading in the story | Read as |", "| --- | --- |");
  for (const h of p.headings) L.push(`| ${h.text} | ${h.role === "unknown" ? "❔ not recognised (kept as text)" : `${h.role}${h.section && h.role !== "acceptance-criteria" ? ` · ${h.section}` : ""}`} |`);
  if (!p.headings.length) L.push("| _(no headings found)_ | |");
  L.push("", `## Acceptance criteria · ${p.acceptanceCriteria.length} (${p.acFormat === "none" ? "not found" : `from a ${p.acFormat}`})`, "");
  for (const a of p.acceptanceCriteria) L.push(`- **${a.id}** ${one(a.text, 220)}`);
  if (p.scopeItems.length) {
    L.push("", `## Scope items · ${p.scopeItems.length} (checked for "is it built?", traced like ACs)`, "");
    for (const s of p.scopeItems) L.push(`- **${s.id}** _(${s.source}${s.service ? ` · ${s.service}` : ""})_ ${one(s.text)}`);
  }
  if (p.outOfScope.length) L.push("", "## Out of scope (never planned, never raised as bugs)", "", ...p.outOfScope.map((x) => `- ${one(x)}`));
  if (p.context.length) L.push("", `## Context for the agents`, "", ...p.context.map((x) => `- ${x.name}: ${one(x.text, 100)}`));
  L.push("", `**Showcase approach:** ${p.showcase ? one(p.showcase, 160) : "_none in the story_"}`);
  const configured = serviceNamesOf(c);
  L.push(`**Services named:** ${p.servicesNamed.length ? p.servicesNamed.join(", ") : "_none_"}${configured.length ? ` (configured: ${c.workspace.services.map((s) => s.name).join(", ")})` : " (no services configured yet)"}`);

  // What to change.
  const todo: string[] = [];
  if (!p.acceptanceCriteria.length)
    todo.push(
      "No acceptance criteria found. Either add your AC heading to a `role: acceptance-criteria` section in `requirements.template`, or, if the ACs live in their own Jira field, set `requirements.jira.acceptanceCriteriaField` (run with `--fields` to find its id).",
    );
  const unknown = [...new Set(p.headings.filter((h) => h.role === "unknown").map((h) => h.text))];
  if (unknown.length) {
    todo.push(
      `Headings not recognised: ${unknown.map((u) => `"${u}"`).join(", ")}. Their text still reaches the agents, but isn't used as requirements. If one matters, add it to a section of \`requirements.template\` in qa-sentinel.config.yaml (the list there holds every section; add a heading to an existing one or append a new one):\n\n\`\`\`yaml\nrequirements:\n  template:\n${unknown
        .slice(0, 3)
        .map((u) => `    - { role: context, name: "${u}", headings: ["${u.replace(/"/g, "'")}"] }   # or: scope (with a prefix), out-of-scope, ignore`)
        .join("\n")}\n\`\`\``,
    );
  }
  if (p.acceptanceCriteria.length > 1 && !p.acIdsFromStory)
    todo.push("The ACs aren't numbered in the story, so qa-sentinel numbers them by position (AC-1, AC-2, …). If someone later inserts, removes or reorders an AC, the `@ac` tags on existing tests point at the wrong criterion. Number them in the story itself: `AC-1: …` list items, or a number column in a Given/When/Then table.");
  if (p.acFormat === "list" && p.acceptanceCriteria.some((a) => /^(given|when|then)\b/i.test(a.text)))
    todo.push("Some ACs look like single Given / When / Then lines: write each scenario as one item (or a Given/When/Then table) so it becomes one AC.");
  if (i.story && !i.keyFound) todo.push(`The key ${i.story} doesn't match \`requirements.storyKeyPattern\` (${c.requirements.storyKeyPattern}); qa-sentinel won't find it in branch names and commits.`);
  if (c.requirements.jira.projectKeys.length && i.story && !c.requirements.jira.projectKeys.some((k) => i.story!.startsWith(`${k}-`)))
    todo.push(`${i.story} is not in \`requirements.jira.projectKeys\` (${c.requirements.jira.projectKeys.join(", ")}).`);
  L.push("", "## What to change", "", ...(todo.length ? todo.map((t) => `- ${t}`) : ["- Nothing: qa-sentinel reads this story as intended. Check a few more stories from different authors."]));

  if (i.fields) {
    L.push("", "## Jira fields on this issue", "", "Use an id for `requirements.jira.acceptanceCriteriaField` or `requirements.jira.scopeFields`.", "", "| Field id | Name | Value |", "| --- | --- | --- |");
    for (const f of i.fields) L.push(`| \`${f.id}\` | ${f.name} | ${f.preview.replace(/\|/g, "/")} |`);
  }
  return L.join("\n") + "\n";
}
