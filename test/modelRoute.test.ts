import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { authHint, modelRoute, readManagedEnv } from "../src/modelRoute.js";
import { scrubbedEnv } from "../src/env.js";

const none = { env: {}, helper: false };
const home = fs.mkdtempSync(path.join(os.tmpdir(), "qas-home-"));

describe("model route (Bedrock, Vertex, gateways, managed settings)", () => {
  it("names the route and what is missing", () => {
    expect(modelRoute({}, none, home)).toMatchObject({ kind: "login" });
    expect(modelRoute({ ANTHROPIC_API_KEY: "sk-ant-x" }, none, home)).toMatchObject({ kind: "api-key" });
    expect(modelRoute({ CLAUDE_CODE_USE_BEDROCK: "1" }, none, home)).toMatchObject({ kind: "bedrock", missing: ["AWS_REGION"], unsure: [expect.stringMatching(/instance role/)] });
    expect(modelRoute({ CLAUDE_CODE_USE_BEDROCK: "1", AWS_REGION: "ap-southeast-1", AWS_PROFILE: "qa" }, none, home)).toMatchObject({ kind: "bedrock", missing: [] });
    expect(modelRoute({ CLAUDE_CODE_USE_VERTEX: "1", CLOUD_ML_REGION: "us-east5" }, none, home).missing).toEqual(["ANTHROPIC_VERTEX_PROJECT_ID"]);
    expect(modelRoute({ CLAUDE_CODE_USE_BEDROCK: "0", ANTHROPIC_API_KEY: "k" }, none, home).kind).toBe("api-key");
  });

  it("reads the organisation's managed settings: their gateway wins over a personal key", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qas-managed-"));
    const file = path.join(dir, "managed-settings.json");
    fs.writeFileSync(file, JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://api.ai.example.gov/v1" }, apiKeyHelper: "/usr/local/bin/key" }));
    const m = readManagedEnv([file]);
    const r = modelRoute({ ANTHROPIC_API_KEY: "sk-ant-personal" }, m, home);
    expect(r).toMatchObject({ kind: "gateway", host: "api.ai.example.gov", managed: file });
    expect(authHint(r)).toMatch(/personal Anthropic key won't work there/);
  });

  it("the agent gets the cloud credentials its route needs; test runs never do", () => {
    const env = { PATH: "/bin", CLAUDE_CODE_USE_BEDROCK: "1", AWS_REGION: "ap-southeast-1", AWS_SECRET_ACCESS_KEY: "s", AWS_ACCESS_KEY_ID: "a" };
    const agent = scrubbedEnv({ baseUrlEnv: "QA_BASE_URL", passEnv: [], forAgent: true }, env);
    expect(agent).toMatchObject({ CLAUDE_CODE_USE_BEDROCK: "1", AWS_REGION: "ap-southeast-1", AWS_SECRET_ACCESS_KEY: "s" });
    const tests = scrubbedEnv({ baseUrlEnv: "QA_BASE_URL", passEnv: [], forAgent: false }, env);
    expect(tests.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(tests.AWS_ACCESS_KEY_ID).toBeUndefined();
  });
});
