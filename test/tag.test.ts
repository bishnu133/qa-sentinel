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
});
