import { defineConfig, devices } from "@playwright/test";

// End-to-end smoke suite: the production build (dist-native/) served by the mock
// server, driven by headless Chromium. `npm run test:e2e` is self-contained:
// e2e/support/globalSetup.ts builds dist-native/ when it is missing or older than
// the sources, and every test starts (and kills) its own mock server on a free port.
export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  globalSetup: "./e2e/support/globalSetup.ts",
  outputDir: process.env.E2E_OUTPUT_DIR ?? "test-results",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // A smoke suite that passes on the second attempt hides the problem it found.
  retries: 0,
  // Every test starts its own mock server and browser context; more workers than this
  // only makes each of them slower.
  workers: process.env.CI ? 2 : 4,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    // Wide enough for the three-dock workspace layout (left and right docks hide below 1200px).
    viewport: { width: 1600, height: 1000 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium" }],
});
