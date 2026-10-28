import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { VERSION } from "../src/run.js";

const ROOT = path.resolve(__dirname, "..");
const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));

describe("one version everywhere", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version as string;
  it("package.json, VERSION and package-lock.json agree", () => {
    expect(VERSION).toBe(pkg);
    const lock = JSON.parse(fs.readFileSync(path.join(ROOT, "package-lock.json"), "utf8"));
    expect(lock.version).toBe(pkg);
    expect(lock.packages[""].version).toBe(pkg);
  });
  it("every CI template that installs qa-sentinel names this version, and none names another", () => {
    const files = walk(path.join(ROOT, "templates/ci"));
    const found: string[] = [];
    for (const f of files) {
      const text = fs.readFileSync(f, "utf8");
      for (const m of text.matchAll(/(?:QA_SENTINEL_VERSION:\s*"|qa-sentinel@)(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)/g)) found.push(`${path.relative(ROOT, f)}=${m[1]}`);
    }
    expect(found.length).toBeGreaterThanOrEqual(9);
    expect(found.filter((x) => !x.endsWith(`=${pkg}`))).toEqual([]);
    for (const f of ["gitlab/service.gitlab-ci.yml", "gitlab/tests.gitlab-ci.yml", "github/qa-gap-report.yml", "jenkins/Jenkinsfile.tests", "jenkins/Jenkinsfile.gap-report", "jenkins/Jenkinsfile.generate", "github/README.md"]) expect(found.some((x) => x.startsWith(`templates/ci/${f}=`)), f).toBe(true);
  });
  it("the README's install line names this version", () => {
    const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
    for (const m of readme.matchAll(/qa-sentinel#v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)/g)) expect(m[1]).toBe(pkg);
  });
  it("the CHANGELOG has one heading for this version and no 'Unreleased' left", () => {
    const log = fs.readFileSync(path.join(ROOT, "CHANGELOG.md"), "utf8");
    const h2 = log.split("\n").filter((l) => /^## /.test(l));
    expect(h2[0]).toBe(`## ${pkg}`);
    expect(h2.filter((l) => /unreleased/i.test(l))).toEqual([]);
  });
  it("the demo script covers /qa ready, per-AC readiness, the post-deploy re-run, release-features and metrics --runs", () => {
    const d = fs.readFileSync(path.join(ROOT, "demo/DEMO-SCRIPT.md"), "utf8");
    for (const w of ["/qa ready", "Waiting ACs", "post-deploy", "release-features", "metrics", "--runs"]) expect(d, w).toContain(w);
    expect(d).toMatch(/does \*\*not\*\* set this up/);
  });
});
