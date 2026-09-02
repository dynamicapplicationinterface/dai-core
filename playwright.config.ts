import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  globalSetup: "./tests/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  use: {
    // Containers are opened from disk, never served.
    acceptDownloads: true,
    trace: "retain-on-failure",
  },
  // The Studio is a normal web app and must be served; the container tests
  // still open their artifacts straight from disk over file://.
  webServer: {
    command: "npx vite --config examples/web-studio/vite.config.ts examples/web-studio",
    url: "http://localhost:5174/",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
});
