import { describe, expect, it } from "vitest";
import { maskSecrets, safeUrl, secretValues } from "../src/secrets.js";

describe("masking credentials in what qa-sentinel publishes", () => {
  const env = {
    QA_APPIUM_URL: "https://farmuser:f4rm-access-key-123@hub.devicefarm.test/wd/hub",
    PAYMENTS_API_KEY: "sk_test_abcdef123456",
    SHORT_TOKEN: "abc", // too short to mask safely
    QA_BASE_URL: "http://127.0.0.1:8080",
    PATH: "/usr/bin",
  };

  it("collects secret-named values and URL passwords, longest first", () => {
    expect(secretValues(env)).toEqual(["sk_test_abcdef123456", "f4rm-access-key-123"]);
  });

  it("masks a device-farm key the agent quoted, URL credentials anywhere, and secret values", () => {
    const text = [
      "Tests failed: could not reach https://farmuser:f4rm-access-key-123@hub.devicefarm.test/wd/hub/session",
      "The key f4rm-access-key-123 looks wrong; the payments key is sk_test_abcdef123456.",
      "Another hub: http://bob:hunter2hunter2@grid.example/wd/hub",
      "QA_BASE_URL http://127.0.0.1:8080 and abc are untouched.",
    ].join("\n");
    const out = maskSecrets(text, env);
    expect(out).not.toContain("f4rm-access-key-123");
    expect(out).not.toContain("sk_test_abcdef123456");
    expect(out).not.toContain("hunter2hunter2");
    expect(out).toContain("https://[redacted]@hub.devicefarm.test/wd/hub/session");
    expect(out).toContain("http://127.0.0.1:8080 and abc are untouched.");
  });

  it("shows a URL without its credentials", () => {
    expect(safeUrl(env.QA_APPIUM_URL)).toBe("https://[redacted]@hub.devicefarm.test/wd/hub");
    expect(safeUrl("http://127.0.0.1:4723")).toBe("http://127.0.0.1:4723");
  });
});
