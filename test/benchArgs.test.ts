import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseFlags } from "../bench/args.js";
import { main } from "../bench/run.js";
import { mutateMain } from "../bench/mutate.js";
import { cleanTmp, tmp } from "./helpers/mocks.js";

afterEach(() => {
  vi.restoreAllMocks();
  cleanTmp();
});

const spies = () => ({ runScenario: vi.fn(async () => { throw new Error("a paid scenario run started"); }), generationMain: vi.fn(async () => { throw new Error("the paid generation benchmark started"); }) });
const quiet = () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
};

describe("bench arguments: anything unclear is a usage error before anything paid can start", () => {
  const bad: string[][] = [
    ["--summarise"],
    ["--summarise", "--runs", "3"],
    ["--summarize", "x.json"],
    ["--runs"],
    ["--runs", "abc"],
    ["--runs", "0"],
    ["--runs", "-1"],
    ["--runs", "2.5"],
    ["--parallel", "0"],
    ["--parallel"],
    ["--only"],
    ["--only", "--runs", "2"],
    ["--only", "nope"],
    ["--only", "new-validation,,x"],
    ["stray"],
    ["--features", "--generate"],
    ["--generate", "--summarise", "x.json"],
    ["--generate", "--only", "nope"],
    ["--summarise", "/no/such/file.json"],
  ];
  it.each(bad)("%s gives usage and exit 2, and starts no scenario and no generation", async (...argv) => {
    quiet();
    const deps = spies();
    expect(await main(argv, deps)).toBe(2);
    expect(deps.runScenario).not.toHaveBeenCalled();
    expect(deps.generationMain).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalled();
  });

  it("good arguments do start what they name (the spies prove the guard is not just refusing everything)", async () => {
    quiet();
    const deps = { runScenario: vi.fn(async () => ({}) as never), generationMain: vi.fn(async () => {}) };
    expect(await main(["--generate", "--only", "new-validation", "--runs", "2"], deps)).toBe(0);
    expect(deps.generationMain).toHaveBeenCalledWith(expect.objectContaining({ only: ["new-validation"], runs: 2 }));
    expect(await main(["--summarise", "test/fixtures/bench-consistency.json"], spies())).toBe(0);
    expect(await main(["--features"], spies())).toBe(0);
    expect(await main(["--help"], spies())).toBe(0);
  });

  it("run as a real process, `--summarise` with no file prints the usage and exits 2 even with every credential removed", () => {
    const home = tmp("qas-nohome-");
    const r = spawnSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "bench/run.ts", "--summarise"], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: home }, timeout: 60_000 });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("--summarise needs a value");
    expect(r.stderr).toContain("usage: npm run bench");
    expect(fs.existsSync(path.resolve("bench/results/runs/new-endpoint-1"))).toBe(false);
  });

  it("parseFlags: values, lists, numbers and switches", () => {
    const spec = { values: { only: "list", runs: "positive-int", name: "string" }, switches: ["go"] } as const;
    expect(parseFlags(["--only", "a, b", "--runs", "3", "--name", "x y", "--go"], { values: { ...spec.values }, switches: [...spec.switches] })).toMatchObject({ ok: true, lists: { only: ["a", "b"] }, ints: { runs: 3 }, values: { name: "x y" } });
    expect(parseFlags(["--name", ""], { values: { name: "string" }, switches: [] })).toMatchObject({ ok: false });
  });
});

describe("bench:mutate arguments", () => {
  it("a missing scenario, a flag without a value (--tests-ref, --work), an unknown flag or a stray word give usage and exit 2", async () => {
    quiet();
    for (const argv of [[], ["--scenario"], ["--scenario", "SHOP-101", "--tests-ref"], ["--scenario", "SHOP-101", "--work"], ["--scenario", "SHOP-101", "--tests-ref", "--work", "x"], ["--scenario", "SHOP-101", "--bogus"], ["SHOP-101"]]) {
      expect(await mutateMain(argv)).toBe(2);
    }
  });
  it("a work folder without the sandbox is exit 2 before anything is copied", async () => {
    quiet();
    expect(await mutateMain(["--scenario", "SHOP-101", "--work", tmp("qas-nowork-")])).toBe(2);
  });
});

