import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { compileDirectory } from "../src/compile.js";
import { verifyContainer } from "../src/container.js";
import { toBase64 } from "../src/core.js";
import {
  labelPublisher,
  mixedScript,
  publisherState,
  recordPublisher,
  safetyNumber,
  skeleton,
  type ConfusableTable,
  type PublisherPin,
  type PublisherStore,
  type RootPublisher,
} from "../src/publisher.js";
import { readFileSync } from "node:fs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER_URL = "http://localhost:5175/";

/** The one table every host loads (spec §9.6). */
const TABLE: ConfusableTable = JSON.parse(readFileSync(resolve(repo, "conformance/confusables.json"), "utf8"));

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

function memoryStore(roots: RootPublisher[] = []): PublisherStore {
  const pins = new Map<string, PublisherPin>();
  return {
    async byKey(publicKey) {
      return pins.get(publicKey) ?? null;
    },
    async bySkeleton(sk) {
      return [...pins.values()].filter((p) => p.skeletons.includes(sk));
    },
    async save(pin) {
      pins.set(pin.publicKey, pin);
    },
    async roots() {
      return roots;
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
test.describe("a name, reduced to what the eye compares", () => {
  test("case, spacing and punctuation do not make a different name", () => {
    expect(skeleton("Acme Finance", TABLE)).toBe(skeleton("ACME  FINANCE.", TABLE));
    expect(skeleton("acme-finance", TABLE)).toBe(skeleton("Acme Finance", TABLE));
  });

  test("the UTS #39 skeleton makes lookalikes one name, and different names stay different", () => {
    // Whole-script Cyrillic "Ace Space": а с е ѕ р are each a UTS #39
    // prototype of a Latin letter. (Cyrillic м is not one of Latin m, so
    // "Асме" is not a lookalike of "Acme" by the table — a fact worth knowing.)
    expect(skeleton("Асе Ѕрасе", TABLE)).toBe(skeleton("Ace Space", TABLE));
    expect(skeleton("Асме", TABLE)).not.toBe(skeleton("Acme", TABLE));
    // Fullwidth Latin, which NFKC brings back.
    expect(skeleton("Ａｃｅ Ｓｐａｃｅ", TABLE)).toBe(skeleton("Ace Space", TABLE));
    expect(skeleton("Acme Bank", TABLE)).not.toBe(skeleton("Acme Finance", TABLE));
    // An all-CJK name collides with nothing Latin.
    expect(skeleton("株式会社アクメ", TABLE)).not.toBe(skeleton("Acme", TABLE));
  });

  test("one word from two alphabets is mixed script; one alphabet per word is not", () => {
    expect(mixedScript("Acme Finаnce")).toBe(true); // Cyrillic а inside a Latin word
    expect(mixedScript("Acme Finance")).toBe(false);
    expect(mixedScript("Асме")).toBe(false); // whole-script Cyrillic: rule 2's job
    expect(mixedScript("株式会社アクメ")).toBe(false); // Han with Katakana is one writing system
    expect(mixedScript("Acme 2024")).toBe(false); // digits belong to no script
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
    expect(await publisherState(store, first, TABLE)).toMatchObject({ state: "new", name: "Acme Finance" });
    await recordPublisher(store, first, TABLE);

    const second = await verifyContainer((await signed(key, "Acme Finance", "Payroll")).html);
    expect(await publisherState(store, second, TABLE)).toMatchObject({ state: "known", name: "Acme Finance", count: 1 });
    await recordPublisher(store, second, TABLE);

    // Opening the same document again is not another of their apps.
    expect(await publisherState(store, second, TABLE)).toMatchObject({ state: "known", count: 2 });

    // Same key, new name: known, and says what it was called.
    const renamed = await verifyContainer((await signed(key, "Acme Financial", "Invoices")).html);
    expect(await publisherState(store, renamed, TABLE)).toMatchObject({
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

    await recordPublisher(store, await verifyContainer((await signed(acme, "Acme Finance")).html), TABLE);

    // The exact name.
    const exact = await verifyContainer((await signed(stranger, "Acme Finance")).html);
    expect(await publisherState(store, exact, TABLE)).toMatchObject({ state: "conflict", knownAs: "Acme Finance", rule: "skeleton" });

    // The name with a Cyrillic а where the Latin one was. Identical on screen.
    const lookalike = await verifyContainer((await signed(stranger, "Acme Finаnce")).html);
    // One word, two alphabets: a conflict by the first rule, before any table.
    expect(await publisherState(store, lookalike, TABLE)).toMatchObject({
      state: "conflict",
      claimed: "Acme Finаnce",
      rule: "mixed-script",
    });

    // Whole-script Cyrillic, which the first rule cannot see and the second can.
    await recordPublisher(store, await verifyContainer((await signed(acme, "Ace Space")).html), TABLE);
    const cyrillic = await verifyContainer((await signed(stranger, "Асе Ѕрасе")).html);
    expect(await publisherState(store, cyrillic, TABLE)).toMatchObject({
      state: "conflict",
      knownAs: "Ace Space",
      rule: "skeleton",
    });

    // And a stranger under their own name is simply new.
    const other = await verifyContainer((await signed(stranger, "Northwind")).html);
    expect(await publisherState(store, other, TABLE)).toMatchObject({ state: "new", name: "Northwind" });
  });

  test("unsigned is unsigned, and a signed document under no name is anonymous", async () => {
    test.slow();
    const store = memoryStore();
    const source = mkdtempSync(join(tmpdir(), "dai-pub-"));
    writeFileSync(join(source, "index.html"), "<!doctype html><meta charset=\"utf-8\"><p>x</p>", "utf8");
    const plain = await compileDirectory({ sourceDir: source, root: repo, appName: "Plain" });
    expect(await publisherState(store, await verifyContainer(plain.html), TABLE)).toEqual({ state: "unsigned" });

    const keyFile = join(source, "key.pem");
    writeFileSync(keyFile, await pem(), "utf8");
    const nameless = await compileDirectory({ sourceDir: source, root: repo, appName: "Nameless", signingKey: keyFile });
    expect(await publisherState(store, await verifyContainer(nameless.html), TABLE)).toMatchObject({ state: "anonymous" });
  });
});

test.describe("what an organisation and a person add", () => {
  test("a host label is shown first, and a stranger collides with it too", async () => {
    test.slow();
    const store = memoryStore();
    const acme = await pem();
    const stranger = await pem();
    const first = await verifyContainer((await signed(acme, "AF Ltd", "Ledger")).html);
    await recordPublisher(store, first, TABLE);
    await labelPublisher(store, first.publicKey!, "Acme Finance", TABLE);

    // Shown by the label; the asserted name beside it.
    const again = await verifyContainer((await signed(acme, "AF Ltd", "Payroll")).html);
    expect(await publisherState(store, again, TABLE)).toMatchObject({ state: "known", name: "Acme Finance", asserted: "AF Ltd" });

    // A stranger using the label collides with it, not only with the asserted name.
    const impostor = await verifyContainer((await signed(stranger, "Acme Finance")).html);
    expect(await publisherState(store, impostor, TABLE)).toMatchObject({ state: "conflict", knownAs: "Acme Finance", rule: "skeleton" });
  });

  test("a root list makes a key known before any sighting, and its names collide", async () => {
    test.slow();
    const acme = await pem();
    const stranger = await pem();
    const doc = await verifyContainer((await signed(acme, "Acme Finance")).html);
    const store = memoryStore([{ spki: doc.publicKey!, name: "Acme Finance", org: "Acme Corp" }]);

    expect(await publisherState(store, doc, TABLE)).toMatchObject({ state: "known", name: "Acme Finance", org: "Acme Corp", count: 0 });

    const impostor = await verifyContainer((await signed(stranger, "Ａｃｍｅ Ｆｉｎａｎｃｅ")).html);
    expect(await publisherState(store, impostor, TABLE)).toMatchObject({ state: "conflict", knownAs: "Acme Finance" });
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
    await expect(publisher).toContainText("Claims to be Acme Finаnce");
    await expect(publisher).toContainText("Treat as a stranger.");
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

/**
 * The conformance vectors (spec §9.7), run through the decision the hosts
 * share. A second implementation runs the same file; this is ours agreeing
 * with the verdicts the vectors state ahead of time.
 */
test.describe("the trust vectors", () => {
  test("every step reaches the state the suite states", async () => {
    test.slow();
    const suite = JSON.parse(readFileSync(resolve(repo, "conformance/trust-vectors.json"), "utf8")) as {
      sequence: { name: string; file: string; expect: Record<string, unknown>; record: boolean }[];
    };
    const store = memoryStore();
    // The document store (§9.6): UUID → key, recorded with the publisher.
    const documents = new Map<string, string>();
    for (const step of suite.sequence) {
      const html = readFileSync(resolve(repo, "conformance", step.file), "utf8");
      const container = await verifyContainer(html);
      const state = await publisherState(store, container, TABLE, documents.get(container.manifest.documentUuid));
      expect(state, step.name).toMatchObject(step.expect);
      if (step.record) {
        await recordPublisher(store, container, TABLE);
        documents.set(container.manifest.documentUuid, container.publicKey!);
      }
    }
  });
});
