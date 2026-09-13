import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type FrameLocator, type Page } from "@playwright/test";
import { compileDirectory } from "../src/compile.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER_URL = "http://localhost:5175/";
const app = (page: Page): FrameLocator => page.frameLocator("iframe").frameLocator("iframe");

/**
 * The write rules arrive before the frame is listening, and are not lost.
 *
 * The host pushes the rules at the handshake. The handshake is sent by the
 * shell before the application frame's bridge exists — the bridge is written
 * into the frame only after `dai:frame-hello` and `dai:payload`. The shell used
 * to relay the rules the instant they arrived, to whatever `frame.contentWindow`
 * was at that moment, and a message posted to a window with no listener is not
 * queued. It is dropped, and nothing re-sent it.
 *
 * That is a race between a network fetch and an in-process frame boot, and it
 * had one outcome on every desktop and the other on a phone: the desktop's
 * bridge was installed before the module arrived, the phone's was not, and the
 * phone's application refused its own first write with
 * `WRITE_SURFACE_UNAVAILABLE` every single time. CPU throttling does not
 * reproduce it, because throttling slows both sides and never changes the
 * order. This test changes the order.
 *
 * The real push is disabled by hanging the module fetch, and the rules are
 * instead posted by this test in the handshake handler itself — synchronously,
 * which is earlier than any fetch could deliver them and before the bridge can
 * exist. With the fix the shell holds them until the bridge announces itself
 * and `openDatabase` waits for them; without it they vanish and the first
 * write throws.
 */
test.describe("write rules that arrive before the frame is listening", () => {
  test.slow();
  // No worker: `/runtime/` is cache-first, and a cached module would satisfy
  // the real push and hide whether the early one was delivered.
  test.use({ serviceWorkers: "block" });

  let container: string;
  let moduleSource: string;

  test.beforeAll(async () => {
    const built = await compileDirectory({
      sourceDir: join(repo, "tests", "fixture", "chess"),
      root: repo,
      appName: "Velvet Chess",
    });
    container = join(mkdtempSync(join(tmpdir(), "dai-race-")), "velvet-chess.dai.html");
    writeFileSync(container, built.html, "utf8");
    // The module the runtime is pinned to. The stamp is computed over this
    // file, so posting these bytes is posting the real rules.
    moduleSource = readFileSync(resolve(repo, "dist/dai-merge.js"), "utf8");
  });

  test("are held until the bridge announces itself, then delivered", async ({ page, context }) => {
    // The host's own push never completes: the only rules the frame can get
    // are the ones this test posts early.
    await context.route("**/runtime/dai-merge.*.js", () => new Promise(() => undefined));

    await page.goto(RUNNER_URL);

    /*
     * Posted from the host window, in the handshake handler, before the host
     * has done anything else — which is before the fetch, before the frame's
     * hello has been answered, and before the bridge exists.
     */
    await page.evaluate((source) => {
      window.addEventListener("message", (event) => {
        const data = event.data as { type?: string; payload?: { sessionNonce?: string } };
        if (data?.type !== "DAI_HOST_HANDSHAKE") return;
        (event.source as Window).postMessage(
          {
            type: "DAI_HOST_WRITE_RULES",
            sessionNonce: data.payload?.sessionNonce ?? null,
            source,
            ownCopy: true,
          },
          "*",
        );
      });
    }, moduleSource);

    await page.setInputFiles("#file", container);
    await page.locator("#card-open").waitFor({ timeout: 60_000 });
    await page.locator("#card-open").click();

    // Seeding the practice board is a replicated write; a visible board means
    // the early rules reached the bridge and the first write went through.
    await expect(app(page).locator("#app")).toBeVisible({ timeout: 60_000 });
    await expect(page.locator("#report")).not.toContainText(/WRITE_RULES|MERGE_MODULE/);

    await app(page).locator("[data-new-game]:visible").first().click();
    await app(page).locator("#setup-you").fill("Ada");
    await app(page).locator("#setup-them").fill("Bo");
    await app(page).locator("#new-game-form button[type=submit]").click();
    await app(page).locator('[data-square="e2"]').click();
    await app(page).locator('[data-square="e4"]').click();
    await expect(app(page).locator("#play-move")).toBeEnabled({ timeout: 30_000 });
    await app(page).locator("#play-move").click();
    await expect(app(page).locator("#move-history")).toContainText("e4", { timeout: 30_000 });
  });

  test("a document promised rules that never come opens read-only and says so", async ({
    page,
    context,
  }) => {
    /*
     * The other edge of the wait. `openDatabase` holds the handle until the
     * rules settle, and "settle" has to include "never arrived", or a host
     * that pushes nothing hangs the document instead of degrading it. The
     * document opens, the reason is on screen, and the first write refuses by
     * name rather than by silence.
     */
    await context.route("**/runtime/dai-merge.*.js", () => new Promise(() => undefined));

    await page.goto(RUNNER_URL);
    await page.setInputFiles("#file", container);
    await page.locator("#card-open").waitFor({ timeout: 60_000 });
    await page.locator("#card-open").click();

    await expect(page.locator("#report")).toContainText(/WRITE_RULES_NOT_DELIVERED/, {
      timeout: 60_000,
    });
    await expect(page.locator("#report")).toContainText(/read here but not changed/i);
  });
});
