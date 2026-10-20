import { describe, expect, it } from "vitest";
import { classifyFailure } from "../src/reporting/taxonomy.js";
import { verificationMarkdown } from "../src/verification.js";

describe("result categories", () => {
  it("defaults to unclassified; never calls a failure a product defect by itself", () => {
    expect(classifyFailure({ message: "expect(received).toBe(expected) Expected: 409 Received: 201" })).toBe("unclassified");
    expect(classifyFailure({ message: "Received: 500" })).toBe("unclassified");
    expect(classifyFailure({ knownDefect: true })).toBe("product-defect");
  });
  it("recognises the environment, deployment and not-built cases", () => {
    expect(classifyFailure({ message: "apiRequestContext.post: connect ECONNREFUSED 127.0.0.1:8080" })).toBe("environment");
    expect(classifyFailure({ message: "page.goto: net::ERR_NAME_NOT_RESOLVED" })).toBe("environment");
    expect(classifyFailure({ message: "Error: self-signed certificate in certificate chain" })).toBe("environment");
    expect(classifyFailure({ message: "Expected 200, got 503 Service Unavailable" })).toBe("environment");
    expect(classifyFailure({ message: "x", waitingForDeployment: true })).toBe("not-deployed");
    expect(classifyFailure({ message: "x", notBuilt: true })).toBe("not-built");
  });
  it("labels failures in the verification report", () => {
    const md = verificationMarkdown({ status: "FAILED", checks: [], cases: [{ name: "a", status: "failed", message: "Expected: 409 Received: 201" }, { name: "b", status: "failed", message: "ECONNRESET" }], counts: { total: 2, passed: 0, failed: 2, skipped: 0 } });
    expect(md).toMatch(/unclassified – needs triage: `a`/);
    expect(md).toMatch(/environment: `b`/);
  });
});
