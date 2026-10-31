import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type BrowserContext, type CDPSession, type FrameLocator, type Page } from "@playwright/test";
import { compileDirectory } from "../src/compile.js";

/**
 * What the owner specs share (Build 2b-1, R-Z): a one-field notes app a person
 * types into, the opener's document open, a read of the opener's key store,
 * and Chromium's virtual authenticator with PRF.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const RUNNER_URL = "http://localhost:5175/";

/** Each built file's document id, so an open can wait for that document and no other. */
const built = new Map<string, string>();

/**
 * A notes app under the ordinary data interface: one field, written as it is
 * typed. `seed` adds a starter row, which the runtime runs once at creation.
 * `onLoad` is SQL the app itself runs as it opens, before anyone touches it;
 * `onFocus`, SQL it runs whenever the field takes focus.
 * The field is disabled until the app can take input (tests/README.md, waiting).
 */
export async function buildNotes(scratch: string, name: string, seed = false, onLoad = "", onFocus = ""): Promise<string> {
  const src = join(scratch, name, "src");
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, "schema.sql"), "CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL);\n");
  // A seed is a document SQL block that is not the schema: the runtime runs it once, at creation.
  const starter = seed ? `<script type="application/sql">INSERT OR IGNORE INTO notes (id, body) VALUES (1, 'starter');</script>` : "";
  writeFileSync(
    join(src, "index.html"),
    `<!doctype html><html><head><meta charset="utf-8"><title>${name}</title>${starter}</head><body>` +
      '<input id="note" disabled autocomplete="off"><script type="module" src="app.js"></script></body></html>\n',
  );
  writeFileSync(
    join(src, "app.js"),
    [
      "const db = await window.dai.database();",
      "window.__db = db;",
      ...(onLoad ? [`await db.run(${JSON.stringify(onLoad)});`] : []),
      'const input = document.getElementById("note");',
      'const rows = await db.query("SELECT body FROM notes WHERE id = 1");',
      'input.value = rows[0] ? rows[0].body : "";',
      ...(onFocus ? [`input.addEventListener("focus", () => void db.run(${JSON.stringify(onFocus)}));`] : []),
      'input.addEventListener("input", () => {',
      '  void db.run("INSERT INTO notes (id, body) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body", [input.value]);',
      "});",
      "input.disabled = false;",
      "",
    ].join("\n"),
  );
  const documentUuid = randomUUID();
  const compiled = await compileDirectory({ sourceDir: src, root: repo, appName: name, documentUuid });
  const file = join(scratch, `${name}.dai.html`);
  writeFileSync(file, compiled.html, "utf8");
  built.set(file, documentUuid);
  return file;
}

export const appIn = (page: Page): FrameLocator => page.frameLocator("#cartridge").frameLocator("#dai-app");

/**
 * Opens a document from a file, as a person picks one, and waits until that
 * document, and no other, is mounted and its field takes input. A document
 * this browser already holds mounts with no card. The opener may resume the
 * last document by itself on load, and its field takes input too: waiting for
 * any field typed into the resumed one, which the picked one then replaced.
 */
export async function openFile(page: Page, file: string): Promise<FrameLocator> {
  await page.setInputFiles("#file", file);
  return waitMounted(page, file);
}

/**
 * Waits until the document built as `file` is the one mounted and its field
 * takes input, clicking its card if one is shown. On its own, after a load:
 * the opener resumes the document open last (`KEYS.RESUME`), and a file picked
 * before that resume lands is mounted and then replaced by it.
 */
export async function waitMounted(page: Page, file: string): Promise<FrameLocator> {
  const expected = built.get(file);
  if (!expected) throw new Error(`not built here: ${file}`);
  const title = file.slice(Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\")) + 1).replace(/\.dai\.html$/, "");
  const app = appIn(page);
  const card = page.locator("#card-open");
  await expect
    .poll(
      async () => {
        if (await card.isVisible()) await card.click();
        const loaded = await page.evaluate(() => (window as Any).__runner.loaded?.manifest?.documentUuid ?? null);
        if (loaded !== expected) return "another document";
        // Bounded: with no frame yet, these would wait for one.
        const named = await app.locator("title").textContent({ timeout: 500 }).catch(() => null);
        const ready = await app.locator("#note").isEnabled({ timeout: 500 }).catch(() => false);
        return named === title && ready ? "mounted" : "waiting";
      },
      { timeout: 60_000 },
    )
    .toBe("mounted");
  return app;
}

export const uuidOf = (page: Page): Promise<string> =>
  page.evaluate(() => (window as Any).__runner.loaded.manifest.documentUuid as string);

export const savesWritten = (page: Page): Promise<number> => page.evaluate(() => (window as Any).__runner.savesWritten as number);

/** Types into the note, a key at a time, as a person does. */
export async function typeNote(app: FrameLocator, text: string, delay = 0): Promise<void> {
  await app.locator("#note").click();
  await app.locator("#note").pressSequentially(text, { delay });
}

/** The stored database, as a reopen reads it, holds `text`. */
export async function storedHolds(page: Page, uuid: string, text: string): Promise<boolean> {
  return page.evaluate(
    async ([id, needle]) => {
      const bytes: Uint8Array | null = await (window as Any).__runner.loadStored(id);
      if (!bytes) return false;
      return new TextDecoder("latin1").decode(bytes).includes(needle);
    },
    [uuid, text] as const,
  );
}

/** SHA-256 of the stored database, hex: whether a step rewrote it. */
export async function storedDigest(page: Page, uuid: string): Promise<string> {
  return page.evaluate(async (id) => {
    const bytes: Uint8Array | null = await (window as Any).__runner.loadStored(id);
    if (!bytes) return "none";
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)));
    return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
  }, uuid);
}

/**
 * Runs `body` in the opener's page with its key store open: `get(key)` reads one
 * entry of the opener's own IndexedDB key store. A read of what the opener kept,
 * never a write to it.
 */
export function withKeyStore<T>(page: Page, body: string, arg?: unknown): Promise<T> {
  return page.evaluate(
    async ([text, value]) => {
      const db: IDBDatabase = await new Promise((resolve, reject) => {
        const open = indexedDB.open("dai_runner_storage");
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error);
      });
      try {
        const get = (key: string): Promise<Any> =>
          new Promise((resolve, reject) => {
            if (!db.objectStoreNames.contains("keys")) return resolve(undefined);
            const request = db.transaction("keys", "readonly").objectStore("keys").get(key);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
        return await new Function("get", "arg", `return (async () => { ${text} })();`)(get, value);
      } finally {
        db.close();
      }
    },
    [body, arg] as const,
  ) as Promise<T>;
}

/** A platform authenticator with PRF, as a phone's passkey provider is. Chromium only. */
export async function addPasskeyProvider(context: BrowserContext, page: Page): Promise<{ cdp: CDPSession; id: string }> {
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      ctap2Version: "ctap2_1",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      hasPrf: true,
      automaticPresenceSimulation: true,
    },
  });
  return { cdp, id: authenticatorId };
}

/** How many passkeys the provider holds: whether a ceremony made one. */
export async function passkeysHeld(provider: { cdp: CDPSession; id: string }): Promise<number> {
  const { credentials } = await provider.cdp.send("WebAuthn.getCredentials", { authenticatorId: provider.id });
  return credentials.length;
}

/**
 * Points every page of `context` at the owner's store at `base`, before the
 * opener loads (`window.__daiOwnerStore`), so the address holds across the
 * reloads a test drives, as a deploy's does. An opener offers to keep beyond
 * this browser only when it has a store.
 */
export async function pointAtStore(context: BrowserContext, base: string): Promise<void> {
  await context.addInitScript((address) => {
    (window as Any).__daiOwnerStore = address;
  }, base);
}

/** Opens the menu, taps "Keep beyond this browser", and takes the way that makes a new passkey (R-Z, amended 31 October). */
export async function keepFromMenu(page: Page): Promise<void> {
  await page.locator("#more").click();
  await page.locator("#keep-beyond").click();
  await page.locator("#keep-new").click();
}

/** The owner current in this browser context, as the opener kept it, or null. */
export const currentOwner = (page: Page): Promise<string | null> =>
  withKeyStore<string | null>(page, 'return (await get("dai:owner")) ?? null;');
