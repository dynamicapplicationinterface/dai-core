import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { compileDirectory } from "../src/compile.js";
import { openFile } from "./open.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * An ordinary document's data worker (R-Y) starts from bytes the document
 * already holds: the shell reads the glue from the verified entries (or, for
 * a thin document, the copy the opener holds) and starts the worker from a
 * blob it mints itself. Nothing is fetched.
 *
 * WebKit fails a blob's load while its network is offline, under the driver's
 * offline emulation: a worker started then reports an error before its script
 * runs. The shell treated that as the document failing and refused it, and
 * the refusal stood over the opener's menu. A worker that never ran has been
 * given nothing, so nothing is lost with it: it is started again, and the
 * document is not refused. Offline the moment the document has loaded, the
 * menu opens and nothing is refused, on every engine; back online, the data
 * answers.
 *
 * (The application's own scripts are blobs too, and WebKit fails those under
 * the same emulation whether or not the document has a worker: the page's
 * application is not what this holds.)
 */
test("offline the moment an ordinary document has loaded: the menu opens, nothing is refused, and back online the data's worker runs", async ({ page, context, browserName }) => {
  test.slow();
  const built = await compileDirectory({ sourceDir: resolve(repo, "examples/chore-chart"), root: repo, appName: "Chore chart" });
  await page.goto("http://localhost:5175/");
  await openFile(page, { name: "chore-chart.dai.html", mimeType: "text/html", buffer: Buffer.from(built.html, "utf8") });
  await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });
  await context.setOffline(true);
  try {
    await page.locator("#more").click({ timeout: 15_000 });
    await expect(page.locator("#sheet-version"), "the menu opened").toBeVisible({ timeout: 15_000 });
    await expect(page.locator("#report"), "the document is not refused").not.toContainText("could not be started");
  } finally {
    await context.setOffline(false);
  }
  // The shell's own word for its data worker: started again, from the bytes it holds, once it could load.
  const shell = page.frameLocator("#cartridge").locator("body");
  await expect
    .poll(() => shell.evaluate(() => (window as unknown as { __DAI__: { dataWorker: string } }).__DAI__.dataWorker), {
      timeout: 60_000,
      message: "back online, the data's worker is running",
    })
    .toBe("running");
  // And the application, which asks the worker for its data. Not on WebKit: the driver's offline emulation
  // failed the application's own scripts (blobs) as they loaded, with or without a worker (the tasks example
  // has none and loses them the same way), so no application is there to ask.
  if (browserName === "webkit") return;
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __runner: { replicaId(): Promise<string | null> } }).__runner.replicaId()), {
      timeout: 60_000,
      message: "back online, the document's data answers",
    })
    .toEqual(expect.any(String));
});
