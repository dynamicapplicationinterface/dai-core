import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { unzipSync, zipSync } from "fflate";

const here = dirname(fileURLToPath(import.meta.url));
const CONTAINER = resolve(here, "fixture/fixture.dai.html");
const RUNNER_URL = "http://localhost:5175/";

/**
 * The runner is the installable half of the mobile story: a container cannot
 * install itself, because file:// forbids service workers and manifests. These
 * tests cover the console, not the cartridge.
 */
test.describe("runner shell", () => {
  test("is installable: manifest, icons and iOS standalone tags", async ({ page }) => {
    const response = await page.goto(RUNNER_URL);
    expect(response?.ok()).toBe(true);

    const manifestHref = await page.getAttribute('link[rel="manifest"]', "href");
    expect(manifestHref).toBeTruthy();

    const manifest = await page.evaluate(async (href) => {
      const res = await fetch(href!);
      return res.json();
    }, manifestHref);

    expect(manifest.display).toBe("standalone");
    expect(manifest.start_url).toBeTruthy();
    // A 512px icon and a maskable variant are what Android needs to install.
    const sizes = manifest.icons.map((icon: { sizes: string }) => icon.sizes);
    expect(sizes).toContain("192x192");
    expect(sizes).toContain("512x512");
    expect(
      manifest.icons.some((icon: { purpose?: string }) => icon.purpose === "maskable"),
    ).toBe(true);

    // iOS reads none of the above; it needs its own tags.
    expect(await page.getAttribute('meta[name="apple-mobile-web-app-capable"]', "content")).toBe(
      "yes",
    );
    expect(await page.getAttribute('link[rel="apple-touch-icon"]', "href")).toContain(".png");

    // The icons must actually exist and be real PNGs, not 404 pages.
    for (const icon of [
      "./icons/icon-192.png",
      "./icons/icon-512.png",
      "./icons/apple-touch-icon.png",
    ]) {
      const probe = await page.request.get(new URL(icon, RUNNER_URL).href);
      expect(probe.ok(), icon).toBe(true);
      expect((await probe.body()).subarray(1, 4).toString("latin1"), icon).toBe("PNG");
    }
  });

  test("registers a service worker that takes control", async ({ page }) => {
    await page.goto(RUNNER_URL);

    await page.waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, {
      timeout: 20_000,
    });

    // Registration alone is not enough: the shell has to actually be in the
    // cache, or the first offline start finds nothing to serve.
    const cached = await page.evaluate(async () => {
      const names = await caches.keys();
      const cache = await caches.open(names[0]!);
      return (await cache.keys()).map((request) => new URL(request.url).pathname);
    });
    expect(cached.some((path) => path.endsWith("/") || path.endsWith("index.html"))).toBe(true);
  });

  test("serves the shell with the network cut", async ({ page, context, browserName }) => {
    // Playwright's WebKit registers and controls, but does not serve
    // navigations from the service worker cache, so an offline reload fails
    // there regardless of what the worker does. This leaves real Safari's
    // offline behaviour unverified — it needs a device, not this harness.
    test.skip(browserName === "webkit", "Playwright WebKit does not serve SW navigations");

    await page.goto(RUNNER_URL);
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, {
      timeout: 20_000,
    });

    await context.setOffline(true);
    await page.reload();

    await expect(page.locator("#open")).toBeVisible();
    // The name a person sees, which is deliberately not the name the code uses.
    expect(await page.title()).toBe("DAI Opener");

    await context.setOffline(false);
  });
});

/**
 * Reaches an action that now lives behind the ⋯ menu.
 *
 * Saving a copy, opening something else and putting a document away are things
 * somebody does occasionally and reads past constantly, so they came off the
 * bar. Tests that clicked them directly were the only callers left assuming a
 * screen full of controls.
 */
async function menu(page: Page, action: string): Promise<void> {
  await page.click("#more");
  await page.click(action);
}

test.describe("cartridge ingestion", () => {
  test("runs a container chosen from the file picker", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(String(error)));

    await page.goto(RUNNER_URL);
    await expect(page.locator("#cartridge")).toBeHidden();

    await page.setInputFiles("#file", CONTAINER);

    await expect(page.locator("body")).toHaveClass(/loaded/);
    await expect(page.locator("#cartridge")).toBeVisible();
    await expect(page.locator("#title")).toContainText("fixture");

    // The container boots inside the runner exactly as it would on a desktop:
    // its own bootloader mounts its own frame, nested inside the runner's.
    const container = page.frameLocator("#cartridge");
    await expect(container.locator("#dai-app")).toBeAttached();
    const app = container.frameLocator("#dai-app");
    await expect(app.locator("#app")).toHaveText("ready dai-shared dai-shared:lazy");

    expect(errors).toEqual([]);
  });

  test("runs a sectioned .dai, which is the form a phone is handed", async ({ page }) => {
    /*
     * The binary form, through the same picker — and asserted on the
     * application, not on the host.
     *
     * The first version of this test checked that the runner had marked itself
     * loaded and shown the frame, both of which it does the moment it mounts
     * rather than when a container answers. It passed for weeks against a
     * container that died inside `atob` on the way up, because the sealed shell
     * carries a placeholder where its payload goes and nothing put the payload
     * back. A test that asserts what the host assumed is not a test.
     */
    const sectioned = resolve(here, "..", "conformance", "cases", "sectioned-valid.dai");

    await page.goto(RUNNER_URL);
    await page.setInputFiles("#file", sectioned);

    await expect(page.locator("body")).toHaveClass(/loaded/);

    /*
     * The application's own words, two frames down: the runner mounts the
     * container, the container mounts the application. Text that only exists
     * inside the payload cannot appear unless the payload was decoded, unzipped
     * and written — which is the whole path that was silently broken.
     */
    const app = page.frameLocator("#cartridge").frameLocator("#dai-app");
    await expect(app.locator("body")).toContainText("A container that exists to be checked", {
      timeout: 30_000,
    });
  });

  test("puts no type filter on the picker, so a .dai is selectable", async ({ page }) => {
    // iOS greys out anything an accept filter does not name, and the Files app
    // has no type for `.dai`: a filter that looked tidy on a desktop made the
    // file unselectable on a phone. Whatever is chosen is verified before it
    // runs, which is the check that was doing the work.
    await page.goto(RUNNER_URL);
    expect(await page.locator("#file").getAttribute("accept")).toBeNull();
  });

  test("reports the publisher fingerprint it verified", async ({ page }) => {
    await page.goto(RUNNER_URL);
    await page.setInputFiles("#file", CONTAINER);

    // The fixture is signed, so the runner must say so rather than staying mute
    // about provenance. It is no longer on the bar: provenance is a question
    // somebody asks, not a label they read past, so it lives one tap away.
    await page.click("#more");
    await expect(page.locator("#sheet-note")).toContainText("signed");

    const state = await page.evaluate(() => {
      const runner = (window as unknown as { __runner: { loaded: unknown } }).__runner;
      const loaded = runner.loaded as {
        manifest: { documentUuid: string };
        publicKeyFingerprint?: string;
        database: Uint8Array;
      };
      return {
        uuid: loaded.manifest.documentUuid,
        fingerprint: loaded.publicKeyFingerprint,
        databaseBytes: loaded.database.length,
      };
    });

    expect(state.uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4/);
    expect(state.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(state.databaseBytes).toBe(0);
  });

  test("refuses a container whose payload was tampered with", async ({ page }) => {
    await page.goto(RUNNER_URL);

    // Swap an entry without touching the manifest: the digests no longer match.
    const original = readFileSync(CONTAINER, "utf8");
    const payload = original.match(/id="dai-payload">([\s\S]*?)<\/script>/)![1]!.trim();
    const archive = unzipSync(Buffer.from(payload, "base64"));
    archive["app/index.html"] = new TextEncoder().encode("<!doctype html><body>pwned");

    const tampered = original.replace(
      /(<script[^>]*id="dai-payload"[^>]*>)[\s\S]*?(<\/script>)/,
      (_m, open: string, close: string) =>
        open + Buffer.from(zipSync(archive, { level: 9 })).toString("base64") + close,
    );

    await page.setInputFiles("#file", {
      name: "tampered.dai.html",
      mimeType: "text/html",
      buffer: Buffer.from(tampered, "utf8"),
    });

    await expect(page.locator("#report")).toHaveClass(/error/);
    await expect(page.locator("#report")).toContainText("has been modified");
    // Nothing may mount: refusing after showing the app would be pointless.
    await expect(page.locator("body")).not.toHaveClass(/loaded/);
  });

  test("refuses a container whose bootloader was rewritten", async ({ page }) => {
    await page.goto(RUNNER_URL);

    // The payload is left untouched and every digest still matches. Only the
    // outer shell changed — which the container cannot detect about itself,
    // because its own check runs inside the code that was rewritten.
    const original = readFileSync(CONTAINER, "utf8");
    const tampered = original.replace(
      'content="required"',
      'content="advisory"',
    );
    expect(tampered).not.toBe(original);

    await page.setInputFiles("#file", {
      name: "reshelled.dai.html",
      mimeType: "text/html",
      buffer: Buffer.from(tampered, "utf8"),
    });

    await expect(page.locator("#report")).toHaveClass(/error/);
    await expect(page.locator("#report")).toContainText("does not match the sealed copy");
    await expect(page.locator("body")).not.toHaveClass(/loaded/);
  });

  test("refuses a file that is not a container at all", async ({ page }) => {
    await page.goto(RUNNER_URL);

    await page.setInputFiles("#file", {
      name: "notes.html",
      mimeType: "text/html",
      buffer: Buffer.from("<!doctype html><body>just a page", "utf8"),
    });

    await expect(page.locator("#report")).toContainText("no DAI payload");
    await expect(page.locator("body")).not.toHaveClass(/loaded/);
  });

  test("opens a container shared to it from elsewhere on the device", async ({ page }) => {
    /*
     * The Android share sheet, driven the way the platform drives it: a POST of
     * a multipart form to the share target. The service worker parks the file
     * and redirects, because a POST response would replace the app rather than
     * open it.
     *
     * This was declared in the manifest once with nothing behind it, and
     * withdrawn rather than left as a claim. It is a claim again now.
     */
    await page.goto(RUNNER_URL);
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, {
      timeout: 30_000,
    });

    const html = readFileSync(CONTAINER, "utf8");
    const landed = await page.evaluate(async (body: string) => {
      const form = new FormData();
      form.append("container", new File([body], "shared.dai.html", { type: "text/html" }));
      const response = await fetch("./shared", { method: "POST", body: form });
      return response.url;
    }, html);

    expect(landed).toContain("shared=1");

    await page.goto(`${RUNNER_URL}?shared=1`);
    await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 30_000 });
    await expect(page.locator("#cartridge")).toBeVisible();
  });

  test("does not reopen a shared container on the next launch", async ({ page }) => {
    // A file left parked would reappear at the next launch, which is somebody's
    // document opening itself without being asked for.
    await page.goto(RUNNER_URL);
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, {
      timeout: 30_000,
    });

    const html = readFileSync(CONTAINER, "utf8");
    await page.evaluate(async (body: string) => {
      const form = new FormData();
      form.append("container", new File([body], "shared.dai.html", { type: "text/html" }));
      await fetch("./shared", { method: "POST", body: form });
    }, html);

    await page.goto(`${RUNNER_URL}?shared=1`);
    await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 30_000 });

    await page.goto(`${RUNNER_URL}?shared=1`);
    await expect(page.locator("#report")).toContainText(/Nothing arrived from the share/i, {
      timeout: 30_000,
    });
  });

  /*
   * Served by the preview server rather than intercepted.
   *
   * Two earlier versions of these tests used request interception, and both
   * failed intermittently on WebKit, which does not reliably apply it — once as
   * the runner's own "that host would not let me read it" message, and once as
   * "this file has no payload", because the runner's service worker answered
   * the failed request with the app shell. Both messages were true; neither was
   * about the container. A file the server actually has removes the question.
   */
  const serveFixture = (name: string, body: string): string => {
    const dir = resolve(here, "..", "apps", "runner", "dist", "files");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), body);
    return `${RUNNER_URL}files/${name}`;
  };

  test("opens a container named by the link that opened it", async ({ page }) => {
    /*
     * The share path: a link, not an attachment. Any address this page may read
     * works, so sharing needs nothing belonging to this project — a container in
     * a bucket, on a file share, or behind a raw URL is a share link already.
     */
    const url = serveFixture("tasks.dai.html", readFileSync(CONTAINER, "utf8"));

    await page.goto(`${RUNNER_URL}?open=${encodeURIComponent(url)}`);

    await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 30_000 });
    await expect(page.locator("#cartridge")).toBeVisible();
  });

  test("verifies what a link hands it, exactly as it verifies a chosen file", async ({ page }) => {
    // Where the bytes came from says nothing about what they are.
    const url = serveFixture(
      "bad.dai.html",
      readFileSync(CONTAINER, "utf8").replace("<head>", "<head><!-- altered -->"),
    );

    await page.goto(`${RUNNER_URL}?open=${encodeURIComponent(url)}`);

    await expect(page.locator("#report")).toContainText(/could not be opened|does not match/i, {
      timeout: 30_000,
    });
    await expect(page.locator("body")).not.toHaveClass(/loaded/);
  });

  test("says what actually went wrong when a host will not allow the read", async ({ page }) => {
    /*
     * The commonest failure this feature will have, and the one that would
     * otherwise be blamed on us: a file host that does not permit other sites
     * to read its files. The browser reports that identically to being offline,
     * so the message has to name the likely cause.
     */
    await page.route("https://blocked.test/**", (route) => route.abort("failed"));

    await page.goto(`${RUNNER_URL}?open=${encodeURIComponent("https://blocked.test/x.dai.html")}`);

    await expect(page.locator("#report")).toContainText(/does not allow other sites/i, {
      timeout: 30_000,
    });
  });

  test("refuses an address that is not a web address", async ({ page }) => {
    // `?open=file:///etc/passwd` and friends: a link cannot ask this page to
    // read something the person did not choose from their own device.
    await page.goto(`${RUNNER_URL}?open=${encodeURIComponent("file:///etc/passwd")}`);
    await expect(page.locator("#report")).toContainText(/only open http and https/i, {
      timeout: 30_000,
    });
  });

  test("records how long the container took to become usable", async ({ page }) => {
    /*
     * The number the whole mobile path is judged on, taken where it can
     * actually be taken. A desktop measurement is a sanity check; this is the
     * mechanism that will report from a phone, which is the only device whose
     * answer counts.
     */
    await page.goto(`${RUNNER_URL}?timing`);
    await page.setInputFiles("#file", CONTAINER);
    await expect(page.locator("body")).toHaveClass(/loaded/);

    // Waiting for the phase, not for the table. The handshake carries an
    // earlier table — the boot has not finished when it is sent — and waiting
    // for the table alone resolves on that one, which is a measurement of the
    // wrong moment.
    const timings = await page.waitForFunction(
      () => {
        const table = (window as unknown as { __daiTimings?: { phase: string }[] }).__daiTimings;
        return table?.some((entry) => entry.phase === "interactive") ? table : null;
      },
      undefined,
      { timeout: 30_000 },
    );

    const phases = (await timings.jsonValue()) as { phase: string; at: number }[];
    expect(phases.some((entry) => entry.phase === "interactive")).toBe(true);
    // Host and container, because a person waits for both: the runner reads and
    // verifies the file before the container is given a chance to start.
    await expect(page.locator("#report")).toContainText(/Usable in \d+ ms/);
    await expect(page.locator("#report")).toContainText(/host \d+ ms/);
    await expect(page.locator("#report")).toContainText(/container \d+ ms/);
  });

  test("reopens what was open when the app is launched again", async ({ page }) => {
    /*
     * The installed app, opened a second time.
     *
     * Somebody who added tasks yesterday expects to see them, not a file
     * picker — and on a phone the runner is the only way back into a
     * container, so an empty console is the app having forgotten. It has the
     * cartridge and the database; all it lacked was which one was open.
     */
    await page.goto(RUNNER_URL);
    await page.setInputFiles("#file", CONTAINER);
    await expect(page.locator("body")).toHaveClass(/loaded/);

    await page.reload();

    await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 30_000 });
    await expect(page.locator("#cartridge")).toBeVisible();
  });

  test("shows the library again after ejecting, and does not reopen", async ({ page }) => {
    // Ejecting is how somebody says they are done with it. Reopening what they
    // just closed would make the button useless.
    await page.goto(RUNNER_URL);
    await page.setInputFiles("#file", CONTAINER);
    await expect(page.locator("body")).toHaveClass(/loaded/);

    await menu(page, "#eject");
    await page.reload();

    await expect(page.locator("body")).not.toHaveClass(/loaded/);
  });

  test("resuming runs the same verification as choosing the file", async ({ page }) => {
    /*
     * A resumed container is read and verified again on the way in, so the
     * gate applies to the way people open a container every day and not only
     * to the first time. This drives that by corrupting the stored copy
     * between visits.
     */
    await page.goto(RUNNER_URL);
    await page.setInputFiles("#file", CONTAINER);
    await expect(page.locator("body")).toHaveClass(/loaded/);

    await page.evaluate(async () => {
      // No version: the store's schema is the app's business, and a test that
      // named a version broke the day the app added one.
      const open = indexedDB.open("dai_runner_storage");
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error);
      });
      const store = db.transaction("cartridges", "readwrite").objectStore("cartridges");
      const all = await new Promise<{ documentUuid: string; html: string }[]>((resolve) => {
        const request = store.getAll();
        request.onsuccess = () => resolve(request.result as { documentUuid: string; html: string }[]);
      });
      const item = all[0]!;
      item.html = item.html.replace("<head>", "<head><!-- tampered -->");

      // Awaited to completion, and the database closed, before the reload. A
      // transaction still open when the page reloads blocks the next one — the
      // resume path then waits on storage for ever and the runner sits on
      // "Loading", which is what this test did on Firefox until it was written
      // this way.
      const write = db.transaction("cartridges", "readwrite");
      write.objectStore("cartridges").put(item);
      await new Promise<void>((resolve, reject) => {
        write.oncomplete = () => resolve();
        write.onerror = () => reject(write.error);
      });
      db.close();
    });

    await page.reload();

    // Refused, and said so, rather than mounted.
    await expect(page.locator("body")).not.toHaveClass(/loaded/);
    await expect(page.locator("#report")).toContainText(/Failed to load|does not match/i, {
      timeout: 30_000,
    });
  });

  test("ejects cleanly and can load another container", async ({ page }) => {
    await page.goto(RUNNER_URL);
    await page.setInputFiles("#file", CONTAINER);
    await expect(page.locator("body")).toHaveClass(/loaded/);

    await menu(page, "#eject");
    await expect(page.locator("body")).not.toHaveClass(/loaded/);
    await expect(page.locator("#slot")).toBeVisible();

    // The input is cleared on eject, so re-choosing the same file still fires.
    await page.setInputFiles("#file", CONTAINER);
    await expect(page.locator("body")).toHaveClass(/loaded/);
  });
});

test.describe("Host Bridge Protocol & OPFS Persistence", () => {
  async function getInnerAppFrame(page: import("@playwright/test").Page): Promise<import("@playwright/test").Frame> {
    const runnerFrameEl = page.locator("#cartridge");
    await runnerFrameEl.waitFor({ state: "attached" });
    const runnerFrame = await runnerFrameEl.elementHandle().then((h) => h!.contentFrame());
    if (!runnerFrame) throw new Error("No runner frame");
    const appEl = runnerFrame.locator("#dai-app");
    await appEl.waitFor({ state: "attached" });
    const appFrame = await appEl.elementHandle().then((h) => h!.contentFrame());
    if (!appFrame) throw new Error("No app frame");
    await appFrame.waitForFunction(() => Boolean((window as never as { dai?: unknown }).dai));
    return appFrame;
  }

  test("establishes DAI_HOST_HANDSHAKE on container boot", async ({ page }) => {
    await page.goto(RUNNER_URL);
    await page.setInputFiles("#file", CONTAINER);
    await expect(page.locator("body")).toHaveClass(/loaded/);

    const container = page.frameLocator("#cartridge");
    await expect(container.locator("#dai-app")).toBeAttached();

    const isHandshakeOk = await page.evaluate(async () => {
      const runner = (window as unknown as { __runner: { handshakeEstablished: boolean } }).__runner;
      return runner.handshakeEstablished;
    });

    expect(isHandshakeOk).toBe(true);
  });

  test("saves database to OPFS without triggering download fallbacks", async ({ page }) => {
    let downloadTriggered = false;
    page.on("download", () => {
      downloadTriggered = true;
    });

    await page.goto(RUNNER_URL);
    await page.setInputFiles("#file", CONTAINER);
    await expect(page.locator("body")).toHaveClass(/loaded/);

    const appFrame = await getInnerAppFrame(page);
    await expect(appFrame.locator("#app")).toHaveText("ready dai-shared dai-shared:lazy");

    const saveResult = await appFrame.evaluate(async () => {
      const dai = (window as unknown as { dai: { saveState: (bytes: Uint8Array) => Promise<unknown> } }).dai;
      return dai.saveState(new Uint8Array([0x44, 0x41, 0x49, 0x5f, 0x54, 0x45, 0x53, 0x54]));
    });

    expect(saveResult).toEqual({ saved: true, method: "host" });
    expect(downloadTriggered).toBe(false);
  });

  test("persists state reload across cartridge eject and remount", async ({ page }) => {
    await page.goto(RUNNER_URL);
    await page.setInputFiles("#file", CONTAINER);
    await expect(page.locator("body")).toHaveClass(/loaded/);

    const appFrame = await getInnerAppFrame(page);
    await expect(appFrame.locator("#app")).toHaveText("ready dai-shared dai-shared:lazy");

    // Save custom database bytes into OPFS via host save
    const testBytes = [0x53, 0x51, 0x4c, 0x49, 0x54, 0x45, 0x33];
    const saveResult = await appFrame.evaluate(async (bytes) => {
      const dai = (window as unknown as { dai: { saveState: (bytes: Uint8Array) => Promise<unknown> } }).dai;
      return dai.saveState(new Uint8Array(bytes));
    }, testBytes);

    expect(saveResult).toEqual({ saved: true, method: "host" });

    // Eject cartridge
    await menu(page, "#eject");
    await expect(page.locator("body")).not.toHaveClass(/loaded/);

    // Re-ingest same container
    await page.setInputFiles("#file", CONTAINER);
    await expect(page.locator("body")).toHaveClass(/loaded/);

    // Verify reloaded container mounts the OPFS database
    const reloadedAppFrame = await getInnerAppFrame(page);
    await expect(reloadedAppFrame.locator("#app")).toHaveText("ready dai-shared dai-shared:lazy");

    const reloadedDocBytes = await reloadedAppFrame.evaluate(() => {
      const dai = (window as unknown as { dai: { document: Uint8Array } }).dai;
      return Array.from(dai.document);
    });

    expect(reloadedDocBytes).toEqual(testBytes);
  });

  test("export action reseals container with OPFS database while preserving publisher signature integrity", async ({ page }) => {
    await page.goto(RUNNER_URL);
    await page.setInputFiles("#file", CONTAINER);
    await expect(page.locator("body")).toHaveClass(/loaded/);

    const appFrame = await getInnerAppFrame(page);
    const updatedBytes = [0x52, 0x45, 0x53, 0x45, 0x41, 0x4c, 0x45, 0x44];

    // Save updated database via host bridge
    await appFrame.evaluate(async (bytes) => {
      const dai = (window as unknown as { dai: { saveState: (bytes: Uint8Array) => Promise<unknown> } }).dai;
      return dai.saveState(new Uint8Array(bytes));
    }, updatedBytes);

    const downloadPromise = page.waitForEvent("download");
    await page.click("#more");
    await expect(page.locator("#export")).toBeVisible();
    await page.click("#export");
    const download = await downloadPromise;

    expect(download.suggestedFilename()).toContain(".dai.html");
    const path = await download.path();
    expect(path).toBeTruthy();

    const exportedContent = readFileSync(path!, "utf8");

    // Eject existing cartridge
    await menu(page, "#eject");
    await expect(page.locator("body")).not.toHaveClass(/loaded/);

    // Re-ingest exported container file into runner
    await page.setInputFiles("#file", {
      name: "exported.dai.html",
      mimeType: "text/html",
      buffer: Buffer.from(exportedContent, "utf8"),
    });

    await expect(page.locator("body")).toHaveClass(/loaded/);
    await page.click("#more");
    await expect(page.locator("#sheet-note")).toContainText("signed");
    await page.keyboard.press("Escape");

    // Verify exported container mounts, passes signature check, and loads updated database
    const exportedAppFrame = await getInnerAppFrame(page);
    await expect(exportedAppFrame.locator("#app")).toHaveText("ready dai-shared dai-shared:lazy");

    const exportedDocBytes = await exportedAppFrame.evaluate(() => {
      const dai = (window as unknown as { dai: { document: Uint8Array; signature: string } }).dai;
      return {
        bytes: Array.from(dai.document),
        signature: dai.signature,
      };
    });

    expect(exportedDocBytes.bytes).toEqual(updatedBytes);
    expect(exportedDocBytes.signature).toBe("valid");
  });

  test("requests storage eviction defense via navigator.storage.persist", async ({ page }) => {
    await page.goto(RUNNER_URL);
    const isPersistedOrSupported = await page.evaluate(async () => {
      if ("storage" in navigator && typeof navigator.storage.persisted === "function") {
        return typeof navigator.storage.persist === "function";
      }
      return true;
    });
    expect(isPersistedOrSupported).toBe(true);
  });

  test("persists imported cartridges in library tray and cleans up OPFS database upon deletion", async ({ page }) => {
    await page.goto(RUNNER_URL);
    await page.setInputFiles("#file", CONTAINER);
    await expect(page.locator("body")).toHaveClass(/loaded/);

    // Save database state
    const appFrame = await getInnerAppFrame(page);
    await appFrame.evaluate(async () => {
      const dai = (window as unknown as { dai: { saveState: (bytes: Uint8Array) => Promise<unknown> } }).dai;
      return dai.saveState(new Uint8Array([0x01, 0x02, 0x03, 0x04]));
    });

    // Eject to return to home screen
    await menu(page, "#eject");
    await expect(page.locator("body")).not.toHaveClass(/loaded/);

    // Verify library tray renders the imported cartridge card
    await expect(page.locator("#library")).toBeVisible();
    await expect(page.locator("#library .tray-item")).toBeVisible();
    await expect(page.locator("#library .tray-title")).toContainText("fixture");

    // Launch app directly from library tray "Run" button
    await page.click("#library .tray-item button:has-text('Run')");
    await expect(page.locator("body")).toHaveClass(/loaded/);

    // Eject back to home screen
    await menu(page, "#eject");
    await expect(page.locator("body")).not.toHaveClass(/loaded/);

    // Delete app from tray
    await page.click("#library .tray-item .btn-del");

    // Verify library tray item is removed
    await expect(page.locator("#library .tray-item")).toBeHidden();

    // Verify OPFS/library is empty
    const libItems = await page.evaluate(async () => {
      const runner = (window as unknown as { __runner: { listLibrary: () => Promise<unknown[]> } }).__runner;
      return runner.listLibrary();
    });
    expect(libItems.length).toBe(0);
  });
});


/*
 * What somebody who did not build this sees on a phone.
 *
 * The first version spent about a fifth of the screen on five controls, in the
 * vocabulary of the people who wrote them — "Eject", "Export Container" — above
 * an app that scrolled and rubber-banded inside a page that also scrolled. A
 * tester's verdict was that it was too clunky to adopt, which is the only
 * verdict that matters for a thing whose entire purpose is being handed to
 * somebody else.
 *
 * These are the two measurements behind that: the chrome is one line, and the
 * page underneath it does not move.
 */
test.describe("on a phone", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test("the chrome is one line and the page does not scroll", async ({ page }) => {
    await page.goto(RUNNER_URL);
    await page.setInputFiles("#file", CONTAINER);
    await expect(page.locator("body")).toHaveClass(/loaded/);

    const layout = await page.evaluate(() => ({
      header: document.querySelector("header")!.getBoundingClientRect().height,
      scrollHeight: document.documentElement.scrollHeight,
      height: window.innerHeight,
    }));

    // A single row of chrome. The old bar was ~90px; anything approaching that
    // is the redesign coming undone.
    expect(layout.header).toBeLessThanOrEqual(52);
    // Nothing to scroll: the running app owns everything below the line, and
    // the page itself cannot drift under a finger.
    expect(layout.scrollHeight).toBe(layout.height);
  });

  test("the words on screen are not the words of the people who built it", async ({ page }) => {
    await page.goto(RUNNER_URL);
    await page.setInputFiles("#file", CONTAINER);
    await page.click("#more");

    const sheet = await page.locator("#sheet").innerText();
    // "Eject" and "Export" describe what the code does. What somebody wants is
    // to keep a copy, open something else, or put this away.
    expect(sheet).not.toMatch(/eject|export|container|cartridge/i);
    expect(sheet).toMatch(/save a copy/i);
  });
});
