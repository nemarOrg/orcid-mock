import { defineConfig } from "@playwright/test";

// A project for tests/runner.test.ts: it runs the fixtures through Playwright's own runner.
// Two workers, so that two containers start at once and each worker proves it has its own.
export default defineConfig({
  testDir: ".",
  testMatch: "*.pw.ts",
  // precedence.pw.ts needs its own environment, so it runs only when asked for.
  testIgnore: process.env.RUNNER_PRECEDENCE ? [] : ["**/precedence.pw.ts"],
  workers: 2,
  // tests/runner.test.ts asks for a JSON report, to read which mock each test used.
  reporter: process.env.RUNNER_JSON
    ? [["list"], ["json", { outputFile: process.env.RUNNER_JSON }]]
    : [["list"]],
  timeout: 60_000,
  outputDir: process.env.RUNNER_OUTPUT_DIR ?? "test-results",
  use: { browserName: "chromium" },
});
