import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { compileDirectory } from "../src/compile.js";
import { verifyContainer } from "../src/container.js";
import { toBase64 } from "../src/core.js";
import {
  foldName,
  publisherState,
  recordPublisher,
  safetyNumber,
  type PublisherPin,
  type PublisherStore,
} from "../src/publisher.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER_URL = "http://localhost:5175/";

/** A fresh P-256 key as the PEM the compiler takes. */
async function pem(): Promise<string> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const body = toBase64(pkcs8).replace(/(.{64})/g, "$1\n");
  return `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`;
}

/** A signed document under a name. Each call is a new document. */
async function signed(key: string, publisherName: string, appName = "Ledger") {
  const source = mkdtempSync(join(tmpdir(), "dai-pub-"));
  writeFileSync(join(source, "index.html"), `<!doctype html><meta charset="utf-8"><p>${appName}</p>`, "utf8");
  const keyFile = join(source, "key.pem");
  writeFileSync(keyFile, key, "utf8");
  const built = await compileDirectory({ sourceDir: source, root: repo, appName, signingKey: keyFile, publisherName });
  return { html: built.html, file: { name: `${appName}.dai.html`, mimeType: "text/html", buffer: Buffer.from(built.html, "utf8") } };
}

function memoryStore(): PublisherStore {
  const pins = new Map<string, PublisherPin>();
  return {
    async byKey(publicKey) {
      return pins.get(publicKey) ?? null;
    },
    async byFoldedName(folded) {
      return [...pins.values()].filter((p) => p.folded === folded);
    },
    async save(pin) {
      pins.set(pin.publicKey, pin);
    },
  };
}

/**
 * A publisher who is somebody.
 *
 * Trust on first use catches a second copy of a document signed by somebody
 * else, and says nothing about a new document — "Acme Finance" arriving for
 * the first time looks the same whether it is Acme Finance or a stranger who
 * typed the name. Remembering publishers rather than documents closes that as
 * far as a device can: known, new, or a name it knows under a key it does not.
 */
test.describe("a name, folded to what the eye compares", () => {
  test("case, spacing and punctuation do not make a different name", () => {
    expect(foldName("Acme Finance")).toBe("acmefinance");
    expect(foldName("ACME  FINANCE.")).toBe("acmefinance");
    expect(foldName("acme-finance")).toBe("acmefinance");
    expect(foldName("Acme Finance™")).toBe("acmefinancetm");
  });

  test("lookalike letters and digits fold to the letters they imitate", () => {
    // Cyrillic а, е, о; Greek ο; the digits people use as letters.
    expect(foldName("Acme Finаnce")).toBe("acmefinance");
    expect(foldName("Аcmе Finance")).toBe("acmefinance");
    expect(foldName("Acme Financе")).toBe("acmefinance");
    expect(foldName("Acme F1nance")).toBe("acmeflnance");
    expect(foldName("Acm3 Finance")).toBe("acmefinance");
    // And a genuinely different name stays different.
    expect(foldName("Acme Bank")).not.toBe(foldName("Acme Finance"));
  });

  test("a safety number is six groups of five digits, and the same for the same key", async () => {
    const one = await safetyNumber("MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE");
    expect(one).toMatch(/^\d{5}( \d{5}){5}$/);
    expect(await safetyNumber("MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE")).toBe(one);
    expect(await safetyNumber("MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAF")).not.toBe(one);
  });
});

test.describe("the three states, decided", () => {
  test("new, then known with a count, then a rename under the same key", async () => {
    test.slow();
    const store = memoryStore();
    const key = await pem();

    const first = await verifyContainer((await signed(key, "Acme Finance", "Ledger")).html);
    expect(await publisherState(store, first)).toMatchObject({ state: "new", name: "Acme Finance" });
    await recordPublisher(store, first);

    const second = await verifyContainer((await signed(key, "Acme Finance", "Payroll")).html);
    expect(await publisherState(store, second)).toMatchObject({ state: "known", name: "Acme Finance", count: 1 });
    await recordPublisher(store, second);

    // Opening the same document again is not another of their apps.
    expect(await publisherState(store, second)).toMatchObject({ state: "known", count: 2 });

    // Same key, new name: known, and says what it was called.
    const renamed = await verifyContainer((await signed(key, "Acme Financial", "Invoices")).html);
    expect(await publisherState(store, renamed)).toMatchObject({
      state: "known",
      name: "Acme Financial",
      renamedFrom: "Acme Finance",
    });
  });

  test("a known name under a different key is a conflict, confusables included", async () => {
    test.slow();
    const store = memoryStore();
    const acme = await pem();
    const stranger = await pem();

    await recordPublisher(store, await verifyContainer((await signed(acme, "Acme Finance")).html));

    // The exact name.
    const exact = await verifyContainer((await signed(stranger, "Acme Finance")).html);
    expect(await publisherState(store, exact)).toMatchObject({ state: "conflict", knownAs: "Acme Finance" });

    // The name with a Cyrillic а where the Latin one was. Identical on screen.
    const lookalike = await verifyContainer((await signed(stranger, "Acme Finаnce")).html);
    expect(await publisherState(store, lookalike)).toMatchObject({
      state: "conflict",
      claimed: "Acme Finаnce",
      knownAs: "Acme Finance",
    });

    // And a stranger under their own name is simply new.
    const other = await verifyContainer((await signed(stranger, "Northwind")).html);
    expect(await publisherState(store, other)).toMatchObject({ state: "new", name: "Northwind" });
  });

  test("unsigned is unsigned, and a signed document under no name is anonymous", async () => {
    test.slow();
    const store = memoryStore();
    const source = mkdtempSync(join(tmpdir(), "dai-pub-"));
    writeFileSync(join(source, "index.html"), "<!doctype html><meta charset=\"utf-8\"><p>x</p>", "utf8");
    const plain = await compileDirectory({ sourceDir: source, root: repo, appName: "Plain" });
    expect(await publisherState(store, await verifyContainer(plain.html))).toEqual({ state: "unsigned" });

    const keyFile = join(source, "key.pem");
    writeFileSync(keyFile, await pem(), "utf8");
    const nameless = await compileDirectory({ sourceDir: source, root: repo, appName: "Nameless", signingKey: keyFile });
    expect(await publisherState(store, await verifyContainer(nameless.html))).toMatchObject({ state: "anonymous" });
  });
});

test.describe("the three states, on the card", () => {
  test("new is neutral with a way to verify, known is the only good state, conflict is red", async ({ page }) => {
    test.slow();
    const acme = await pem();
    const stranger = await pem();
    const publisher = page.locator("#card-publisher");

    // NEW. First document from a key never seen here.
    await page.goto(RUNNER_URL);
    await page.setInputFiles("#file", (await signed(acme, "Acme Finance", "Ledger")).file);
    await expect(publisher).toHaveAttribute("data-state", "new", { timeout: 60_000 });
    await expect(publisher).toHaveText("Acme Finance · first time you've seen this publisher");
    // Neutral: no positive colour.
    expect(await publisher.evaluate((el) => getComputedStyle(el).color)).toBe("rgb(209, 213, 219)");
    // The verify affordance reveals a number two people can read to each other.
    await expect(page.locator("#card-safety")).toBeHidden();
    await page.locator("#card-verify").click();
    await expect(page.locator("#card-safety")).toContainText(/Safety number \d{5} \d{5} \d{5} \d{5} \d{5} \d{5}/);
    await page.locator("#card-open").click();
    await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });
    await page.click("#more");
    await page.locator("#eject").click();

    // KNOWN. A second document from the same key.
    await page.setInputFiles("#file", (await signed(acme, "Acme Finance", "Payroll")).file);
    await expect(publisher).toHaveAttribute("data-state", "known", { timeout: 60_000 });
    await expect(publisher).toHaveText("Acme Finance · you've opened 1 of their apps before");
    expect(await publisher.evaluate((el) => getComputedStyle(el).color)).toBe("rgb(52, 211, 153)");
    await expect(page.locator("#card-verify")).toBeHidden();
    await page.locator("#card-open").click();
    await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });
    await page.click("#more");
    await page.locator("#eject").click();

    // CONFLICT. A key never seen here, using the name with a Cyrillic а.
    await page.setInputFiles("#file", (await signed(stranger, "Acme Finаnce", "Ledger")).file);
    await expect(publisher).toHaveAttribute("data-state", "conflict", { timeout: 60_000 });
    await expect(publisher).toHaveText(
      "Claims to be Acme Finаnce, but the Acme Finance you know uses a different key. Treat as a stranger.",
    );
    expect(await publisher.evaluate((el) => getComputedStyle(el).color)).toBe("rgb(248, 113, 113)");
    // Never the word "verified", in any state.
    expect(await page.locator("#card").innerText()).not.toMatch(/verified/i);
  });

  test("an unsigned document says so, in the words it always did", async ({ page }) => {
    const source = mkdtempSync(join(tmpdir(), "dai-pub-"));
    writeFileSync(join(source, "index.html"), "<!doctype html><meta charset=\"utf-8\"><p>x</p>", "utf8");
    const plain = await compileDirectory({ sourceDir: source, root: repo, appName: "Plain" });
    await page.goto(RUNNER_URL);
    await page.setInputFiles("#file", { name: "plain.dai.html", mimeType: "text/html", buffer: Buffer.from(plain.html) });
    await expect(page.locator("#card-publisher")).toHaveAttribute("data-state", "unsigned", { timeout: 60_000 });
    await expect(page.locator("#card-publisher")).toHaveText("Not signed — anyone could have made this.");
  });
});
