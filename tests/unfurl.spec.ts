import { createReadStream, existsSync, mkdtempSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import middleware from "../apps/runner/middleware.js";
import { compileDirectory } from "../src/compile.js";
import { descriptionOf, documentIdFrom, injectPreview, previewIdFrom } from "../src/unfurl.js";
import { publish, storePreview } from "../src/store.js";
import { fsStore } from "../src/store-fs.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(repo, "apps/runner/dist");

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
};

/** The crawlers that actually fetch a link before a person sees it. */
const CRAWLERS = [
  "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)",
  "Twitterbot/1.0",
  "WhatsApp/2.23.20.0",
  "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
];

test.describe("what a link preview is allowed to say", () => {
  test("a preview names only what the sender consented to show", () => {
    const page = `<head><!--DAI_PREVIEW--><meta property="og:title" content="A DAI app"></head>`;

    // No preview in the sidecar: the document is returned untouched, and the
    // generic tags it already carries are what a crawler reads.
    const none = injectPreview(page, undefined);
    expect(none.html).toBe(page);
    expect(none.html).toContain("A DAI app");
    // Absence is a fact about now, so it is never cached.
    expect(none.cacheControl).toBe("no-store");

    const named = injectPreview(page, { name: "Chore chart", publisherName: "Acme" });
    expect(named.html).toContain(`content="Chore chart"`);
    // The card is the app's: its name, its own line when it has one, and
    // whose it is. Without a line, whose it is stands alone.
    expect(named.html).toContain(`content="Made with DAI"`);
    const described = injectPreview(page, { name: "Chore chart", description: "Who does what, this week" });
    expect(described.html).toContain(`content="Who does what, this week · Made with DAI"`);
    // Content-addressed: these bytes will never mean anything else.
    expect(named.cacheControl).toBe("public, max-age=31536000, immutable");

    // An icon appears only when one was stored.
    expect(injectPreview(page, { name: "x" }, "https://s/i.png").html).not.toContain("og:image");
    expect(injectPreview(page, { name: "x", icon: true }, "https://s/i.png").html).toContain(
      `content="https://s/i.png"`,
    );
  });

  test("a name is somebody's text, and never becomes markup", () => {
    const out = injectPreview(`<!--DAI_PREVIEW-->`, {
      name: `"><script>alert(1)</script>`,
    });
    expect(out.html).not.toContain("<script>");
    expect(out.html).toContain("&quot;&gt;&lt;script&gt;");
  });

  test("an app's own line is read the way the card reads it, and only when it is a line", () => {
    expect(descriptionOf('<head><meta name="description" content="Everything for the beach,  ticked off"></head>')).toBe(
      "Everything for the beach, ticked off",
    );
    // Either attribute order.
    expect(descriptionOf('<meta content="Written the other way round" name="description">')).toBe(
      "Written the other way round",
    );
    expect(descriptionOf("<head><title>Nothing</title></head>")).toBeUndefined();
    // A paragraph is not a line.
    expect(descriptionOf(`<meta name="description" content="${"x".repeat(250)}">`)).toBeUndefined();
  });

  test("only a reference link is a document id", () => {
    const id = "a".repeat(64);
    expect(documentIdFrom(`/d/${id}`)).toBe(id);
    // A card for a document inside its link is the other path, and not this one.
    expect(documentIdFrom(`/p/${id}`)).toBeUndefined();
    expect(previewIdFrom(`/p/${id}`)).toBe(id);
    expect(previewIdFrom(`/d/${id}`)).toBeUndefined();
    expect(previewIdFrom(`/p/${id}/../x`)).toBeUndefined();
    expect(documentIdFrom(`/d/${id.toUpperCase()}`)).toBe(id);
    expect(documentIdFrom("/d/nope")).toBeUndefined();
    expect(documentIdFrom("/")).toBeUndefined();
    // Not a path traversal, not a prefix of something else.
    expect(documentIdFrom(`/d/${id}/../secret`)).toBeUndefined();
  });
});

/**
 * The edge half of backlog 3.3, against the real build and a real store.
 *
 * The middleware is a plain `Request` → `Response` function, so it can be
 * exercised without deploying anything: give it a request for `/d/<id>` on an
 * origin that serves the built opener, with a store beside it.
 */
test.describe("a crawler fetching /d/<id>", () => {
  test.skip(!existsSync(dist), "run `vite build apps/runner` first");

  let opener: Server | undefined;
  let store: Server | undefined;
  let openerOrigin = "";
  let storeOrigin = "";
  let root = "";

  test.beforeAll(async () => {
    opener = createServer((request, response) => {
      const path = decodeURIComponent((request.url ?? "/").split("?")[0]!);
      const rewritten = /^\/[dp]\/[0-9a-f]{64}\/?$/i.test(path) ? "/" : path;
      const file = join(dist, rewritten === "/" ? "index.html" : rewritten.replace(/^\/+/, ""));
      if (!file.startsWith(dist) || !existsSync(file) || statSync(file).isDirectory()) {
        response.writeHead(404).end("not here");
        return;
      }
      response.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
      createReadStream(file).pipe(response);
    });
    await new Promise<void>((ok) => opener!.listen(0, "127.0.0.1", ok));
    openerOrigin = `http://127.0.0.1:${(opener!.address() as { port: number }).port}`;

    root = mkdtempSync(join(tmpdir(), "dai-unfurl-"));
    store = createServer((request, response) => {
      const name = decodeURIComponent((request.url ?? "/").slice(1));
      const file = join(root, name);
      if (!name || !existsSync(file)) {
        response.writeHead(404, { "access-control-allow-origin": "*" }).end();
        return;
      }
      // The opener fetches the blob from another origin, exactly as it does
      // from the real store.
      response.writeHead(200, {
        "content-type": TYPES[extname(file)] ?? "application/octet-stream",
        "access-control-allow-origin": "*",
      });
      createReadStream(file).pipe(response);
    });
    await new Promise<void>((ok) => store!.listen(0, "127.0.0.1", ok));
    storeOrigin = `http://127.0.0.1:${(store!.address() as { port: number }).port}`;
    process.env.DAI_STORE_PUBLIC_BASE = storeOrigin + "/";
  });

  test.afterAll(async () => {
    await new Promise<void>((done) => opener?.close(() => done()));
    await new Promise<void>((done) => store?.close(() => done()));
    delete process.env.DAI_STORE_PUBLIC_BASE;
  });

  async function seal(preview: boolean) {
    const built = await compileDirectory({
      sourceDir: resolve(repo, "examples/packing-list"),
      root: repo,
      appName: "Beach trip",
    });
    return publish(built.html, fsStore({ root, baseUrl: storeOrigin }), openerOrigin, {
      preview,
      icon: preview ? { png: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) } : undefined,
    });
  }

  test("sees the name, never the ciphertext, and always a 200", async () => {
    const { sealed } = await seal(true);

    for (const agent of CRAWLERS) {
      const response = await middleware(
        new Request(`${openerOrigin}/d/${sealed.hash}`, { headers: { "user-agent": agent } }),
      );
      const body = await response.text();

      expect(response.status, agent).toBe(200);
      expect(body, agent).toContain(`content="Beach trip"`);
      expect(body, agent).toContain(`${sealed.hash}.png`);
      expect(response.headers.get("cache-control")).toContain("immutable");

      // The one thing a preview must never contain. The blob is the document,
      // and no request the middleware makes is for it.
      const ciphertext = Buffer.from(sealed.blob).toString("base64");
      expect(body).not.toContain(ciphertext.slice(0, 64));
      expect(body).not.toContain(sealed.key);
    }
  });

  test("a document inside its link gets a card of its own, and losing the card loses nothing else", async () => {
    // Nothing of the document reaches the store: a preview under a random id,
    // beside no blob, is all that is written.
    const built = await compileDirectory({
      sourceDir: resolve(repo, "examples/packing-list"),
      root: repo,
      appName: "Beach trip",
    });
    const card = await storePreview(built.html, fsStore({ root, baseUrl: storeOrigin }), {
      icon: { png: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) },
    });
    expect(card.id).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(join(root, card.id))).toBe(false);
    expect(existsSync(join(root, `${card.id}.json`))).toBe(true);
    expect(card.sidecar).toMatchObject({ size: 0, inline: true, preview: { name: "Beach trip", icon: true } });
    expect(card.sidecar.preview?.description).toContain("beach");

    const response = await middleware(
      new Request(`${openerOrigin}/p/${card.id}`, { headers: { "user-agent": CRAWLERS[0]! } }),
    );
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain(`content="Beach trip"`);
    expect(body).toContain("Made with DAI");
    expect(body).toContain(`${card.id}.png`);

    // A card the store no longer holds is only a card: the document is in the
    // link and opens as it always did, so this is never "expired".
    const gone = await middleware(
      new Request(`${openerOrigin}/p/${"e".repeat(64)}`, { headers: { "user-agent": CRAWLERS[0]! } }),
    );
    const generic = await gone.text();
    expect(gone.status).toBe(200);
    expect(generic).not.toContain("expired");
    expect(generic).toContain("A DAI app");
  });

  test("a sidecar of the wrong shape is no preview, and the link still opens", async () => {
    // A sidecar is a public object written by whoever stored the document.
    // One that says the name is a number once stopped the page being served
    // at all; now it is simply not a preview.
    const { writeFileSync } = await import("node:fs");
    const hash = "c".repeat(64);
    writeFileSync(join(root, `${hash}.json`), JSON.stringify({ size: 10, preview: { name: 42, icon: "yes" } }), "utf8");
    const response = await middleware(
      new Request(`${openerOrigin}/d/${hash}`, { headers: { "user-agent": CRAWLERS[0]! } }),
    );
    expect(response.status).toBe(200);
    const body = await response.text();
    // No preview was built, so nothing the sidecar said reaches the page.
    // Asked of the tags rather than of the whole document: the opener's own
    // stylesheet is entitled to contain the digits 4 and 2 next to each other.
    expect(body).not.toMatch(/<meta property="og:[a-z]+" content="[^"]*42/);
    expect(body).not.toMatch(/<title>[^<]*42/);
    expect(body).toContain("<!doctype html>".slice(0, 9));
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  test("a store refuses an icon it would have to serve as an asset", async () => {
    const { compileDirectory } = await import("../src/compile.js");
    const built = await compileDirectory({
      sourceDir: resolve(repo, "examples/packing-list"),
      root: repo,
      appName: "Beach trip",
    });
    const store = fsStore({ root, baseUrl: storeOrigin });

    // Over the cap: a preview icon is a caption, not a payload.
    await expect(
      publish(built.html, store, openerOrigin, {
        preview: true,
        icon: { png: new Uint8Array(200 * 1024) },
      }),
    ).rejects.toMatchObject({ code: "STORE_REFUSED" });

    // An icon nothing claims would be a file the store serves and nothing
    // references.
    await expect(
      publish(built.html, store, openerOrigin, { icon: { png: new Uint8Array(8) } }),
    ).rejects.toMatchObject({ code: "STORE_REFUSED" });
  });

  test("says nothing about a document whose sender did not consent", async () => {
    const { sealed } = await seal(false);
    const response = await middleware(new Request(`${openerOrigin}/d/${sealed.hash}`));
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).not.toContain("Beach trip");
    expect(body).toContain("A DAI app");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  test("an id the store has never held still opens", async () => {
    const response = await middleware(new Request(`${openerOrigin}/d/${"b".repeat(64)}`));
    const body = await response.text();

    // Not a 404: the opener says what happened far better than an error page.
    expect(response.status).toBe(200);
    expect(body).toContain("expired");
    // A store that does not hold it today may hold it tomorrow.
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  test("the browser still opens the document the middleware previewed", async ({ page }) => {
    test.slow();
    const { sealed } = await seal(true);
    const link =
      `${openerOrigin}/d/${sealed.hash}` +
      `#h=${sealed.hash}&u=${encodeURIComponent(`${storeOrigin}/${sealed.hash}`)}&k=${sealed.key}`;

    await page.goto(link);
    // The fragment is what the server never saw, and it is still here.
    expect(await page.evaluate(() => location.hash)).toContain(sealed.key);
    await page.locator("#card-open").click({ timeout: 60_000 });
    await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });
    await expect(page.locator("#title")).toContainText("Beach trip");
  });
});
