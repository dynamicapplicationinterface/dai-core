import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type ConsoleMessage, type Frame, type Page } from "@playwright/test";
import { unzipSync } from "fflate";

const here = dirname(fileURLToPath(import.meta.url));
const CONTAINER = resolve(here, "fixture/fixture.dai.html");
const CONTAINER_URL = `file:///${CONTAINER.replace(/\\/g, "/")}`;

/** Console errors, so every test can assert the container booted cleanly. */
function watchConsole(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message: ConsoleMessage) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(String(error)));
  return errors;
}

/** The app runs in the srcdoc frame; everything worth asserting lives there. */
async function appFrame(page: Page): Promise<Frame> {
  const element = page.locator("#dai-app");
  await element.waitFor({ state: "attached" });
  const frame = await element.elementHandle().then((h) => h!.contentFrame());
  if (!frame) throw new Error("The container never created its application frame.");
  await frame.waitForFunction(() => Boolean((window as never as { dai?: unknown }).dai));
  return frame;
}

test.describe("DAI container", () => {
  test("mounts the application from file:// with no console errors", async ({ page }) => {
    const errors = watchConsole(page);
    await page.goto(CONTAINER_URL);

    const frame = await appFrame(page);

    // Resolves only if the dynamic import crossed the cyclic chunk graph.
    await frame.waitForSelector("#app[data-ready='true']");
    expect(await frame.textContent("#app")).toBe("ready dai-shared dai-shared:lazy");

    // The boot UI hides itself only once the frame reports back.
    await expect(page.locator("body")).toHaveClass(/dai-mounted/);
    expect(errors).toEqual([]);
  });

  test("loads nothing over the network", async ({ page }) => {
    const external: string[] = [];
    page.on("request", (request) => {
      const url = request.url();
      if (!url.startsWith("blob:") && !url.startsWith("data:") && !url.startsWith("file:")) {
        external.push(url);
      }
    });

    await page.goto(CONTAINER_URL);
    const frame = await appFrame(page);
    await frame.evaluate(() => (window as never as { dai: { initSqlite(): Promise<unknown> } }).dai.initSqlite());

    expect(external).toEqual([]);
  });

  test("exposes the engine as bytes, never as a URL", async ({ page }) => {
    await page.goto(CONTAINER_URL);
    const frame = await appFrame(page);

    const engine = await frame.evaluate(() => {
      const dai = (window as never as { dai: Record<string, never> }).dai;
      return {
        hasEngine: dai.hasSqliteEngine as unknown as boolean,
        hasGlue: dai.hasSqliteGlue as unknown as boolean,
        bytes: (dai.sqliteWasm as unknown as ArrayBuffer).byteLength,
        // Must be this frame's intrinsic, not the parent's.
        isArrayBuffer: (dai.sqliteWasm as unknown) instanceof ArrayBuffer,
      };
    });

    expect(engine.hasEngine).toBe(true);
    expect(engine.hasGlue).toBe(true);
    expect(engine.bytes).toBeGreaterThan(500_000);
    expect(engine.isArrayBuffer).toBe(true);
  });

  test("initializes SQLite and runs create, insert and select", async ({ page }) => {
    const errors = watchConsole(page);
    await page.goto(CONTAINER_URL);
    const frame = await appFrame(page);

    const result = await frame.evaluate(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dai = (window as any).dai;
      const api = await dai.initSqlite();
      const db = await dai.openDatabase();

      // Methods must stay bound: sqlite3's exec() reads this.pointer.
      db.exec("CREATE TABLE notes(id INTEGER PRIMARY KEY, body TEXT)");
      db.exec({ sql: "INSERT INTO notes(body) VALUES(?)", bind: ["first"] });
      db.exec({ sql: "INSERT INTO notes(body) VALUES(?)", bind: ["second"] });

      return {
        libVersion: api.version.libVersion as string,
        count: db.selectValue("SELECT count(*) FROM notes") as number,
        second: db.selectValue("SELECT body FROM notes WHERE id = 2") as string,
        exported: dai.exportDatabase(db).length as number,
      };
    });

    expect(result.libVersion).toMatch(/^3\./);
    expect(result.count).toBe(2);
    expect(result.second).toBe("second");
    // A serialized database is whole pages, never empty.
    expect(result.exported).toBeGreaterThan(0);
    expect(result.exported % 512).toBe(0);
    expect(errors).toEqual([]);
  });

  test("daiSaveState emits a valid container carrying the new database", async ({ page }) => {
    await page.goto(CONTAINER_URL);
    const frame = await appFrame(page);

    await frame.evaluate(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const win = window as any;
      const db = await win.dai.openDatabase();
      db.exec("CREATE TABLE saved(note TEXT)");
      db.exec({ sql: "INSERT INTO saved(note) VALUES(?)", bind: ["persisted"] });
      win.__db = db;
    });

    // method:"download" takes the <a download> path — the same one Safari and
    // Firefox use, and the only one drivable headlessly (see the cancel test).
    const [download, result] = await Promise.all([
      page.waitForEvent("download"),
      frame.evaluate(() =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (window as any).dai.saveDatabase((window as any).__db, { method: "download" }),
      ),
    ]);

    expect(result).toEqual({ saved: true, method: "download" });

    expect(download.suggestedFilename()).toBe("fixture.dai.html");

    const saved = readFileSync(await download.path(), "utf8");
    const payload = saved.match(/id="dai-payload">([\s\S]*?)<\/script>/)?.[1]?.trim();
    expect(payload).toBeTruthy();

    const archive = unzipSync(Buffer.from(payload!, "base64"));
    const original = unzipSync(
      Buffer.from(
        readFileSync(CONTAINER, "utf8").match(/id="dai-payload">([\s\S]*?)<\/script>/)![1]!.trim(),
        "base64",
      ),
    );

    // A real database replaced the empty seed.
    const database = Buffer.from(archive["document.sqlite"]!);
    expect(database.subarray(0, 15).toString("latin1")).toBe("SQLite format 3");
    expect(database.includes(Buffer.from("saved"))).toBe(true);

    // The saved file can still run and still rewrite itself.
    expect(archive["runtime/container.html"]).toBeTruthy();
    expect(Buffer.from(archive["runtime/sqlite3.wasm"]!)).toEqual(
      Buffer.from(original["runtime/sqlite3.wasm"]!),
    );
    expect(Buffer.from(archive["runtime/sqlite3.mjs"]!)).toEqual(
      Buffer.from(original["runtime/sqlite3.mjs"]!),
    );
    expect(Buffer.from(archive["app/index.html"]!)).toEqual(
      Buffer.from(original["app/index.html"]!),
    );
  });

  test("reports a dismissed save dialog instead of resolving silently", async ({ page }) => {
    await page.goto(CONTAINER_URL);
    const frame = await appFrame(page);

    // Headless Chromium exposes showSaveFilePicker but auto-dismisses it with
    // AbortError. The caller must be able to tell that apart from a real save.
    const result = await frame.evaluate(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).dai.saveState(new Uint8Array([1, 2, 3]), { method: "picker" }),
    );

    expect(result).toEqual({ saved: false, method: "cancelled" });
  });

  test("a saved container reopens and reads back its own data", async ({ page }, testInfo) => {
    await page.goto(CONTAINER_URL);
    const frame = await appFrame(page);

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      frame.evaluate(async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const dai = (window as any).dai;
        const db = await dai.openDatabase();
        db.exec("CREATE TABLE roundtrip(value TEXT)");
        db.exec({ sql: "INSERT INTO roundtrip(value) VALUES(?)", bind: ["survived"] });
        return dai.saveDatabase(db, { method: "download" });
      }),
    ]);

    // Reopen the saved artifact as its own document.
    const savedPath = testInfo.outputPath("reopened.dai.html");
    await download.saveAs(savedPath);

    await page.goto(`file:///${savedPath.replace(/\\/g, "/")}`);
    const reopened = await appFrame(page);

    const readBack = await reopened.evaluate(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dai = (window as any).dai;
      const db = await dai.openDatabase();
      return {
        seeded: dai.document.length as number,
        value: db.selectValue("SELECT value FROM roundtrip") as string,
      };
    });

    expect(readBack.seeded).toBeGreaterThan(0);
    expect(readBack.value).toBe("survived");
  });
});
