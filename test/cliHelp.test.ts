import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("qa-sentinel --help", () => {
  it("opens with a line that covers what the tool does today, not only gap reports and API tests", () => {
    const root = path.resolve(__dirname, "..");
    const r = spawnSync(path.join(root, "node_modules/.bin/tsx"), [path.join(root, "src/cli.ts"), "--help"], { encoding: "utf8", timeout: 60_000 });
    const top = r.stdout.split("\n\n")[1] ?? "";
    expect(top).not.toMatch(/gap reports and API test generation from dev changes/);
    expect(top.replace(/\s+/g, " ")).toMatch(/web and mobile test generation.*evidence/);
  }, 90_000);
});
