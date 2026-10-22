import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { cloneServices, serviceCloneUrl } from "../src/stories/cloneServices.js";
import { storyParts } from "../src/story.js";
import { GIT_ENV, cleanTmp, commit, g, tmp } from "./helpers/mocks.js";

// The CI job `qa-stories` starts with the test repo only. cloneServices puts the service repos where the config says they are,
// so `generate --story` can find the story's code (it used to stop with "No service changes found" on every check).
let root: string, qa: string, remote: string;
const c = () => ConfigSchema.parse({ version: 1, mode: "existing", project: { name: "t" }, tests: { api: { framework: "mocha", runCommand: "x" } }, ci: { platform: "gitlab", gitlabUrl: "https://gitlab.example.com" }, workspace: { services: [{ name: "orders", path: "../services/orders", gitlabProject: "grp/orders" }, { name: "local", path: "../local" }] } });

beforeEach(() => {
  for (const [k, v] of Object.entries(GIT_ENV)) vi.stubEnv(k, v);
  root = tmp("qas-clone-");
  qa = path.join(root, "qa");
  remote = path.join(root, "remote-orders");
  for (const d of [qa, remote]) {
    fs.mkdirSync(d);
    g(d, "init", "-q", "-b", "main");
  }
  commit(remote, "src/app.js", "v1", "init");
  commit(remote, "src/app.js", "v2", "SHOP-7 orders change");
});
afterEach(() => {
  vi.unstubAllEnvs();
  cleanTmp();
});

describe("cloneServices (the qa-stories CI job)", () => {
  it("clones a service that is not there, drops the remote (no token left in .git/config) and leaves other services alone", () => {
    const r = cloneServices(c(), qa, {}, { urlFor: (p) => (p === "grp/orders" ? remote : undefined) });
    expect(r).toEqual({ cloned: ["orders"], skipped: [], failed: [] });
    const dest = path.join(root, "services/orders");
    expect(g(dest, "log", "--format=%s", "-1")).toBe("SHOP-7 orders change");
    expect(g(dest, "remote")).toBe("");
    expect(fs.readFileSync(path.join(dest, ".git/config"), "utf8")).not.toContain(remote);
    // Already there: not touched again.
    expect(cloneServices(c(), qa, {}, { urlFor: () => undefined })).toEqual({ cloned: [], skipped: ["orders"], failed: [] });
  });

  it("after the clone the story's code is found; without it nothing is", async () => {
    expect((await storyParts({ c: c(), cwd: qa, story: "SHOP-7" })).parts).toEqual([]);
    cloneServices(c(), qa, {}, { urlFor: () => remote });
    const sp = await storyParts({ c: c(), cwd: qa, story: "SHOP-7" });
    expect(sp.parts.map((p) => [p.service.name, p.merged])).toEqual([["orders", true]]);
  });

  it("uses the job token (read) when there is one, else the GitLab token; with neither it says what is missing", () => {
    expect(serviceCloneUrl(c(), "grp/orders", { CI_JOB_TOKEN: "jt" })).toBe("https://gitlab-ci-token:jt@gitlab.example.com/grp/orders.git");
    expect(serviceCloneUrl(c(), "grp/orders", { QA_SENTINEL_GITLAB_TOKEN: "pat" })).toBe("https://oauth2:pat@gitlab.example.com/grp/orders.git");
    expect(serviceCloneUrl(c(), "grp/orders", {})).toBeUndefined();
    const r = cloneServices(c(), qa, {});
    expect(r.failed[0]).toMatch(/orders \(no CI_JOB_TOKEN or QA_SENTINEL_GITLAB_TOKEN/);
  });

  it("a failed clone never shows the token", () => {
    const r = cloneServices(c(), qa, {}, { urlFor: () => "https://gitlab-ci-token:SECRET@127.0.0.1:1/none.git" });
    expect(r.failed).toHaveLength(1);
    expect(r.failed.join()).not.toContain("SECRET");
  });
});
