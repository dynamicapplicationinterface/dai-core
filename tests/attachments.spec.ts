import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { compileDirectory } from "../src/compile.js";
import { openFile } from "./open.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER_URL = "http://localhost:5175/";

/**
 * A picture that lives in the document (backlog 4.5).
 *
 * The claim is that a document is one file and everything in it travels: a
 * photograph attached on one device is in the file that arrives on the other,
 * with no folder beside it and no server behind it. That claim is only worth
 * anything if somebody has actually walked it, so this walks it — attach on
 * device A, export, open the exported file on device B.
 *
 * "Device B" here is a browser context with nothing in it: no OPFS, no
 * IndexedDB, nothing this document has ever touched. The only thing that
 * crosses is the file.
 */

/**
 * A real PNG, built here rather than pasted as base64.
 *
 * The browser has to actually decode this — the whole test is that bytes
 * survive a round trip — and a base64 blob copied from somewhere is a string
 * nobody in this repository can check. Sixteen pixels of red, encoded by hand:
 * signature, IHDR, IDAT, IEND, each with its CRC.
 */
function picture(): Buffer {
  const side = 8;

  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buffer: Buffer): number => {
    let c = 0xffffffff;
    for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, body: Buffer): Buffer => {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(body.length);
    const typed = Buffer.concat([Buffer.from(type, "latin1"), body]);
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc(typed));
    return Buffer.concat([head, typed, tail]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(side, 0);
  ihdr.writeUInt32BE(side, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour

  // One filter byte per row, then RGB triples.
  const raw = Buffer.concat(
    Array.from({ length: side }, () =>
      Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: side * 3 }, (_, i) => (i % 3 === 0 ? 220 : 40)))]),
    ),
  );

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const SOURCE = {
  "index.html": `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Trip</title></head>
  <body>
    <script type="application/sql">
      CREATE TABLE IF NOT EXISTS entries (id INTEGER PRIMARY KEY, note TEXT, photo BLOB);
      INSERT INTO entries (id, note) SELECT 1, 'Day one'
        WHERE NOT EXISTS (SELECT 1 FROM entries WHERE id = 1);
    </script>

    <dai-rows query="SELECT id, note, photo FROM entries ORDER BY id">
      <template>
        <li>
          <span data-text="note"></span>
          <img data-blob="photo" alt="" hidden>
          <dai-attach run="UPDATE entries SET photo = :file WHERE id = :id" data-id="1">
            Add a photo
          </dai-attach>
        </li>
      </template>
    </dai-rows>

    <dai-save>Save</dai-save>
    <script type="module" src="./dai-kit.js"></script>
  </body>
</html>
`,
};

test.describe("a photo attached on one device, opened on another", () => {
  test("survives export and arrives in the file", async ({ page, browser }) => {
    // Two documents opened, a picture decoded and re-encoded, an export and a
    // second cold open. It is the whole walk, and it is not quick.
    test.setTimeout(240_000);

    const work = mkdtempSync(join(tmpdir(), "dai-attach-"));
    const source = join(work, "src");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(source, { recursive: true });
    for (const [name, body] of Object.entries(SOURCE)) writeFileSync(join(source, name), body, "utf8");

    const photo = join(work, "photo.png");
    writeFileSync(photo, picture());

    const built = await compileDirectory({ sourceDir: source, root: repo, appName: "Trip" });
    const container = join(work, "trip.dai.html");
    writeFileSync(container, built.html, "utf8");

    // Device A.
    await page.goto(RUNNER_URL);
    await page.setInputFiles("#file", container);
    await page.locator("#card-open").click({ timeout: 60_000 });
    await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });

    const outer = page.frameLocator("#cartridge");
    const inner = outer.frameLocator("#dai-app");

    // The picture is not there yet, which is what makes the next assertion
    // mean anything.
    await expect(inner.locator("img[data-blob]")).toBeHidden({ timeout: 60_000 });

    // Attaching is choosing a file, the way a person does it. The element's
    // own input is hidden behind the label it draws.
    await inner.locator("dai-attach input[type=file]").setInputFiles(photo);
    await expect(inner.locator("img[data-blob]")).toBeVisible({ timeout: 60_000 });

    // Scaled and re-encoded on the way in: what goes into the document is a
    // JPEG the document can afford, not whatever the camera produced.
    const src = await inner.locator("img[data-blob]").getAttribute("src");
    expect(src).toMatch(/^blob:/);

    // Exported: the file device B will be handed.
    /*
     * Exported, through the container's own save.
     *
     * `method: "download"` is the `<a download>` path — the one Safari and
     * Firefox take, and the only one drivable headlessly, since the save
     * dialog a desktop browser prefers is a dialog nobody can click here.
     * What comes out is the document as it now stands: the archive resealed
     * around the database the photo was written into.
     */
    const frame = page.frameLocator("#cartridge").frameLocator("#dai-app");
    const downloading = page.waitForEvent("download", { timeout: 60_000 });
    await frame.locator("body").evaluate(async () => {
      const win = window as unknown as {
        dai: { saveDatabase(db: unknown, options: { method: string }): Promise<unknown> };
        daiKit: { db: unknown };
      };
      await win.dai.saveDatabase(win.daiKit.db, { method: "download" });
    });
    const download = await downloading;

    const exported = join(work, "trip-exported.dai.html");
    writeFileSync(exported, readFileSync(await download.path()));

    // Device B: a context that has never seen this document.
    const second = await browser.newContext({ acceptDownloads: true });
    try {
      const other = await second.newPage();
      await other.goto(RUNNER_URL);
      // Whatever the card decides to do on a document it has never seen —
      // `openFile` waits for it and presses it, exactly as a person would.
      await openFile(other, exported);
      await expect(other.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });

      const arrived = other.frameLocator("#cartridge").frameLocator("#dai-app");
      await expect(arrived.locator("img[data-blob]")).toBeVisible({ timeout: 60_000 });

      // Not a broken image: the bytes decoded on the other side.
      const decoded = await arrived.locator("img[data-blob]").evaluate(
        (img: HTMLImageElement) =>
          new Promise<number>((done) => {
            if (img.complete) return done(img.naturalWidth);
            img.onload = () => done(img.naturalWidth);
            img.onerror = () => done(0);
          }),
      );
      expect(decoded, "the photo should decode on the device it arrived at").toBeGreaterThan(0);
    } finally {
      await second.close();
    }
  });

  test("refuses a file it cannot read as a picture, and says so", async ({ page }) => {
    test.slow();

    const work = mkdtempSync(join(tmpdir(), "dai-attach-bad-"));
    const source = join(work, "src");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(source, { recursive: true });
    for (const [name, body] of Object.entries(SOURCE)) writeFileSync(join(source, name), body, "utf8");
    const notAPicture = join(work, "notes.txt");
    writeFileSync(notAPicture, "this is not a photograph", "utf8");

    const built = await compileDirectory({ sourceDir: source, root: repo, appName: "Trip" });
    const container = join(work, "trip.dai.html");
    writeFileSync(container, built.html, "utf8");

    await page.goto(RUNNER_URL);
    await page.setInputFiles("#file", container);
    await page.locator("#card-open").click({ timeout: 60_000 });
    await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });

    const inner = page.frameLocator("#cartridge").frameLocator("#dai-app");
    await inner.locator("dai-attach input[type=file]").setInputFiles(notAPicture);

    // Said out loud, in the element itself, rather than swallowed — and the
    // document is unchanged.
    await expect(inner.locator("dai-attach")).toContainText("could not be read", {
      timeout: 60_000,
    });
    await expect(inner.locator("img[data-blob]")).toBeHidden();
  });
});
