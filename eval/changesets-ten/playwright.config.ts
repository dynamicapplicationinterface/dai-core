import { defineConfig, devices } from "@playwright/test";

/*
 * The changeset spike's ten cold apps, rerun through the real runtime (R-O,
 * Build 1). Not part of the suite: run by hand, after `npm run build`,
 *
 *   npx playwright test --config eval/changesets-ten/playwright.config.ts
 *
 * and the results land in eval/changesets-ten/out/. The runner is served as
 * the suite serves it, on the same port, so never run it beside the suite.
 */
export default defineConfig({
  testDir: ".",
  testMatch: ["ten-apps.spec.ts", "history.spec.ts"],
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  timeout: 300_000,
  use: { acceptDownloads: true, ...devices["Desktop Chrome"] },
  webServer: [
    {
      command:
        "npx vite build --config apps/runner/vite.config.ts apps/runner && " +
        "npx vite preview --config apps/runner/vite.config.ts apps/runner",
      cwd: "../..",
      url: "http://localhost:5175/",
      reuseExistingServer: false,
      timeout: 180_000,
    },
  ],
});
