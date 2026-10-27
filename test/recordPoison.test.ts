import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigSchema, writeConfig } from "../src/config.js";
import { publishCommand } from "../src/commands/publish.js";
import { cleanTmp, tmp } from "./helpers/mocks.js";
afterEach(() => cleanTmp());

async function withJira(run: (o: { cwd: string; props: Record<string, any>; env: NodeJS.ProcessEnv }) => Promise<void>) {
  const props: Record<string, any> = {};
  const srv = http.createServer((req, res) => { let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => {
    const m = req.url!.match(/\/issue\/([^/]+)\/properties\/(.+)$/);
    if (m) { const k = m[1] + "/" + m[2]; if (req.method === "PUT") { props[k] = JSON.parse(b); res.writeHead(204).end(); return; }
      if (k in props) { res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ key: m[2], value: props[k] })); return; } }
    res.writeHead(404, { "content-type": "application/json" }).end("{}"); }); });
  await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok));
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  try {
    const cwd = tmp("qas-poison-");
    writeConfig(cwd, ConfigSchema.parse({ version: 1, mode: "existing", project: { name: "t" }, tests: { api: { framework: "playwright", runCommand: "x" } }, ci: { platform: "gitlab" }, requirements: { jira: { baseUrl: base } }, automation: { record: "jira" } }));
    await run({ cwd, props, env: { JIRA_PAT: "x" } });
  } finally { srv.close(); }
}
const craftRun = (cwd: string, steps: unknown[]) => {
  const dir = path.join(cwd, ".qa-sentinel", "runs", "evil");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "publish.json"), JSON.stringify({ version: 1, kind: "generate", runId: "evil", createdAt: "x", steps }));
};
const entries = [{ ac: "AC-1", kind: "single", state: "written", heads: "h", acHash: "a" }, { ac: "AC-2", kind: "cross", state: "written", heads: "h", acHash: "a" }, { ac: "AC-3", kind: "single", state: "held", heads: "h", acHash: "a", reason: "r" }];

describe("a hostile publish.json cannot write the record of a story it is not about", () => {
  it("a record step for another story with no merge request: nothing is claimed written, no reset, a held entry only", async () => {
    await withJira(async ({ cwd, props, env }) => {
      craftRun(cwd, [{ type: "record", story: "OTHER-9", reset: true, entries, evidence: [] }]);
      await publishCommand({ cwd, kind: "generate", env });
      const rec = props["OTHER-9/qa-sentinel.record"];
      expect(Object.values(rec?.singleService ?? {}).map((x: any) => x.state)).toEqual(["held"]);
      expect(rec?.crossService ?? {}).toEqual({});
    });
  });
  it("a record step for another story than the run's merge request is refused", async () => {
    await withJira(async ({ cwd, props, env }) => {
      craftRun(cwd, [{ type: "record", story: "OTHER-9", entries: [], evidence: [], reset: true }, { type: "merge-request", branch: "qa-sentinel/story-SHOP-1", headSha: "a".repeat(40), storyKey: "SHOP-1", title: "t", description: "d", labels: [] }]);
      expect(await publishCommand({ cwd, kind: "generate", env })).toBe(1);
      expect(props["OTHER-9/qa-sentinel.record"]).toBeUndefined();
    });
  });
  it("a conflict step: not for the story's branch, or carrying entries or reset, is refused before anything is written", async () => {
    await withJira(async ({ cwd, props, env }) => {
      const conflict = (branch: string) => ({ branch, message: "[click here|https://evil.example]", key: "k" });
      craftRun(cwd, [
        { type: "record", story: "OTHER-9", conflict: conflict("qa-sentinel/evil"), entries: [], evidence: [] },
        { type: "record", story: "OTHER-9", conflict: conflict("qa-sentinel/story-OTHER-9"), reset: true, entries, evidence: [] },
      ]);
      expect(await publishCommand({ cwd, kind: "generate", env })).toBe(1);
      expect(props["OTHER-9/qa-sentinel.record"]).toBeUndefined();
    });
  });
});
