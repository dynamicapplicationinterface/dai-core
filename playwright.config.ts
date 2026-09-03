import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  globalSetup: "./tests/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // "github" annotates each failure on the run's summary page, so a red build
  // says what broke without anybody downloading an artifact to find out.
  reporter: process.env.CI
    ? [["github"], ["list"], ["html", { open: "never" }]]
    : [["list"]],
  use: {
    // Containers are opened from disk, never served.
    acceptDownloads: true,
    trace: "retain-on-failure",
  },
  // The Studio and the runner are normal web apps and must be served; the
  // container tests still open their artifacts straight from disk over file://.
  webServer: [
    {
      command: "npx vite --config examples/web-studio/vite.config.ts examples/web-studio",
      url: "http://localhost:5174/",
      reuseExistingServer: !process.env.CI,
      timeout: process.env.CI ? 300_000 : 120_000,
    },
    {
      /*
       * The website, built and previewed.
       *
       * Added because a page can lose the control it exists for without any
       * test noticing: an edit removed the `finished` binding the build step is
       * gated on, Vue resolved it to undefined, the section disappeared, and
       * the build stayed green on three engines. Only opening the page catches
       * that.
       */
      command: "npm --prefix website run build && npm --prefix website run preview -- --port 5176",
      url: "http://localhost:5176/",
      reuseExistingServer: !process.env.CI,
      timeout: process.env.CI ? 300_000 : 120_000,
    },
    {
      // Built and previewed rather than dev-served: a cache-first service
      // worker would freeze a dev server's unbundled modules, and the worker is
      // most of what the runner tests are checking.
      command:
        "npx vite build --config apps/runner/vite.config.ts apps/runner && " +
        "npx vite preview --config apps/runner/vite.config.ts apps/runner",
      url: "http://localhost:5175/",
      reuseExistingServer: !process.env.CI,
      timeout: process.env.CI ? 300_000 : 120_000,
    },
  ],
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
});
