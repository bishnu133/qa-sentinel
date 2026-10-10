import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkDeployment, featureMarkdown, featureStatus, partFromGit } from "../src/feature/manifest.js";

const g = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
function serviceRepo() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), "qas-feat-"));
  g(r, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(r, "a.js"), "1");
  g(r, "add", "-A");
  g(r, "commit", "-q", "-m", "init");
  g(r, "checkout", "-q", "-b", "feature/SHOP-106-ship");
  fs.writeFileSync(path.join(r, "a.js"), "2");
  g(r, "commit", "-qam", "SHOP-106: ship orders");
  g(r, "checkout", "-q", "main");
  return r;
}
const svc: any = { name: "orders-service", path: ".", dependsOn: [], version: { path: "/orders/version", field: "commit" } };

describe("feature manifest", () => {
  it("finds a story's work by branch and commit message, and knows when it is merged", () => {
    const r = serviceRepo();
    const before = partFromGit(r, svc, "SHOP-106", "main")!;
    expect(before).toMatchObject({ service: "orders-service", source: "git", branch: "feature/SHOP-106-ship", merged: false });
    expect(partFromGit(r, svc, "SHOP-1", "main")).toBeUndefined(); // SHOP-1 is not SHOP-106
    g(r, "merge", "-q", "--no-ff", "feature/SHOP-106-ship", "-m", "merge");
    expect(partFromGit(r, svc, "SHOP-106", "main")!.merged).toBe(true);
  });

  it("reads the deployed commit and checks it contains the change", async () => {
    const r = serviceRepo();
    g(r, "merge", "-q", "--no-ff", "feature/SHOP-106-ship", "-m", "merge");
    const part = partFromGit(r, svc, "SHOP-106", "main")!;
    let deployed = g(r, "rev-parse", "main~1"); // the old main, before the merge
    const server = http.createServer((_q, res) => res.end(JSON.stringify({ commit: deployed })));
    await new Promise<void>((ok) => server.listen(0, ok));
    const base = `http://127.0.0.1:${(server.address() as any).port}`;
    try {
      part.deployed = await checkDeployment(part, svc, "sit", base, r);
      expect(part.deployed).toMatchObject({ environment: "sit", includesChange: false });
      expect(featureStatus([part], "sit")).toBe("waiting-for-deployment");
      deployed = g(r, "rev-parse", "main"); // the merge commit is now deployed
      part.deployed = await checkDeployment(part, svc, "sit", base, r);
      expect(part.deployed!.includesChange).toBe(true);
      expect(featureStatus([part], "sit")).toBe("ready-for-feature-tests");
      expect(featureMarkdown({ story: "SHOP-106", environment: "sit", parts: [part], status: "ready-for-feature-tests", notes: [] })).toContain("✅ Every service change is deployed");
    } finally {
      server.close();
    }
  });

  it("reports in-development and missing version endpoints plainly", async () => {
    expect(featureStatus([], "sit")).toBe("no-changes-found");
    expect(featureStatus([{ service: "a", source: "git", merged: false }], "sit")).toBe("in-development");
    expect(await checkDeployment({ service: "a", source: "git", merged: true, sha: "abc" }, { ...svc, version: undefined }, "sit", "http://x")).toMatchObject({ error: expect.stringContaining("no version endpoint") });
  });
});
