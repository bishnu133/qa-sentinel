import { describe, expect, it } from "vitest";
import { checkNewTests, checkTestMap, indexSource, parseTags, traceMarkdown, traceStory } from "../src/analysis/testIndex.js";

const SRC = `import { test, expect } from "../../../src/fixtures";
const tags = "@service:payments-service @endpoint:POST_/payments/{id}/refund @story:SHOP-102";

test.describe("POST /payments/{id}/refund", () => {
  test(\`partially refunds \${tags} @ac:AC-1\`, async ({ api }) => {
    const res = await api.post("/x", {});
    expect(res.status()).toBe(200);
    expect(1).toBe(1);
  });

  // QA-AGENT: AC-2 says the total can never exceed the amount
  test.fixme("returns 422 when partial refunds exceed the amount @service:payments-service @endpoint:POST_/payments/{id}/refund @story:SHOP-102 @ac:AC-2", async () => {
    expect(2).toBe(2);
  });

  test.step("not a test", async () => {});
});

test("legacy happy path (AC-3) @endpoint:GET_/payments/{id} @smoke", async () => {});
`;

describe("test index", () => {
  const idx = indexSource("tests/api/payments/refund.spec.ts", SRC);
  it("finds tests with status, describe, tags from constants, ACs and assertion counts", () => {
    expect(idx).toHaveLength(3);
    expect(idx[0]).toMatchObject({
      line: 5,
      title: "partially refunds",
      describe: "POST /payments/{id}/refund",
      status: "active",
      services: ["payments-service"],
      endpoints: ["POST /payments/{id}/refund"],
      stories: ["SHOP-102"],
      acs: ["AC-1"],
      assertions: 2,
    });
    expect(idx[1]).toMatchObject({ status: "fixme", acs: ["AC-2"], assertions: 1 });
    expect(idx[2]).toMatchObject({ describe: undefined, acs: ["AC-3"], endpoints: ["GET /payments/{id}"], tags: ["smoke"] });
  });
  it("parses comma-separated tags", () => {
    expect(parseTags("x @ac:AC-1,ac-4 @story:A-1").acs).toEqual(["AC-1", "AC-4"]);
  });
  it("builds a requirement matrix", () => {
    const t = traceStory(idx, "SHOP-102", [{ id: "AC-1" }, { id: "AC-2" }, { id: "AC-4" }]);
    expect(t.acs.map((r) => r.status)).toEqual(["covered", "pending-only", "not-traced"]);
    const md = traceMarkdown("SHOP-102", t);
    expect(md).toContain("| AC-2 | ⏸️ pending-only | – | `tests/api/payments/refund.spec.ts:12` returns 422");
  });
  it("checks tags against test-map.yaml", () => {
    const map = { services: { "payments-service": { endpoints: { "POST /payments/{id}/refund": ["tests/api/payments/refund.spec.ts"] } } } };
    const f = checkTestMap(idx, map);
    expect(f.map((x) => x.message)).toEqual([expect.stringContaining("@endpoint:GET_/payments/{id} but test-map.yaml does not list")]);
  });
  it("flags new tests without an endpoint or with unknown ACs", () => {
    const extra = indexSource("tests/api/n.spec.ts", `test("no tags @story:SHOP-102 @ac:AC-9", async () => {});`);
    const f = checkNewTests([...idx, ...extra], ["tests/api/n.spec.ts"], "SHOP-102", ["AC-1", "AC-2"]);
    expect(f.map((x) => x.message)).toEqual([expect.stringContaining("no @endpoint tag"), expect.stringContaining("AC-9, which is not in SHOP-102")]);
  });
});

describe("traceability status", () => {
  it("marks an AC with both passing and fixme tests as a discrepancy", () => {
    const idx = indexSource("t.spec.ts", `const t = "@story:S-1 @ac:AC-2 @endpoint:POST_/x";
test(\`single refund over the amount \${t}\`, async () => {});
test.fixme(\`cumulative refunds over the amount \${t}\`, async () => {});`);
    expect(idx[1].title).toBe("cumulative refunds over the amount");
    expect(traceStory(idx, "S-1", [{ id: "AC-2" }]).acs[0].status).toBe("discrepancy");
  });
});

describe("@ac:none and reviewer flags", () => {
  const idx = indexSource("r.spec.ts", `const t = "@story:S-1 @endpoint:POST_/x";
test(\`authorises \${t} @ac:AC-1\`, async () => {});
test(\`refunds \${t} @ac:AC-2\`, async () => {});
test.fixme(\`zero amount \${t} @ac:none\`, async () => {});`);
  it("treats @ac:none as deliberately outside the ACs, not as an AC called NONE", () => {
    expect(idx[2].acs).toEqual([]);
    expect(checkNewTests(idx, ["r.spec.ts"], "S-1", ["AC-1", "AC-2"])).toEqual([]);
    const tr = traceStory(idx, "S-1", [{ id: "AC-1" }, { id: "AC-2" }]);
    expect(tr.outsideAcs.map((x) => x.line)).toEqual([4]);
    expect(tr.storyOnly).toEqual([]);
  });
  it("shows an AC proven only by reviewer-flagged tests as weak", () => {
    const md = traceMarkdown("S-1", traceStory(idx, "S-1", [{ id: "AC-1" }, { id: "AC-2" }]), new Map([["r.spec.ts:2", "weak"]]));
    expect(md).toContain("| AC-1 | 🟠 weak | `r.spec.ts:2` authorises 🟠 _weak_ |");
    expect(md).toContain("| AC-2 | ✅ covered |");
    expect(md).toContain("Outside the story's ACs on purpose (`@ac:none`): `r.spec.ts:4` zero amount (fixme)");
  });
});
