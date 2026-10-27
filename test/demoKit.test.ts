// The demo kit (demo/): seed, merge, bug fix and reset, run against a fake Jira and a fake GitLab.
// No network, no AI, no global git name or e-mail, and nothing here reads process.env.CI: every script gets an explicit env.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs scripts
import { seedJira, checkSeedGuards } from "../demo/scripts/seed-jira.mjs";
// @ts-expect-error plain .mjs scripts
import { demoMerge } from "../demo/scripts/demo-merge.mjs";
// @ts-expect-error plain .mjs scripts
import { demoBugfix } from "../demo/scripts/demo-bugfix.mjs";
// @ts-expect-error plain .mjs scripts
import { reset } from "../demo/scripts/reset.mjs";
// @ts-expect-error plain .mjs scripts
import { setupGitlab, configOverlay, buildWorkFolders } from "../demo/scripts/setup-gitlab.mjs";
// @ts-expect-error plain .mjs scripts
import { applyEdits, loadConfig, loadCards, loadChange, parseArgs, toWiki, redact, TEMPLATE_DIR, DEMO_DIR } from "../demo/scripts/lib.mjs";
import { startFakeGitlab, startFakeJira } from "./helpers/fakeDemo.js";

const TOKEN = "glpat-TESTTOKEN-1234567890";
const JIRA_TOKEN = "jira-secret-token-abcdef";
const JIRA_AUTH = `Basic ${Buffer.from(`bot@example.test:${JIRA_TOKEN}`).toString("base64")}`;
const FLAG = "i-know-this-is-a-test-project";
const ROOT = path.resolve(DEMO_DIR, "..");

const tpl = (...p: string[]) => fs.readFileSync(path.join(TEMPLATE_DIR, ...p), "utf8");
const serviceFiles = (dir: string) => ({ "src/server.js": tpl(dir, "src/server.js"), "openapi.yaml": tpl(dir, "openapi.yaml"), "package.json": tpl(dir, "package.json") });

let jira: Awaited<ReturnType<typeof startFakeJira>>;
let gl: Awaited<ReturnType<typeof startFakeGitlab>>;
let tmp: string;
let logs: string[];
const log = (...a: unknown[]) => void logs.push(a.join(" "));
const env = (extra: Record<string, string> = {}) => ({ GITLAB_TOKEN: TOKEN, JIRA_EMAIL: "bot@example.test", JIRA_API_TOKEN: JIRA_TOKEN, DEMO_JIRA_PROJECT: "DEMO", ...extra });
const files = () => ({ configFile: path.join(tmp, "demo.config.json"), stateFile: path.join(tmp, ".demo-state.json") });
const state = () => JSON.parse(fs.readFileSync(files().stateFile, "utf8"));
const base = () => ({ env: env(), log, ...files() });

beforeEach(async () => {
  logs = [];
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "qas-demo-"));
  jira = await startFakeJira({ token: JIRA_AUTH });
  gl = await startFakeGitlab({ token: TOKEN });
  gl.addProject("g/shoplite-tests", { "qa-sentinel.config.yaml": "version: 1\n" });
  gl.addProject("g/shoplite-orders", serviceFiles("service-orders"), "main", ["release/demo"]);
  gl.addProject("g/shoplite-payments", serviceFiles("service-payments"));
  fs.writeFileSync(
    files().configFile,
    JSON.stringify({
      gitlabUrl: gl.url,
      testsProject: "g/shoplite-tests",
      services: [
        { name: "orders-service", project: "g/shoplite-orders" },
        { name: "payments-service", project: "g/shoplite-payments", optional: true },
      ],
      jira: { baseUrl: jira.url, project: "DEMO", auth: "cloud" },
    }),
  );
});
afterEach(async () => {
  await jira.close();
  await gl.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Seed Jira, and write what setup-gitlab.mjs would have recorded for GitLab. */
async function seeded() {
  await seedJira({ ...base(), args: { yes: true, [FLAG]: true } });
  const st = state();
  st.gitlab = { url: gl.url, testsProject: "g/shoplite-tests", projects: ["g/shoplite-tests", "g/shoplite-orders", "g/shoplite-payments"], defaultBranch: "main", releaseBranch: "release/demo", baselines: {}, setupAt: "2000-01-01T00:00:00Z" };
  fs.writeFileSync(files().stateFile, JSON.stringify(st));
  gl.requests.length = 0;
  return st;
}
const mergeCard = (card: string, extra: Record<string, unknown> = {}) => demoMerge({ ...base(), args: { card, yes: true, merge: true, ...extra } });
const fixCard = (card: string, extra: Record<string, unknown> = {}) => demoBugfix({ ...base(), args: { card, yes: true, merge: true, ...extra } });
const resetArgs = (extra: Record<string, unknown> = {}) => ({ ...base(), args: { yes: true, [FLAG]: true, ...extra } });
const rejects = async (p: Promise<unknown>, re: RegExp) => expect(p).rejects.toThrow(re);

describe("demo kit: the files", () => {
  it("every card has a story file and a change file, with the Jira key left out", () => {
    const cards = loadCards().cards;
    expect(cards.map((c: any) => c.type).sort()).toEqual(["Bug", "Bug", "Story", "Story", "Story"]);
    for (const c of cards) {
      expect(fs.existsSync(path.join(DEMO_DIR, c.storyFile))).toBe(true);
      for (const ch of c.changes) expect(loadChange(ch).service).toBeTruthy();
      expect(JSON.stringify(c)).not.toMatch(/[A-Z]{2,}-\d+/); // no made-up or real keys: Jira makes them
    }
    expect(cards.find((c: any) => c.linksTo)?.linksTo.card).toBe("delivery-slot");
    expect(cards.filter((c: any) => c.changes.length === 2)).toHaveLength(1);
    expect(cards.filter((c: any) => c.hotfix)).toHaveLength(1);
    const stories = cards.filter((c: any) => c.type === "Story");
    for (const s of stories) expect(fs.readFileSync(path.join(DEMO_DIR, s.storyFile), "utf8")).toMatch(/## Acceptance criteria\n1\. /);
  });

  it("every change fits the template it is made for, in the order of the demo, and the result is valid JavaScript", () => {
    const code: Record<string, Record<string, string>> = { "orders-service": serviceFiles("service-orders"), "payments-service": serviceFiles("service-payments") };
    for (const name of ["delivery-slot", "qty-limit", "slot-cap-bug", "cancel-refund-payments", "cancel-refund-orders", "blank-item-hotfix"]) {
      const ch = loadChange(name);
      for (const [file, pairs] of Object.entries<any>(ch.edits)) code[ch.service][file] = applyEdits(code[ch.service][file], pairs, `${ch.service}:${file}`);
    }
    for (const svc of Object.values(code)) new vm.Script(svc["src/server.js"]);
    expect(code["orders-service"]["src/server.js"]).toContain("MAX_ORDERS_PER_SLOT = 3");
    expect(code["orders-service"]["src/server.js"]).toContain("qty must be at most 10");
    expect(code["payments-service"]["src/server.js"]).toContain("/payments/:id/refund");
  });

  it("a change that does not fit is refused, not skipped", () => {
    expect(() => applyEdits("abc", [["zzz", "y"]], "x")).toThrow(/not found/);
  });

  it("the bug fix does not fit before its story is merged", () => {
    const fix = loadChange("slot-cap-bug");
    expect(() => applyEdits(tpl("service-orders", "src/server.js"), fix.edits["src/server.js"], "orders")).toThrow(/earlier card/);
  });

  it("the sample config is what setup writes on top of init", async () => {
    const YAML = (await import("yaml")).default;
    const sample = YAML.parse(tpl("tests", "qa-sentinel.config.sample.yaml"));
    const made = configOverlay({ gitlabUrl: "https://gitlab.example.com", testsProject: "<your-group>/shoplite-tests", services: [{ name: "orders-service", project: "<your-group>/shoplite-orders" }, { name: "payments-service", project: "<your-group>/shoplite-payments" }], jira: { baseUrl: "https://<your-site>.atlassian.net", project: "<YOUR-TEST-PROJECT-KEY>" } });
    expect(sample).toEqual(JSON.parse(JSON.stringify(made)));
    const text = tpl("tests", "qa-sentinel.config.sample.yaml") + tpl("tests", ".gitlab-ci.yml") + tpl("service-orders", ".gitlab-ci.yml");
    expect(text).not.toMatch(/glpat-|ATATT|sk-ant|password|secret\s*:/i);
  });

  it("no credentials or real addresses in the kit", () => {
    const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === ".work" ? [] : walk(path.join(d, e.name))) : [path.join(d, e.name)]));
    for (const f of walk(DEMO_DIR)) {
      if (/\.(png|jpg)$/.test(f) || f.endsWith(".demo-state.json")) continue;
      const t = fs.readFileSync(f, "utf8");
      expect(t, f).not.toMatch(/glpat-[A-Za-z0-9_-]{10,}|ATATT[A-Za-z0-9]{10,}|sk-ant-[A-Za-z0-9]{10,}|atlassian\.net\/browse\/[A-Z]+-\d+/);
    }
    expect(fs.readFileSync(path.join(DEMO_DIR, ".gitignore"), "utf8")).toContain(".demo-state.json");
  });

  it("helpers: arguments, wiki text and secrets", () => {
    expect(parseArgs(["--yes", "--card", "a", "--x=1", "pos"])).toEqual({ _: ["pos"], yes: true, card: "a", x: "1" });
    expect(toWiki("## Acceptance criteria\n1. one\n2. two")).toBe("h2. Acceptance criteria\n# one\n# two");
    expect(redact(`oops ${TOKEN} here`, [TOKEN])).not.toContain("TESTTOKEN");
  });

  it("builds the three folders from the template with the shipped qa-sentinel init (no network)", async () => {
    const out = path.join(tmp, "work");
    const bin = `${process.execPath} ${ROOT}/node_modules/tsx/dist/cli.mjs ${ROOT}/src/cli.ts`;
    const dirs = await buildWorkFolders({ config: JSON.parse(fs.readFileSync(files().configFile, "utf8")), out, env: { PATH: process.env.PATH ?? "", HOME: tmp, QA_SENTINEL_BIN: bin }, log });
    const cfg = fs.readFileSync(path.join(dirs["shoplite-tests"], "qa-sentinel.config.yaml"), "utf8");
    expect(cfg).toContain("gitlabProject: g/shoplite-orders");
    expect(cfg).toContain("source: jira");
    expect(cfg).toContain("testRepoProject: g/shoplite-tests");
    expect(fs.existsSync(path.join(dirs["shoplite-tests"], "ci/qa-sentinel/tests.gitlab-ci.yml"))).toBe(true);
    expect(fs.readFileSync(path.join(dirs["shoplite-tests"], ".gitlab-ci.yml"), "utf8")).toContain("orders-service=g/shoplite-orders payments-service=g/shoplite-payments");
    expect(fs.readFileSync(path.join(dirs["orders-service"], ".gitlab-ci.yml"), "utf8")).toContain('project: "g/shoplite-tests"');
    expect(fs.readFileSync(path.join(dirs["shoplite-tests"], "test-map.yaml"), "utf8")).toContain("payments-service:");
    expect(fs.existsSync(path.join(dirs["orders-service"], ".git"))).toBe(true);
  }, 120_000);
});

describe("seed-jira", () => {
  it("is a dry run by default: it says what it would create and sends nothing", async () => {
    await seedJira({ ...base(), args: {} });
    expect(jira.requests).toHaveLength(0);
    expect(fs.existsSync(files().stateFile)).toBe(false);
    expect(logs.join("\n")).toMatch(/dry run/);
    expect(logs.filter((l) => l.includes("would create"))).toHaveLength(5);
  });

  it("refuses without DEMO_JIRA_PROJECT, with another project, with another Jira, and without the test-project flag", async () => {
    await rejects(seedJira({ ...base(), env: env({ DEMO_JIRA_PROJECT: "" }), args: { yes: true, [FLAG]: true } }), /Set DEMO_JIRA_PROJECT/);
    await rejects(seedJira({ ...base(), env: env({ DEMO_JIRA_PROJECT: "REAL" }), args: { yes: true, [FLAG]: true } }), /must be the same/);
    await rejects(seedJira({ ...base(), env: env({ JIRA_BASE_URL: "https://company.atlassian.net" }), args: { yes: true, [FLAG]: true } }), /not the Jira in demo\.config/);
    await rejects(seedJira({ ...base(), args: { yes: true } }), /--i-know-this-is-a-test-project/);
    await rejects(seedJira({ ...base(), args: { yes: true, [FLAG]: "OTHER" } }), /does not match/);
    expect(jira.requests).toHaveLength(0);
    expect(fs.existsSync(files().stateFile)).toBe(false);
  });

  it("refuses placeholder values in the config", () => {
    expect(() => checkSeedGuards({ config: { jira: { baseUrl: "https://<your-site>.atlassian.net", project: "<KEY>" } }, args: {}, env: { DEMO_JIRA_PROJECT: "<KEY>" } })).toThrow(/filled in/);
  });

  it("creates the cards, links the bug to its story, moves stories to In Progress and records the keys; a second run creates nothing", async () => {
    await seedJira({ ...base(), args: { yes: true, [FLAG]: true } });
    const st = state();
    expect(Object.keys(st.cards).sort()).toEqual(["blank-item-hotfix", "cancel-refund", "delivery-slot", "qty-limit", "slot-cap-bug"]);
    expect(st.jira).toEqual({ baseUrl: jira.url, project: "DEMO" });
    expect(jira.issues.size).toBe(5);
    const slot = jira.issues.get(st.cards["delivery-slot"].key)!;
    expect(slot.fields.status.name).toBe("In Progress");
    expect(slot.fields.labels).toContain("qa-sentinel-demo");
    expect(slot.fields.description).toContain("# A slot accepts at most 3 orders");
    expect(st.cards["delivery-slot"].startStatus).toBe("In Progress");
    expect(st.cards["slot-cap-bug"].startStatus).toBe("To Do");
    expect(jira.issues.get(st.cards["slot-cap-bug"].key)!.fields.issuetype.name).toBe("Bug");
    expect(jira.links).toEqual([{ type: { name: "Relates" }, inwardIssue: { key: st.cards["slot-cap-bug"].key }, outwardIssue: { key: st.cards["delivery-slot"].key } }]);
    // secrets never reach the state file or the screen
    expect(JSON.stringify(st) + logs.join("\n")).not.toContain(JIRA_TOKEN);

    jira.requests.length = 0;
    await seedJira({ ...base(), args: { yes: true, [FLAG]: true } });
    expect(jira.writes()).toHaveLength(0);
    expect(jira.issues.size).toBe(5);
  });

  it("will not seed another project into a state file that belongs to a different one", async () => {
    await seeded();
    const st = state();
    st.jira.project = "OLD";
    fs.writeFileSync(files().stateFile, JSON.stringify(st));
    await rejects(seedJira({ ...base(), args: { yes: true, [FLAG]: true } }), /belongs to/);
  });
});

describe("demo-merge and demo-bugfix", () => {
  it("refuses a card that was not seeded, and a project that is not listed in the state", async () => {
    await rejects(demoMerge({ ...base(), args: { card: "qty-limit", yes: true } }), /Run seed-jira/);
    await seeded();
    const st = state();
    st.gitlab.projects = ["g/shoplite-tests"]; // the orders project is not listed
    fs.writeFileSync(files().stateFile, JSON.stringify(st));
    gl.requests.length = 0;
    await rejects(demoMerge({ ...base(), args: { card: "qty-limit", yes: true } }), /not one of the demo projects listed/);
    expect(gl.writes()).toHaveLength(0);
  });

  it("a wrong token fails with a plain message that does not contain the token", async () => {
    await seeded();
    const bad = "glpat-WRONG0000000000000";
    const err = await demoMerge({ ...base(), env: env({ GITLAB_TOKEN: bad }), args: { card: "qty-limit" } }).catch((e: Error) => e);
    expect(String((err as Error).message)).toMatch(/401/);
    expect(String((err as Error).message)).not.toContain(bad);
    expect(gl.writes()).toHaveLength(0);
  });

  it("the example config cannot be used as it is", () => {
    expect(() => loadConfig(path.join(DEMO_DIR, "demo.config.example.json"))).toThrow(/placeholder/);
  });

  it("uses the right script for the card type", async () => {
    await seeded();
    await rejects(demoMerge({ ...base(), args: { card: "slot-cap-bug", yes: true } }), /demo-bugfix/);
    await rejects(demoBugfix({ ...base(), args: { card: "qty-limit", yes: true } }), /demo-merge/);
  });

  it("dry run checks that the change fits and writes nothing", async () => {
    await seeded();
    await demoMerge({ ...base(), args: { card: "delivery-slot", merge: true } });
    expect(gl.writes()).toHaveLength(0);
    expect(logs.join("\n")).toMatch(/dry run/);
    expect(logs.join("\n")).toMatch(/change fits: src\/server\.js/);
  });

  it("opens a merge request with the Jira key in the title, and merges it only with --merge", async () => {
    const st = await seeded();
    const key = st.cards["delivery-slot"].key;
    await demoMerge({ ...base(), args: { card: "delivery-slot", yes: true } });
    const pr = gl.projects.get("g/shoplite-orders")!;
    const mr = pr.mrs[0];
    expect(mr.title).toBe(`${key}: Choose a delivery slot when ordering`);
    expect(mr.source_branch).toBe(`demo/${key}-delivery-slot`);
    expect(mr.state).toBe("opened");
    expect(gl.files("g/shoplite-orders", "main")["src/server.js"]).not.toContain("MAX_ORDERS_PER_SLOT");
    expect(gl.files("g/shoplite-orders", mr.source_branch)["src/server.js"]).toContain("MAX_ORDERS_PER_SLOT = 5");
    expect(state().mrs).toHaveLength(1);
    expect(state().branches).toEqual([{ project: "g/shoplite-orders", branch: `demo/${key}-delivery-slot` }]);

    await demoMerge({ ...base(), args: { card: "delivery-slot", yes: true, merge: true } });
    expect(mr.state).toBe("merged");
    expect(gl.files("g/shoplite-orders", "main")["src/server.js"]).toContain("MAX_ORDERS_PER_SLOT");
    expect(state().merges).toHaveLength(1);
    expect(logs.join("\n")).toContain("qa-trigger-generation");
    expect(logs.join("\n")).not.toContain(TOKEN);
    await rejects(demoMerge({ ...base(), args: { card: "delivery-slot", yes: true, merge: true } }), /already merged/);
  });

  it("says so when GitLab will not merge yet, and keeps the merge request open", async () => {
    await seeded();
    (gl.projects.get("g/shoplite-orders") as any).refuseMerge = true;
    await rejects(demoMerge({ ...base(), args: { card: "qty-limit", yes: true, merge: true } }), /would not merge/);
    expect(gl.projects.get("g/shoplite-orders")!.mrs[0].state).toBe("opened");
  });

  it("fixes the bug only after the story is merged", async () => {
    const st = await seeded();
    await rejects(fixCard("slot-cap-bug"), /not found|earlier card/);
    expect(gl.writes()).toHaveLength(0);
    await mergeCard("delivery-slot");
    await fixCard("slot-cap-bug");
    expect(gl.files("g/shoplite-orders", "main")["src/server.js"]).toContain("MAX_ORDERS_PER_SLOT = 3");
    const titles = gl.projects.get("g/shoplite-orders")!.mrs.map((m) => m.title);
    expect(titles).toContain(`${st.cards["slot-cap-bug"].key}: Delivery slot accepts 5 orders, the story says 3`);
  });

  it("a card with two parts needs --part and the optional project", async () => {
    await seeded();
    await rejects(mergeCard("cancel-refund"), /--part/);
    await mergeCard("cancel-refund", { part: "payments-service" });
    expect(gl.files("g/shoplite-payments", "main")["src/server.js"]).toContain("/payments/:id/refund");
    expect(logs.join("\n")).toMatch(/WAIT/);
    await mergeCard("cancel-refund", { part: "orders-service" });
    expect(gl.files("g/shoplite-orders", "main")["src/server.js"]).toContain("/orders/:id/cancel");
    // without the payments project in the config the card is refused
    const cfg = JSON.parse(fs.readFileSync(files().configFile, "utf8"));
    cfg.services = cfg.services.filter((s: any) => s.name !== "payments-service");
    fs.writeFileSync(files().configFile, JSON.stringify(cfg));
    await rejects(mergeCard("cancel-refund", { part: "orders-service" }), /needs the service "payments-service"/);
  });

  it("the hotfix goes to the release branch first and is copied to main only with --cherry-pick", async () => {
    await seeded();
    await fixCard("blank-item-hotfix");
    const mr = gl.projects.get("g/shoplite-orders")!.mrs[0];
    expect(mr.target_branch).toBe("release/demo");
    expect(mr.source_branch).toMatch(/^hotfix\/DEMO-\d+-blank-item$/);
    expect(gl.files("g/shoplite-orders", "release/demo")["src/server.js"]).toContain("!item.trim()");
    expect(gl.files("g/shoplite-orders", "main")["src/server.js"]).not.toContain("!item.trim()");
    expect(logs.join("\n")).toMatch(/NO tests are generated until/);
    await fixCard("blank-item-hotfix", { "cherry-pick": true });
    expect(gl.files("g/shoplite-orders", "main")["src/server.js"]).toContain("!item.trim()");
    expect(state().merges.map((m: any) => m.kind)).toEqual(["merge", "cherry-pick"]);
    await rejects(mergeCard("qty-limit", { "cherry-pick": true }), /only for the hotfix/);
  });
});

describe("reset", () => {
  /** The demo is run, qa-sentinel (the same user as the token) leaves its marks, and a person leaves theirs. */
  async function afterADemo() {
    const st = await seeded();
    const k = (id: string) => st.cards[id].key as string;
    await mergeCard("delivery-slot");
    await mergeCard("qty-limit");
    await fixCard("slot-cap-bug");
    await fixCard("blank-item-hotfix");
    await fixCard("blank-item-hotfix", { "cherry-pick": true });
    const orders = gl.projects.get("g/shoplite-orders")!;
    const open = await mergeCardOpenOnly();
    // qa-sentinel's marks in GitLab and Jira
    gl.addNote("g/shoplite-orders", orders.mrs[0].iid, "<!-- qa-sentinel:gap-report -->\nreport", "me");
    gl.addNote("g/shoplite-orders", orders.mrs[0].iid, "<!-- qa-sentinel:gap-report -->\nsomeone pasted the marker", "other");
    gl.addNote("g/shoplite-orders", orders.mrs[0].iid, "my own plain comment", "me");
    gl.addNote("g/shoplite-orders", orders.mrs[0].iid, "qa-sentinel: system note", "me", true);
    const agent = gl.addAgentMr("g/shoplite-tests", `qa-sentinel/story-${k("delivery-slot")}`, "QA agent: tests");
    gl.addNote("g/shoplite-tests", agent.iid, "<!-- qa-sentinel:gap-report -->\nagent note", "me");
    const mine = jira.comment(k("delivery-slot"), "gap report\n{color:#97a0af}qa-sentinel:gap-report:orders-service{color}", "me");
    const theirs = jira.comment(k("delivery-slot"), "I quoted qa-sentinel:gap-report in my own words", "other");
    const plain = jira.comment(k("delivery-slot"), "a normal comment", "me");
    jira.issues.get(k("delivery-slot"))!.props["qa-sentinel.record"] = { version: 1 };
    jira.issues.get(k("delivery-slot"))!.props["qa-sentinel.showcase"] = { attachments: [{ id: "att-1", filename: "qa-showcase.md" }] };
    jira.issues.get(k("delivery-slot"))!.props["unrelated.property"] = { keep: true };
    jira.setStatus(k("delivery-slot"), "Done");
    gl.requests.length = 0;
    jira.requests.length = 0;
    return { st, k, orders, agent, mine, theirs, plain, open };
  }
  async function mergeCardOpenOnly() {
    await demoMerge({ ...base(), args: { card: "cancel-refund", part: "orders-service", yes: true } }).catch(() => undefined);
    return gl.projects.get("g/shoplite-orders")!.mrs.find((m) => m.state === "opened");
  }

  it("is a dry run by default: it prints the plan and changes nothing", async () => {
    const w = await afterADemo();
    expect(await reset({ ...base(), args: {} })).toBe(0);
    expect(gl.writes()).toHaveLength(0);
    expect(jira.writes()).toHaveLength(0);
    const out = logs.join("\n");
    expect(out).toMatch(/DRY RUN/);
    expect(out).toMatch(/revert/);
    expect(out).toMatch(/delete comment/);
    expect(out).toMatch(/move from "Done" back to "In Progress"/);
    expect(out).toMatch(/What reset cannot undo/);
    expect(out).toContain("qa-sentinel.record");
    expect(w.orders.mrs.some((m) => m.state === "opened")).toBe(true);
  });

  it("refuses to write without the test-project flag, and for another Jira project", async () => {
    await afterADemo();
    await rejects(reset({ ...base(), args: { yes: true } }), /--i-know-this-is-a-test-project/);
    await rejects(reset({ ...base(), env: env({ DEMO_JIRA_PROJECT: "REAL" }), args: { yes: true, [FLAG]: true } }), /Nothing was changed/);
    await rejects(reset({ ...base(), env: env({ DEMO_JIRA_PROJECT: "" }), args: {} }), /Set DEMO_JIRA_PROJECT/);
    expect(gl.writes()).toHaveLength(0);
    expect(jira.writes()).toHaveLength(0);
  });

  it("puts GitLab and Jira back, touching only what is recorded or carries the marker and the right author", async () => {
    const w = await afterADemo();
    jira.addForeign("DEMO-900");
    jira.comment("DEMO-900", "qa-sentinel:gap-report:orders-service mine, but on a card the demo never made", "me");
    gl.addProject("other/project", { "x.txt": "1" });
    const foreignMr = gl.addAgentMr("other/project", "qa-sentinel/story-X", "not ours");
    expect(await reset(resetArgs())).toBe(0);

    // GitLab: the files equal the baseline again, as new revert commits (no history rewriting)
    for (const [project, branches] of [["g/shoplite-orders", ["main", "release/demo"]], ["g/shoplite-payments", ["main"]], ["g/shoplite-tests", ["main"]]] as const) {
      const pr = gl.projects.get(project)!;
      for (const b of branches) expect(gl.files(project, b)).toEqual(pr.commits.get(pr.tags.get("demo-baseline")!)!.files);
    }
    expect(gl.requests.some((r) => r.method === "PUT" && /\/repository\/branches/.test(r.path))).toBe(false);
    const orders = w.orders;
    expect(orders.mrs.every((m) => m.state !== "opened")).toBe(true);
    expect([...orders.branches.keys()].sort()).toEqual(["main", "release/demo"]);
    expect([...gl.projects.get("g/shoplite-tests")!.branches.keys()]).toEqual(["main"]); // qa-sentinel/story-… deleted
    expect(gl.projects.get("g/shoplite-tests")!.mrs[0].state).toBe("closed");
    // comments: only the token user's marker notes went
    const notes = gl.projects.get("g/shoplite-orders")!.notes.get(orders.mrs[0].iid)!.map((n: any) => n.body);
    expect(notes).toEqual(["<!-- qa-sentinel:gap-report -->\nsomeone pasted the marker", "my own plain comment", "qa-sentinel: system note"]);
    expect(gl.projects.get("g/shoplite-tests")!.notes.get(w.agent.iid)).toEqual([]);
    // not in the state: untouched
    expect(gl.projects.get("other/project")!.mrs[0].state).toBe("opened");
    expect(gl.projects.get("other/project")!.branches.has("qa-sentinel/story-X")).toBe(true);
    expect(foreignMr.state).toBe("opened");
    expect(gl.requests.some((r) => r.path.includes("other%2Fproject") && r.method !== "GET")).toBe(false);

    // Jira
    const slot = jira.issues.get(w.k("delivery-slot"))!;
    expect(slot.comments.map((c) => c.id).sort()).toEqual([w.theirs, w.plain].sort());
    expect(Object.keys(slot.props)).toEqual(["unrelated.property"]);
    expect(jira.deletedAttachments).toEqual(["att-1"]);
    expect(slot.fields.status.name).toBe("In Progress");
    expect(jira.issues.get("DEMO-900")!.comments).toHaveLength(1);
    expect(jira.requests.some((r) => r.path.includes("DEMO-900") && r.method !== "GET")).toBe(false);

    // the state keeps projects and cards, forgets the run
    const st = state();
    expect(st.mrs).toEqual([]);
    expect(st.merges).toEqual([]);
    expect(st.branches).toEqual([]);
    expect(Object.keys(st.cards)).toHaveLength(5);
    expect(logs.join("\n")).toMatch(/same files as demo-baseline/);
    expect(logs.join("\n")).not.toContain(TOKEN);
    expect(logs.join("\n")).not.toContain(JIRA_TOKEN);
  });

  it("is idempotent: a second run finds nothing to do and sends no write", async () => {
    await afterADemo();
    await reset(resetArgs());
    gl.requests.length = 0;
    jira.requests.length = 0;
    logs.length = 0;
    expect(await reset(resetArgs())).toBe(0);
    expect(gl.writes()).toHaveLength(0);
    expect(jira.writes()).toHaveLength(0);
    expect(logs.join("\n")).toMatch(/Nothing to do/);
  });

  it("the demo can be run again after a reset", async () => {
    await afterADemo();
    await reset(resetArgs());
    await mergeCard("delivery-slot");
    expect(gl.files("g/shoplite-orders", "main")["src/server.js"]).toContain("MAX_ORDERS_PER_SLOT = 5");
    await reset(resetArgs());
    expect(gl.files("g/shoplite-orders", "main")["src/server.js"]).not.toContain("MAX_ORDERS_PER_SLOT");
  });

  it("reports MANUAL steps when GitLab will not revert, keeps the records, and a repeat can finish", async () => {
    const w = await afterADemo();
    (w.orders as any).failReverts = true;
    expect(await reset(resetArgs())).toBe(1);
    expect(logs.join("\n")).toMatch(/MANUAL: GitLab would not revert/);
    expect(logs.join("\n")).toMatch(/git revert/);
    expect(state().merges.length).toBeGreaterThan(0); // not forgotten
    (w.orders as any).failReverts = false;
    expect(await reset(resetArgs())).toBe(0);
    expect(gl.files("g/shoplite-orders", "main")).toEqual(w.orders.commits.get(w.orders.tags.get("demo-baseline")!)!.files);
  });

  it("does not delete comments when Jira will not say who the login is", async () => {
    const w = await afterADemo();
    const real = jira.requests.length;
    void real;
    // a login that Jira does not know: the /myself answer has no id
    const server = await startFakeJiraWithoutMyself(jira);
    const st = state();
    st.jira.baseUrl = server.url;
    fs.writeFileSync(files().stateFile, JSON.stringify(st));
    const cfg = JSON.parse(fs.readFileSync(files().configFile, "utf8"));
    cfg.jira.baseUrl = server.url;
    fs.writeFileSync(files().configFile, JSON.stringify(cfg));
    try {
      await reset({ ...base(), args: {} });
      expect(logs.join("\n")).toMatch(/Jira comments are NOT touched/);
      expect(logs.join("\n")).not.toMatch(/\[jira\] .*delete comment/);
    } finally {
      await server.close();
    }
    void w;
  });

  it("cleans the test repo folder and keeps unrelated files", async () => {
    await afterADemo();
    const dir = path.join(tmp, "tests-repo");
    fs.mkdirSync(path.join(dir, ".qa-sentinel/stories"), { recursive: true });
    fs.writeFileSync(path.join(dir, "qa-sentinel.config.yaml"), "version: 1\n");
    fs.writeFileSync(path.join(dir, "qa-stories.md"), "# stories");
    fs.writeFileSync(path.join(dir, ".qa-sentinel/stories/DEMO-1.json"), "{}");
    fs.writeFileSync(path.join(dir, "keep.txt"), "keep");
    await reset({ ...base(), args: { "tests-dir": dir, "skip-doctor": true } });
    expect(fs.existsSync(path.join(dir, "qa-stories.md"))).toBe(true); // dry run
    await reset(resetArgs({ "tests-dir": dir, "skip-doctor": true }));
    expect(fs.existsSync(path.join(dir, "qa-stories.md"))).toBe(false);
    expect(fs.existsSync(path.join(dir, ".qa-sentinel"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "keep.txt"))).toBe(true);
    await rejects(reset({ ...base(), args: { "tests-dir": tmp } }), /no qa-sentinel\.config\.yaml/);
  });

  it("runs doctor in the test repo folder at the end (a stand-in command here)", async () => {
    await afterADemo();
    const dir = path.join(tmp, "tests-repo");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "qa-sentinel.config.yaml"), "version: 1\n");
    const fake = path.join(tmp, "fake-doctor.mjs");
    fs.writeFileSync(fake, `import fs from "node:fs"; fs.writeFileSync("doctor-ran.txt", process.argv.slice(2).join(" "));`);
    await reset({ ...resetArgs({ "tests-dir": dir }), env: env({ QA_SENTINEL_BIN: `${process.execPath} ${fake}` }) });
    expect(fs.readFileSync(path.join(dir, "doctor-ran.txt"), "utf8")).toBe("doctor");
  });

  it("only deletes bug cards that qa-sentinel raised when asked, and only the ones it labelled and the login reported", async () => {
    const w = await afterADemo();
    const slotKey = w.k("delivery-slot");
    jira.issues.get(slotKey)!.props["qa-sentinel.bugs"] = { "AC-3": { key: "DEMO-701" }, "AC-4": { key: "DEMO-702" } };
    jira.addForeign("DEMO-701");
    jira.issues.get("DEMO-701")!.fields.labels = ["qa-sentinel"];
    jira.issues.get("DEMO-701")!.fields.reporter = jira.ME;
    jira.addForeign("DEMO-702"); // no label, other reporter
    await reset(resetArgs());
    expect(jira.issues.has("DEMO-701")).toBe(true);
    expect(logs.join("\n")).toMatch(/--delete-bugs/);
    await reset(resetArgs({ "delete-bugs": true }));
    expect(jira.issues.has("DEMO-701")).toBe(false);
    expect(jira.issues.has("DEMO-702")).toBe(true);
  });
});

describe("setup-gitlab", () => {
  it("is a dry run by default and sends nothing", async () => {
    await setupGitlab({ ...base(), args: {} });
    expect(gl.requests).toHaveLength(0);
    expect(logs.join("\n")).toMatch(/dry run/);
    expect(logs.join("\n")).toMatch(/demo-baseline/);
  });

  it("will not fill a project that already has commits", async () => {
    gl.projects.get("g/shoplite-orders")!.empty = false;
    await rejects(setupGitlab({ ...base(), args: { yes: true } }), /already has commits/);
    expect(gl.writes()).toHaveLength(0);
  });
});

/** A second fake Jira whose /myself answers with nothing useful. */
async function startFakeJiraWithoutMyself(real: Awaited<ReturnType<typeof startFakeJira>>) {
  const http = await import("node:http");
  const server = http.createServer((req, res) => {
    if (req.url === "/rest/api/2/myself") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end("{}");
    }
    const target = new URL(real.url);
    const up = http.request({ host: target.hostname, port: target.port, path: req.url, method: req.method, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    req.pipe(up);
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  return { url: `http://127.0.0.1:${(server.address() as any).port}`, close: () => new Promise<void>((ok) => server.close(() => ok())) };
}
