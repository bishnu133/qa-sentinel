import { describe, expect, it } from "vitest";
import { nonTagChanges, untagged } from "../src/commands/tag.js";

describe("tag backfill check", () => {
  it("accepts diffs that only add tags to titles", () => {
    const diff = `diff --git a/t.spec.ts b/t.spec.ts
@@ -3 +3 @@
-  test("creates an order", async ({ api }) => {
+  test("creates an order @service:orders @endpoint:POST_/orders", async ({ api }) => {
@@ -9 +9 @@
-  test(\`gets \${id}\`, async () => {
+  test(\`gets \${id} @service:orders @endpoint:GET_/orders/{id}\`, async () => {`;
    expect(nonTagChanges(diff)).toEqual([]);
    expect(untagged('test("a @page:/x/:id", () => {')).toBe('test("a", () => {');
  });
  it("rejects any other change", () => {
    const diff = `@@ -3 +3 @@
-    expect(res.status()).toBe(201);
+    expect(res.status()).toBe(200);
@@ -7,0 +8 @@
+    console.log("x");`;
    expect(nonTagChanges(diff)).toEqual(["-    expect(res.status()).toBe(201);", "+    expect(res.status()).toBe(200);", '+    console.log("x");']);
  });
  it("rejects code, comments, data or removed tags dressed up as tags", () => {
    const pair = (a: string, b: string) => nonTagChanges(`@@ -1 +1 @@\n-${a}\n+${b}`);
    expect(pair("  test(`creates order ${n}`, async () => {", "  test(`creates order ${n} @service:x${globalThis.process.exit(0)}`, async () => {")).not.toEqual([]);
    expect(pair("    expect(r.status()).toBe(201); // @ok", "    expect(r.status()).toBe(201); // @ok:x;expect.soft=()=>0")).not.toEqual([]);
    expect(pair('    const user = "admin@acme";', '    const user = "admin@guest";')).not.toEqual([]);
    expect(pair('  test("x @service:orders", () => {', '  test("x @service:payments", () => {')).not.toEqual([]);
    expect(pair('  it("opens @screen:home", async () => {', '  it("opens @screen:home @service:app @ac:none", async () => {')).toEqual([]);
  });
});
