import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readManualCards, writeCards, parseCards } from "../src/manualTests.js";
import { validatePlan } from "../src/plan/validate.js";
import { acStandings } from "../src/reporting/jiraSummary.js";
import { implementationMarkdown, manualTestsMarkdown } from "../src/plan/render.js";
import { indexSource, traceStory, traceMarkdown } from "../src/analysis/testIndex.js";
import { assessStory } from "../src/showcase/showcase.js";
import { ConfigSchema } from "../src/config.js";

const card = { requirementIds: ["AC-2"], title: "Confirmation email looks right", why: "layout needs a person's eye", preconditions: ["a real inbox"], steps: ["Place an order", "Open the email"], expected: ["Slot time shown", "Brand footer"] };

const plan = (extra: object = {}) => ({
  schemaVersion: 1,
  verdict: "v",
  recommendedAction: "r",
  changes: [{ id: "c1", type: "business-rule", summary: "s", observable: true, oracleStatus: "approved", requirementIds: ["AC-1"], riskFactors: ["business-rule"], evidence: [{ source: "source-code", file: "x.js", reference: "r" }] }],
  decisions: [{ changeId: "c1", decision: "create", reason: "new behaviour", coverage: "missing", existingTests: [], proposedScenarios: [{ title: "t", layer: "api", requirementIds: ["AC-1"], assertions: ["a"] }], evidence: [{ source: "source-code", file: "x.js", reference: "r" }] }],
  impactedTests: [],
  acMismatches: [],
  specDrift: [],
  requirementStatus: [
    { id: "AC-1", status: "implemented", where: "x.js:1", evidence: [{ source: "source-code", file: "x.js", reference: "r" }] },
    { id: "AC-2", status: "implemented", where: "m.js:1", evidence: [{ source: "source-code", file: "x.js", reference: "r" }], automation: { how: "manual", reason: "visual" } },
    { id: "AC-3", status: "implemented", where: "j.js:1", evidence: [{ source: "source-code", file: "x.js", reference: "r" }], automation: { how: "hook", reason: "nightly job", hook: "POST /test/jobs/run" } },
  ],
  manualTests: [card],
  ...extra,
});

describe("automatability triage and manual test cards (A3)", () => {
  const ctx = (repo: string) => ({ acIds: ["AC-1", "AC-2", "AC-3"], scopeIds: [], requirementsMissing: false, testRepo: repo, serviceRepo: repo, layers: ["api"], defaultLayer: "api" }) as never;

  it("validates the triage: reasons, named hooks, cards for manual items", () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "qas-manual-"));
    fs.writeFileSync(path.join(repo, "x.js"), "x");
    const ok = validatePlan(plan(), ctx(repo));
    expect(ok.errors).toEqual([]);
    const bad = validatePlan(
      plan({
        requirementStatus: [
          { id: "AC-1", status: "implemented", where: "x.js:1", evidence: [{ source: "source-code", file: "x.js", reference: "r" }] },
          { id: "AC-2", status: "implemented", where: "x", evidence: [{ source: "source-code", file: "x.js", reference: "r" }], automation: { how: "manual" } },
          { id: "AC-3", status: "implemented", where: "x", evidence: [{ source: "source-code", file: "x.js", reference: "r" }], automation: { how: "hook", reason: "job" } },
        ],
        manualTests: [],
      }),
      ctx(repo),
    );
    expect(bad.errors).toEqual(expect.arrayContaining([expect.stringMatching(/AC-2: automation "manual" needs a reason/), expect.stringMatching(/AC-3: automation "hook" must name the hook/)]));
    expect(bad.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/AC-2: manual, but no manualTests card/)]));
  });

  it("reports manual and hook items as such, not as missing tests", () => {
    const p = validatePlan(plan(), ctx(fs.mkdtempSync(path.join(os.tmpdir(), "qas-m-")))).plan ?? (plan() as never);
    const st = acStandings(p as never, ["AC-1", "AC-2", "AC-3"]);
    expect([...st.values()]).toEqual(["needs-tests", "manual", "needs-hook"]);
    const md = implementationMarkdown(p as never, [{ id: "AC-2", text: "email" }, { id: "AC-3", text: "reminder" }]);
    expect(md).toContain("✋ by hand (visual)");
    expect(md).toContain("🔌 needs a test hook: POST /test/jobs/run (nightly job)");
    expect(manualTestsMarkdown(p as never)).toContain("AC-2: Confirmation email looks right – layout needs a person's eye");
  });

  it("saves cards next to the tests without overwriting edited ones, and counts them in traceability and the showcase", () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "qas-cards-"));
    expect(writeCards(repo, "manual-tests", "SHOP-1", "SHOP-1", [card])).toEqual({ file: "manual-tests/SHOP-1.md", added: 1 });
    const file = path.join(repo, "manual-tests/SHOP-1.md");
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("Open the email", "Open the email on a phone")); // QA edits it
    expect(writeCards(repo, "manual-tests", "SHOP-1", "SHOP-1", [card]).added).toBe(0);
    expect(fs.readFileSync(file, "utf8")).toContain("on a phone");
    const cards = readManualCards(repo, "manual-tests");
    expect(cards).toEqual([{ story: "SHOP-1", acs: ["AC-2"], title: "Confirmation email looks right", file: "manual-tests/SHOP-1.md", line: 6 }]);
    expect(parseCards("x.md", "## AC-9: t\n<!-- qa-sentinel: @story:S-1 @ac:AC-9 -->")[0].acs).toEqual(["AC-9"]);

    const index = indexSource("tests/api/a.spec.ts", 'test("books @story:SHOP-1 @ac:AC-1", async () => { expect(1).toBe(1); });');
    const trace = traceStory(index, "SHOP-1", [{ id: "AC-1" }, { id: "AC-2" }, { id: "AC-3" }], cards);
    expect(trace.acs.map((a) => a.status)).toEqual(["covered", "manual", "not-traced"]);
    expect(traceMarkdown("SHOP-1", trace)).toContain("✋ checked by hand | manual card `manual-tests/SHOP-1.md:6`");

    const c = ConfigSchema.parse({ version: 1, mode: "scratch", project: { name: "p" }, tests: { api: { framework: "playwright", runCommand: "x" } }, ci: { platform: "gitlab" } });
    const results = [{ file: "tests/api/a.spec.ts", line: 1, title: "books", status: "passed" as const, evidence: [] }];
    const r = assessStory(c, index, results, "SHOP-1", [{ id: "AC-1" }, { id: "AC-2" }], cards);
    expect(r).toMatchObject({ ready: true, blockers: [] });
    expect(r.acs.map((a) => a.status)).toEqual(["passed", "manual"]);
  });
});
