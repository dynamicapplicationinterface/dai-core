import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  globalSetup: "./tests/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    // Containers are opened from disk, never served.
    baseURL: undefined,
    acceptDownloads: true,
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
