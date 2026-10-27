import http from "node:http";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { emptyRecord, fileStore, jiraStore } from "../src/stories/record.js";
import { startJob } from "../src/stories/start.js";
import { applyRecordPatch } from "../src/commands/generate.js";
import { cleanTmp, tmp } from "./helpers/mocks.js";
afterEach(() => cleanTmp());
it("split + record: jira: the per-story budget is not forgotten after a publish (the two record copies are merged field by field)", async () => {
  const props: Record<string, unknown> = {};
  const srv = http.createServer((req, res) => { let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => {
    const m = req.url!.match(/\/issue\/([^/]+)\/properties\/(.+)$/);
    if (m) { const k = m[1] + "/" + m[2]; if (req.method === "PUT") { props[k] = JSON.parse(b); res.writeHead(204).end(); return; }
      if (k in props) { res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ key: m[2], value: props[k] })); return; } }
    if (req.url!.includes("/myself")) { res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ accountId: "bot" })); return; }
    res.writeHead(404, { "content-type": "application/json" }).end("{}"); }); });
  await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok));
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  try {
    const c = ConfigSchema.parse({ version: 1, mode: "existing", project: { name: "t" }, tests: { api: { framework: "playwright", runCommand: "x" } }, ci: { platform: "gitlab" }, requirements: { jira: { baseUrl: base } }, automation: { record: "jira", budgets: { perStoryUsd: 1 } } });
    const analysis = tmp("qas-an-"); const publishCwd = tmp("qas-pub-");
    const env = { JIRA_PAT: "x" };
    // pipeline 1 analysis spent $5 on SHOP-1 (kept in the runner-cached local file)
    await fileStore(analysis).save({ ...emptyRecord("SHOP-1"), totalCostUsd: 5, updatedAt: new Date(Date.now() - 60_000).toISOString() });
    const before = await startJob({ cwd: analysis, c, story: "SHOP-1", kind: "generate", key: "k1", env, local: true });
    // pipeline 1 publish job writes its record step to Jira
    await applyRecordPatch(jiraStore(publishCwd, { baseUrl: base, authHeader: "Bearer x" } as any), "SHOP-1", { entries: [], evidence: [], clearConflict: true });
    const after = await startJob({ cwd: analysis, c, story: "SHOP-1", kind: "generate", key: "k2", env, local: true });
    expect(after.run).toBe(false);
    expect((await fileStore(analysis).load("SHOP-1"))?.totalCostUsd).toBe(5);
  } finally { srv.close(); }
});
