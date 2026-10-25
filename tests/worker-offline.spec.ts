import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type FrameLocator, type Page } from "@playwright/test";
import { compileDirectory } from "../src/compile.js";
import { openFile } from "./open.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * An ordinary document's data worker (R-Y) starts from bytes the document
 * already holds: the shell reads the glue from the verified entries (or, for
 * a thin document, the copy the opener holds) and starts the worker from a
 * blob it mints itself. Nothing is fetched.
 *
 * WebKit fails every blob load while its network is offline, under the
 * driver's offline emulation (a page with no code of ours loses a blob
 * script, a blob worker and a blob fetch alike; Chromium and Firefox load all
 * three). A worker started then reports an error before its script runs. The
 * shell treated that as the document failing and refused it, and the refusal
 * stood over the opener's menu. A worker that never ran has been given
 * nothing, so nothing is lost with it: it is started again, and the document
 * is not refused.
 */

let built: string;
test.beforeAll(async () => {
  built = (await compileDirectory({ sourceDir: resolve(repo, "examples/chore-chart"), root: repo, appName: "Chore chart" })).html;
});

/** The shell's own word for its data worker; "no shell" until the shell document has loaded. */
const dataWorker = (shell: FrameLocator): Promise<string> =>
  shell
    .locator("body")
    .evaluate(() => {
      const facts = (window as unknown as { __DAI__?: { dataWorker?: string } }).__DAI__;
      return facts ? (facts.dataWorker ?? "unsaid") : "no shell";
    })
    .catch(() => "no shell");

async function open(page: Page): Promise<FrameLocator> {
  await page.goto("http://localhost:5175/");
  await openFile(page, { name: "chore-chart.dai.html", mimeType: "text/html", buffer: Buffer.from(built, "utf8") });
  await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });
  const shell = page.frameLocator("#cartridge");
  // Loaded: the document's own shell is there. The opener's page says "loaded" before its frame has the shell,
  // and under WebKit's emulation going offline in between fails the shell's own (blob) load: the opener's, not this.
  await expect.poll(() => dataWorker(shell), { timeout: 60_000, message: "the document's shell has loaded" }).not.toBe("no shell");
  return shell;
}

/** Back online, the shell's data worker runs; where the application could load, the data answers. */
async function answers(page: Page, shell: FrameLocator, askApplication: boolean): Promise<void> {
  await expect.poll(() => dataWorker(shell), { timeout: 60_000, message: "the data's worker is running" }).toBe("running");
  if (!askApplication) return;
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __runner: { replicaId(): Promise<string | null> } }).__runner.replicaId()), {
      timeout: 60_000,
      message: "the document's data answers",
    })
    .toEqual(expect.any(String));
}

test("offline the moment a worker document has loaded: the menu opens, nothing is refused, and back online the data's worker runs", async ({ page, context, browserName }) => {
  test.slow();
  const shell = await open(page);
  await context.setOffline(true);
  try {
    await page.locator("#more").click({ timeout: 15_000 });
    await expect(page.locator("#sheet-version"), "the menu opened").toBeVisible({ timeout: 15_000 });
    await expect(page.locator("#report"), "the document is not refused").not.toContainText("could not be started");
  } finally {
    await context.setOffline(false);
  }
  // Not the application on WebKit: the emulation fails its own scripts (blobs) as they load, with or without a
  // worker, so no application is there to ask. Offline at this same moment, the chore chart lost its kit in 10 runs
  // of 10; the tasks example, which has no worker, lost its script in 8 of 10 and drew whole in 2, a race with the
  // script's load. Online on WebKit, and offline on Chromium and Firefox, it drew whole every time.
  await answers(page, shell, browserName !== "webkit");
});

/*
 * Whether the worker's script was still loading at the moment the test went
 * offline is a race the test does not hold. So the same case, held: the first
 * worker the shell starts has its script's blob revoked before it loads, as
 * the emulation fails it, on every engine.
 */
test("a data worker whose script never loaded is started again: nothing is refused, and the data's worker runs", async ({ page, context }) => {
  test.slow();
  await context.addInitScript(() => {
    // The shell alone: a blob document framed directly by the opener.
    if (!location.href.startsWith("blob:") || window === window.top || window.parent !== window.top) return;
    const Real = window.Worker;
    let first = true;
    window.Worker = function (url: string | URL, options?: WorkerOptions): Worker {
      if (first) {
        first = false;
        URL.revokeObjectURL(String(url));
      }
      return new Real(url, options);
    } as unknown as typeof Worker;
  });
  const said: string[] = [];
  page.on("console", (m) => said.push(m.text()));
  const shell = await open(page);
  // Whichever comes first: the worker started again, or the document refused for it.
  const refused = async (): Promise<boolean> => (await page.locator("#report").innerText().catch(() => "")).includes("could not be started");
  await expect
    .poll(async () => said.some((s) => s.includes("the data's worker did not start")) || (await refused()), { timeout: 30_000, message: "the first worker's failure was answered" })
    .toBe(true);
  expect(await refused(), "the document is not refused").toBe(false);
  await answers(page, shell, true);
});
