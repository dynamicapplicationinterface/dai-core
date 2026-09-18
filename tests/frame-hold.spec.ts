import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { compileDirectory } from "../src/compile.js";
import { TO_HOST, TO_DOCUMENT } from "../src/bridge.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER_URL = "http://localhost:5175/";

/**
 * Every message from the shell to the application's frame waits for the
 * bridge, and none waits longer than that (backlog D33).
 *
 * A message posted to a frame whose bridge has no listener yet is dropped. The
 * write rules lost that race on a phone, then the merge lost it on WebKit; each
 * was fixed alone, which left every other message racing. Now the shell holds
 * everything by default and releases it when the bridge announces itself. This
 * proves both halves — a message sent before the bridge is answered, and one
 * sent after is not delayed — because a hold that never releases is the same
 * bug wearing different clothes. The sessions question is the probe: it is
 * answered by the frame, and its answer carries the id it was asked with, so
 * this test's own questions cannot be confused with the opener's.
 */

test("the shell sends into the frame directly only once: the payload, which brings the bridge up", () => {
  const source = readFileSync(resolve(repo, "src/runtime/bootloader.ts"), "utf8");
  const direct = source.match(/frame\.contentWindow\?\.postMessage\(/g) ?? [];
  expect(direct, "a second direct send into the frame would skip the hold (see toFrame)").toHaveLength(1);
  expect(source).toMatch(/frame\.contentWindow\?\.postMessage\(framePayload, "\*", transfer\)/);
});

async function jobs(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "dai-frame-hold-"));
  writeFileSync(join(dir, "index.html"), '<!doctype html><meta charset="utf-8"><p id="app">here</p>', "utf8");
  const built = await compileDirectory({ sourceDir: dir, root: repo, appName: "Hold" });
  const file = join(dir, "hold.dai.html");
  writeFileSync(file, built.html, "utf8");
  return file;
}

/** Collects the frame's answers to sessions questions, by id, with when they came. */
async function listenForAnswers(page: Page): Promise<void> {
  // The name travels in as an argument: this runs in the page, where nothing
  // imported here exists.
  await page.evaluate((answer) => {
    const w = window as unknown as { __answers: Record<string, number> };
    w.__answers = {};
    window.addEventListener("message", (event) => {
      const data = event.data as { type?: string; id?: string };
      if (data?.type === answer && typeof data.id === "string") w.__answers[data.id] = performance.now();
    });
  }, TO_HOST.SESSIONS_ANSWER);
}

test("a message sent before the bridge is listening is held and answered", async ({ page }) => {
  const file = await jobs();
  await page.goto(RUNNER_URL);
  await listenForAnswers(page);
  // Asked from the host's handshake handler, synchronously: before the host has
  // done anything else, and before the application's bridge can exist.
  await page.evaluate(({ handshake, sessions }) => {
    window.addEventListener("message", (event) => {
      const data = event.data as { type?: string };
      if (data?.type !== handshake) return;
      (event.source as Window).postMessage({ type: sessions, id: "early" }, "*");
    });
  }, { handshake: TO_HOST.HANDSHAKE, sessions: TO_DOCUMENT.SESSIONS });
  await page.setInputFiles("#file", file);
  await page.locator("#card-open").click({ timeout: 60_000 });
  await expect(page.frameLocator("#cartridge").frameLocator("#dai-app").locator("#app")).toHaveText("here", {
    timeout: 60_000,
  });
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __answers: Record<string, number> }).__answers.early ?? null), {
      timeout: 15_000,
      message: "the early question was dropped, not held",
    })
    .not.toBeNull();
});

test("a message sent after the bridge is listening is not delayed", async ({ page }) => {
  const file = await jobs();
  await page.goto(RUNNER_URL);
  await listenForAnswers(page);
  await page.setInputFiles("#file", file);
  await page.locator("#card-open").click({ timeout: 60_000 });
  await expect(page.frameLocator("#cartridge").frameLocator("#dai-app").locator("#app")).toHaveText("here", {
    timeout: 60_000,
  });
  // The bridge is up. A question now goes straight through: answered in well
  // under a second, not held for something that already happened.
  const asked = await page.evaluate((sessions) => {
    const frame = document.getElementById("cartridge") as HTMLIFrameElement;
    const at = performance.now();
    frame.contentWindow?.postMessage({ type: sessions, id: "late" }, "*");
    return at;
  }, TO_DOCUMENT.SESSIONS);
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __answers: Record<string, number> }).__answers.late ?? null), {
      timeout: 5_000,
      message: "a question sent after the bridge was listening was not answered",
    })
    .not.toBeNull();
  const answered = await page.evaluate(() => (window as unknown as { __answers: Record<string, number> }).__answers.late!);
  expect(answered - asked, "answered promptly, not held").toBeLessThan(1_000);
});
