import { createReadStream, existsSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { compileDirectory } from "../src/compile.js";
import { openFile } from "./open.js";
import { ContainerError, verifyContainer } from "../src/container.js";
import { openFromStore, publish, referenceFrom, sealForStore, type Sidecar } from "../src/store.js";
import { fsStore } from "../src/store-fs.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const KEY = resolve(repo, "conformance", "signing-key.pem");
const RUNNER_URL = "http://localhost:5175/";

/**
 * A store that knows nothing.
 *
 * The blob is ciphertext under the hash of the ciphertext; the key is in the
 * fragment, which no browser sends. So the store can count and measure and can
 * neither read a document, connect a blob to a link, nor substitute one — the
 * hash is checked before the key is touched, and the signature inside after.
 *
 * These serve one directory from two different origins to prove the link is
 * about the content and not the host, log every request to prove the fragment
 * never arrives, and tamper with a blob to prove the hash is what refuses it.
 */
async function serve(root: string, log: string[]): Promise<{ server: Server; origin: string }> {
  const server = createServer((request, response) => {
    log.push(request.url ?? "");
    const name = decodeURIComponent((request.url ?? "/").split("?")[0]!.slice(1));
    const file = join(root, name);
    if (!name || !existsSync(file) || statSync(file).isDirectory()) {
      response.writeHead(404, { "access-control-allow-origin": "*" }).end();
      return;
    }
    response.writeHead(200, {
      "content-type": name.endsWith(".json") ? "application/json" : "application/octet-stream",
      "access-control-allow-origin": "*",
      "cache-control": "public, max-age=31536000, immutable",
    });
    createReadStream(file).pipe(response);
  });
  await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
  const address = server.address();
  return { server, origin: `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}` };
}

async function chart(signed = true) {
  return compileDirectory({
    sourceDir: resolve(repo, "examples/chore-chart"),
    root: repo,
    appName: "Chore chart",
    signingKey: signed ? KEY : undefined,
    allowTestKey: true,
  });
}

test.describe("a document sealed for a store", () => {
  test("the store holds ciphertext, and the hash names it", async () => {
    const built = await chart();
    const sealed = await sealForStore(built.html);

    // Not the document, not any recognisable part of it.
    const text = new TextDecoder().decode(sealed.blob);
    expect(text).not.toContain("dai-payload");
    expect(text).not.toContain("Chore chart");
    // Thin: the engine stays with the opener, not with every blob.
    expect(sealed.blob.length).toBeLessThan(200 * 1024);
    expect(sealed.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(sealed.key).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // And it opens back into the document, which verifies as it did.
    const html = await openFromStore(sealed.blob, sealed.hash, sealed.key);
    const parsed = await verifyContainer(html, {
      supply: await (async () => {
        const { readFileSync } = await import("node:fs");
        const { sha256Hex } = await import("../src/core.js");
        const held = new Map<string, Uint8Array>();
        for (const file of ["sqlite3.wasm", "index.mjs"]) {
          const bytes = new Uint8Array(readFileSync(resolve(repo, "node_modules/@sqlite.org/sqlite-wasm/dist", file)));
          held.set(await sha256Hex(bytes), bytes);
        }
        return (digest: string) => held.get(digest);
      })(),
    });
    expect(parsed.signature).toBe("valid");
    expect(parsed.manifest.documentUuid).toBe(built.manifest.documentUuid);
  });

  test("two seals of one document are two different blobs", async () => {
    // A fresh key each time, so a store holding both cannot tell they are the
    // same document — and nobody can tell from a hash who has what.
    const built = await chart();
    const [a, b] = await Promise.all([sealForStore(built.html), sealForStore(built.html)]);
    expect(a.hash).not.toBe(b.hash);
    expect(a.key).not.toBe(b.key);
  });

  test("a tampered blob is refused by hash, before anything is decrypted", async () => {
    const built = await chart();
    const sealed = await sealForStore(built.html);
    const tampered = new Uint8Array(sealed.blob);
    tampered[tampered.length - 1] ^= 1;

    const refusal = await openFromStore(tampered, sealed.hash, sealed.key).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(ContainerError);
    expect((refusal as ContainerError).code).toBe("BLOB_MISMATCH");
  });

  test("a wrong key is refused as the key's fault, not the store's", async () => {
    const built = await chart();
    const sealed = await sealForStore(built.html);
    /*
     * The first character, not the last. A 32-byte key is 43 base64url
     * characters, and the last one carries two key bits and four of padding:
     * flipping it from A to B changed only padding, decoded to the same key,
     * decrypted successfully, and failed this test for one key in sixteen.
     */
    const wrong = (sealed.key.startsWith("A") ? "B" : "A") + sealed.key.slice(1);

    const refusal = await openFromStore(sealed.blob, sealed.hash, wrong).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(ContainerError);
    expect((refusal as ContainerError).code).toBe("BLOB_UNDECRYPTABLE");
  });

  test("a store admits only what it can check is a document", async () => {
    const built = await chart();
    const sealed = await sealForStore(built.html);
    const store = fsStore({ root: mkdtempSync(join(tmpdir(), "dai-store-")) });

    // The honest put succeeds and is idempotent.
    const href = await store.put(sealed.hash, sealed.blob, sealed.sidecar);
    expect(await store.put(sealed.hash, sealed.blob, sealed.sidecar)).toBe(href);
    expect((await store.head(href)).exists).toBe(true);

    // The sidecar says nothing a stranger may not read: no manifest, no
    // identity, no key. A review found the whole manifest sitting at a public
    // URL with the preview off — name, publisher, generating model, dates.
    expect(Object.keys(sealed.sidecar).sort()).toEqual(["size"]);
    const unfurled = await sealForStore(built.html, { preview: true });
    expect(Object.keys(unfurled.sidecar).sort()).toEqual(["preview", "size"]);
    expect(JSON.stringify(unfurled.sidecar)).not.toMatch(/documentUuid|publicKey|hashes|generator/);

    // A preview that is a payload rather than a caption.
    const stuffed: Sidecar = { ...unfurled.sidecar, preview: { name: "x".repeat(201) } };
    await expect(store.put(sealed.hash, sealed.blob, stuffed)).rejects.toMatchObject({ code: "STORE_REFUSED" });

    // A size that disagrees with the blob.
    await expect(
      store.put(sealed.hash, sealed.blob, { ...sealed.sidecar, size: sealed.sidecar.size + 1 }),
    ).rejects.toMatchObject({ code: "STORE_REFUSED" });

    // Bytes stored under a name they do not hash to.
    await expect(store.put("0".repeat(64), sealed.blob, sealed.sidecar)).rejects.toMatchObject({
      code: "STORE_REFUSED",
    });
  });

  test("the link grammar is read strictly", () => {
    const h = "a".repeat(64);
    const k = "A".repeat(43);
    expect(referenceFrom(`/d/${h}`, "", `#h=${h}&k=${k}`)).toEqual({ hash: h, key: k });
    expect(referenceFrom("/", "?d=" + h, `#h=${h}&k=${k}`)).toEqual({ hash: h, key: k });
    expect(referenceFrom("/", "", `#h=${h}&u=${encodeURIComponent("https://s.example/x")}&k=${k}`)).toEqual({
      hash: h,
      key: k,
      url: "https://s.example/x",
    });
    // A path that disagrees with the fragment is not trusted on either.
    expect(referenceFrom(`/d/${"b".repeat(64)}`, "", `#h=${h}&k=${k}`)).toBeUndefined();
    // Short keys, non-hex hashes, non-http stores: not a reference link.
    expect(referenceFrom("/", "", `#h=${h}&k=short`)).toBeUndefined();
    expect(referenceFrom("/", "", `#h=nothex&k=${k}`)).toBeUndefined();
    expect(referenceFrom("/", "", `#h=${h}&u=${encodeURIComponent("file:///etc/passwd")}&k=${k}`)).toBeUndefined();
    expect(referenceFrom("/", "", "#a=abc")).toBeUndefined();
  });
});

test.describe("a reference link, opened", () => {
  test("resolves from two different hosts, and the fragment reaches neither", async ({ page }) => {
    test.slow();

    const built = await chart();
    const root = mkdtempSync(join(tmpdir(), "dai-store-"));
    const logA: string[] = [];
    const logB: string[] = [];
    const a = await serve(root, logA);
    const b = await serve(root, logB);
    try {
      // Published once, to one directory, and named by content: the same
      // document is at both origins without anything being republished.
      const { sealed, links } = await publish(built.html, fsStore({ root, baseUrl: a.origin }), RUNNER_URL);
      expect(links.anyHost).toContain(`#h=${sealed.hash}`);

      const linkVia = (origin: string) =>
        `${RUNNER_URL}#h=${sealed.hash}&u=${encodeURIComponent(`${origin}/${sealed.hash}`)}&k=${sealed.key}`;

      // First host, first sighting: the card, then the document.
      await page.goto(linkVia(a.origin));
      await page.locator("#card-open").click({ timeout: 60_000 });
      await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });
      await expect(page.locator("#title")).toContainText("Chore chart");
      await page.click("#more");
      await page.locator("#eject").click();

      // Second host, same document: kept here now, under the same key, so it
      // opens with no card — the 1.2 rule holding across a carrier the
      // document did not arrive by the first time.
      await page.goto("about:blank");
      await page.goto(linkVia(b.origin));
      await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });
      await expect(page.locator("#title")).toContainText("Chore chart");
      await expect(page.locator("#card")).toBeHidden();

      // The store's logs. The path is the hash; the fragment never left the
      // browser, and neither did the key.
      for (const line of [...logA, ...logB]) {
        expect(line).not.toContain("k=");
        expect(line).not.toContain("#");
        expect(line).not.toContain(sealed.key);
      }
      expect(logA.length).toBeGreaterThan(0);
      expect(logB.length).toBeGreaterThan(0);
    } finally {
      await new Promise<void>((done) => a.server.close(() => done()));
      await new Promise<void>((done) => b.server.close(() => done()));
    }
  });

  test("a blob the store has changed is refused, and says the store did it", async ({ page }) => {
    test.slow();
    const built = await chart();
    const root = mkdtempSync(join(tmpdir(), "dai-store-"));
    const log: string[] = [];
    const { server, origin } = await serve(root, log);
    try {
      const { sealed } = await publish(built.html, fsStore({ root, baseUrl: origin }), RUNNER_URL);
      // Somebody with write access to the store swaps the bytes.
      const { readFileSync, writeFileSync } = await import("node:fs");
      const stored = new Uint8Array(readFileSync(join(root, sealed.hash)));
      stored[40] ^= 0xff;
      writeFileSync(join(root, sealed.hash), stored);

      await page.goto(`${RUNNER_URL}#h=${sealed.hash}&u=${encodeURIComponent(`${origin}/${sealed.hash}`)}&k=${sealed.key}`);
      await expect(page.locator("#report")).toContainText(/store has been changed|not what this link names/i, {
        timeout: 60_000,
      });
      await expect(page.locator("body")).not.toHaveClass(/loaded/);
      await expect(page.locator("#card")).toBeHidden();
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
    }
  });
});

/**
 * A link that names a document and cannot open one (backlog 3.4).
 *
 * The key is after the `#`, which is the half that does not survive being
 * retyped, screenshotted, shortened, or pasted through a tool that strips
 * fragments. Nothing can recover it — it was never sent to a server — so what
 * the opener owes is a sentence, not the empty chooser.
 */
test.describe("a link with the fragment stripped", () => {
  test("is told apart from a link that was never a reference at all", async () => {
    const { strippedReference } = await import("../src/store.js");
    const id = "a".repeat(64);
    const key = "A".repeat(43);

    expect(strippedReference(`/d/${id}`, "", "")).toEqual({ named: id, missing: "key" });
    expect(strippedReference("/", "?d=" + id, "")).toEqual({ named: id, missing: "key" });
    expect(strippedReference("/", "", `#h=${id}`)).toEqual({ named: id, missing: "key" });
    expect(strippedReference("/", "", `#k=${key}`)).toEqual({ missing: "document" });

    // A whole link is not a stripped one, and the opener opens it.
    expect(strippedReference(`/d/${id}`, "", `#h=${id}&k=${key}`)).toBeUndefined();
    // Nothing here was ever a reference link.
    expect(strippedReference("/", "", "")).toBeUndefined();
    expect(strippedReference("/", "", "#handoff")).toBeUndefined();
    expect(strippedReference("/d/nope", "", "")).toBeUndefined();
  });

  test("says what is missing and who can fix it, instead of a blank chooser", async ({ page }) => {
    test.slow();
    const built = await chart();
    const root = mkdtempSync(join(tmpdir(), "dai-store-"));
    const a = await serve(root, []);
    try {
      const { sealed } = await publish(built.html, fsStore({ root, baseUrl: a.origin }), RUNNER_URL);

      // The whole link, minus everything after the #: what a screenshot, a
      // link wrapper, or a retype leaves behind.
      await page.goto(`${RUNNER_URL}?d=${sealed.hash}`);
      const said = page.locator("#report");
      await expect(said).toContainText("missing the part that opens it");
      await expect(said).toContainText("ask whoever sent it");
      await expect(said).toHaveClass(/error/);
      // Not the empty chooser dressed up as a working app.
      await expect(page.locator("body")).not.toHaveClass(/loaded/);

      // A key with nothing to open is the other half of the same mistake.
      await page.goto(`${RUNNER_URL}#k=${sealed.key}`);
      await expect(said).toContainText("does not say which document");
    } finally {
      await new Promise<void>((done) => a.server.close(() => done()));
    }
  });
});

/**
 * The icon a home screen gets, for a document that arrived by link (3.5).
 *
 * An icon has to launch into something. `?doc=<uuid>` finds a document this
 * device already keeps — the right answer once it does, and nothing at all on
 * a device that has been reset, had its storage evicted, or where somebody
 * added the icon and opened it a week later. That icon opens on an empty
 * chooser, which is the failure iOS made loudest because it is the platform
 * with no other way in.
 *
 * A link is the document: it says where the bytes are and carries the key in
 * its fragment, so an icon built from one fetches it again and then runs
 * offline. The fragment is kept by the browser and never sent to a server, so
 * the property that makes the link private is the one that makes it safe on a
 * home screen.
 */
test.describe("the home-screen icon for a document that came by link", () => {
  test("launches into the link, fragment and all", async ({ page }) => {
    test.slow();

    const built = await chart();
    const root = mkdtempSync(join(tmpdir(), "dai-store-"));
    const a = await serve(root, []);
    try {
      const { sealed } = await publish(built.html, fsStore({ root, baseUrl: a.origin }), RUNNER_URL);
      const link =
        `${RUNNER_URL}#h=${sealed.hash}` +
        `&u=${encodeURIComponent(`${a.origin}/${sealed.hash}`)}&k=${sealed.key}`;

      await page.goto(link);
      await page.locator("#card-open").click({ timeout: 60_000 });
      await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });

      // The page describes the document asynchronously — it renders an icon
      // and puts it in a cache first — so wait for it rather than racing it.
      await page.waitForFunction(
        () =>
          document.querySelector('link[rel="manifest"]')?.getAttribute("href")?.startsWith("data:"),
        undefined,
        { timeout: 60_000 },
      );

      const manifest = await page.evaluate(() => {
        const tag = document.querySelector('link[rel="manifest"]') as HTMLLinkElement | null;
        const href = tag?.getAttribute("href") ?? "";
        return href.startsWith("data:")
          ? (JSON.parse(decodeURIComponent(href.slice(href.indexOf(",") + 1))) as {
              start_url: string;
              id: string;
            })
          : null;
      });

      expect(manifest, "a document on screen should describe itself").toBeTruthy();
      // The whole link, key included — not ?doc=, which needs this device to
      // already hold the document.
      expect(manifest!.start_url).toContain(`k=${sealed.key}`);
      expect(manifest!.start_url).toContain(`h=${sealed.hash}`);
      expect(manifest!.start_url).not.toContain("?doc=");
      expect(manifest!.id).toContain(built.manifest.documentUuid);
    } finally {
      await new Promise<void>((done) => a.server.close(() => done()));
    }
  });

  test("a document that came as a file gets the icon a file can have", async ({ page }) => {
    test.slow();
    const built = await chart();
    const root = mkdtempSync(join(tmpdir(), "dai-file-"));
    const file = join(root, "chart.dai.html");
    writeFileSync(file, built.html, "utf8");

    await page.goto(RUNNER_URL);
    await openFile(page, file);
    await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });

    await page.waitForFunction(
      () =>
        document.querySelector('link[rel="manifest"]')?.getAttribute("href")?.startsWith("data:"),
      undefined,
      { timeout: 60_000 },
    );

    const start = await page.evaluate(() => {
      const href = document.querySelector('link[rel="manifest"]')?.getAttribute("href") ?? "";
      return href.startsWith("data:")
        ? (JSON.parse(decodeURIComponent(href.slice(href.indexOf(",") + 1))) as { start_url: string })
            .start_url
        : "";
    });

    // No link to point at, so the honest answer: the document this device
    // keeps, by its identity.
    expect(start).toContain("doc=");
    expect(start).not.toContain("k=");
  });
});

/**
 * A store that holds documents it can read (backlog 3.4, decided).
 *
 * Off everywhere by default and off on the public relay permanently. It exists
 * for one deployment: a store inside a perimeter that already controls who
 * reaches it, where the operator would rather hold documents they can read
 * than hold keys they cannot lose.
 *
 * Three things make that safe to offer at all. The store has to be configured
 * for it, so the choice is made once by whoever runs it and never by whoever
 * is uploading. The link says so explicitly, so a link that merely lost its
 * fragment can never be mistaken for one claiming plaintext. And the card says
 * so to the person opening it, who made none of these choices.
 */
test.describe("a document a store was allowed to read", () => {
  test("a store refuses it unless its operator turned that on", async () => {
    const built = await chart();
    const root = mkdtempSync(join(tmpdir(), "dai-clear-"));

    // The default, and what the public relay is.
    await expect(
      publish(built.html, fsStore({ root }), RUNNER_URL, { clear: true }),
    ).rejects.toMatchObject({ code: "STORE_REFUSED" });

    // A store whose operator decided otherwise.
    const { sealed, links } = await publish(
      built.html,
      fsStore({ root, allowClear: true }),
      RUNNER_URL,
      { clear: true },
    );

    // No key, because there is nothing to unlock; and the link says which it
    // is rather than leaving it to be inferred from an absence.
    expect(sealed.key).toBe("");
    expect(links.known).toContain("&c=1");
    expect(links.known).not.toContain("k=");

    // The bytes are the document. The hash still names them, so what it is has
    // still been checked — only who can read it has changed.
    expect(new TextDecoder().decode(sealed.blob)).toContain("dai-payload");
  });

  test("the grammar tells a clear link from a damaged one", async () => {
    const { referenceFrom, strippedReference } = await import("../src/store.js");
    const id = "a".repeat(64);
    const key = "A".repeat(43);

    // Said outright: opened, and flagged.
    expect(referenceFrom(`/d/${id}`, "", `#h=${id}&c=1`)).toEqual({ hash: id, key: "", clear: true });
    expect(strippedReference(`/d/${id}`, "", `#h=${id}&c=1`)).toBeUndefined();

    // Merely missing: still damaged, still caught before any fetch. This is
    // the case that must never be read as "not encrypted".
    expect(referenceFrom(`/d/${id}`, "", `#h=${id}`)).toBeUndefined();
    expect(strippedReference(`/d/${id}`, "", `#h=${id}`)).toEqual({ named: id, missing: "key" });

    // Both at once is a link nobody could have meant.
    expect(referenceFrom(`/d/${id}`, "", `#h=${id}&k=${key}&c=1`)).toBeUndefined();
  });

  test("the card says so, to the person who did not choose it", async ({ page }) => {
    test.slow();
    const built = await chart();
    const root = mkdtempSync(join(tmpdir(), "dai-clear-open-"));
    const a = await serve(root, []);
    try {
      const { sealed } = await publish(
        built.html,
        fsStore({ root, baseUrl: a.origin, allowClear: true }),
        RUNNER_URL,
        { clear: true },
      );
      const link =
        `${RUNNER_URL}#h=${sealed.hash}` +
        `&u=${encodeURIComponent(`${a.origin}/${sealed.hash}`)}&c=1`;

      await page.goto(link);
      const said = page.locator("#card-clear");
      await expect(said).toBeVisible({ timeout: 60_000 });
      await expect(said).toContainText("without encryption");
      await expect(said).toContainText("could read it");

      // It still opens, and it is still the document it says it is.
      await page.locator("#card-open").click();
      await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });
      await expect(page.locator("#title")).toContainText("Chore chart");
    } finally {
      await new Promise<void>((done) => a.server.close(() => done()));
    }
  });

  test("an ordinary encrypted document says nothing about encryption", async ({ page }) => {
    test.slow();
    const built = await chart();
    const root = mkdtempSync(join(tmpdir(), "dai-sealed-"));
    const a = await serve(root, []);
    try {
      const { sealed } = await publish(built.html, fsStore({ root, baseUrl: a.origin }), RUNNER_URL);
      await page.goto(
        `${RUNNER_URL}#h=${sealed.hash}&u=${encodeURIComponent(`${a.origin}/${sealed.hash}`)}&k=${sealed.key}`,
      );
      await expect(page.locator("#card-open")).toBeVisible({ timeout: 60_000 });
      // The normal case is silent. A notice on every card is a notice nobody reads.
      await expect(page.locator("#card-clear")).toBeHidden();
    } finally {
      await new Promise<void>((done) => a.server.close(() => done()));
    }
  });
});
