import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigSchema, writeConfig } from "../src/config.js";
import { gapReportCommand } from "../src/commands/gapReport.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "qas-gapdraft-"));
  vi.stubEnv("CI_MERGE_REQUEST_IID", "7");
  vi.stubEnv("CI_PROJECT_ID", "1");
  vi.stubEnv("CI_MERGE_REQUEST_TITLE", "Draft: add slots");
  vi.stubEnv("QA_SENTINEL_GITLAB_TOKEN", "");
  vi.stubEnv("GITLAB_TOKEN", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});
const configure = (automation: Record<string, unknown> = {}) =>
  writeConfig(dir, ConfigSchema.parse({ version: 1, mode: "existing", project: { name: "t" }, tests: { api: { framework: "playwright", runCommand: "npx playwright test" } }, ci: { platform: "gitlab" }, automation }));

describe("gap report on a draft merge request", () => {
  it("waits, writes a note, and does not fail the pipeline", async () => {
    configure();
    const r = await gapReportCommand({ cwd: dir, service: "orders" });
    expect(r).toMatchObject({ skipped: true, exitCode: 0 });
    expect(fs.readFileSync(path.join(dir, "qa-gap-report.md"), "utf8")).toContain("draft");
  });
  it("does not wait when automation.gapReport.when is always", async () => {
    configure({ gapReport: { when: "always" } });
    // It goes on to look for the service and fails there, which proves the draft check did not stop it.
    await expect(gapReportCommand({ cwd: dir, service: "orders" })).rejects.toThrow();
  });
});
