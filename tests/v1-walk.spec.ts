import { createServer, type Server } from "node:http";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type FrameLocator, type Page } from "@playwright/test";
import { test } from "./fixtures.js";
import { compileDirectory } from "../src/compile.js";
import { VersionDO, announcementBytes } from "../apps/relay/src/version-do.js";
import { memoryState } from "./relay-memory.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER_URL = "http://localhost:5175/";
const inside = (page: Page): FrameLocator => page.frameLocator("#cartridge").frameLocator("#dai-app");
const toBase64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");

/**
 * The V1 walk (`docs/v1-walk.md`), driven on an iPhone.
 *
 * V1 is a daily single-user app with author updates, shared friend to friend,
 * and it is done when the `.dai` version is indistinguishable from the control
 * PWA on the same phone with the same person. This is that walk, step by step,
 * as far as a browser can be driven — WebKit, with an iPhone's user agent and
 * screen, which is the engine and the shape of the device but not the device.
 *
 * **The app is a stand-in.** `examples/packing-list` is the walk's shape today:
 * one person, one phone, rows they write and keep, no replicated tables.
 * When `examples/workout/` exists it replaces it by changing `APP` below, and
 * nothing else here changes — the steps are the walk's, not the app's.
 *
 * Every step reads what is on screen and asserts the sentence, because a step
 * that passes while saying the wrong thing is not a step a person can walk.
 *
 * ## What only a phone can see, and is therefore skipped here
 *
 * Listed rather than left out, because a walk with silent gaps reads as a walk
 * with none. Each of these is a phone check in `docs/v1-walk.md`:
 *
 * 1. **The Share sheet, and Add to Home Screen.** The instructions are read
 *    here (step 1); the gesture belongs to iOS, and no automation performs it.
 * 2. **Whether an icon's launch gets storage of its own**, which is the whole
 *    of D50's iOS boundary and the reason its sentences are what they are.
 * 3. **Whether the browser grants persistence**, and whether asking after the
 *    first save changes the answer (D55). The moment of the request is checked
 *    here; a headless browser grants freely, which is the opposite of the case
 *    that matters.
 * 4. **A real push, a real notification, and the icon's badge** (D34, D44).
 * 5. **Losing the phone and reinstalling from the link** (step 6). What the
 *    screen says when a document is gone is held by `icon-after-wipe`; the
 *    reinstall itself is a device.
 * 6. **Android** (step 7), which is a different device and not this engine.
 */

/** The app the walk is walked with. Swap for `examples/workout` when it exists. */
const APP = join("examples", "packing-list");
const APP_NAME = "Beach trip";

/** An iPhone, as far as a browser can be told to be one. */
const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

test.use({ userAgent: IPHONE, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: false });

/**
 * The steps of the walk a browser cannot take, named as skipped tests.
 *
 * In the header as prose *and* here as skips, because the two do different
 * jobs: the prose explains, and these appear in every run's output. A reader of
 * a green report should be able to see what was not walked without opening the
 * file — a walk with silent gaps reads as a walk with none.
 *
 * Each is a phone check in `docs/v1-walk.md`. None of them is waiting on code.
 */
test.describe("the V1 walk — only a phone can take these steps", () => {
  test.skip("step 1: the Share sheet, and Add to Home Screen — iOS performs the gesture, nothing here can", () => {});
  test.skip("step 1: whether an icon's launch gets storage of its own — D50's iOS boundary, and why its sentences are what they are", () => {});
  test.skip("step 3: whether a browser grants persistence, and whether asking after the first save changes it — a headless browser grants freely (D55)", () => {});
  test.skip("step 4: a real push, a real notification, and the icon's badge (D34, D44)", () => {});
  test.skip("step 6: losing the phone and reinstalling from the link — what the screen says is held by icon-after-wipe; the reinstall is a device", () => {});
  test.skip("step 7: Android — a different device, and not this engine", () => {});
});

test.describe("the V1 walk, on a phone-shaped browser", () => {
  test.slow();

  /** The relay both halves of the walk use: the deployed class, locally. */
  async function relay(): Promise<{ base: string; close: () => Promise<void> }> {
    const objects = new Map<string, VersionDO>();
    const cors = {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "content-type",
    };
    const server: Server = createServer((request, response) => {
      if (request.method === "OPTIONS") {
        response.writeHead(204, cors);
        response.end();
        return;
      }
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(chunk as Buffer));
      request.on("end", () => {
        void (async () => {
          const url = new URL(request.url ?? "/", "http://relay.invalid");
          const document = url.pathname.split("/").filter(Boolean)[1] ?? "";
          let object = objects.get(document);
          if (!object) {
            object = new VersionDO(memoryState().state, {});
            objects.set(document, object);
          }
          const answer = await object.fetch(
            new Request(`https://relay.invalid${url.pathname}`, {
              method: request.method,
              headers: { "content-type": "application/json" },
              body: Buffer.concat(chunks).toString("utf8") || undefined,
            }),
          );
          response.writeHead(answer.status, { ...cors, "content-type": "application/json" });
          response.end(Buffer.from(await answer.arrayBuffer()));
        })().catch(() => {
          response.writeHead(500, cors);
          response.end();
        });
      });
    });
    await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
    return {
      base: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
      close: () =>
        new Promise<void>((closed) => {
          server.closeAllConnections();
          server.close(() => closed());
        }),
    };
  }

  /** Where the author puts a new version for people to fetch. */
  async function host(html: string): Promise<{ address: string; close: () => Promise<void> }> {
    const server: Server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html", "access-control-allow-origin": "*" });
      response.end(html);
    });
    await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
    return {
      address: `http://127.0.0.1:${(server.address() as { port: number }).port}/next.dai.html`,
      close: () =>
        new Promise<void>((closed) => {
          server.closeAllConnections();
          server.close(() => closed());
        }),
    };
  }

  /**
   * The author: one key, the app they ship, and the next version of it.
   *
   * Signed, because an author who ships updates signs — an unsigned document
   * cannot say which build it is, so it takes no part in the update half of
   * the walk (D85, `docs/version-ping.md`).
   */
  async function author(): Promise<{
    publicKey: string;
    sign: (bytes: Uint8Array) => Promise<string>;
    file: string;
    next: () => Promise<{ html: string; version: string }>;
  }> {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const spki = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
    const pkcs8 = Buffer.from(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
    const source = mkdtempSync(join(tmpdir(), "dai-walk-"));
    cpSync(join(repo, APP), source, { recursive: true });
    const keyFile = join(source, "key.pem");
    writeFileSync(
      keyFile,
      [
        "-----BEGIN PRIVATE KEY-----",
        pkcs8.toString("base64").replace(/(.{64})/g, "$1\n"),
        "-----END PRIVATE KEY-----",
        "",
      ].join("\n"),
      "utf8",
    );
    const one = await compileDirectory({ sourceDir: source, root: repo, appName: APP_NAME, signingKey: keyFile });
    const file = join(source, "app.dai.html");
    writeFileSync(file, one.html, "utf8");

    return {
      publicKey: toBase64(spki),
      sign: async (bytes) =>
        toBase64(
          new Uint8Array(
            await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, bytes as unknown as ArrayBuffer),
          ),
        ),
      file,
      next: async () => {
        /*
         * The author changes their app: one line a person can see, so the test
         * can tell which build is running without reading a digest.
         *
         * Taken from the app's own source in the repository, not from the copy
         * in the build directory. The compiler injects the schema into
         * `index.html` as it builds, and building again from the injected copy
         * produced a page that rendered its own `schema.sql` as text — the
         * successor adopted the rows correctly and showed SQL. Measured, not
         * guessed: the card said "adopting" while the app read
         * `-- seed rows; the tables are declared in schema.sql`.
         */
        /*
         * The app's own source, unchanged.
         *
         * The successor differs from its predecessor where it matters — a new
         * id and a signed , so a different signature, which is
         * what the version door compares — without this test having to edit
         * the example. Editing it was how the successor came to be built from
         * an index.html the compiler had already injected, and the adopted app
         * rendered its own schema as text.
         */
        writeFileSync(join(source, "index.html"), readFileSync(join(repo, APP, "index.html"), "utf8"), "utf8");
        const two = await compileDirectory({
          sourceDir: source,
          root: repo,
          appName: APP_NAME,
          signingKey: keyFile,
          upgradeOf: file,
        });
        return { html: two.html, version: two.manifest.signature ?? "" };
      },
    };
  }

  /** Records every request for durable storage, and answers as a phone might. */
  async function watchStorage(page: Page): Promise<void> {
    await page.addInitScript(() => {
      const real = navigator.storage as StorageManager | undefined;
      let kept = false;
      const held = window as unknown as { __persistCalls?: number };
      held.__persistCalls = 0;
      Object.defineProperty(navigator, "storage", {
        configurable: true,
        value: {
          getDirectory: real?.getDirectory?.bind(real),
          persisted: async () => kept,
          persist: async () => {
            held.__persistCalls = (held.__persistCalls ?? 0) + 1;
            kept = true;
            return true;
          },
        },
      });
    });
  }

  const persistCalls = (page: Page): Promise<number> =>
    page.evaluate(() => (window as unknown as { __persistCalls?: number }).__persistCalls ?? 0);

  /** Whether this device has written something of its own into the document. */
  const wrote = (page: Page): Promise<boolean> =>
    page.evaluate(async () => {
      const runner = (window as unknown as { __runner: { listLibrary: () => Promise<{ wrote?: boolean }[]> } }).__runner;
      return (await runner.listLibrary()).some((item) => item.wrote === true);
    });

  const documentId = (page: Page): Promise<string> =>
    page.evaluate(async () => {
      const runner = (window as unknown as { __runner: { listLibrary: () => Promise<{ documentUuid: string }[]> } })
        .__runner;
      return (await runner.listLibrary())[0]?.documentUuid ?? "";
    });

  /**
   * Waits until the document is really on screen, not merely mounted.
   *
   * The launch screen holds over the frame until the runtime reports the app
   * interactive, and it covers the header — so a click on the menu lands on
   * the splash and retries until the test times out, which reads as a missing
   * control rather than an early one.
   */
  async function onScreen(page: Page): Promise<void> {
    await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });
    await expect(page.locator("#launch")).toBeHidden({ timeout: 60_000 });
  }

  /**
   * Opens the document menu.
   *
   * The sheet animates up from the bottom and covers the button that opened
   * it, so an ordinary click can land, open the sheet, and then be retried
   * against a button the sheet is now over — which reads as a control that
   * never became clickable. Opened once, and then waited for.
   */
  async function menu(page: Page): Promise<void> {
    if (await page.locator("#sheet").isVisible()) return;
    await page.locator("#more").click({ force: true });
    await expect(page.locator("#sheet")).toBeVisible({ timeout: 30_000 });
  }

  /** How many things are on the list, from the app's own counter. */
  const packedTotal = (page: Page): Promise<number> =>
    inside(page)
      .locator("p.progress dai-value")
      .nth(1)
      .textContent()
      .then((text) => Number((text ?? "").trim()));

  /**
   * Adds an item the way a person does.
   *
   * Waited for by the app's own count rather than by the text appearing: every
   * write re-renders the lists, so a locator for the new row can be resolved
   * against the render it interrupted. The count is one value that changes
   * once, which is the thing the next step depends on.
   */
  async function packSomething(page: Page, what: string): Promise<void> {
    const before = await packedTotal(page);
    // The group is chosen, not left to whatever the last render left in the
    // control: an item added with no group belongs to no section and is
    // nowhere on the list, though the count includes it.
    await inside(page).locator('dai-form select[name="kind"]').selectOption("Beach");
    await inside(page).locator('dai-form input[name="what"]').fill(what);
    await inside(page).locator("dai-form button").click();
    await expect
      .poll(() => packedTotal(page), { timeout: 30_000, message: `${what} is on the list` })
      .toBe(before + 1);
  }

  /**
   * Waits until this device has stopped writing.
   *
   * Autosave lands a little after the last edit, and one save can carry more
   * than one edit, so counting a save per item answers the wrong question: two
   * items can produce one save, and a wait for "a save since I typed" is
   * satisfied by the save the *previous* item caused. Both mistakes were made
   * here, and both ended the same way — a reload between the two, and the
   * second item gone from a list that had shown it.
   *
   * What the next step needs is that nothing is still pending, which is the
   * count of saves holding still.
   */
  async function savesSettled(page: Page, saves: string[]): Promise<void> {
    await expect
      .poll(() => saves.length, { timeout: 30_000, message: "at least one save has landed" })
      .toBeGreaterThan(0);
    let seen = -1;
    await expect
      .poll(
        async () => {
          const now = saves.length;
          const stable = now === seen;
          seen = now;
          if (!stable) await page.waitForTimeout(1_500);
          return stable;
        },
        { timeout: 60_000, message: "this device has stopped writing" },
      )
      .toBe(true);
  }

  test("open, keep, write, reopen, update or not, and share", async ({ browser }) => {
    /*
     * The whole walk in one test, because it is one walk: each step is the
     * state the next one starts from. It takes minutes — an install reload, an
     * autosave, an adoption — so it gets minutes, rather than a default meant
     * for a test that does one thing.
     */
    test.setTimeout(300_000);
    const she = await author();
    const door = await relay();
    const device = await browser.newContext({ userAgent: IPHONE, viewport: { width: 390, height: 844 } });
    const page = await device.newPage();
    await watchStorage(page);
    const saves: string[] = [];
    page.on("console", (message) => {
      if (/^dai: save \d+ written$/.test(message.text())) saves.push(message.text());
    });

    /*
     * Step 1 — open the link on iOS, and be told how to keep it.
     *
     * The gesture is iOS's; what this can read is the instruction, which is the
     * part that is ours to get right.
     */
    await page.goto(RUNNER_URL);
    await page.setInputFiles("#file", she.file);
    await page.locator("#card-open:visible, body.loaded").first().waitFor({ timeout: 60_000 });
    if (await page.locator("#card-open").isVisible()) await page.locator("#card-open").click();
    await onScreen(page);

    await menu(page);
    await page.locator("#keep-cta").click({ force: true });
    /*
     * On iOS, Keep reloads first.
     *
     * `keepHere` reloads the page at the document's own launch address so the
     * document's manifest is the one linked when the page loads — which is what
     * makes "Add to Home Screen" produce an icon for the document rather than
     * for the opener. The sheet of instructions is shown after that reload, so
     * this waits through a navigation, not just for an element.
     */
    /*
     * The document comes back — the reload reopens it from its own launch
     * address — and then Keep is pressed again.
     *
     * The second press is not what a person should have to do, and it is
     * filed: **D87**. The sheet the reload asks for is shown by `describe()`,
     * and `describe()` closes any sheet before it shows one, so a later call —
     * the remount is one — can close the sheet the reload just opened. Measured
     * here: sometimes it stands, sometimes it is gone by the time anything can
     * read it. The second press is reliable because the page is already at the
     * document's launch address, so `keepHere` does not reload again.
     *
     * What this step is for is the sentences, and those are the same however
     * many presses it took. So it presses until the sheet is there — which is
     * what a person does, and it is the shape of the defect rather than a
     * workaround for a flake: a second press is usually enough, a third has
     * been needed, and the count is the measurement D87 records.
     */
    await onScreen(page);
    for (let press = 0; press < 4; press += 1) {
      if (await page.locator("#keep-sheet").isVisible()) break;
      await menu(page);
      await page.locator("#keep-cta").click({ force: true });
      await page
        .locator("#keep-sheet")
        .waitFor({ state: "visible", timeout: 8_000 })
        .catch(() => undefined);
    }
    await expect(page.locator("#keep-sheet"), "the instructions a person reads on iOS (D87)").toBeVisible({
      timeout: 30_000,
    });
    await expect(page.locator("#keep-title")).toHaveText(`Add ${APP_NAME} to your Home Screen`);
    await expect(page.locator("#keep-sub")).toHaveText(
      "It opens like an app, works without a connection, and stays on this device.",
    );
    await expect(page.locator("#keep-steps")).toContainText("Tap the Share button");
    await expect(page.locator("#keep-steps")).toContainText("Tap Add to Home Screen");
    // D53, said where it can still be acted on.
    await expect(page.locator("#keep-backup")).toHaveText(
      `Keeping ${APP_NAME} here is not a backup. The link or file you opened it from brings the app back; what you write in it stays on this device.`,
    );
    await page.click("#keep-done");

    /*
     * Step 3, before step 2 finishes — the storage request is not made at boot,
     * nor for opening a document. It waits for something worth keeping (D55).
     */
    expect(await persistCalls(page), "nothing asked for before there is anything to lose").toBe(0);

    // Step 2 — log something. Twice, so a count can tell the copies apart.
    await packSomething(page, "sun cream");
    await packSomething(page, "goggles");
    await expect
      .poll(() => wrote(page), { timeout: 30_000, message: "it is on this device, not just on screen" })
      .toBe(true);
    await savesSettled(page, saves);

    // Step 3 — and now the browser is asked, once.
    await expect
      .poll(() => persistCalls(page), { timeout: 30_000, message: "asked once the first thing was written" })
      .toBe(1);
    await expect(page.locator("#sheet-storage")).toContainText("kept on this device");

    /*
     * Step 2, the rest — close it and come back tomorrow. A reload is what a
     * phone does when it discards a page and the icon is tapped again: the
     * document comes back from this device's own storage.
     */
    // Both are on the list before it closes, so "gone after a reopen" cannot
    // be confused with "never added".
    await expect(inside(page).getByText("sun cream", { exact: true })).toBeVisible();
    await expect(inside(page).getByText("goggles", { exact: true })).toBeVisible();

    await page.reload();
    await onScreen(page);
    await expect(inside(page).getByText("sun cream", { exact: true }), "history intact").toBeVisible({
      timeout: 60_000,
    });
    await expect(inside(page).getByText("goggles", { exact: true })).toBeVisible();
    await expect(page.locator("#report"), "and nothing is said, because nothing happened").not.toContainText(
      "opened empty",
    );

    /*
     * Step 4 — the author ships a new version, and the copy is offered it.
     * Pointed at the relay the way a deploy points at it: the address carries
     * the mailbox path, and the version door is `/v` on the same worker.
     */
    const uuid = await documentId(page);
    const next = await she.next();
    const served = await host(next.html);
    const published = {
      document: uuid,
      version: next.version,
      label: "Version two",
      note: "a few more things worth packing",
      successor: served.address,
    };
    const announced = await fetch(`${door.base}/v/${uuid}/announce`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...published, publicKey: she.publicKey, signature: await she.sign(announcementBytes(published)) }),
    });
    expect(announced.status, "the author published it").toBe(200);

    await page.evaluate((base) => (window as any).__runner.useRelay(`${base}/m`), door.base);
    await page.evaluate(() => (window as any).__runner.checkForNewVersion());

    await expect(page.locator("#update-sheet")).toBeVisible({ timeout: 60_000 });
    await expect(page.locator("#update-title")).toHaveText(`Version two of ${APP_NAME}`);
    await expect(page.locator("#update-note")).toHaveText("a few more things worth packing");
    await expect(page.locator("#update-kept")).toHaveText(
      "Your entries are kept. This changes the app, not what you have written in it.",
    );

    // Not now: the version they have, still working.
    await page.locator("#update-later").click();
    await expect(page.locator("#update-sheet")).toBeHidden();
    await packSomething(page, "hat");
    // Still the version they had: succession gives a successor its own id, so
    // the document this device holds is the same one it held before.
    expect(await documentId(page), "the version they have, untouched").toBe(uuid);

    /*
     * Not now is not "ask me again in a minute". The copy has checked today,
     * so it does not check again today — the card stays away until a day has
     * passed, which is `checkIsDue` and has its own test.
     */
    await page.evaluate(() => (window as any).__runner.checkForNewVersion());
    await page.waitForTimeout(2_000);
    await expect(page.locator("#update-sheet"), "not asked again the same day").toBeHidden();

    /*
     * A day passes. Written into the library rather than waited for, and it is
     * the one piece of state this test sets by hand — said plainly, because a
     * test that quietly rewrites what it is measuring is worse than a slow one.
     */
    await page.evaluate(
      () =>
        new Promise<void>((done) => {
          const open = indexedDB.open("dai_runner_storage");
          open.onsuccess = () => {
            const store = open.result.transaction("cartridges", "readwrite").objectStore("cartridges");
            const all = store.getAll();
            all.onsuccess = () => {
              const yesterday = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
              for (const row of all.result as { versionCheckedAt?: string }[]) {
                store.put({ ...row, versionCheckedAt: yesterday });
              }
              done();
            };
            all.onerror = () => done();
          };
          open.onerror = () => done();
        }),
    );

    // And there it is again, because the question is still open.
    await page.evaluate(() => (window as any).__runner.checkForNewVersion());
    await expect(page.locator("#update-sheet"), "offered again the next day").toBeVisible({ timeout: 60_000 });

    // Update: the new version runs, and everything written is still there.
    await page.locator("#update-go").click();
    await expect(page.locator("#card-open"), "offered, not taken").toBeVisible({ timeout: 60_000 });
    await expect(page.locator("#card-succession")).toContainText(`Replaces ${APP_NAME}`);
    await page.locator("#card-open").click();
    /*
     * Version two is what is running, read from the document's own identity
     * rather than from anything on its page.
     *
     * A successor has an id of its own — that is what makes it a successor and
     * not a rebuild (D85) — so a different id, alongside the rows, is the
     * whole claim: the new application, the old entries. An earlier version of
     * this looked for a line the author had changed, which turned out to be a
     * test of the example's markup: the adoption was working and the marker
     * was not rendering, and it failed while saying "version two is not
     * running", which was false.
     */
    await expect
      .poll(() => documentId(page), { timeout: 60_000, message: "the successor is the document now" })
      .not.toBe(uuid);
    for (const what of ["sun cream", "goggles", "hat"]) {
      // Exactly, because the list is seeded: "hat" is also inside "Hats".
      await expect(inside(page).getByText(what, { exact: true }), `${what} came across`).toBeVisible({
        timeout: 60_000,
      });
    }

    /*
     * Step 5 — share it with a friend. A document nobody joins sends the app,
     * not the sender's entries, and the card says which of the two is about to
     * happen.
     */
    await onScreen(page);
    // Pressed until it opens, like Keep above: the menu sheet animates, and a
    // press that lands on it while it is moving lands nowhere.
    for (let press = 0; press < 4; press += 1) {
      if (await page.locator("#send-sheet").isVisible()) break;
      await menu(page);
      await page.locator("#send").click({ force: true });
      await page
        .locator("#send-sheet")
        .waitFor({ state: "visible", timeout: 8_000 })
        .catch(() => undefined);
    }
    await expect(page.locator("#send-sheet")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("#send-with-data"), "their list stays theirs").not.toBeChecked();
    await expect(page.locator("#send-note")).toHaveText(
      "Anyone with the link gets the app as it arrived, with none of your entries.",
    );
    await expect(page.locator("#send-backup")).toHaveText(
      "This link carries the app without your entries, so it is not a copy of them. What you have written lives on this device only.",
    );

    await device.close();
    await served.close();
    await door.close();
  });
});
