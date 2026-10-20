import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { type ExpectedFile, ExpectedFileError, acHash, freshness, mergeExpected, normaliseAcText, parseExpected, readExpected, renderExpected, writeExpected } from "../src/expected/format.js";

const AC1 = "A slot takes at most 3 orders.";
const AC2 = "The confirmation email names the slot.";
const story = [
  { id: "AC-1", text: AC1 },
  { id: "AC-2", text: AC2 },
];

const proposal = (): ExpectedFile => ({
  version: 1,
  story: "SHOP-101",
  title: "Delivery slots",
  acs: [
    {
      id: "AC-1",
      hash: acHash(AC1),
      text: AC1,
      services: ["orders-service"],
      behaviours: [
        { id: "B1", kind: "main", statement: "A third order for a slot is accepted", expect: { maxOrdersPerSlot: 3, status: 201 }, state: "ready", source: "ac" },
        { id: "B2", kind: "boundary", statement: "A fourth order for a full slot is rejected", expect: { status: 409 }, state: "ready", source: "ac" },
      ],
    },
    {
      id: "AC-2",
      hash: acHash(AC2),
      text: AC2,
      services: ["notifications-service"],
      behaviours: [{ id: "B3", kind: "main", statement: "The email shows the slot's date and time", expect: {}, state: "unspecified", question: "Which time format: 24h or am/pm?", source: "ac" }],
    },
  ],
});

describe("AC text normalisation", () => {
  it("ignores formatting, numbering, case, spacing and closing punctuation, not words or numbers", () => {
    const h = acHash("A slot takes at most 3 orders.");
    expect(acHash("AC-1: a slot takes *at most* 3 orders")).toBe(h);
    expect(acHash("1. A  slot takes at most 3 orders;")).toBe(h);
    expect(acHash("- A slot takes {color:red}at most{color} 3 orders")).toBe(h);
    expect(acHash("A slot takes at most 5 orders.")).not.toBe(h);
    expect(acHash("A slot takes at least 3 orders.")).not.toBe(h);
    expect(normaliseAcText("Use the max_orders setting.")).toContain("max_orders"); // snake_case survives
    expect(acHash("5.5% fee applies")).not.toBe(acHash("7.5% fee applies"));
    expect(acHash("-1 quantity is rejected")).not.toBe(acHash("1 quantity is rejected"));
    expect(normaliseAcText("Values <max and total> are shown")).toContain("<max and total>");
    expect(acHash("<p>A slot takes at most 3 orders</p>")).toBe(h);
  });
});

describe("expected file", () => {
  it("round-trips: render then parse gives the same data, and rendering is stable", () => {
    const f = parseExpected(renderExpected(proposal()));
    expect(f).toEqual(proposal());
    expect(renderExpected(f)).toBe(renderExpected(proposal()));
    expect(renderExpected(f)).toContain("| B3 | main | The email shows the slot's date and time | – | unspecified: Which time format: 24h or am/pm? |");
  });

  it("names every problem with its path", () => {
    expect(() => parseExpected("# no data block")).toThrow(ExpectedFileError);
    const bad = renderExpected(proposal()).replace("id: B3", "id: B1");
    expect(() => parseExpected(bad, "expected/SHOP-101.md")).toThrow(/expected\/SHOP-101\.md: .*behaviour id B1 is used in AC-1 and AC-2/);
    const noQuestion = renderExpected(proposal()).replace(/\n\s+question: .*\n/, "\n");
    expect(() => parseExpected(noQuestion)).toThrow(/unspecified behaviour needs a question/);
  });

  it("reads and writes under the expected folder", () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "qas-exp-"));
    expect(readExpected(repo, "expected", "SHOP-101")).toBeUndefined();
    expect(writeExpected(repo, "expected", proposal())).toBe("expected/SHOP-101.md");
    expect(readExpected(repo, "expected", "SHOP-101")).toEqual(proposal());
  });
});

describe("merging a new proposal into the stored file", () => {
  it("is a zero diff when the story didn't change, and QA edits survive", () => {
    const stored = proposal();
    stored.acs[0].behaviours[1].expect = { status: 422 }; // QA corrected it
    const again = proposal();
    again.acs[0].behaviours[0].statement = "reworded by the AI this time";
    const { file, changes } = mergeExpected(stored, again, story);
    expect(renderExpected(file)).toBe(renderExpected(stored));
    expect(changes).toEqual([]);
  });

  it("follows a renumbered AC by its text and keeps behaviour ids", () => {
    const { file, changes } = mergeExpected(proposal(), proposal(), [
      { id: "AC-1", text: "Customers can pick a slot." },
      { id: "AC-2", text: AC1 },
      { id: "AC-3", text: AC2 },
    ]);
    const ac2 = file.acs.find((a) => a.id === "AC-2")!;
    expect(ac2.behaviours.map((b) => b.id)).toEqual(["B1", "B2"]);
    expect(file.acs.find((a) => a.id === "AC-3")!.behaviours.map((b) => b.id)).toEqual(["B3"]);
    expect(changes).toContain("AC-1 is now AC-2 (renumbered, same text)");
    expect(file.acs.find((a) => a.id === "AC-1")!.behaviours).toEqual([]); // the new AC-1 has no proposal yet
  });

  it("revises an edited AC from the proposal, keeps what the proposal dropped as needs-review, and gives new ids", () => {
    const edited = "A slot takes at most 5 orders.";
    const prop = proposal();
    prop.acs[0] = { ...prop.acs[0], hash: acHash(edited), text: edited, behaviours: [{ id: "B1", kind: "main", statement: "A fifth order is accepted", expect: { maxOrdersPerSlot: 5 }, state: "ready", source: "ac" }, { id: "B9", kind: "negative", statement: "A sixth order is rejected", expect: { status: 409 }, state: "ready", source: "ac" }] };
    const { file, changes } = mergeExpected(proposal(), prop, [{ id: "AC-1", text: edited }, { id: "AC-2", text: AC2 }]);
    const ac1 = file.acs[0];
    expect(ac1.hash).toBe(acHash(edited));
    expect(ac1.behaviours.find((b) => b.id === "B1")!.expect).toEqual({ maxOrdersPerSlot: 5 });
    expect(ac1.behaviours.find((b) => b.id === "B2")!.state).toBe("needs-review");
    expect(ac1.behaviours.find((b) => b.id === "B9")).toBeDefined(); // unused id kept
    expect(changes).toContain("AC-1 changed in the story: expectations revised for review");
  });

  it("never reuses an id that is already taken", () => {
    const prop = proposal();
    const newAc = "Customers can pick a slot.";
    prop.acs.push({ id: "AC-3", hash: acHash(newAc), text: newAc, services: [], behaviours: [{ id: "B1", kind: "main", statement: "x", expect: {}, state: "ready", source: "ac" }] });
    const { file } = mergeExpected(proposal(), prop, [...story, { id: "AC-3", text: newAc }]);
    expect(file.acs[2].behaviours[0].id).toBe("B4");
  });

  it("fills an empty placeholder from a later proposal, without touching the other ACs", () => {
    const stored = proposal();
    stored.acs[1].behaviours = [];
    const { file, changes } = mergeExpected(stored, proposal(), story);
    expect(file.acs[1].behaviours.map((b) => b.id)).toEqual(["B3"]);
    expect(file.acs[0]).toEqual(stored.acs[0]);
    expect(changes).toEqual(["AC-2: expectations added"]);
  });

  it("brings back an AC whose text returns to the story, with QA's behaviours, and keeps QA's notes", () => {
    const { file: gone } = mergeExpected(proposal(), proposal(), [{ id: "AC-1", text: AC1 }]);
    gone.acs[1].behaviours[0].note = "QA: checked with Priya";
    const { file, changes } = mergeExpected(gone, proposal(), story);
    expect(file.acs.map((a) => [a.id, a.removed ?? false])).toEqual([
      ["AC-1", false],
      ["AC-2", false],
    ]);
    expect(file.acs[1].behaviours[0].note).toBe("QA: checked with Priya; the AC is back in the story: check it");
    expect(changes).toContain("AC-2 is back in the story: its earlier expectations restored for review");
  });

  it("keeps an AC removed from the story, marked, and ignores ACs the proposal invented", () => {
    const prop = proposal();
    prop.acs.push({ id: "AC-9", hash: acHash("made up"), text: "made up", services: [], behaviours: [] });
    const { file, changes } = mergeExpected(proposal(), prop, [{ id: "AC-1", text: AC1 }]);
    expect(file.acs.map((a) => [a.id, a.removed ?? false])).toEqual([
      ["AC-1", false],
      ["AC-2", true],
    ]);
    expect(file.acs[1].behaviours.every((b) => b.state === "needs-review")).toBe(true);
    expect(changes).toContain("AC-9 was proposed but isn't in the story: ignored");
  });

  it("reports per AC whether its expectations are current", () => {
    const f = proposal();
    expect([...freshness(f, story)]).toEqual([
      ["AC-1", "current"],
      ["AC-2", "current"],
    ]);
    expect(Object.fromEntries(freshness(f, [{ id: "AC-1", text: "changed" }, { id: "AC-3", text: "new one" }]))).toEqual({ "AC-1": "changed", "AC-3": "new", "AC-2": "removed" });
    expect(Object.fromEntries(freshness(undefined, story))).toEqual({ "AC-1": "new", "AC-2": "new" });
  });
});
