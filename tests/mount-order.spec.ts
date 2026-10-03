import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type FrameLocator, type Page } from "@playwright/test";
import { test } from "./fixtures.js";
import { compileDirectory } from "../src/compile.js";
import { BATCH_FORMAT_VERSION, canonicalHeader } from "../src/replicated-batch.js";
import { TO_HOST } from "../src/bridge.js";
import { libraryLock } from "../src/keys.js";
import { play } from "./chess-play.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER_URL = "http://localhost:5175/";
const app = (page: Page): FrameLocator => page.frameLocator("#cartridge").frameLocator("#dai-app");

/**
 * A completion belongs to the mount it began under (D167).
 *
 * The host answers a document's save, sign and write rules after awaits, and
 * the person can open another document in between. Each test here forces one
 * such order rather than waiting for a scheduler to produce it:
 *
 * - A save is held inside its reseal, after the handler has checked which
 *   document is open: the page's SHA-256 over that save's database bytes waits
 *   until the test lets it go.
 * - A shell's handshake is held at the host by a listener registered before
 *   the host's own (`addInitScript`), and replayed when the test says.
 * - A sign is held at the library lock (`dai:<uuid>`, FIFO), taken by such a
 *   listener as the host receives the sign, so it is queued ahead of the
 *   sign's own request.
 *
 * Each was run red on the host before D167's fix, on Chromium and WebKit, and
 * read failing on its own subject.
 *
 * `sign-scope.spec.ts` is the same property under load, with the order left to
 * the machine; it stays as it is.
 */

type Opened = { chessFile: string; forgerFile: string };

/** Chess, played once, with nothing in flight; and a forger that asks for a header naming it. */
async function openChessAndBuildForger(page: Page): Promise<Opened> {
  const dir = mkdtempSync(join(tmpdir(), "dai-mount-order-"));
  const chess = await compileDirectory({ sourceDir: join(repo, "tests", "fixture", "chess"), root: repo, appName: "Velvet Chess" });
  const chessFile = join(dir, "chess.dai.html");
  writeFileSync(chessFile, chess.html, "utf8");

  await page.goto(RUNNER_URL);
  await page.setInputFiles("#file", chessFile);
  await page.locator("#card-open").click({ timeout: 60_000 });
  await expect(app(page).locator("#app")).toBeVisible({ timeout: 60_000 });
  const ui = app(page);
  await ui.locator("[data-new-game]:visible").first().click({ timeout: 60_000 });
  await ui.locator("#setup-you").fill("Ada");
  await ui.locator("#setup-them").fill("Bo");
  await ui.locator('input[name="color"][value="w"]').check();
  await ui.locator("#new-game-form button[type=submit]").click();
  await expect(ui.locator('[data-square="e2"]')).toBeVisible({ timeout: 30_000 });
  await settled(page);

  const documentA = (await page.evaluate(() => (window as any).__runner.loaded.manifest.documentUuid)) as string;
  const author = Buffer.from((await page.evaluate(() => (window as any).__runner.authorId())) as string, "base64url");
  // Well formed in every other way, so only the document it names can refuse it.
  const header = canonicalHeader({
    version: BATCH_FORMAT_VERSION,
    document: documentA,
    author: new Uint8Array(author),
    lc: 1,
    digest: new Uint8Array(32).fill(7),
    covers: [["moves", 1]],
  });
  const source = mkdtempSync(join(tmpdir(), "dai-mount-order-forger-"));
  writeFileSync(
    join(source, "index.html"),
    '<!doctype html><meta charset="utf-8"><title>Forger</title><p id="out">loading</p><script src="forge.js"></script>',
    "utf8",
  );
  // Asks only when told to, so the test decides when; and keeps every sign
  // answer that reaches it, asked for or not.
  writeFileSync(
    join(source, "forge.js"),
    `const header = Uint8Array.from(${JSON.stringify([...header])});
window.__signed = [];
window.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type !== "dai:signed") return;
  window.__signed.push({ id: String(data.id), signed: Boolean(data.sig) });
  if (data.id === "forge") document.getElementById("out").textContent = data.sig ? "signed" : "refused: " + (data.error || "");
});
window.forge = () => window.parent.postMessage({ type: "dai:sign", id: "forge", header, seq: 1 }, "*");
document.getElementById("out").textContent = "ready";
`,
    "utf8",
  );
  const forger = await compileDirectory({ sourceDir: source, root: repo, appName: "Forger" });
  const forgerFile = join(dir, "forger.dai.html");
  writeFileSync(forgerFile, forger.html, "utf8");
  return { chessFile, forgerFile };
}

/** Every save asked has been written: nothing of the document is in flight. */
async function settled(page: Page): Promise<void> {
  const counts = (): Promise<[number, number]> =>
    page.evaluate(() => [Number((window as any).__runner.saves), Number((window as any).__runner.savesWritten)]);
  await expect.poll(async () => {
    const [asked, written] = await counts();
    return asked > 0 && asked === written;
  }, { timeout: 30_000, message: "every save asked is written" }).toBe(true);
}

/** Lets a lock the test holds go. */
async function release(page: Page, name: string): Promise<void> {
  await page.evaluate((name) => (window as any).__holds[name].release(), name);
}

/** How many requests wait on a lock. */
const waiting = (page: Page, key: string): Promise<number> =>
  page.evaluate(async (key) => ((await navigator.locks.query()).pending ?? []).filter((l) => l.name === key).length, key);

const loadedName = (page: Page): Promise<string | undefined> =>
  page.evaluate(() => (window as any).__runner.loaded?.manifest.appName);

/**
 * Holds the host's reseal of the next save: the first SHA-256 the page takes
 * over exactly that save's database bytes, which is the reseal hashing its
 * entries. By then the save handler has checked which document is open, so
 * this is the window D167 names. Registered before the host loads; armed by
 * `__holdReseal`, and the length is read from the host's own "save N asked
 * (B bytes)" line.
 */
async function holdReseals(page: Page): Promise<void> {
  await page.context().addInitScript(() => {
    if (window !== window.top) return;
    const w = window as any;
    const info = console.info.bind(console);
    console.info = (...args: unknown[]) => {
      const asked = /^dai: save \d+ asked \((\d+) bytes\)/.exec(String(args[0]));
      if (asked && w.__holdReseal) {
        w.__holdReseal = false;
        w.__resealBytes = Number(asked[1]);
      }
      info(...args);
    };
    const digest = SubtleCrypto.prototype.digest;
    SubtleCrypto.prototype.digest = function (this: SubtleCrypto, algorithm: AlgorithmIdentifier, data: BufferSource) {
      const result = digest.call(this, algorithm, data);
      if (w.__resealBytes === undefined || (data as ArrayBuffer).byteLength !== w.__resealBytes) return result;
      w.__resealBytes = undefined;
      return new Promise<ArrayBuffer>((resolve) => {
        w.__releaseReseal = () => resolve(result);
      });
    };
  });
}

/** Chess plays a move; its save is accepted while chess is mounted, and held inside the reseal. */
async function saveHeldInReseal(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as any).__holdReseal = true;
  });
  await play(app(page), "e2", "e4");
  await expect
    .poll(() => page.evaluate(() => typeof (window as any).__releaseReseal === "function"), {
      timeout: 30_000,
      message: "the move's save is inside its reseal",
    })
    .toBe(true);
}

async function openForger(page: Page, file: string): Promise<void> {
  await page.setInputFiles("#file", file);
  await page.locator("#card-open").click({ timeout: 60_000 });
}

test("a save that lands after the next document opens leaves the next document open", async ({ page }) => {
  test.slow();
  await holdReseals(page);
  const { forgerFile } = await openChessAndBuildForger(page);
  await saveHeldInReseal(page);
  const written = await page.evaluate(() => Number((window as any).__runner.savesWritten));

  await openForger(page, forgerFile);
  await expect(app(page).locator("#out")).toHaveText("ready", { timeout: 60_000 });
  expect(await loadedName(page)).toBe("Forger");

  await page.evaluate(() => (window as any).__releaseReseal());
  await expect
    .poll(() => page.evaluate(() => Number((window as any).__runner.savesWritten)), { timeout: 30_000, message: "chess's save is written" })
    .toBeGreaterThan(written);
  expect(await loadedName(page), "a late save must not put chess back as the open document").toBe("Forger");
});

test("a save that lands between the next document's mount and its handshake gives that document no writer", async ({ page }) => {
  test.slow();
  // Before the host's own listener, so it runs first; armed by the test.
  await page.context().addInitScript((handshake) => {
    if (window !== window.top) return;
    const w = window as any;
    window.addEventListener("message", (event) => {
      if (!w.__holdHandshake || (event.data as any)?.type !== handshake) return;
      w.__holdHandshake = false;
      w.__heldHandshake = { data: event.data, source: event.source };
      event.stopImmediatePropagation();
    });
    w.__replayHandshake = () => {
      const held = w.__heldHandshake;
      window.dispatchEvent(new MessageEvent("message", { data: held.data, source: held.source }));
    };
  }, TO_HOST.HANDSHAKE);
  await holdReseals(page);
  const { forgerFile } = await openChessAndBuildForger(page);
  await saveHeldInReseal(page);
  const written = await page.evaluate(() => Number((window as any).__runner.savesWritten));

  await page.evaluate(() => {
    (window as any).__holdHandshake = true;
  });
  await openForger(page, forgerFile);
  await expect
    .poll(() => page.evaluate(() => Boolean((window as any).__heldHandshake)), { timeout: 60_000, message: "the forger's shell handshakes" })
    .toBe(true);

  await page.evaluate(() => (window as any).__releaseReseal());
  await expect
    .poll(() => page.evaluate(() => Number((window as any).__runner.savesWritten)), { timeout: 30_000, message: "chess's save is written" })
    .toBeGreaterThan(written);
  await page.evaluate(() => (window as any).__replayHandshake());

  const out = app(page).locator("#out");
  await expect(out).toHaveText("ready", { timeout: 60_000 });
  await out.evaluate(() => (window as any).forge());
  await expect(out, "the forger's question was answered").not.toHaveText("ready", { timeout: 30_000 });
  await expect(out, "and not with a signature over chess's header").toHaveText(/^refused/);
});

test("the last shell's handshake, after the next document is framed, makes it a writer of nothing", async ({ page }) => {
  test.slow();
  // Every handshake is held while armed, and replayed when the test says.
  await page.context().addInitScript((handshake) => {
    if (window !== window.top) return;
    const w = window as any;
    w.__heldHandshakes = [];
    window.addEventListener("message", (event) => {
      if (!w.__holdHandshakes || (event.data as any)?.type !== handshake) return;
      w.__heldHandshakes.push({ data: event.data, source: event.source });
      event.stopImmediatePropagation();
    });
    w.__replay = (index: number, data?: unknown) => {
      const held = w.__heldHandshakes[index];
      window.dispatchEvent(new MessageEvent("message", { data: data ?? held.data, source: held.source }));
    };
  }, TO_HOST.HANDSHAKE);
  const dir = mkdtempSync(join(tmpdir(), "dai-mount-order-shell-"));
  const chess = await compileDirectory({ sourceDir: join(repo, "tests", "fixture", "chess"), root: repo, appName: "Velvet Chess" });
  const chessFile = join(dir, "chess.dai.html");
  writeFileSync(chessFile, chess.html, "utf8");
  const source = mkdtempSync(join(tmpdir(), "dai-mount-order-other-"));
  writeFileSync(join(source, "index.html"), '<!doctype html><meta charset="utf-8"><title>Other</title><p id="out">ready</p>', "utf8");
  const other = await compileDirectory({ sourceDir: source, root: repo, appName: "Other" });
  const otherFile = join(dir, "other.dai.html");
  writeFileSync(otherFile, other.html, "utf8");

  // The other document's shell handshakes, and is held there: it is still the
  // last shell when chess is framed.
  await page.goto(RUNNER_URL);
  await page.evaluate(() => {
    (window as any).__holdHandshakes = true;
  });
  await page.setInputFiles("#file", otherFile);
  await page.locator("#card-open").click({ timeout: 60_000 });
  await expect.poll(() => page.evaluate(() => (window as any).__heldHandshakes.length), { timeout: 60_000 }).toBe(1);
  await page.setInputFiles("#file", chessFile);
  await page.locator("#card-open").click({ timeout: 60_000 });
  await expect.poll(() => page.evaluate(() => (window as any).__heldHandshakes.length), { timeout: 60_000 }).toBe(2);

  // Chess is framed and has not handshaken; the other shell's handshake lands now.
  await page.evaluate(() => {
    (window as any).__holdHandshakes = false;
    (window as any).__replay(0);
  });
  const lastNonce = (await page.evaluate(() => (window as any).__heldHandshakes[0].data.payload.sessionNonce)) as string;
  const author = Buffer.from((await page.evaluate(() => (window as any).__runner.authorId())) as string, "base64url");
  const header = canonicalHeader({
    version: BATCH_FORMAT_VERSION,
    document: chess.manifest.documentUuid,
    author: new Uint8Array(author),
    lc: 1,
    digest: new Uint8Array(32).fill(7),
    covers: [["moves", 1]],
  });
  const settledBefore = await page.evaluate(() => Number((window as any).__runner.signsSettled));
  const signaturesBefore = await page.evaluate(() => Number((window as any).__runner.signatures));
  // What that shell's code would send next: a chess header, under its nonce.
  await page.evaluate(
    ({ type, sessionNonce, header }) => {
      const held = (window as any).__heldHandshakes[0];
      window.dispatchEvent(
        new MessageEvent("message", { data: { type, sessionNonce, id: "last", header: Uint8Array.from(header), seq: 1 }, source: held.source }),
      );
    },
    { type: TO_HOST.SIGN, sessionNonce: lastNonce, header: [...header] },
  );
  await expect
    .poll(() => page.evaluate(() => Number((window as any).__runner.signsSettled)), { timeout: 30_000, message: "the host is done with the sign" })
    .toBeGreaterThan(settledBefore);
  expect(
    await page.evaluate(() => Number((window as any).__runner.signatures)),
    "the last shell's nonce signs nothing for the document framed after it",
  ).toBe(signaturesBefore);

  // Chess's own handshake still makes chess the writer it is.
  await page.evaluate(() => (window as any).__replay(1));
  await expect(app(page).locator("#app")).toBeVisible({ timeout: 60_000 });
  expect(await loadedName(page)).toBe("Velvet Chess");
});

test("a sign asked before the next document opens is not answered into it", async ({ page }) => {
  test.slow();
  // The lock is taken as the host receives the sign, from a listener that runs
  // before the host's own, so it is queued ahead of the sign's request whatever
  // else of chess's is in flight (a save left from the game's setup would
  // otherwise hold the seal, and the sign would not be asked at all).
  await page.context().addInitScript((sign) => {
    if (window !== window.top) return;
    const w = window as any;
    window.addEventListener("message", (event) => {
      if (!w.__holdOnSign || (event.data as any)?.type !== sign) return;
      const key = w.__holdOnSign;
      w.__holdOnSign = undefined;
      w.__holds ??= {};
      const entry = (w.__holds.first = { granted: false, release: null as null | (() => void) });
      void navigator.locks.request(key, () => new Promise<void>((done) => {
        entry.granted = true;
        entry.release = done;
      }));
    });
  }, TO_HOST.SIGN);
  const { forgerFile } = await openChessAndBuildForger(page);
  const key = libraryLock((await page.evaluate(() => (window as any).__runner.loaded.manifest.documentUuid)) as string);
  await page.evaluate((key) => {
    (window as any).__holdOnSign = key;
  }, key);
  await play(app(page), "e2", "e4");
  await expect
    .poll(() => page.evaluate(() => (window as any).__holds?.first?.granted === true), { timeout: 30_000, message: "chess asks for a sign" })
    .toBe(true);
  await expect.poll(() => waiting(page, key), { message: "chess's sign waits on the lock" }).toBeGreaterThan(0);
  const settledBefore = await page.evaluate(() => Number((window as any).__runner.signsSettled));

  await openForger(page, forgerFile);
  const out = app(page).locator("#out");
  await expect(out).toHaveText("ready", { timeout: 60_000 });
  const signaturesBefore = await page.evaluate(() => Number((window as any).__runner.signatures));

  await release(page, "first");
  await expect
    .poll(() => page.evaluate(() => Number((window as any).__runner.signsSettled)), { timeout: 30_000, message: "the host is done with chess's sign" })
    .toBeGreaterThan(settledBefore);
  expect(
    await page.evaluate(() => Number((window as any).__runner.signatures)),
    "no signature is made for a mount that is no longer the one mounted",
  ).toBe(signaturesBefore);
  // The forger's own question travels the same road after it, so once its
  // answer is in, anything the host sent before it has arrived too.
  await out.evaluate(() => (window as any).forge());
  await expect(out).not.toHaveText("ready", { timeout: 30_000 });
  const reached = (await out.evaluate(() => (window as any).__signed)) as { id: string; signed: boolean }[];
  expect(reached.filter((answer) => answer.id !== "forge"), "no answer to chess's sign reaches the forger").toEqual([]);
});
