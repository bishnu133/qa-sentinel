import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { checkContent } from "../src/guardrails.js";
import { StoryReviewSchema, storyReviewMarkdown } from "../src/review/storyReview.js";
import { render } from "../src/templates.js";

const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();

describe("async patterns (A4)", () => {
  it("warns about fixed waits in new tests", () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "qas-wait-"));
    sh(repo, "init", "-q", "-b", "main");
    sh(repo, "commit", "-q", "--allow-empty", "-m", "base");
    const ref = sh(repo, "rev-parse", "HEAD");
    fs.mkdirSync(path.join(repo, "tests/api"), { recursive: true });
    fs.writeFileSync(path.join(repo, "tests/api/job.spec.ts"), "await page.waitForTimeout(5000);\nawait expect.poll(() => status()).toBe('sent');\n");
    const f = checkContent([{ path: "tests/api/job.spec.ts", status: "A" }], { repo, ref, allowedHosts: [], assertionRemoval: "warn" } as never);
    expect(f).toEqual([expect.objectContaining({ level: "warning", rule: "fixed-wait", message: expect.stringContaining("waitForTimeout(5000)") })]);
  });

  it("the scaffolded pollUntil waits for the state, with a bound and a useful error", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qas-poll-"));
    const src = render(fs.readFileSync(path.join(__dirname, "../templates/scaffold/playwright-api/src/api/async.ts.tmpl"), "utf8"), {});
    fs.writeFileSync(path.join(dir, "async.ts"), src);
    const { pollUntil } = await import(path.join(dir, "async.ts"));
    let n = 0;
    expect(await pollUntil(async () => ++n, (v: number) => v >= 3, { what: "three", intervalMs: 5 })).toBe(3);
    await expect(pollUntil(async () => "queued", (v: string) => v === "sent", { what: "the email to be sent", timeoutMs: 50, intervalMs: 10 })).rejects.toThrow(/waiting for the email to be sent \(last value: "queued"\)/);
  });

  it("story review can flag requirements that need a test hook", () => {
    const r = StoryReviewSchema.parse({ schemaVersion: 1, summary: "s", findings: [{ type: "needs-test-hook", ref: "AC-3", finding: "the reminder is sent by a nightly job", suggestion: "add a test-only endpoint that runs the reminder job" }], suggestedAcs: [], openQuestions: [] });
    expect(storyReviewMarkdown("SHOP-1", r)).toContain("Needs a test hook");
  });
});
