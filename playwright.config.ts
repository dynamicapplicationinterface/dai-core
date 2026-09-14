import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

/*
 * Specs that never open a browser, run once instead of once per engine.
 *
 * Decided by reading each spec, so a new one lands on the right side without
 * anybody keeping a list. The rule errs toward the browser: a spec is node-only
 * only if the words page, browser, context and browserName appear nowhere in
 * it, comments included. A wrong call the other way would be silent — a spec
 * that needs an engine, run on one where it used to run on three — so a spec
 * that merely mentions "the page" in prose stays on all three.
 */
const specs = fileURLToPath(new URL("./tests/", import.meta.url));
const NODE_ONLY = readdirSync(specs)
  .filter((file) => file.endsWith(".spec.ts"))
  .filter((file) => !/\b(page|browser|context|browserName)\b/.test(readFileSync(specs + file, "utf8")))
  .map((file) => `**/${file}`);

export default defineConfig({
  testDir: "./tests",
  globalSetup: "./tests/global-setup.ts",
  /*
   * Four workers here, two per engine job in CI, each spec file kept whole on
   * one worker. Set from evidence, not hope: three full chromium passes on
   * different schedules — four workers with files whole, four with tests
   * split across workers, three with tests split — each ran every test with
   * no failures. Seven workers did not: one run found a test racing its own
   * save (fixed), the next lost a worker's browser between two tests for no
   * reason the log records. So the ceiling is four until a clean run says
   * otherwise. A spec that cannot share the machine is serialized by name,
   * never hidden by dropping this back to one.
   */
  fullyParallel: false,
  workers: process.env.CI ? 2 : 4,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // "github" annotates each failure on the run's summary page, so a red build
  // says what broke without anybody downloading an artifact to find out.
  // The count gate runs everywhere, because the failure it catches — tests
  // that stopped being collected — is invisible in every other signal a green
  // run produces. See tests/count-gate.ts.
  reporter: process.env.CI
    ? [["github"], ["list"], ["html", { open: "never" }], ["./tests/count-gate.ts"]]
    : [["list"], ["./tests/count-gate.ts"]],
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
    { name: "chromium", use: { ...devices["Desktop Chrome"] }, testIgnore: NODE_ONLY },
    { name: "firefox", use: { ...devices["Desktop Firefox"] }, testIgnore: NODE_ONLY },
    { name: "webkit", use: { ...devices["Desktop Safari"] }, testIgnore: NODE_ONLY },
    { name: "node", testMatch: NODE_ONLY },
  ],
});
