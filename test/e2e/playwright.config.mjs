// Browser tests against the built standalone dashboard and the simulator. global-setup.mjs starts
// both with the scenario harness and passes their URLs on in env vars, which the workers inherit.
import { defineConfig, devices } from "@playwright/test";

const CI = !!process.env.CI;

export default defineConfig({
  testDir: "tests",
  globalSetup: "./global-setup.mjs",
  // one dashboard and one simulator are shared, and some tests change a host's scenario
  workers: 1,
  fullyParallel: false,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: CI ? [["github"], ["html", { open: "never" }]] : [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: process.env.PADDOCK_E2E_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    // signs in through the UI, including the forced first password change, and saves the session
    { name: "setup", testMatch: /auth\.setup\.mjs/ },
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], storageState: ".auth/admin.json" },
      dependencies: ["setup"],
    },
  ],
});
