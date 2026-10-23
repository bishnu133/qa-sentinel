import { defineConfig } from "vitest/config";

// Only qa-sentinel's own unit tests; sandbox/ and examples/ hold Playwright specs for the generated projects.
// 30 s per test: several tests build real git repos and start servers, and a loaded CI runner can take longer than the 5 s default.
export default defineConfig({ test: { include: ["test/**/*.test.ts"], testTimeout: 30000 } });
