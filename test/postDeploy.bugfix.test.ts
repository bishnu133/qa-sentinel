import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { featureGrep, featuresForKeys, postDeployCommand, storiesFromService } from "../src/commands/postDeploy.js";
import { ConfigSchema } from "../src/config.js";
import { upsertPart } from "../src/stories/parts.js";
import { emptyRecord, fileStore } from "../src/stories/record.js";
import { card, commit, g, jiraMock, parentOf, serve, tmp, cleanTmp } from "./helpers/mocks.js";

afterEach(() => {
  cleanTmp();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const ISSUES = {
  "SHOP-12": card("Delivery slots", "Story"),
  "SHOP-210": card("Slot accepts a 4th order", "Bug", { parent: parentOf("SHOP-12") }),
  "SHOP-77": card("Loose bug", "Bug"),
};

/** An orders service with the story's change merged, a test repo with tagged tests, and a runner that logs which spec files it was given. */
async function setup(o: { jiraUrl?: string } = {}) {
  const work = tmp("qas-bugfix-");
  const svc = path.join(work, "orders");
  fs.mkdirSync(svc);
  g(svc, "init", "-q", "-b", "main");
  commit(svc, "a.js", "0", "start");
  const feature = commit(svc, "slots.js", "1", "SHOP-12: delivery slots");

  const qa = path.join(work, "qa-tests");
  fs.mkdirSync(path.join(qa, "tests/api"), { recursive: true });
  fs.writeFileSync(path.join(qa, "tests/api/slots.spec.ts"), 'test("books a slot @service:orders @story:SHOP-12 @ac:AC-1", async () => { expect(1).toBe(1); });\n');
  fs.writeFileSync(path.join(qa, "tests/api/bug.spec.ts"), 'test("a 4th order is refused @service:orders @story:SHOP-12 @bug:SHOP-210 @ac:AC-1", async () => { expect(1).toBe(1); });\n');
  fs.writeFileSync(path.join(qa, "tests/api/other.spec.ts"), 'test("something else @service:orders @story:SHOP-99 @ac:AC-1", async () => { expect(1).toBe(1); });\n');
  fs.writeFileSync(
    path.join(qa, "run.mjs"),
    `import fs from "node:fs"; fs.mkdirSync("out", { recursive: true }); fs.appendFileSync("ran.txt", process.argv.slice(2).join(" ") + "\\n");
fs.writeFileSync("out/junit.xml", '<testsuite><testcase name="books a slot" classname="tests/api/slots.spec.ts"/></testsuite>');`,
  );
  let deployed = "";
  const version = await serve((_r, url) => (url.pathname === "/orders/version" ? { body: { commit: deployed } } : { body: {} }));
  fs.writeFileSync(
    path.join(qa, "qa-sentinel.config.yaml"),
    YAML.stringify({
      version: 1,
      mode: "existing",
      project: { name: "p" },
      tests: { api: { framework: "other", runCommand: "node run.mjs" } },
      ci: { platform: "gitlab" },
      verification: { junitPath: "out/junit.xml", typecheck: "never" },
      environments: { sit: { baseUrl: version.url } },
      workspace: { services: [{ name: "orders", path: "../orders", version: { path: "/orders/version", field: "commit" } }] },
      ...(o.jiraUrl ? { requirements: { source: "jira", jira: { baseUrl: o.jiraUrl, projectKeys: ["SHOP"], featureIssueTypes: ["Story"] } } } : {}),
    }),
  );
  g(qa, "init", "-q", "-b", "main");
  return { svc, qa, feature, version, deploy: (sha: string) => (deployed = sha) };
}
const ran = (qa: string) => (fs.existsSync(path.join(qa, "ran.txt")) ? fs.readFileSync(path.join(qa, "ran.txt"), "utf8") : "");
const report = (qa: string) => fs.readFileSync(path.join(qa, "qa-post-deploy.md"), "utf8");

describe("a deployed bug fix re-runs its feature's tests", () => {
  it("the deployment holds only 'SHOP-210 fix' (a bug whose parent is SHOP-12): SHOP-12's tests and the bug's own test run, and the report says why", async () => {
    const jira = await jiraMock(ISSUES);
    const s = await setup({ jiraUrl: jira.url });
    try {
      vi.stubEnv("JIRA_PAT", "x");
      const fix = commit(s.svc, "fix.js", "1", "SHOP-210 fix slot overflow");
      s.deploy(fix);
      const code = await postDeployCommand({ cwd: s.qa, env: "sit", service: "orders", sha: fix, before: s.feature, waitMinutes: 0 });
      expect(code).toBe(0);
      const md = report(s.qa);
      expect(md).toContain("## SHOP-12: ✅ tests passed");
      expect(md).toContain("re-run: fix SHOP-210 (Bug → SHOP-12) deployed");
      expect(md).not.toContain("## SHOP-210");
      // Both of the feature's tests ran, the other story's did not.
      expect(ran(s.qa)).toContain("slots.spec.ts");
      expect(ran(s.qa)).toContain("bug.spec.ts");
      expect(ran(s.qa)).not.toContain("other.spec.ts");
      // The result is in the story's record.
      const rec = (await fileStore(s.qa).load("SHOP-12"))!;
      expect(rec.results).toHaveLength(1);
      expect(rec.results[0]).toMatchObject({ environment: "sit", status: "passed", tests: 2 });
      expect(rec.results[0].basis).toMatch(/^[0-9a-f]{10}$/);
    } finally {
      await jira.close();
      await s.version.close();
    }
  });

  it("a key with no tests is reported as 'no tests tagged', not dropped (no Jira: keys are used as they are)", async () => {
    const s = await setup();
    try {
      const fix = commit(s.svc, "fix.js", "1", "SHOP-310 fix slot overflow");
      s.deploy(fix);
      expect(await postDeployCommand({ cwd: s.qa, env: "sit", service: "orders", sha: fix, before: s.feature, waitMinutes: 0 })).toBe(0);
      expect(report(s.qa)).toContain("## SHOP-310: ⬜ no tests tagged");
      expect(ran(s.qa)).toBe("");
    } finally {
      await s.version.close();
    }
  });

  it("a key with no tests is 'no tests tagged' at once: no polling while undeployed, and it does not make the run exit 75", async () => {
    const s = await setup();
    try {
      commit(s.svc, "fix.js", "1", "SHOP-310 fix slot overflow"); // never deployed
      const t0 = Date.now();
      const code = await postDeployCommand({ cwd: s.qa, env: "sit", stories: ["SHOP-310"], waitMinutes: 5, pollMs: 4000 });
      expect(code).toBe(0);
      expect(Date.now() - t0).toBeLessThan(3000);
      expect(report(s.qa)).toContain("## SHOP-310: ⬜ no tests tagged");
    } finally {
      await s.version.close();
    }
  });

  it("a deployed bug fix re-runs the bug's test and the feature's tests even while the feature has another MR open", async () => {
    const jira = await jiraMock(ISSUES);
    const s = await setup({ jiraUrl: jira.url });
    try {
      vi.stubEnv("JIRA_PAT", "x");
      g(s.svc, "checkout", "-q", "-b", "feature/SHOP-12-more");
      commit(s.svc, "more.js", "1", "SHOP-12: more slots (not merged yet)");
      g(s.svc, "checkout", "-q", "main");
      const fix = commit(s.svc, "fix.js", "1", "SHOP-210 fix slot overflow");
      s.deploy(fix);
      const code = await postDeployCommand({ cwd: s.qa, env: "sit", service: "orders", sha: fix, before: s.feature, waitMinutes: 0 });
      expect(code).toBe(0);
      expect(report(s.qa)).toContain("## SHOP-12: ✅ tests passed");
      expect(report(s.qa)).not.toContain("not merged yet\n");
      expect(ran(s.qa)).toContain("bug.spec.ts");
      expect(ran(s.qa)).toContain("slots.spec.ts");
    } finally {
      await jira.close();
      await s.version.close();
    }
  });

  it("without Jira a fix key still runs the tests tagged @bug:KEY", async () => {
    const s = await setup();
    try {
      const fix = commit(s.svc, "fix.js", "1", "SHOP-210 fix slot overflow");
      s.deploy(fix);
      expect(await postDeployCommand({ cwd: s.qa, env: "sit", service: "orders", sha: fix, before: s.feature, waitMinutes: 0 })).toBe(0);
      expect(report(s.qa)).toContain("## SHOP-210: ✅ tests passed");
      expect(ran(s.qa)).toContain("bug.spec.ts");
      expect(ran(s.qa)).not.toContain("slots.spec.ts");
    } finally {
      await s.version.close();
    }
  });

  it("a commit with no key in its message is mapped to its story through the record", async () => {
    const jira = await jiraMock(ISSUES);
    const s = await setup({ jiraUrl: jira.url });
    try {
      vi.stubEnv("JIRA_PAT", "x");
      const squash = commit(s.svc, "tidy.js", "1", "tidy the slot code (#5)");
      s.deploy(squash);
      const store = fileStore(s.qa);
      await store.save(upsertPart(emptyRecord("SHOP-12"), { service: "orders", source: "gitlab-mr", iid: 5, state: "merged", squashSha: squash, keys: ["SHOP-12"] }));
      await postDeployCommand({ cwd: s.qa, env: "sit", service: "orders", sha: squash, before: s.feature, waitMinutes: 0 });
      expect(report(s.qa)).toContain("## SHOP-12: ✅ tests passed");
      expect(ran(s.qa)).toContain("slots.spec.ts");
    } finally {
      await jira.close();
      await s.version.close();
    }
  });

  it("a key that is not in Jira is left out with a note", async () => {
    const jira = await jiraMock(ISSUES);
    const s = await setup({ jiraUrl: jira.url });
    try {
      vi.stubEnv("JIRA_PAT", "x");
      const typo = commit(s.svc, "t.js", "1", "SHOP-1012 typo in the key");
      s.deploy(typo);
      await postDeployCommand({ cwd: s.qa, env: "sit", service: "orders", sha: typo, before: s.feature, waitMinutes: 0 });
      expect(report(s.qa)).toContain("SHOP-1012 is not in Jira");
      expect(report(s.qa)).not.toContain("## SHOP-1012");
    } finally {
      await jira.close();
      await s.version.close();
    }
  });
});

describe("pieces", () => {
  it("storiesFromService returns every key, with or without tests", async () => {
    const s = await setup();
    try {
      commit(s.svc, "x.js", "1", "SHOP-210 and SHOP-211 fixes");
      const c = ConfigSchema.parse({ version: 1, mode: "scratch", project: { name: "p" }, tests: { api: { framework: "playwright", runCommand: "x" } }, ci: { platform: "gitlab" } });
      expect(storiesFromService(c, s.svc, "HEAD", s.feature)).toEqual(["SHOP-210", "SHOP-211"]);
      expect(storiesFromService(c, s.svc, "HEAD").sort()).toEqual(["SHOP-12", "SHOP-210", "SHOP-211"]);
    } finally {
      await s.version.close();
    }
  });

  it("featuresForKeys: bug → story with the bug named; two bugs of one story are one feature; a loose bug is its own", async () => {
    const jira = await jiraMock({ ...ISSUES, "SHOP-211": card("Another", "Bug", { parent: parentOf("SHOP-12") }) });
    try {
      const c = ConfigSchema.parse({ version: 1, mode: "scratch", project: { name: "p" }, tests: { api: { framework: "playwright", runCommand: "x" } }, ci: { platform: "gitlab" }, requirements: { source: "jira", jira: { baseUrl: jira.url, projectKeys: ["SHOP"], featureIssueTypes: ["Story"] } } });
      const r = await featuresForKeys(c, { baseUrl: jira.url, authHeader: "Bearer x" }, ["SHOP-210", "SHOP-211", "SHOP-77", "SHOP-12"]);
      expect(r.targets.map((t) => [t.feature, t.bugs.map((b) => b.key)])).toEqual([["SHOP-12", ["SHOP-210", "SHOP-211"]], ["SHOP-77", []]]);
    } finally {
      await jira.close();
    }
  });

  it("featureGrep matches the story tag and the bug tags, and not look-alike keys", () => {
    const re = new RegExp(featureGrep("SHOP-12", ["SHOP-210"]));
    expect(re.test("x @story:SHOP-12 @ac:AC-1")).toBe(true);
    expect(re.test("x @story:SHOP-12,SHOP-13")).toBe(true);
    expect(re.test("x @bug:SHOP-210")).toBe(true);
    expect(re.test("x @story:SHOP-120")).toBe(false);
    expect(re.test("x @bug:SHOP-2100")).toBe(false);
  });
});
