import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { HINT_KEY } from "../src/link.js";
import { compileDirectory } from "../src/compile.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER_URL = "http://localhost:5175/";

/**
 * A document that comes back.
 *
 * Everything the carriers do is distribution: one person makes a document and
 * others receive it. Correspondence is the document returning — a move made
 * and sent back, to somebody who already holds the same document. Two people
 * playing chess by link is the whole of it, and it is the case that was never
 * tested.
 *
 * What a person saw: the move never arrived. The same link in a private window
 * showed it, which says the arriving data was read and then discarded in
 * favour of what this device had already stored.
 */
async function board(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "dai-correspondence-"));
  writeFileSync(
    join(dir, "schema.sql"),
    "CREATE TABLE IF NOT EXISTS moves (n INTEGER PRIMARY KEY, san TEXT NOT NULL);",
    "utf8",
  );
  writeFileSync(
    join(dir, "index.html"),
    '<!doctype html><meta charset="utf-8"><meta name="description" content="A game by post">' +
      '<p id="app">…</p><button id="move">Move</button><button id="save-now">Save now</button>' +
      '<script type="module">\n' +
      "const db = await window.dai.openDatabase();\n" +
      "const draw = () => {\n" +
      "  const rows = db.selectObjects('SELECT san FROM moves ORDER BY n');\n" +
      "  document.getElementById('app').textContent = rows.map((r) => r.san).join(' ') || 'no moves';\n" +
      "};\n" +
      "document.getElementById('move').onclick = () => {\n" +
      "  const next = db.selectValue('SELECT COALESCE(MAX(n), 0) + 1 FROM moves');\n" +
      "  db.exec({ sql: 'INSERT INTO moves (n, san) VALUES (?, ?)', bind: [next, 'move' + next] });\n" +
      "  draw();\n" +
      "};\n" +
      // A save that changes nothing a person did: D36's open-time save, on demand.
      "document.getElementById('save-now').onclick = () => window.dai.saveDatabase(db);\n" +
      "draw();\n" +
      "</script>",
    "utf8",
  );
  const built = await compileDirectory({ sourceDir: dir, root: repo, appName: "Postal Chess" });
  const file = join(dir, "chess.dai.html");
  writeFileSync(file, built.html, "utf8");
  return file;
}

/** Waits for a save that happened after this call, not one from before it. */
async function settled(page: Page): Promise<void> {
  await page.evaluate(() => {
    const el = document.getElementById("save-state");
    if (el) el.textContent = "";
  });
  await expect(page.locator("#save-state")).toHaveText(/Saved/, { timeout: 30_000 });
  // The library write follows the OPFS write inside the same lock.
  await page.waitForTimeout(600);
}

/**
 * Answers the launch card if one appears, and waits until the app is running.
 *
 * Waits for whichever comes first — the card, or the app already running —
 * because that is the state the next step depends on. It used to wait up to
 * twenty seconds for the card and then carry on, so the tests where the right
 * outcome is *no* card (a reopen, a link older than what this device holds)
 * sat out the whole twenty seconds every time: a quarter of a minute per open,
 * a sixth of the suite in one file.
 *
 * Polled rather than `card.or(body.loaded)`: the card is hidden, not removed,
 * once it has been answered, so both can match at once and a locator refuses
 * an ambiguous match.
 */
async function through(page: Page): Promise<boolean> {
  const card = page.locator("#card-open");
  await expect
    .poll(
      async () =>
        (await card.isVisible()) ||
        (await page.evaluate(() => document.body.classList.contains("loaded"))),
      { timeout: 60_000 },
    )
    .toBe(true);
  const shown = await card.isVisible();
  if (shown) await card.click();
  await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });
  return shown;
}

const inside = (page: Page) => page.frameLocator("#cartridge").frameLocator("#dai-app");

/**
 * What every frame of every open page holds, when a test here fails (D32).
 *
 * The kept traces say a reopen ends with the shell's frame and its app frame
 * gone and a new app frame made, and then a 90-second wait for text that never
 * appears. What they cannot say is whether that new frame is the one the page
 * is attached to and is simply empty, or whether the document mounted into a
 * frame the page no longer shows — a frame that renders the right text but is
 * not the document's frame is a product defect, not a lost locator. The
 * snapshots are incremental and cannot be read back for that, so the frames are
 * asked directly, at the moment it fails.
 */
test.afterEach(async ({ browser }, testInfo) => {
  if (testInfo.status === testInfo.expectedStatus) return;
  for (const [c, context] of browser.contexts().entries()) {
    for (const [p, page] of context.pages().entries()) {
      for (const frame of page.frames()) {
        const read = await frame
          .evaluate(() => ({
            url: location.href.slice(0, 70),
            title: document.title.slice(0, 40),
            body: (document.body?.innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 70),
            app: Boolean(document.getElementById("app") ?? document.getElementById("dai-app")),
            frames: window.frames.length,
            attached: document.defaultView !== null,
          }))
          .catch((error: Error) => ({ url: frame.url().slice(0, 70), error: String(error.message).slice(0, 60) }));
        console.log(`D32 frame c${c}p${p} parent=${frame.parentFrame() ? "y" : "n"} ${JSON.stringify(read)}`);
      }
    }
  }
});

/** Opens a file and waits for the application to be running. */
async function open(page: Page, file: string): Promise<void> {
  await page.goto(RUNNER_URL);
  await page.setInputFiles("#file", file);
  await through(page);
  await expect(inside(page).locator("#app")).toBeVisible({ timeout: 60_000 });
}

/** Shares the open document and returns the link that reached the clipboard. */
async function shareLink(page: Page): Promise<string> {
  await page.evaluate(() => {
    (window as unknown as { __copied?: string }).__copied = undefined;
    navigator.clipboard.writeText = async (text: string) => {
      (window as unknown as { __copied?: string }).__copied = text;
    };
  });
  await page.click("#more");
  await page.click("#send");
  await page.click("#send-go");
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __copied?: string }).__copied), {
      timeout: 60_000,
    })
    .toBeTruthy();
  return (await page.evaluate(
    () => (window as unknown as { __copied?: string }).__copied,
  )) as string;
}

test.describe("a move sent back to somebody who has the app", () => {
  test("arrives, instead of being replaced by what this device already had", async ({ browser }) => {
    test.slow();
    const file = await board();

    // Her device: she has the game and makes a move.
    const hers = await browser.newContext();
    const alice = await hers.newPage();
    await open(alice, file);
    await inside(alice).locator("#move").click();
    await expect(inside(alice).locator("#app")).toHaveText("move1");
    // Saved, so the share carries it rather than the state it opened with.
    await settled(alice);
    const link = await shareLink(alice);
    await hers.close();

    // His device: the same game, already open, with no moves in it.
    const his = await browser.newContext();
    const bob = await his.newPage();
    await open(bob, file);
    await expect(inside(bob).locator("#app")).toHaveText("no moves");

    // Her link, followed on his device — the app is the one he already has,
    // and the only thing that changed is the data.
    await bob.goto("about:blank");
    await bob.goto(link);
    // Answered if it appears, so the data underneath can be looked at on its
    // own. Whether it should appear at all is the next test.
    await through(bob);

    // Her move, not his empty board. This is what failed: his stored database
    // was mounted over hers, and the move was silently dropped.
    await expect(inside(bob).locator("#app")).toHaveText("move1", { timeout: 60_000 });
    await his.close();
  });

  test("a link older than what this device holds does not roll it back", async ({ browser }) => {
    test.slow();
    const file = await board();

    // He shares the board before either of them has moved.
    const his = await browser.newContext();
    const bob = await his.newPage();
    await open(bob, file);
    const stale = await shareLink(bob);

    // Then plays two moves of his own.
    await inside(bob).locator("#move").click();
    await inside(bob).locator("#move").click();
    await expect(inside(bob).locator("#app")).toHaveText("move1 move2");
    await settled(bob);

    // The old link, opened again — a message scrolled back to, or sent twice.
    // What he has is newer, and newer wins: a game does not go backwards.
    await bob.goto("about:blank");
    await bob.goto(stale);
    await through(bob);
    await expect(inside(bob).locator("#app")).toHaveText("move1 move2", { timeout: 60_000 });
    await his.close();
  });

  test("opening your own copy after they moved does not make yours look newer", async ({ browser }) => {
    test.slow();
    const file = await board();

    // Both start from the same file. Neither has changed anything.
    const his = await browser.newContext();
    const bob = await his.newPage();
    await open(bob, file);

    // She moves, on her device, and sends it.
    const hers = await browser.newContext();
    const alice = await hers.newPage();
    await open(alice, file);
    await inside(alice).locator("#move").click();
    await inside(alice).locator("#move").click();
    await settled(alice);
    const link = await shareLink(alice);
    await hers.close();

    /*
     * He opens his own copy before following her link — the ordinary thing to
     * do, and the thing that broke it. Opening reseals around the stored
     * database and stamps the moment it ran; recording that as when his copy
     * was saved would put his clock ahead of her move and refuse it.
     */
    await bob.goto("about:blank");
    await bob.goto(RUNNER_URL);
    await through(bob);
    await expect(inside(bob).locator("#app")).toHaveText("no moves");

    await bob.goto("about:blank");
    await bob.goto(link);
    await through(bob);
    await expect(inside(bob).locator("#app")).toHaveText("move1 move2", { timeout: 60_000 });
    await his.close();
  });
});

/**
 * D36: which copy opens is decided by what each has seen, not whose clock ran
 * last. Every case here forces its order on purpose. The bug was seen once in
 * seven runs, when a save happened to land between a share and the link being
 * followed, and a bug that cannot be provoked on demand gets found again
 * instead of fixed.
 */
test.describe("two copies of a document that cannot merge", () => {
  /** Resolves when the opener refuses to choose between two copies. */
  function refusal(page: Page): Promise<string> {
    return new Promise((resolve) => {
      page.on("console", (message) => {
        if (message.text().includes("dai: refused to choose between diverged copies")) resolve(message.text());
      });
    });
  }

  test("a save that changed nothing, landing between her share and his following it, does not outrank her move", async ({ browser }) => {
    test.slow();
    const file = await board();

    const hers = await browser.newContext();
    const alice = await hers.newPage();
    await open(alice, file);
    await inside(alice).locator("#move").click();
    await settled(alice);
    const link = await shareLink(alice);
    await hers.close();

    // His copy saves after her share and before her link: the losing order,
    // forced. Nothing he did changed the data; his clock moved past her move.
    const his = await browser.newContext();
    const bob = await his.newPage();
    await open(bob, file);
    // Waited for as the host's own line: an explicit save does not touch the
    // save-state label that `settled` reads.
    const written = new Promise<void>((resolve) =>
      bob.on("console", (message) => {
        if (/^dai: save \d+ written$/.test(message.text())) resolve();
      }),
    );
    await inside(bob).locator("#save-now").click();
    await written;
    await bob.waitForTimeout(600);
    await expect(inside(bob).locator("#app")).toHaveText("no moves");

    await bob.goto("about:blank");
    await bob.goto(link);
    await through(bob);
    await expect(inside(bob).locator("#app")).toHaveText("move1", { timeout: 60_000 });
    await his.close();
  });

  test("both changed since they last matched: neither is opened over the other, and he is told", async ({ browser }) => {
    test.slow();
    const file = await board();

    const hers = await browser.newContext();
    const alice = await hers.newPage();
    await open(alice, file);
    await inside(alice).locator("#move").click();
    await inside(alice).locator("#move").click();
    await settled(alice);
    const link = await shareLink(alice);
    await hers.close();

    // He moves too, on his own copy, after her share: a real change she never saw.
    const his = await browser.newContext();
    const bob = await his.newPage();
    await open(bob, file);
    await inside(bob).locator("#move").click();
    await settled(bob);

    const refused = refusal(bob);
    await bob.goto("about:blank");
    await bob.goto(link);
    await refused;
    await expect(bob.locator("#report")).toContainText("both changed since they last matched", { timeout: 30_000 });
    await expect(bob.locator("body")).not.toHaveClass(/loaded/);

    // Nothing of his was touched: his own copy still opens with his move.
    await bob.goto("about:blank");
    await bob.goto(RUNNER_URL);
    await through(bob);
    await expect(inside(bob).locator("#app")).toHaveText("move1", { timeout: 60_000 });
    await his.close();
  });

  test("a turn sent and answered, with nothing written in between, is taken without a question", async ({ browser }) => {
    test.slow();
    const file = await board();

    // He moves and sends it.
    const his = await browser.newContext();
    const bob = await his.newPage();
    await open(bob, file);
    await inside(bob).locator("#move").click();
    await settled(bob);
    const toHer = await shareLink(bob);

    // She opens his link, answers, and sends it back.
    const hers = await browser.newContext();
    const alice = await hers.newPage();
    await alice.goto(toHer);
    await through(alice);
    await expect(inside(alice).locator("#app")).toHaveText("move1", { timeout: 60_000 });
    await inside(alice).locator("#move").click();
    await expect(inside(alice).locator("#app")).toHaveText("move1 move2");
    await settled(alice);
    const toHim = await shareLink(alice);
    await hers.close();

    // His copy changed (his move) since the file, but not since he sent it.
    const refused = refusal(bob);
    let wasRefused = false;
    void refused.then(() => (wasRefused = true));
    await bob.goto("about:blank");
    await bob.goto(toHim);
    await through(bob);
    await expect(inside(bob).locator("#app")).toHaveText("move1 move2", { timeout: 60_000 });
    expect(wasRefused, "a legitimate reply was refused as a divergence").toBe(false);
    await his.close();
  });
});

test.describe("a newer copy arriving at its own icon's address", () => {
  test("inline-newer-copy-of-held-document-supersedes", async ({ browser }) => {
    test.slow();

    /*
     * The same succession, at the address an icon launches.
     *
     * A home-screen icon for a document that arrived by link carries both the
     * document and `#u=<uuid>` — the payload and a hint naming it. The hint
     * used to be read first: a library hit opened the local copy and returned,
     * so the payload was never decompressed and `ingest`, which is where
     * `savedAt` decides succession, was never reached. A newer copy of a
     * document you already had could not win, by construction, and nothing on
     * screen said a newer one had arrived.
     *
     * The payload decides now, and this is the case that could never pass
     * before: the link is newer, the address names the document it carries,
     * and the newer state is what opens.
     */
    const file = await board();
    const { parseContainer } = await import("../src/container.js");
    const { readFileSync } = await import("node:fs");
    const uuid = parseContainer(readFileSync(file, "utf8")).manifest.documentUuid;

    // Her device: a move, saved, shared.
    const hers = await browser.newContext();
    const alice = await hers.newPage();
    await open(alice, file);
    await inside(alice).locator("#move").click();
    await expect(inside(alice).locator("#app")).toHaveText("move1");
    await settled(alice);
    const link = await shareLink(alice);
    await hers.close();

    // His device: the same game, no moves, and now held — so the hint below
    // names something this device really has, which is the whole trap.
    const his = await browser.newContext();
    const bob = await his.newPage();
    await open(bob, file);
    await expect(inside(bob).locator("#app")).toHaveText("no moves");

    // Her link, with the hint an icon would carry beside it.
    const iconAddress = `${link}${link.includes("#") ? "&" : "#"}${HINT_KEY}=${uuid}`;
    await bob.goto("about:blank");
    await bob.goto(iconAddress);
    await through(bob);

    // Her move. Under the old ordering this said "no moves": his own copy,
    // opened because the hint matched, with hers still sitting unread in the
    // address bar.
    await expect(inside(bob).locator("#app")).toHaveText("move1", { timeout: 60_000 });
    await his.close();
  });
});
