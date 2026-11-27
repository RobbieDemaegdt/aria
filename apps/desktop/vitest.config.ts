import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Unit tests for renderer code that doesn't need Electron (the Playwright E2E in e2e/ covers the running app).
export default defineConfig({
  plugins: [react()],
  // Nothing leaves this PC and GitHub CLI never runs (core's guard, PLAN.md §0.4).
  test: { include: ["test/**/*.test.{ts,tsx}"], setupFiles: ["../../packages/core/test/no-network.ts"] },
});
