import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_TEMPLATE, normHeading, parseStory } from "../src/storyTemplate.js";
import { toText, wikiToMarkdown } from "../src/scm/jira.js";
import { parseStoryFor, storyMarkdown } from "../src/requirements.js";
import { ConfigSchema } from "../src/config.js";
import { storyCheckCommand } from "../src/commands/storyCheck.js";

// Synthetic stories in the shape of a common enterprise Jira template (no real project content).
const wiki = fs.readFileSync(path.join(__dirname, "fixtures/stories/template-wiki.txt"), "utf8");
const cfg = (extra: Record<string, unknown> = {}) =>
  ConfigSchema.parse({
    version: 1,
    mode: "existing",
    project: { name: "t" },
    workspace: {
      services: [
        { name: "rewards-service", path: "../rewards-service" },
        { name: "console-bff", path: "../console-bff", gitlabProject: "grp/console-bff" },
        { name: "console", path: "../console-web", kind: "web" },
      ],
    },
    tests: { api: { framework: "playwright", runCommand: "npx playwright test" } },
    ci: { platform: "gitlab" },
    ...extra,
  });

describe("story template", () => {
  it("reads a wiki story: Given/When/Then table ACs, in scope with sub-points, out of scope, tech notes per service, context, showcase", () => {
    const p = parseStoryFor(cfg(), wikiToMarkdown(wiki));
    expect(p.acFormat).toBe("table");
    expect(p.acceptanceCriteria.map((a) => a.id)).toEqual(["AC-1", "AC-2"]);
    expect(p.acceptanceCriteria[0].text).toBe(
      "Given a support agent with the care role, when they open the profile of a member who is eligible, then they see a challenge entry for every assigned challenge AND the values follow the status mapping above",
    );
    expect(p.acceptanceCriteria[1].text).toContain('the earned transaction reads "Walk More (40 mins), 01 Jul 2030 - 07 Jul 2030"');
    expect(p.scopeItems.filter((x) => x.id.startsWith("IS")).map((x) => x.text)).toEqual([
      "For weekly challenges with base and stretch goals, the reward description is: [challenge name] ([goal value]), [start date] - [end date]; The goal value follows what the member achieved",
      "Map statuses shown in the console: Active; Pending acceptance; Declined",
      "Add a new 'Decision date' column for the member's accept or decline date",
    ]);
    const ts = p.scopeItems.filter((x) => x.id.startsWith("TS"));
    expect(ts.map((x) => [x.id, x.service])).toEqual([
      ["TS-1", "rewards-service"],
      ["TS-2", "console-bff"],
      ["TS-3", "console-bff"],
      ["TS-4", "console"], // named by its repo folder (console-web), mapped to the configured service
      ["TS-5", undefined], // "Note: …" after the lists belongs to no service
    ]);
    expect(p.outOfScope).toEqual(["Changing how points are calculated", "The mobile app"]);
    expect(p.context.map((x) => x.name)).toEqual(["Client Requirement", "Assumptions", "Feature Toggle / Environment Variables"]);
    expect(p.showcase).toContain("Seed a member with an accepted challenge");
    expect(p.servicesNamed).toEqual(["rewards-service", "console-bff", "console"]);
    expect(p.headings.find((h) => h.text === "Checklist")?.role).toBe("ignore");
    // Nothing from the checklist table or the empty Questions section becomes a requirement.
    expect(JSON.stringify(p.scopeItems)).not.toContain("Estimation");
  });

  it("reads an ADF story: numbered GWT table with an unlabelled number column and '—' cells, nested tech notes with sub-headings, N/A sections", () => {
    const t = (text: string) => ({ type: "text", text });
    const para = (text: string) => ({ type: "paragraph", content: [t(text)] });
    const h = (level: number, text: string) => ({ type: "heading", attrs: { level }, content: [t(text)] });
    const bullets = (...items: (string | [string, string[]])[]) => ({
      type: "bulletList",
      content: items.map((i) =>
        typeof i === "string"
          ? { type: "listItem", content: [para(i)] }
          : { type: "listItem", content: [para(i[0]), { type: "bulletList", content: i[1].map((s) => ({ type: "listItem", content: [para(s)] })) }] },
      ),
    });
    const cell = (type: string, text: string) => ({ type, content: text.split("\n").map(para) });
    const row = (type: string, ...cells: string[]) => ({ type: "tableRow", content: cells.map((c) => cell(type, c)) });
    const doc = {
      type: "doc",
      content: [
        para("As a member I am given a default goal so that I can join right away"),
        h(2, "In-scope"),
        bullets("New MemberGoal table (MemberId, GoalId, SetAt)", ["Default goal assigned when a member becomes", ["active AND verified", "whether verified at sign-up or later"]], "Feature toggle DEFAULT_GOAL_TOGGLE"),
        h(2, "Out of scope"),
        bullets("/external/import routes", "The monthly reminder job (separate story)"),
        h(2, "UI Reference (Figma / Screenshots)"),
        para("N/A — backend-only story, no UI changes"),
        h(2, "Acceptance Criteria"),
        {
          type: "table",
          content: [
            row("tableHeader", "", "Given", "When", "Then"),
            row("tableCell", "1", "A new member is created and is already verified", "sign-up completes", "the member gets the default goal\nwith SetAt = time of assignment"),
            row("tableCell", "2", "After the backfill: an existing member is active but not verified", "—", "the member has no goal"),
            row("tableCell", "3", "An existing member already has a goal", "the backfill job runs", "the goal is left unchanged"),
          ],
        },
        h(2, "Tech notes"),
        h(3, "Implementation"),
        para("Data model"),
        bullets("Add a MemberGoal migration in members-svc", "Unique index on MemberId"),
        para("Tests"),
        bullets("goal-service.spec.ts: add/change upserts MemberGoal"),
        h(2, "Showcase approach"),
        bullets("Test data: an active unverified member", "Execution: verify the member and show the MemberGoal row", "Clean up: remove test rows"),
      ],
    };
    const p = parseStory(toText(doc), DEFAULT_TEMPLATE, { serviceNames: ["members-svc"] });
    expect(p.acFormat).toBe("table");
    expect(p.acceptanceCriteria).toEqual([
      { id: "AC-1", text: "Given A new member is created and is already verified, when sign-up completes, then the member gets the default goal with SetAt = time of assignment" },
      { id: "AC-2", text: "Given After the backfill: an existing member is active but not verified, then the member has no goal" },
      { id: "AC-3", text: "Given An existing member already has a goal, when the backfill job runs, then the goal is left unchanged" },
    ]);
    expect(p.scopeItems.filter((x) => x.id.startsWith("IS")).map((x) => x.text)).toEqual([
      "New MemberGoal table (MemberId, GoalId, SetAt)",
      "Default goal assigned when a member becomes: active AND verified; whether verified at sign-up or later",
      "Feature toggle DEFAULT_GOAL_TOGGLE",
    ]);
    expect(p.scopeItems.filter((x) => x.id.startsWith("TS")).map((x) => x.text)).toEqual([
      "[Data model] Add a MemberGoal migration in members-svc",
      "[Data model] Unique index on MemberId",
      "[Tests] goal-service.spec.ts: add/change upserts MemberGoal",
    ]);
    expect(p.scopeItems.find((x) => x.id === "TS-1")?.service).toBe("members-svc");
    expect(p.outOfScope).toHaveLength(2);
    expect(p.context.map((c) => c.name)).not.toContain("UI Reference (Figma / Screenshots)"); // N/A
    expect(p.showcase).toContain("Clean up: remove test rows");
  });

  it("keeps reading the simple formats: numbered lists, AC-n lines, Gherkin scenarios", () => {
    expect(parseStory("Story\n\n## Acceptance criteria\n1. Shows the price.\n2. Shows the total,\n   updated live.\n\n## Notes\nx").acceptanceCriteria).toEqual([
      { id: "AC-1", text: "Shows the price." },
      { id: "AC-2", text: "Shows the total, updated live." },
    ]);
    expect(parseStory("*Acceptance Criteria*\nAC-2: second\nAC-1: first").acceptanceCriteria).toEqual([
      { id: "AC-2", text: "second" },
      { id: "AC-1", text: "first" },
    ]);
    const g = parseStory("Scenario: paid\n  Given an order\n  When it is paid\n  Then it shows paid\nScenario: refused\n  Given an order\n  When payment fails\n  Then it shows refused");
    expect(g.acFormat).toBe("gherkin");
    expect(g.acceptanceCriteria.map((a) => a.text)).toEqual(["Scenario: paid Given an order When it is paid Then it shows paid", "Scenario: refused Given an order When payment fails Then it shows refused"]);
    expect(normHeading("*In-scope:*")).toBe("in scope");
  });

  it("follows a team's own template from the config, and the v0.6.0 scope sections", () => {
    const c = cfg({
      requirements: {
        template: [
          { role: "acceptance-criteria", name: "Done when", headings: ["done when"] },
          { role: "scope", name: "Dev scope", prefix: "DS", headings: ["dev scope"] },
          { role: "out-of-scope", name: "Not now", headings: ["not now"] },
        ],
        scope: { sections: [{ prefix: "BR", name: "Business rule", headings: ["business rules"] }] },
      },
    });
    const p = parseStoryFor(c, "## Done when\n- it works\n## Dev scope\n- add a column\n## Business rules\n- max 3\n## Not now\n- exports\n## Acceptance criteria\n1. ignored: not in this team's template");
    expect(p.acceptanceCriteria).toEqual([{ id: "AC-1", text: "it works" }]);
    expect(p.scopeItems.map((x) => x.id)).toEqual(["DS-1", "BR-1"]);
    expect(p.outOfScope).toEqual(["exports"]);
    expect(() => cfg({ requirements: { template: [{ role: "scope", name: "x", headings: ["x"] }] } })).toThrow(/prefix/);
  });

  it("tells the agents what is out of scope", () => {
    const c = cfg();
    const p = parseStoryFor(c, wikiToMarkdown(wiki));
    const md = storyMarkdown({ schemaVersion: 1, source: "story-file", approvalStatus: "unverified", rawText: "x", capturedAt: "now", ...p } as any);
    expect(md).toContain("Explicitly OUT OF SCOPE");
    expect(md).toContain("- The mobile app");
    expect(md).toContain("TS-2 (Tech scope, console-bff)");
    expect(md).toContain("Services this story names: rewards-service, console-bff, console.");
  });

  it("story-check explains how a story is read and what to configure", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qas-check-"));
    fs.writeFileSync(path.join(dir, "qa-sentinel.config.yaml"), "version: 1\nmode: existing\nproject: { name: t }\ntests: { api: { framework: playwright, runCommand: x } }\nci: { platform: gitlab }\n");
    fs.writeFileSync(path.join(dir, "good.txt"), wiki);
    expect(await storyCheckCommand({ cwd: dir, storyFile: "good.txt" })).toBe(0);
    const good = fs.readFileSync(path.join(dir, "qa-story-check.md"), "utf8");
    expect(good).toContain("## Acceptance criteria · 2 (from a table)");
    expect(good).toContain("| Out of scope | out-of-scope · Out of scope |");
    fs.writeFileSync(path.join(dir, "bad.txt"), "## Definition of Awesome\n- it is awesome\n## Release notes\nsoon");
    expect(await storyCheckCommand({ cwd: dir, storyFile: "bad.txt" })).toBe(1);
    const bad = fs.readFileSync(path.join(dir, "qa-story-check.md"), "utf8");
    expect(bad).toContain("No acceptance criteria found");
    expect(bad).toContain('{ role: context, name: "Definition of Awesome", headings: ["Definition of Awesome"] }');
  });
});

import { initCommand } from "../src/commands/init.js";
import { loadConfig } from "../src/config.js";
describe("onboarding with init", () => {
  it("records the team's Jira, GitLab and layers, and writes the story template out for editing", async () => {
    const repo = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "qas-onb-")), "qa-tests");
    fs.mkdirSync(repo);
    await initCommand({ cwd: repo, yes: true, mode: "scratch", ci: "gitlab", level: "intelligence", name: "pay-tests", jiraUrl: "https://acme.atlassian.net/", jiraProjects: ["PAY", "CARD"], gitlabUrl: "https://gitlab.acme.test/", testRepoProject: "qa/pay-tests", web: true });
    const c = loadConfig(repo);
    expect(c.requirements.source).toBe("jira");
    expect(c.requirements.jira).toMatchObject({ baseUrl: "https://acme.atlassian.net", projectKeys: ["PAY", "CARD"] });
    expect(new RegExp(c.requirements.storyKeyPattern).test("feature/CARD-12-limits")).toBe(true);
    expect(new RegExp(`^(?:${c.requirements.storyKeyPattern})$`).test("SHOP-1")).toBe(false);
    expect(c.ci).toMatchObject({ gitlabUrl: "https://gitlab.acme.test", testRepoProject: "qa/pay-tests" });
    expect(c.tests.web.enabled).toBe(true);
    const yaml = fs.readFileSync(path.join(repo, "qa-sentinel.config.yaml"), "utf8");
    expect(yaml).toContain("template:");
    expect(yaml).toContain("out of scope");
  });
});

describe("AC numbering", () => {
  it("knows whether the story numbers its own ACs (stable ids) or qa-sentinel numbers them by position", () => {
    const own = parseStory("h2. Acceptance criteria\n* AC-2: shows the total\n* AC-5: shows the status\n");
    expect(own.acIdsFromStory).toBe(true);
    expect(own.acceptanceCriteria.map((a) => a.id)).toEqual(["AC-2", "AC-5"]);
    const positional = parseStory("h2. Acceptance criteria\n* shows the total\n* shows the status\n");
    expect(positional.acIdsFromStory).toBe(false);
    expect(positional.acceptanceCriteria.map((a) => a.id)).toEqual(["AC-1", "AC-2"]);
  });
});
