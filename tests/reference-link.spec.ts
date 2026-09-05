import { createReadStream, existsSync, mkdtempSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { compileDirectory } from "../src/compile.js";
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
    const wrong = sealed.key.slice(0, -1) + (sealed.key.endsWith("A") ? "B" : "A");

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

    // A sidecar whose manifest was edited: the signature no longer verifies,
    // and a store that took it would be a file host.
    const forged: Sidecar = {
      ...sealed.sidecar,
      manifest: { ...sealed.sidecar.manifest, appName: "Payroll Portal" },
    };
    await expect(store.put(sealed.hash, sealed.blob, forged)).rejects.toMatchObject({ code: "UNVERIFIED_SIGNATURE" });

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
