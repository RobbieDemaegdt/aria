import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  timeout: 10 * 60_000,
  expect: { timeout: 180_000 },
  workers: 1,
  reporter: [["list"]],
  outputDir: "e2e/.artifacts/results",
});
