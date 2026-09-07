import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { compileDirectory } from "../src/compile.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER_URL = "http://localhost:5175/";

/**
 * Where the edges of the screen are, told to the document drawing to them.
 *
 * `env(safe-area-inset-*)` is zero inside an iframe, always, and an
 * application runs two frames below the page that can see the real values.
 * It did not matter while the host reserved a strip at the top and padded the
 * bottom: the application was handed a rectangle already clear of the status
 * bar and the home indicator. The application has the whole screen now — it
 * draws under both — so the host measures them and passes them down, host to
 * shell to application, as custom properties an application can pad with.
 *
 * A test browser reports no insets, so what this holds is the path: that the
 * properties are set at all, on both documents, without the application
 * having asked.
 */
test("the screen's edges reach the application, which cannot measure them itself", async ({ page }) => {
  const source = mkdtempSync(join(tmpdir(), "dai-safe-"));
  writeFileSync(
    join(source, "index.html"),
    '<!doctype html><meta charset="utf-8"><p id="app">here</p>',
    "utf8",
  );
  const built = await compileDirectory({ sourceDir: source, root: repo, appName: "Edges" });
  const file = join(source, "edges.dai.html");
  writeFileSync(file, built.html, "utf8");

  await page.goto(RUNNER_URL);
  await page.setInputFiles("#file", file);
  await page.locator("#card-open").click({ timeout: 60_000 });
  await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });

  const read = () =>
    page
      .frameLocator("#cartridge")
      .frameLocator("#dai-app")
      .locator("body")
      .evaluate(() =>
        ["top", "right", "bottom", "left"].map((edge) =>
          document.documentElement.style.getPropertyValue(`--dai-safe-${edge}`),
        ),
      );

  // Set on the application's own root, from a measurement two documents up.
  await expect.poll(read, { timeout: 30_000 }).toEqual(["0px", "0px", "0px", "0px"]);

  // And on the shell between them, which has chrome of its own to keep clear.
  const shell = await page
    .frameLocator("#cartridge")
    .locator("body")
    .evaluate(() => document.documentElement.style.getPropertyValue("--dai-safe-bottom"));
  expect(shell).toBe("0px");
});
