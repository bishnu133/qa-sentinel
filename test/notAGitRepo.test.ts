import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { ConfigSchema, writeConfig } from "../src/config.js";

const ROOT = path.resolve(__dirname, "..");
const cli = (cwd: string, ...args: string[]) =>
  spawnSync(path.join(ROOT, "node_modules/.bin/tsx"), [path.join(ROOT, "src/cli.ts"), ...args], {
    cwd,
    encoding: "utf8",
    timeout: 60_000,
    env: { PATH: process.env.PATH, HOME: os.tmpdir(), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CEILING_DIRECTORIES: path.dirname(cwd) },
  });

function folder() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qas-nogit-"));
  writeConfig(dir, ConfigSchema.parse({ version: 1, mode: "scratch", project: { name: "p" }, tests: { api: { framework: "playwright", runCommand: "x" } }, ci: { platform: "gitlab" }, workspace: { services: [{ name: "orders", path: "orders" }] } }));
  fs.mkdirSync(path.join(dir, "orders"));
  return dir;
}

describe("a folder that is not a git repository", () => {
  it("doctor says so in its own words and does not let git's 'fatal:' lines through", () => {
    const r = cli(folder(), "doctor");
    const all = `${r.stdout}\n${r.stderr}`;
    expect(all).not.toMatch(/fatal:/);
    expect(all).toMatch(/test repo is a git repository/);
    expect(all).toMatch(/git init/);
  }, 90_000);

  it("release-features names the service folder that is not a git repository, without git's own error", () => {
    const r = cli(folder(), "release-features", "--tag", "v1");
    const all = `${r.stdout}\n${r.stderr}`;
    expect(all).not.toMatch(/fatal:/);
    expect(all).toMatch(/orders: .*is not a git repository/);
  }, 90_000);
});
