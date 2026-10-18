import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { groupByToggles, togglesOf, withToggles } from "../src/toggles.js";
import { indexSource } from "../src/analysis/testIndex.js";
import { verifyChanges } from "../src/verification.js";

const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));

/** A fake flag service: one file per toggle in `dir`, holding its value. */
function flags(dir: string) {
  return {
    get: `cat ${dir}/{toggle} 2>/dev/null || echo off`,
    set: `echo {value} > ${dir}/{toggle} && echo "{toggle}={value}" >> ${dir}/history`,
  };
}
const config = (dir: string, extra: object = {}) =>
  ConfigSchema.parse({ version: 1, mode: "existing", project: { name: "p" }, tests: { api: { framework: "other", runCommand: "x" } }, ci: { platform: "gitlab" }, toggles: { environments: { sit: flags(dir) } }, ...extra });

describe("feature toggles", () => {
  it("reads @toggle tags and groups spec files by the toggle state they need", () => {
    const idx = [
      ...indexSource("a.spec.ts", 'test("new checkout @toggle:new-checkout=on", () => {});'),
      ...indexSource("b.spec.ts", 'test("old checkout @toggle:new-checkout=off,promo=on", () => {});'),
      ...indexSource("c.spec.ts", 'test("plain", () => {});'),
      ...indexSource("d.spec.ts", 'test("x @toggle:new-checkout=on", () => {});\ntest("y @toggle:new-checkout=off", () => {});'),
    ];
    expect(togglesOf(idx[1])).toEqual({ "new-checkout": "off", promo: "on" });
    const { groups, conflicts } = groupByToggles(["a.spec.ts", "b.spec.ts", "c.spec.ts", "d.spec.ts"], idx);
    expect(groups.map((g) => [g.toggles, g.files])).toEqual([
      [{ "new-checkout": "on" }, ["a.spec.ts"]],
      [{ "new-checkout": "off", promo: "on" }, ["b.spec.ts"]],
      [{}, ["c.spec.ts"]],
    ]);
    expect(conflicts).toEqual([{ file: "d.spec.ts", toggle: "new-checkout" }]);
  });

  it("sets toggles, runs, and always puts them back – also when the run throws", async () => {
    const dir = tmp("qas-flags-");
    fs.writeFileSync(path.join(dir, "promo"), "on\n");
    const c = config(dir);
    const seen: string[] = [];
    await withToggles(c, "sit", { "new-checkout": "on", promo: "on" }, process.env, async () => void seen.push(fs.readFileSync(path.join(dir, "new-checkout"), "utf8").trim()));
    expect(seen).toEqual(["on"]);
    expect(fs.readFileSync(path.join(dir, "new-checkout"), "utf8").trim()).toBe("off"); // back to what it was
    expect(fs.readFileSync(path.join(dir, "history"), "utf8").trim().split("\n")).toEqual(["new-checkout=on", "new-checkout=off"]); // promo was already on: untouched

    await expect(withToggles(c, "sit", { "new-checkout": "on" }, process.env, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(fs.readFileSync(path.join(dir, "new-checkout"), "utf8").trim()).toBe("off");
  });

  it("verification runs each toggle group with its toggles set", async () => {
    const dir = tmp("qas-flags-");
    const repo = tmp("qas-toggle-repo-");
    fs.mkdirSync(path.join(repo, "tests/api"), { recursive: true });
    fs.writeFileSync(path.join(repo, "tests/api/new.spec.ts"), 'test("new checkout @toggle:new-checkout=on", () => {});\n');
    fs.writeFileSync(path.join(repo, "tests/api/old.spec.ts"), 'test("old checkout", () => {});\n');
    // The runner records which toggle value each spec saw, and writes JUnit.
    fs.writeFileSync(
      path.join(repo, "run.mjs"),
      `import fs from "node:fs"; const v = (()=>{try{return fs.readFileSync(${JSON.stringify(dir)}+"/new-checkout","utf8").trim()}catch{return "off"}})();
const specs = process.argv.slice(2); fs.appendFileSync("seen.txt", specs.map((s) => s + "=" + v).join("\\n") + "\\n");
fs.mkdirSync("out", { recursive: true }); fs.writeFileSync("out/junit.xml", "<testsuite>" + specs.map((s) => '<testcase name="t" classname="' + s + '"/>').join("") + "</testsuite>");`,
    );
    const c = config(dir, { tests: { api: { framework: "other", runCommand: "node run.mjs" } }, verification: { junitPath: "out/junit.xml", typecheck: "never", preflight: false } });
    const runDir = tmp("qas-run-");
    const r = await verifyChanges({ cwd: repo, c, environment: "sit", runDir, env: process.env, changes: [{ path: "tests/api/new.spec.ts", status: "A" }, { path: "tests/api/old.spec.ts", status: "A" }] });
    expect(fs.readFileSync(path.join(repo, "seen.txt"), "utf8").trim().split("\n").sort()).toEqual(["tests/api/new.spec.ts=on", "tests/api/old.spec.ts=off"]);
    expect(r.status).toBe("VERIFIED");
    expect(r.checks.filter((x) => x.name === "tests").map((x) => x.detail)).toEqual([expect.stringContaining("toggles new-checkout=on"), expect.not.stringContaining("toggles")]);
    expect(fs.readFileSync(path.join(dir, "new-checkout"), "utf8").trim()).toBe("off");
  });
});

describe("toggle command safety", () => {
  it("never puts get output or odd names into a shell command", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qas-flags-"));
    const marker = path.join(dir, "PWNED");
    const c = ConfigSchema.parse({ version: 1, mode: "existing", project: { name: "p" }, tests: { api: { framework: "other", runCommand: "x" } }, ci: { platform: "gitlab" }, toggles: { environments: { sit: { get: `echo 'off; touch ${marker}'`, set: `echo {value} > ${dir}/{toggle}` } }, defaults: { x: "off" } } });
    const r = await withToggles(c, "sit", { x: "on" }, process.env, async () => "ran");
    expect(r.result).toBe("ran");
    expect(fs.existsSync(marker)).toBe(false);
    expect(fs.readFileSync(path.join(dir, "x"), "utf8").trim()).toBe("off"); // back to the configured default
    expect(r.problems.join(" ")).toMatch(/not a plain value/);
    await expect(withToggles(c, "sit", { "a;b": "on" }, process.env, async () => 1)).rejects.toThrow(/refusing toggle/);
  });
});

describe("post-deploy runs only the story's tests", () => {
  it("passes the story tag to Playwright as --grep, so other tests in the same file don't decide the result", async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "qas-grep-"));
    fs.mkdirSync(path.join(repo, "tests/api"), { recursive: true });
    fs.writeFileSync(path.join(repo, "tests/api/orders.spec.ts"), 'test("qty 0 @story:SHOP-101", () => {});\ntest("other", () => {});\n');
    // Stand-in for `playwright test`: records its arguments, writes JUnit where Playwright would.
    fs.writeFileSync(
      path.join(repo, "pw.mjs"),
      `import fs from "node:fs"; fs.writeFileSync("args.json", JSON.stringify(process.argv.slice(2)));
fs.writeFileSync(process.env.PLAYWRIGHT_JUNIT_OUTPUT_NAME, '<testsuite><testcase name="qa" classname="tests/api/orders.spec.ts"/></testsuite>');`,
    );
    const c = ConfigSchema.parse({ version: 1, mode: "existing", project: { name: "p" }, tests: { api: { framework: "playwright", runCommand: "node pw.mjs" } }, ci: { platform: "gitlab" }, verification: { typecheck: "never", preflight: false } });
    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "qas-run-"));
    const grep = "@story:(?:\\S*,)?SHOP-101(?![\\w-])";
    const r = await verifyChanges({ cwd: repo, c, runDir, env: process.env, changes: [{ path: "tests/api/orders.spec.ts", status: "M" }], grep });
    const args: string[] = JSON.parse(fs.readFileSync(path.join(repo, "args.json"), "utf8"));
    expect(args[args.indexOf("--grep") + 1]).toBe(grep);
    expect(r.status).toBe("VERIFIED");
    const re = new RegExp(grep, "i");
    expect(["qty 0 @story:SHOP-101", "x @story:SHOP-7,SHOP-101"].every((t) => re.test(t))).toBe(true);
    expect(["x @story:SHOP-1010", "x @story:SHOP-101-b", "x @story:SHOP-10"].some((t) => re.test(t))).toBe(false);
  });
});
