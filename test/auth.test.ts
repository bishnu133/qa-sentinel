import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { render } from "../src/templates.js";
import { ConfigSchema } from "../src/config.js";
import { testEnv } from "../src/run.js";

async function load() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qas-auth-"));
  fs.writeFileSync(path.join(dir, "auth.ts"), render(fs.readFileSync(path.join(__dirname, "../templates/scaffold/playwright-api/src/api/auth.ts.tmpl"), "utf8"), { authRolesJson: JSON.stringify({ officer: ["OFFICER_LOGIN", "OFFICER_SECRET"] }) }));
  return import(path.join(dir, "auth.ts"));
}

describe("auth patterns (D3)", () => {
  it("TOTP matches the RFC 6238 test vector", async () => {
    const { totp } = await load();
    // RFC 6238, SHA-1 seed "12345678901234567890" (base32 below), T = 59 s → 94287082 (8 digits).
    expect(totp("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", 59_000, 8)).toBe("94287082");
    expect(totp("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", 1111111109_000, 8)).toBe("07081804");
  });

  it("DPoP proofs are valid ES256 JWTs bound to the method, URL and access token", async () => {
    const { dpopKey, dpopProof } = await load();
    const key = dpopKey();
    const jwt = dpopProof(key, "post", "https://api.example.test/orders?x=1#f", "tok");
    const [h, p, sig] = jwt.split(".");
    const header = JSON.parse(Buffer.from(h, "base64url").toString());
    const payload = JSON.parse(Buffer.from(p, "base64url").toString());
    expect(header).toMatchObject({ typ: "dpop+jwt", alg: "ES256", jwk: { kty: "EC", crv: "P-256" } });
    expect(header.jwk.d).toBeUndefined(); // never the private key
    expect(payload).toMatchObject({ htm: "POST", htu: "https://api.example.test/orders", ath: crypto.createHash("sha256").update("tok").digest("base64url") });
    const pub = crypto.createPublicKey({ key: header.jwk, format: "jwk" });
    expect(crypto.verify("sha256", Buffer.from(`${h}.${p}`), { key: pub, dsaEncoding: "ieee-p1363" }, Buffer.from(sig, "base64url"))).toBe(true);
  });

  it("the scaffolded role() reads the variables tests.auth.roles names", async () => {
    const { role } = await load();
    process.env.OFFICER_LOGIN = "o1";
    process.env.QA_ADMIN_USER = "a1";
    try {
      expect(role("officer").user).toBe("o1");
      expect(role("admin").user).toBe("a1");
    } finally {
      delete process.env.OFFICER_LOGIN;
      delete process.env.QA_ADMIN_USER;
    }
  });

  it("role credentials reach test runs from the environment, not the agent unless shared", async () => {
    const { agentEnv } = await import("../src/run.js");
    const c2 = ConfigSchema.parse({ version: 1, mode: "scratch", project: { name: "p" }, tests: { api: { framework: "playwright", runCommand: "x" }, auth: { roles: [{ name: "case officer" }] } }, ci: { platform: "gitlab" } });
    expect(agentEnv(c2, { PATH: "/bin", QA_CASE_OFFICER_PASSWORD: "p" }).QA_CASE_OFFICER_PASSWORD).toBeUndefined();
    const shared = ConfigSchema.parse({ ...c2, tests: { ...c2.tests, auth: { ...c2.tests.auth, shareWithAgent: true } } });
    expect(agentEnv(shared, { PATH: "/bin", QA_CASE_OFFICER_PASSWORD: "p" }).QA_CASE_OFFICER_PASSWORD).toBe("p");
  });

  it("role credentials reach test runs from the environment, nothing else does", () => {
    const c = ConfigSchema.parse({ version: 1, mode: "scratch", project: { name: "p" }, tests: { api: { framework: "playwright", runCommand: "x" }, auth: { roles: [{ name: "case officer" }] } }, ci: { platform: "gitlab" } });
    const env = testEnv(c, { PATH: "/bin", QA_CASE_OFFICER_USER: "u", QA_CASE_OFFICER_PASSWORD: "p", QA_OTHER_PASSWORD: "x" });
    expect(env).toMatchObject({ QA_CASE_OFFICER_USER: "u", QA_CASE_OFFICER_PASSWORD: "p" });
    expect(env.QA_OTHER_PASSWORD).toBeUndefined();
  });
});

import { indexFeature } from "../src/analysis/testIndex.js";
describe("Cucumber features in the test index (D4)", () => {
  it("indexes scenarios with feature and scenario tags", () => {
    const src = `@service:orders-service
Feature: Delivery slots

  Background:
    Given a customer

  @endpoint:POST_/orders @story:SHOP-101 @ac:AC-1
  Scenario: order with a slot
    When I order with a slot
    Then the order is confirmed
    And the slot is shown

  @story:SHOP-101 @ac:AC-3 @fixme
  Scenario Outline: slot full
    Then I get <code>
`;
    const t = indexFeature("features/slots.feature", src);
    expect(t.map((x) => [x.line, x.title, x.status, x.services, x.endpoints, x.acs, x.assertions])).toEqual([
      [8, "order with a slot", "active", ["orders-service"], ["POST /orders"], ["AC-1"], 2],
      [14, "slot full", "fixme", ["orders-service"], [], ["AC-3"], 1],
    ]);
  });
});
