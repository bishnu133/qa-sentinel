import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { nricValid, scanEvidence, scanJson, scanText } from "../src/showcase/pii.js";
import { piiGuard } from "../src/commands/showcase.js";
import { ConfigSchema } from "../src/config.js";

const all = { detect: ["nric", "email", "phone", "card"], allow: [], allowEmailDomains: [], custom: [] };

describe("personal data guard for evidence", () => {
  it("finds NRIC/FIN with a valid check letter, real emails, international phones and card numbers", () => {
    expect(nricValid("S", "1234567", "D")).toBe(true);
    expect(nricValid("S", "1234567", "A")).toBe(false);
    expect(nricValid("T", "1234567", "J")).toBe(true);
    const f = scanText("id S1234567D, ref S1234567A, mail jane.tan@gmail.com, test qa@shop.example.test, +65 9123 4567, order 20261017123456, card 4539 1488 0343 6467, test card 4111 1111 1111 1111", "x", all);
    expect(f.map((x) => `${x.kind}:${x.value}`)).toEqual(["nric:S12****7D", "email:ja***@gmail.com", "phone:+65******67", "card:453***********67"]);
  });

  it("reads API evidence as JSON: phone numbers under phone-like keys too, with the path; allows known test values", () => {
    const log = { calls: [{ method: "POST", path: "/users", request: { name: "Tan", mobile: "91234567", email: "bob@corp.com.sg" }, response: { id: 7 } }] };
    const f = scanJson(log, "api", all);
    expect(f.map((x) => [x.kind, x.where])).toEqual([
      ["phone", "api.calls[0].request.mobile"],
      ["email", "api.calls[0].request.email"],
    ]);
    expect(scanJson(log, "api", { ...all, allow: ["^9123\\d{4}$"], allowEmailDomains: ["corp.com.sg"] })).toEqual([]);
  });

  it("strips HTML before scanning (the PDF source and title cards)", () => {
    expect(scanEvidence([{ where: "evidence.html", text: '<td class="v">jane&#64;gmail.com</td><style>.a{}</style>' }], all)[0]).toMatchObject({ kind: "email", where: "evidence.html" });
  });

  it("checks everything a showcase would attach, including the pack's HTML and the API logs", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "qas-pii-"));
    const work = path.join(cwd, ".qa-sentinel/showcase/SHOP-1");
    fs.mkdirSync(work, { recursive: true });
    fs.writeFileSync(path.join(work, "evidence.html"), "<p>Customer S1234567D</p>");
    const apiLog = path.join(cwd, "api-log.json");
    fs.writeFileSync(apiLog, JSON.stringify({ calls: [{ response: { email: "real.person@gmail.com" } }] }));
    const c = ConfigSchema.parse({ version: 1, mode: "scratch", project: { name: "p" }, tests: { api: { framework: "playwright", runCommand: "x" } }, ci: { platform: "gitlab" } });
    const r = { story: "SHOP-1", ready: true, blockers: [], acs: [{ id: "AC-1", status: "passed", pending: [], tests: [{ test: { title: "t" }, result: { title: "t", status: "passed", evidence: [{ kind: "api-log", name: "api-log", path: apiLog }] } }] }] } as never;
    const found = piiGuard(cwd, c, r, [{ name: "summary.md", data: Buffer.from("all good"), contentType: "text/markdown" }] as never);
    expect(found.map((f) => f.kind).sort()).toEqual(["email", "nric"]);
    expect(piiGuard(cwd, ConfigSchema.parse({ ...c, showcase: { ...c.showcase, pii: { mode: "off" } } }), r, [])).toEqual([]);
  });
});
