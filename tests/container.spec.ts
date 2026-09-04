import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type ConsoleMessage, type Frame, type Page } from "@playwright/test";
import { unzipSync, zipSync } from "fflate";
import { MANIFEST_VERSION } from "../src/core.js";

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

  test("writes through showSaveFilePicker when the picker succeeds", async ({ page }) => {
    // The real picker needs a user gesture no automation can supply, so the
    // success path is only reachable with a stand-in. This asserts the host
    // actually drives createWritable/write/close and reports method:"picker".
    await page.addInitScript(() => {
      const win = window as unknown as Record<string, unknown>;
      win.__pickerCalls = [];
      win.showSaveFilePicker = async (options: unknown) => {
        (win.__pickerCalls as unknown[]).push(options);
        return {
          createWritable: async () => ({
            write: async (data: Blob) => {
              win.__savedText = await data.text();
              win.__savedType = data.type;
            },
            close: async () => {
              win.__closed = true;
            },
          }),
        };
      };
    });

    await page.goto(CONTAINER_URL);
    const frame = await appFrame(page);

    const result = await frame.evaluate(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dai = (window as any).dai;
      const db = await dai.openDatabase();
      db.exec("CREATE TABLE picked(note TEXT)");
      db.exec({ sql: "INSERT INTO picked(note) VALUES(?)", bind: ["via-picker"] });
      return dai.saveDatabase(db, { method: "picker" });
    });

    expect(result).toEqual({ saved: true, method: "picker" });

    const host = await page.evaluate(() => {
      const win = window as unknown as Record<string, unknown>;
      return {
        calls: (win.__pickerCalls as unknown[]).length,
        suggested: ((win.__pickerCalls as { suggestedName: string }[])[0] ?? {}).suggestedName,
        closed: win.__closed === true,
        type: win.__savedType,
        text: win.__savedText as string,
      };
    });

    expect(host.calls).toBe(1);
    expect(host.suggested).toBe("fixture.dai.html");
    expect(host.closed).toBe(true);
    expect(host.type).toBe("text/html");

    // The bytes handed to the writable must be a working container.
    const payload = host.text.match(/id="dai-payload">([\s\S]*?)<\/script>/)?.[1]?.trim();
    expect(payload).toBeTruthy();
    const archive = unzipSync(Buffer.from(payload!, "base64"));
    const database = Buffer.from(archive["document.sqlite"]!);
    expect(database.subarray(0, 15).toString("latin1")).toBe("SQLite format 3");
    expect(database.includes(Buffer.from("picked"))).toBe(true);
    expect(archive["runtime/container.html"]).toBeTruthy();
  });

  test("reports a dismissed save dialog instead of resolving silently", async ({ page }) => {
    // Injected rather than relying on the engine: Chromium auto-dismisses its
    // picker while WebKit and Firefox have none, so only a stand-in makes the
    // cancellation path deterministic everywhere.
    await page.addInitScript(() => {
      (window as unknown as Record<string, unknown>).showSaveFilePicker = async () => {
        const error = new Error("The user aborted a request.");
        error.name = "AbortError";
        throw error;
      };
    });

    await page.goto(CONTAINER_URL);
    const frame = await appFrame(page);

    const result = await frame.evaluate(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).dai.saveState(new Uint8Array([1, 2, 3]), { method: "picker" }),
    );

    expect(result).toEqual({ saved: false, method: "cancelled" });
  });

  test("reports an unsupported picker rather than silently downloading", async ({ page }) => {
    // Safari and Firefox have no File System Access API. Demanding the picker
    // must say so, not quietly emit a copy the user thinks overwrote the file.
    await page.addInitScript(() => {
      delete (window as unknown as Record<string, unknown>).showSaveFilePicker;
    });

    await page.goto(CONTAINER_URL);
    const frame = await appFrame(page);

    const result = await frame.evaluate(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).dai.saveState(new Uint8Array([1, 2, 3]), { method: "picker" }),
    );

    expect(result).toEqual({ saved: false, method: "unsupported" });
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

test.describe("manifest and integrity", () => {
  test("seals every entry and mints a document UUID", async () => {
    const archive = unzipSync(
      Buffer.from(
        readFileSync(CONTAINER, "utf8").match(/id="dai-payload">([\s\S]*?)<\/script>/)![1]!.trim(),
        "base64",
      ),
    );

    const manifest = JSON.parse(
      Buffer.from(archive["runtime/manifest.json"]!).toString("utf8"),
    );

    // The compiler's own constant: this asserts the manifest records a version,
    // not which one. What the value must be is asserted in
    // older-containers.spec.ts, where the reason it matters lives.
    expect(manifest.manifestVersion).toBe(MANIFEST_VERSION);
    expect(manifest.algorithm).toBe("SHA-256");
    expect(manifest.documentUuid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );

    // Every entry but the manifest is covered, and each digest is correct.
    const covered = Object.keys(archive).filter((n) => n !== "runtime/manifest.json").sort();
    expect(Object.keys(manifest.hashes).sort()).toEqual(covered);
    expect(manifest.hashes["runtime/manifest.json"]).toBeUndefined();

    for (const name of covered) {
      const digest = createHash("sha256").update(Buffer.from(archive[name]!)).digest("hex");
      expect(manifest.hashes[name], `digest for ${name}`).toBe(digest);
    }
  });

  test("exposes the UUID to the application", async ({ page }) => {
    await page.goto(CONTAINER_URL);
    const frame = await appFrame(page);

    const identity = await frame.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dai = (window as any).dai;
      return { uuid: dai.documentUuid as string, verified: dai.verified as boolean };
    });

    expect(identity.uuid).toMatch(/^[0-9a-f]{8}-/);
    expect(identity.verified).toBe(true);
  });

  test("refuses to mount a tampered payload", async ({ page }, testInfo) => {
    const original = readFileSync(CONTAINER, "utf8");
    const payload = original.match(/id="dai-payload">([\s\S]*?)<\/script>/)![1]!.trim();
    const archive = unzipSync(Buffer.from(payload, "base64"));

    // Swap the entry HTML for something the manifest never saw.
    archive["app/index.html"] = new TextEncoder().encode(
      "<!doctype html><body><script>window.__pwned = true</script>",
    );
    const tampered = original.replace(
      /(<script[^>]*id="dai-payload"[^>]*>)[\s\S]*?(<\/script>)/,
      (_m, open: string, close: string) =>
        open + Buffer.from(zipSync(archive, { level: 9 })).toString("base64") + close,
    );

    const path = testInfo.outputPath("tampered.dai.html");
    writeFileSync(path, tampered, "utf8");
    await page.goto(`file:///${path.replace(/\\/g, "/")}`);

    await expect(page.locator("#dai-boot-status")).toContainText("Integrity check failed");
    await expect(page.locator("#dai-boot-detail")).toContainText("app/index.html");

    // Fail fast means fail before mounting: no frame, no execution.
    expect(await page.locator("#dai-app").count()).toBe(0);
    await expect(page.locator("body")).not.toHaveClass(/dai-mounted/);
  });

  test("a save reseals the manifest and keeps the document UUID", async ({ page }, testInfo) => {
    await page.goto(CONTAINER_URL);
    const frame = await appFrame(page);

    const before = await frame.evaluate(() => (window as any).dai.documentUuid as string);

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      frame.evaluate(async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const dai = (window as any).dai;
        const db = await dai.openDatabase();
        db.exec("CREATE TABLE sealed(v TEXT)");
        db.exec({ sql: "INSERT INTO sealed(v) VALUES(?)", bind: ["resealed"] });
        return dai.saveDatabase(db, { method: "download" });
      }),
    ]);

    const savedPath = testInfo.outputPath("resealed.dai.html");
    await download.saveAs(savedPath);

    // The saved manifest must describe the saved payload, digest for digest.
    const saved = readFileSync(savedPath, "utf8");
    const archive = unzipSync(
      Buffer.from(saved.match(/id="dai-payload">([\s\S]*?)<\/script>/)![1]!.trim(), "base64"),
    );
    const manifest = JSON.parse(
      Buffer.from(archive["runtime/manifest.json"]!).toString("utf8"),
    );

    expect(manifest.documentUuid).toBe(before);
    expect(manifest.savedAt).toBeTruthy();
    for (const name of Object.keys(archive).filter((n) => n !== "runtime/manifest.json")) {
      const digest = createHash("sha256").update(Buffer.from(archive[name]!)).digest("hex");
      expect(manifest.hashes[name], `digest for ${name}`).toBe(digest);
    }

    // And it must still open: a stale seal would refuse to mount.
    await page.goto(`file:///${savedPath.replace(/\\/g, "/")}`);
    const reopened = await appFrame(page);
    const readBack = await reopened.evaluate(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dai = (window as any).dai;
      const db = await dai.openDatabase();
      return {
        uuid: dai.documentUuid as string,
        value: db.selectValue("SELECT v FROM sealed") as string,
      };
    });

    expect(readBack.uuid).toBe(before);
    expect(readBack.value).toBe("resealed");
  });
});

test.describe("integrity policy cannot be disabled from inside the payload", () => {
  /** Rebuilds a container around a mutated archive. */
  function repack(archive: Record<string, Uint8Array>): string {
    const original = readFileSync(CONTAINER, "utf8");
    return original.replace(
      /(<script[^>]*id="dai-payload"[^>]*>)[\s\S]*?(<\/script>)/,
      (_m, open: string, close: string) =>
        open + Buffer.from(zipSync(archive, { level: 9 })).toString("base64") + close,
    );
  }

  function archiveOf(html: string): Record<string, Uint8Array> {
    return unzipSync(
      Buffer.from(html.match(/id="dai-payload">([\s\S]*?)<\/script>/)![1]!.trim(), "base64"),
    );
  }

  test("the shell, not the manifest, decides", async ({ page }) => {
    const html = readFileSync(CONTAINER, "utf8");
    expect(html).toContain('<meta name="dai-integrity" content="required">');

    const archive = archiveOf(html);
    const manifest = JSON.parse(Buffer.from(archive["runtime/manifest.json"]!).toString("utf8"));

    // The old escape hatch: flip the flag, then swap an entry.
    manifest.verifyIntegrity = false;
    manifest.integrityPolicy = "advisory";
    archive["runtime/manifest.json"] = new TextEncoder().encode(JSON.stringify(manifest, null, 2));
    archive["app/index.html"] = new TextEncoder().encode("<!doctype html><body>swapped");

    const path = test.info().outputPath("policy-flipped.dai.html");
    writeFileSync(path, repack(archive), "utf8");
    await page.goto(`file:///${path.replace(/\\/g, "/")}`);

    await expect(page.locator("#dai-boot-status")).toContainText("Integrity check failed");
    expect(await page.locator("#dai-app").count()).toBe(0);
  });

  test("a stripped manifest is refused, not treated as unsealed", async ({ page }) => {
    const archive = archiveOf(readFileSync(CONTAINER, "utf8"));
    delete archive["runtime/manifest.json"];
    archive["app/index.html"] = new TextEncoder().encode("<!doctype html><body>unsealed");

    const path = test.info().outputPath("no-manifest.dai.html");
    writeFileSync(path, repack(archive), "utf8");
    await page.goto(`file:///${path.replace(/\\/g, "/")}`);

    await expect(page.locator("#dai-boot-status")).toContainText("Integrity check failed");
    await expect(page.locator("#dai-boot-detail")).toContainText("missing");
    expect(await page.locator("#dai-app").count()).toBe(0);
  });
});

test.describe("publisher signature", () => {
  function archiveOf(html: string): Record<string, Uint8Array> {
    return unzipSync(
      Buffer.from(html.match(/id="dai-payload">([\s\S]*?)<\/script>/)![1]!.trim(), "base64"),
    );
  }

  function repack(html: string, archive: Record<string, Uint8Array>): string {
    return html.replace(
      /(<script[^>]*id="dai-payload"[^>]*>)[\s\S]*?(<\/script>)/,
      (_m, open: string, close: string) =>
        open + Buffer.from(zipSync(archive, { level: 9 })).toString("base64") + close,
    );
  }

  test("signs the app and runtime but not the database", async () => {
    const archive = archiveOf(readFileSync(CONTAINER, "utf8"));
    const manifest = JSON.parse(Buffer.from(archive["runtime/manifest.json"]!).toString("utf8"));

    expect(manifest.signatureAlgorithm).toBe("COSE-ES256");
    expect(manifest.signature).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(manifest.publicKeyFingerprint).toMatch(/^[0-9a-f]{16}$/);

    // The mutable database must stay outside the signed set, or no save could
    // ever produce a container that still verifies.
    expect(manifest.signedEntries["document.sqlite"]).toBeUndefined();
    expect(manifest.signedEntries["app/index.html"]).toBe(manifest.hashes["app/index.html"]);
    expect(manifest.signedEntries["runtime/sqlite3.wasm"]).toBe(
      manifest.hashes["runtime/sqlite3.wasm"],
    );
    expect(manifest.signedEntries["runtime/container.html"]).toBeTruthy();
  });

  test("reports a valid signature to the application", async ({ page }) => {
    await page.goto(CONTAINER_URL);
    const frame = await appFrame(page);

    const identity = await frame.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dai = (window as any).dai;
      return {
        signature: dai.signature as string,
        fingerprint: dai.publicKeyFingerprint as string,
      };
    });

    expect(identity.signature).toBe("valid");
    expect(identity.fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  test("refuses a payload re-sealed by someone without the private key", async ({ page }, testInfo) => {
    const html = readFileSync(CONTAINER, "utf8");
    const archive = archiveOf(html);
    const manifest = JSON.parse(Buffer.from(archive["runtime/manifest.json"]!).toString("utf8"));

    // The attacker swaps the app and recomputes every digest correctly — which
    // defeats the integrity check on its own. Only the signature catches this.
    archive["app/index.html"] = new TextEncoder().encode("<!doctype html><body>forged");
    const forged = createHash("sha256")
      .update(Buffer.from(archive["app/index.html"]))
      .digest("hex");
    manifest.hashes["app/index.html"] = forged;
    manifest.signedEntries["app/index.html"] = forged;
    archive["runtime/manifest.json"] = new TextEncoder().encode(JSON.stringify(manifest, null, 2));

    const path = testInfo.outputPath("forged.dai.html");
    writeFileSync(path, repack(html, archive), "utf8");
    await page.goto(`file:///${path.replace(/\\/g, "/")}`);

    await expect(page.locator("#dai-boot-status")).toContainText("not authentic");
    expect(await page.locator("#dai-app").count()).toBe(0);
  });

  test("refuses a signature that covers digests the payload does not have", async ({ page }, testInfo) => {
    const html = readFileSync(CONTAINER, "utf8");
    const archive = archiveOf(html);
    const manifest = JSON.parse(Buffer.from(archive["runtime/manifest.json"]!).toString("utf8"));

    // Leave signedEntries (and the signature) untouched, but swap the entry and
    // its integrity digest. Integrity now passes legitimately — the payload
    // matches its own hashes — so only the signature's cross-check can catch
    // that the signed digest and the real one disagree.
    archive["app/index.html"] = new TextEncoder().encode("<!doctype html><body>mismatch");
    manifest.hashes["app/index.html"] = createHash("sha256")
      .update(Buffer.from(archive["app/index.html"]))
      .digest("hex");
    archive["runtime/manifest.json"] = new TextEncoder().encode(JSON.stringify(manifest, null, 2));

    const path = testInfo.outputPath("mismatched.dai.html");
    writeFileSync(path, repack(html, archive), "utf8");
    await page.goto(`file:///${path.replace(/\\/g, "/")}`);

    await expect(page.locator("#dai-boot-status")).toContainText("not authentic");
    await expect(page.locator("#dai-boot-detail")).toContainText("different digest");
    expect(await page.locator("#dai-app").count()).toBe(0);
  });

  test("a save keeps the signature valid", async ({ page }, testInfo) => {
    await page.goto(CONTAINER_URL);
    const frame = await appFrame(page);

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      frame.evaluate(async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const dai = (window as any).dai;
        const db = await dai.openDatabase();
        db.exec("CREATE TABLE signed_save(v TEXT)");
        db.exec({ sql: "INSERT INTO signed_save(v) VALUES(?)", bind: ["kept"] });
        return dai.saveDatabase(db, { method: "download" });
      }),
    ]);

    const savedPath = testInfo.outputPath("signed-save.dai.html");
    await download.saveAs(savedPath);

    // Reopening exercises the real verifier: a broken signature refuses to mount.
    await page.goto(`file:///${savedPath.replace(/\\/g, "/")}`);
    const reopened = await appFrame(page);

    const state = await reopened.evaluate(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dai = (window as any).dai;
      const db = await dai.openDatabase();
      return {
        signature: dai.signature as string,
        value: db.selectValue("SELECT v FROM signed_save") as string,
      };
    });

    expect(state.signature).toBe("valid");
    expect(state.value).toBe("kept");
  });
});

test.describe("page size stability", () => {
  test("pins a new database to 4096 and holds it across save and reopen", async ({ page }, testInfo) => {
    await page.goto(CONTAINER_URL);
    const frame = await appFrame(page);

    const [download, before] = await Promise.all([
      page.waitForEvent("download"),
      frame.evaluate(async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const dai = (window as any).dai;
        const db = await dai.openDatabase();
        db.exec("CREATE TABLE geometry(v TEXT)");
        db.exec({ sql: "INSERT INTO geometry(v) VALUES(?)", bind: ["aligned"] });

        const bytes = dai.exportDatabase(db);
        const result = {
          pragma: db.selectValue("PRAGMA page_size") as number,
          header: dai.pageSizeOf(bytes) as number,
          length: bytes.length as number,
        };
        await dai.saveDatabase(db, { method: "download" });
        return result;
      }),
    ]);

    // The engine's own default is 8192; an unpinned database would report that.
    expect(before.pragma).toBe(4096);
    expect(before.header).toBe(4096);
    expect(before.length % 4096).toBe(0);

    const savedPath = testInfo.outputPath("paged.dai.html");
    await download.saveAs(savedPath);

    // The bytes written into the container must declare the same geometry.
    const archive = unzipSync(
      Buffer.from(
        readFileSync(savedPath, "utf8").match(/id="dai-payload">([\s\S]*?)<\/script>/)![1]!.trim(),
        "base64",
      ),
    );
    const stored = Buffer.from(archive["document.sqlite"]!);
    expect(stored.readUInt16BE(16)).toBe(4096);
    expect(stored.length % 4096).toBe(0);

    // And a reopened document must keep it rather than adopting the engine
    // default again, which is exactly the drift that breaks deserialize.
    await page.goto(`file:///${savedPath.replace(/\\/g, "/")}`);
    const reopened = await appFrame(page);

    const after = await reopened.evaluate(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dai = (window as any).dai;
      const db = await dai.openDatabase();
      return {
        seedHeader: dai.pageSizeOf(dai.document) as number,
        pragma: db.selectValue("PRAGMA page_size") as number,
        header: dai.pageSizeOf(dai.exportDatabase(db)) as number,
        value: db.selectValue("SELECT v FROM geometry") as string,
      };
    });

    expect(after.seedHeader).toBe(4096);
    expect(after.pragma).toBe(4096);
    expect(after.header).toBe(4096);
    expect(after.value).toBe("aligned");
  });

  test("honours a seeded database's own page size instead of rewriting it", async ({ page }) => {
    await page.goto(CONTAINER_URL);
    const frame = await appFrame(page);

    // A document carrying 8192-page bytes must open as 8192: the pragma cannot
    // change an existing file, so claiming otherwise would be a silent lie.
    const observed = await frame.evaluate(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dai = (window as any).dai;
      const api = await dai.initSqlite();

      const source = new api.oo1.DB();
      source.exec("PRAGMA page_size=8192");
      source.exec("CREATE TABLE wide(v TEXT)");
      const bytes = api.capi.sqlite3_js_db_export(source.pointer);

      const target = new api.oo1.DB();
      const pointer = api.wasm.allocFromTypedArray(bytes);
      api.capi.sqlite3_deserialize(
        target.pointer,
        "main",
        pointer,
        bytes.length,
        bytes.length,
        api.capi.SQLITE_DESERIALIZE_FREEONCLOSE | api.capi.SQLITE_DESERIALIZE_RESIZEABLE,
      );

      return {
        sourceHeader: dai.pageSizeOf(bytes) as number,
        reopened: target.selectValue("PRAGMA page_size") as number,
      };
    });

    expect(observed.sourceHeader).toBe(8192);
    expect(observed.reopened).toBe(8192);
  });
});

test.describe("app mode", () => {
  test("the shell owns the fullscreen control, not the app", async ({ page }) => {
    await page.goto(CONTAINER_URL);
    const frame = await appFrame(page);

    const button = page.locator("#dai-app-mode");
    await expect(button).toBeVisible();
    await expect(button).toHaveText("Enter App Mode");

    // The frame must not be able to seize the viewport on its own.
    const frameCanFullscreen = await frame.evaluate(
      () => document.fullscreenEnabled === true,
    );
    expect(frameCanFullscreen).toBe(false);

    // The app observes App Mode; it cannot request it.
    const api = await frame.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dai = (window as any).dai;
      return {
        appMode: dai.appMode as boolean,
        canObserve: typeof dai.onAppModeChange === "function",
        cannotRequest: dai.enterAppMode === undefined,
      };
    });
    expect(api).toEqual({ appMode: false, canObserve: true, cannotRequest: true });
  });

  test("entering and leaving fullscreen updates shell and app state", async ({ page }) => {
    await page.goto(CONTAINER_URL);
    const frame = await appFrame(page);

    // Record transitions the app is told about, before any click happens.
    await frame.evaluate(() => {
      const seen: boolean[] = [];
      (window as unknown as { __appMode: boolean[] }).__appMode = seen;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).dai.onAppModeChange((active: boolean) => seen.push(active));
    });

    await page.click("#dai-app-mode");

    await expect(page.locator("body")).toHaveClass(/dai-app-mode/);
    expect(await page.evaluate(() => document.fullscreenElement !== null)).toBe(true);
    await expect
      .poll(() => frame.evaluate(() => (window as unknown as { dai: { appMode: boolean } }).dai.appMode))
      .toBe(true);

    // Leaving by any route must be handled: the listener is on
    // fullscreenchange, not on the click. Headless Chromium does not exit on
    // Escape, so this drives the underlying API a browser's Escape would.
    await page.evaluate(() => document.exitFullscreen());

    await expect(page.locator("body")).not.toHaveClass(/dai-app-mode/);
    await expect(page.locator("#dai-app-mode")).toHaveText("Enter App Mode");
    await expect
      .poll(() => frame.evaluate(() => (window as unknown as { dai: { appMode: boolean } }).dai.appMode))
      .toBe(false);

    expect(await frame.evaluate(() => (window as unknown as { __appMode: boolean[] }).__appMode)).toEqual([
      true,
      false,
    ]);
  });

  test("the app still fills the viewport in app mode", async ({ page }) => {
    await page.goto(CONTAINER_URL);
    await appFrame(page);
    await page.click("#dai-app-mode");
    await expect(page.locator("body")).toHaveClass(/dai-app-mode/);

    // The frame is fixed to the viewport, so fullscreen must not leave letterboxing.
    const fits = await page.evaluate(() => {
      const rect = document.getElementById("dai-app")!.getBoundingClientRect();
      return {
        width: Math.round(rect.width) === window.innerWidth,
        height: Math.round(rect.height) === window.innerHeight,
        controlDisplay: getComputedStyle(document.getElementById("dai-app-mode")!).display,
        controlOpacity: getComputedStyle(document.getElementById("dai-app-mode")!).opacity,
      };
    });

    expect(fits.width).toBe(true);
    expect(fits.height).toBe(true);
    // The exit control stays reachable rather than hiding: Escape is not
    // discoverable, and it is the only other way out.
    expect(fits.controlDisplay).not.toBe("none");
    expect(Number(fits.controlOpacity)).toBeGreaterThan(0);
  });
});

test.describe("host bridge", () => {
  /** Frames the container the way a native host or the runner does. */
  async function frameContainer(page: import("@playwright/test").Page, hostReplies: boolean) {
    // A secure origin, not about:blank. A blob document inherits its creator's
    // origin, and an opaque one has no crypto.subtle — the container would
    // refuse to verify itself and never mount. localhost qualifies; the runner's
    // preview server is already running for the other suites.
    await page.goto("http://localhost:5175/");
    await page.setContent(
      `<iframe id="host-frame" style="width:100%;height:400px"
         sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-downloads"></iframe>`,
    );

    await page.evaluate((replies) => {
      const win = window as unknown as Record<string, unknown>;
      win.__saves = [];
      window.addEventListener("message", (event) => {
        const data = event.data as {
          type?: string;
          payload?: { html?: string; sessionNonce?: string };
        };
        if (data?.type === "DAI_HOST_HANDSHAKE" && replies) {
          // Echoing the value the container invented is what makes this a host
          // rather than a window that happens to be listening. A container
          // ignores an acknowledgement without it, which is the whole point.
          (event.source as Window).postMessage(
            {
              type: "DAI_HOST_HANDSHAKE_ACK",
              payload: { sessionNonce: data.payload?.sessionNonce },
            },
            "*",
          );
        }
        if (data?.type === "DAI_HOST_SAVE") {
          (win.__saves as unknown[]).push(data.payload?.html ?? "");
          if (replies) {
            // Echoing the request id, as a real host does: a reply without it
            // is not this request's reply, and the container waits for one
            // that is.
            (event.source as Window).postMessage(
              { type: "DAI_HOST_SAVE_ACK", status: "ok", requestId: data.requestId },
              "*",
            );
          }
        }
      });
    }, hostReplies);

    const html = readFileSync(CONTAINER, "utf8");
    await page.evaluate((source) => {
      const frame = document.getElementById("host-frame") as HTMLIFrameElement;
      frame.src = URL.createObjectURL(new Blob([source], { type: "text/html" }));
    }, html);

    const frame = page.frameLocator("#host-frame");
    await expect(frame.locator("#dai-app")).toBeAttached({ timeout: 20_000 });
    return page.frames().find((f) => f.url().startsWith("blob:"))!;
  }

  /**
   * The application's frame, one level inside the container.
   *
   * It has to be reached as a frame rather than through `contentWindow`,
   * because the container cannot see into it — the sandbox grants no shared
   * origin, so a property read across that edge throws.
   */
  function appFrame(container: import("@playwright/test").Frame) {
    const child = container.childFrames()[0];
    if (!child) throw new Error("The container mounted no application frame.");
    return child;
  }

  test("routes saves to a host that answered the handshake", async ({ page }) => {
    const container = await frameContainer(page, true);

    // Driven from inside the application's own frame. Reaching in from the
    // shell used to work and no longer can: the frame has no origin in common
    // with the document that mounted it, which is the point of the boundary.
    const app = appFrame(container);
    const result = await app.evaluate(async () =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).dai.saveState(new Uint8Array([1, 2, 3])),
    );

    // The fake host declares no class, so the container takes it for a viewer
    // and says so: a copy was kept, the file was not written.
    expect(result).toEqual({ saved: true, method: "host", inPlace: false });

    // The host must receive a finished container, not raw database bytes:
    // resealing in the host would duplicate the runtime's logic.
    const saved = await page.evaluate(
      () => (window as unknown as { __saves: string[] }).__saves,
    );
    expect(saved).toHaveLength(1);
    expect(saved[0]).toContain('id="dai-payload"');
    expect(saved[0]).toContain("dai-integrity");
  });

  test("falls back to the browser when nothing answers the handshake", async ({ page }) => {
    // The PWA runner and any ordinary embedder frame containers without
    // implementing the host protocol. Being framed is not evidence of a host.
    const container = await frameContainer(page, false);

    const app = appFrame(container);
    const result = await app.evaluate(async () =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).dai.saveState(new Uint8Array([1, 2, 3]), { method: "picker" }),
    );

    // Which browser path runs is engine-specific — Chromium auto-dismisses its
    // picker, Firefox and WebKit have none — so assert what actually matters:
    // the save stayed in the browser and never went to a host.
    expect((result as { saved: boolean }).saved).toBe(false);
    expect((result as { method: string }).method).not.toBe("host");
    const saved = await page.evaluate(
      () => (window as unknown as { __saves: string[] }).__saves,
    );
    expect(saved).toHaveLength(0);
  });
});

test.describe("host bridge hooks", () => {
  /** A host that records what it is told, without acting on any of it. */
  async function observe(page: import("@playwright/test").Page, html: string) {
    await page.goto("http://localhost:5175/");
    await page.setContent(
      `<iframe id="obs" style="width:100%;height:300px"
         sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-downloads"></iframe>`,
    );

    await page.evaluate(() => {
      const win = window as unknown as Record<string, unknown>;
      win.__seen = [];
      window.addEventListener("message", (event) => {
        const data = event.data as { type?: string; payload?: unknown };
        if (typeof data?.type === "string" && data.type.startsWith("DAI_HOST_")) {
          (win.__seen as unknown[]).push({ type: data.type, payload: data.payload });
        }
      });
    });

    await page.evaluate((source) => {
      const frame = document.getElementById("obs") as HTMLIFrameElement;
      frame.src = URL.createObjectURL(new Blob([source], { type: "text/html" }));
    }, html);

    return async () =>
      page.evaluate(() => (window as unknown as { __seen: { type: string; payload: never }[] }).__seen);
  }

  test("reports a refusal instead of leaving the host to guess", async ({ page }) => {
    // Digests recomputed would defeat integrity, so this leaves them stale:
    // the container must refuse itself and say which check failed.
    const original = readFileSync(CONTAINER, "utf8");
    const archive = unzipSync(
      Buffer.from(original.match(/id="dai-payload">([\s\S]*?)<\/script>/)![1]!.trim(), "base64"),
    );
    archive["app/index.html"] = new TextEncoder().encode("<!doctype html><body>tampered");
    const tampered = original.replace(
      /(<script[^>]*id="dai-payload"[^>]*>)[\s\S]*?(<\/script>)/,
      (_m, open: string, close: string) =>
        open + Buffer.from(zipSync(archive, { level: 9 })).toString("base64") + close,
    );

    const seen = await observe(page, tampered);
    await expect.poll(async () => (await seen()).length).toBeGreaterThan(0);

    const messages = await seen();
    const refusal = messages.find((m) => m.type === "DAI_HOST_REFUSED")!;
    expect(refusal).toBeTruthy();
    expect((refusal.payload as { reason: string }).reason).toBe("DIGEST_MISMATCH");
    // Named, so a host can log the document rather than an anonymous failure.
    expect((refusal.payload as { documentUuid: string }).documentUuid).toMatch(/^[0-9a-f]{8}-/);
    expect((refusal.payload as { bridgeVersion: number }).bridgeVersion).toBe(1);

    // A refusal must not be followed by a handshake: the cartridge stopped.
    expect(messages.some((m) => m.type === "DAI_HOST_HANDSHAKE")).toBe(false);
  });

  test("a healthy cartridge handshakes with a bridge version", async ({ page }) => {
    const seen = await observe(page, readFileSync(CONTAINER, "utf8"));
    await expect
      .poll(async () => (await seen()).some((m) => m.type === "DAI_HOST_HANDSHAKE"))
      .toBe(true);

    const handshake = (await seen()).find((m) => m.type === "DAI_HOST_HANDSHAKE")!;
    const payload = handshake.payload as {
      bridgeVersion: number;
      verified: boolean;
      payloadFingerprint: string;
    };

    expect(payload.bridgeVersion).toBe(1);
    expect(payload.verified).toBe(true);
    expect(payload.payloadFingerprint).toMatch(/^[0-9a-f]{64}$/);

    // No refusal from a cartridge that is fine.
    expect((await seen()).some((m) => m.type === "DAI_HOST_REFUSED")).toBe(false);
  });

  test("signals closing when the document goes away", async ({ page }) => {
    const seen = await observe(page, readFileSync(CONTAINER, "utf8"));
    await expect
      .poll(async () => (await seen()).some((m) => m.type === "DAI_HOST_HANDSHAKE"))
      .toBe(true);

    // Navigating the frame away is what a host does when it swaps cartridges.
    await page.evaluate(() => {
      (document.getElementById("obs") as HTMLIFrameElement).src = "about:blank";
    });

    await expect
      .poll(async () => (await seen()).some((m) => m.type === "DAI_HOST_CLOSING"))
      .toBe(true);
  });
});
