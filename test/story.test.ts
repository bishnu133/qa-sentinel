import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { combinedChange, storyParts, storyRange } from "../src/story.js";

const g = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();
function repo(dir: string, commits: [string, string, string][]) {
  fs.mkdirSync(dir, { recursive: true });
  g(dir, "init", "-q", "-b", "main");
  for (const [file, content, msg] of commits) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), content);
    g(dir, "add", "-A");
    g(dir, "-c", "user.name=d", "-c", "user.email=d@x", "commit", "-q", "-m", msg);
  }
}

describe("story mode", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "qas-story-"));
  repo(path.join(ws, "orders"), [
    ["src/a.js", "1", "initial"],
    ["src/a.js", "2", "SHOP-106: ship endpoint"],
    ["src/b.js", "x", "SHOP-106: tracking number"],
    ["src/c.js", "y", "SHOP-1060: unrelated story"],
  ]);
  repo(path.join(ws, "notifications"), [
    ["n.js", "1", "initial"],
    ["n.js", "2", "SHOP-106 shipping template"],
  ]);
  repo(path.join(ws, "payments"), [["p.js", "1", "initial"]]);
  const tests = path.join(ws, "qa-tests");
  fs.mkdirSync(tests);
  const c = ConfigSchema.parse({
    version: 1,
    mode: "scratch",
    project: { name: "p" },
    workspace: { services: [{ name: "orders", path: "../orders" }, { name: "notifications", path: "../notifications", kind: "web", routes: ["/x"] }, { name: "payments", path: "../payments" }] },
    tests: { api: { framework: "playwright", runCommand: "x" } },
    ci: { platform: "gitlab" },
  });

  it("finds each repo's story range from the first story commit, ignoring look-alike keys", () => {
    const orders = path.join(ws, "orders");
    const r = storyRange(orders, "SHOP-106", g(orders, "rev-parse", "HEAD~1"))!;
    expect(g(orders, "log", "-1", "--format=%s", r.base)).toBe("initial");
    expect(storyRange(path.join(ws, "payments"), "SHOP-106", "HEAD")).toBeUndefined();
  });

  it("assembles the parts and one combined view", async () => {
    const { parts } = await storyParts({ c, cwd: tests, story: "SHOP-106" });
    expect(parts.map((p) => [p.service.name, p.relevant.sort()])).toEqual([
      ["orders", ["src/a.js", "src/b.js"]],
      ["notifications", ["n.js"]],
    ]);
    const v = combinedChange("SHOP-106", parts);
    expect(v.relevant).toEqual(expect.arrayContaining(["orders/src/a.js", "notifications/n.js"]));
    expect(v.cs.diff).toContain("# ===== service: notifications");
    expect(v.service).toMatchObject({ name: "story-SHOP-106", kind: "web", routes: ["/x"] });
  });
});
