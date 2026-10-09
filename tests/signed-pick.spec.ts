import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Frame, type Page } from "@playwright/test";
import { test } from "./fixtures.js";
import { compileDirectory } from "../src/compile.js";

/**
 * A signed replicated file, built as the compiler builds it by default, opens
 * when a person picks it on the opener (backlog D166).
 *
 * The version is left to the compiler on purpose. The specs that pick signed
 * files once pinned `manifestVersion: 3`, which stepped round a bootloader
 * that refused the version 4 the compiler writes for every replicated build;
 * no test met the file a person would have. This one builds with no version
 * given, so a builder and a bootloader that disagree cannot hide again.
 */

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER_URL = "http://localhost:5175/";

const appFrame = (page: Page): Frame => {
  const frame = page.frames().find((f) => f.parentFrame()?.parentFrame() === page.mainFrame());
  if (!frame) throw new Error("app frame not found (main → shell → app)");
  return frame;
};

test("a signed replicated file built at the default version opens from the picker (D166)", async ({ browser }) => {
  test.slow();
  const built = await compileDirectory({
    sourceDir: join(repo, "tests", "fixture", "chess"),
    root: repo,
    appName: "Chess",
    signingKey: resolve(repo, "conformance", "signing-key.pem"),
    allowTestKey: true,
  });
  // What the default is, read rather than assumed: a replicated build is version 4.
  expect(built.manifest.manifestVersion).toBe(4);
  const file = join(mkdtempSync(join(tmpdir(), "dai-d166-")), "chess.dai.html");
  writeFileSync(file, built.html, "utf8");

  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(RUNNER_URL);
  const chooser = page.waitForEvent("filechooser");
  await page.locator("#open").click();
  await (await chooser).setFiles(file);
  await page.locator("#card-open").click({ timeout: 60_000 });

  // Loaded, or refused: whichever comes, so a refusal fails with its own sentence.
  await expect
    .poll(
      async () => {
        const text = await page.locator("body").innerText().catch(() => "");
        if (/which this bootloader does not know|not authentic/.test(text)) return `refused: ${text.slice(0, 300)}`;
        try {
          return (await appFrame(page).evaluate(() => Boolean((window as any).daiKit?.db))) ? "running" : "waiting";
        } catch {
          return "waiting";
        }
      },
      { timeout: 60_000 },
    )
    .toBe("running");
  await expect(page.locator("body")).toHaveClass(/loaded/);
  await context.close();
});
