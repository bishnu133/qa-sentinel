import { defineConfig } from "vitest/config";

// Only qa-sentinel's own unit tests; sandbox/ and examples/ hold Playwright specs for the generated projects.
export default defineConfig({ test: { include: ["test/**/*.test.ts"] } });
