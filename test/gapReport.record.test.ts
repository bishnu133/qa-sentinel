import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigSchema, writeConfig } from "../src/config.js";

// A fake agent runtime: no model is ever called. The report ends "analysis incomplete", which is enough here.
vi.mock("../src/engines/ClaudeCodeEngine.js", () => ({
  engineFor: () => ({ name: "fake", available: () => ({ ok: true }), run: async () => ({ ok: false, status: "error", result: "fake engine: no model in tests" }) }),
}));

import { gapReportCommand } from "../src/commands/gapReport.js";
import { fileStore } from "../src/stories/record.js";
import { card, commit, g, jiraMock, parentOf, tmp, cleanTmp } from "./helpers/mocks.js";

afterEach(() => {
  cleanTmp();
  vi.unstubAllEnvs();
});

describe("the gap report records its merge request at first sight", () => {
  it("the MR (its number, branch, head and the bug it came through) is a part of the story's record", async () => {
    const jira = await jiraMock({
      "SHOP-12": card("Delivery slots", "Story", { description: "## Acceptance criteria\n- AC-1: A slot takes at most 3 orders.\n" }),
      "SHOP-210": card("Slot accepts a 4th order", "Bug", { parent: parentOf("SHOP-12") }),
    });
    try {
      const root = tmp("qas-record-gap-");
      const repo = path.join(root, "orders");
      g(root, "init", "-q", "-b", "main");
      fs.mkdirSync(repo, { recursive: true });
      g(repo, "init", "-q", "-b", "main");
      commit(repo, "src/a.ts", "export const a = 0;\n", "base");
      const baseSha = g(repo, "rev-parse", "HEAD");
      g(repo, "checkout", "-q", "-b", "fix/slot-overflow");
      const head = commit(repo, "src/a.ts", "export const a = 0;\nexport const b = 1;\n", "change");
      writeConfig(
        root,
        ConfigSchema.parse({
          version: 1,
          mode: "existing",
          project: { name: "t" },
          workspace: { services: [{ name: "orders", path: "orders", gitlabProject: "shop/orders" }] },
          tests: { api: { framework: "playwright", runCommand: "npx playwright test" } },
          ci: { platform: "gitlab", gitlabUrl: "https://gl.example" },
          requirements: { source: "jira", jira: { baseUrl: jira.url, projectKeys: ["SHOP"], featureIssueTypes: ["Story"] } },
        }),
      );
      vi.stubEnv("JIRA_PAT", "x");
      vi.stubEnv("CI_MERGE_REQUEST_IID", "7");
      vi.stubEnv("CI_MERGE_REQUEST_TITLE", "SHOP-210 stop the fourth order");
      vi.stubEnv("CI_MERGE_REQUEST_SOURCE_BRANCH_NAME", "fix/slot-overflow");
      vi.stubEnv("CI_MERGE_REQUEST_SOURCE_BRANCH_SHA", head);
      vi.stubEnv("CI_MERGE_REQUEST_DIFF_BASE_SHA", baseSha);
      vi.stubEnv("CI_MERGE_REQUEST_PROJECT_URL", "https://gl.example/shop/orders");
      vi.stubEnv("QA_SENTINEL_GITLAB_TOKEN", "");

      await gapReportCommand({ cwd: root, service: "orders", servicePath: repo });

      const rec = (await fileStore(root).load("SHOP-12"))!;
      expect(rec.parts).toHaveLength(1);
      expect(rec.parts[0]).toMatchObject({ service: "orders", iid: 7, state: "opened", branch: "fix/slot-overflow", headSha: head, workKey: "SHOP-210", url: "https://gl.example/shop/orders/-/merge_requests/7", keys: ["SHOP-210"] });
      expect(await fileStore(root).load("SHOP-210")).toBeUndefined();
    } finally {
      await jira.close();
    }
  });
});
