import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Page } from "@playwright/test";
import { test } from "./fixtures.js";
import { RUNNER_URL, addPasskeyProvider, buildNotes, currentOwner, keepFromMenu, openFile, savesWritten, storedHolds, typeNote, uuidOf, withKeyStore } from "./owner.js";
import { KEYS } from "../src/keys.js";

/**
 * The library by owner, as a boundary, Build 2b-2 item 4 (R-Z sentence 5's
 * first half; R-B; 2b-1's L2).
 *
 * Sign-in decides what the opener lists and opens. A document held under
 * another owner is neither listed nor opened, by a resume or by its file, so
 * nobody signed in as one owner types into another's. A document no owner
 * holds is claimed only by the owner who first changes it: not by opening it
 * under a sign-in, not by a sign-in, and not by an enrollment, which adopts
 * only what this browser has written.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

const VIRTUAL_PASSKEY = "owners need passkeys with PRF: Chromium's virtual authenticator";

const ownerOf = (page: Page, uuid: string): Promise<string | null> =>
  withKeyStore<string | null>(page, 'const r = await get("dai:data-key:" + arg); return r ? (r.owner ?? "none") : null;', uuid);

const loadedUuid = (page: Page): Promise<string | null> => page.evaluate(() => (window as Any).__runner.loaded?.manifest?.documentUuid ?? null);

/** Opens a document, changes it, and waits for the change to be stored and every save written. */
async function changed(page: Page, file: string, text: string): Promise<string> {
  const app = await openFile(page, file);
  const uuid = await uuidOf(page);
  await typeNote(app, text);
  await expect.poll(() => storedHolds(page, uuid, text), { timeout: 30_000 }).toBe(true);
  await page.evaluate(() => (window as Any).__runner.flush());
  await expect.poll(() => page.evaluate(() => (window as Any).__runner.saves === (window as Any).__runner.savesWritten), { timeout: 30_000 }).toBe(true);
  return uuid;
}

/** Opens a seeded document and touches nothing: it saves as it opens, and nobody changed it. */
async function openedOnly(page: Page, file: string): Promise<string> {
  const before = await savesWritten(page);
  await openFile(page, file);
  const uuid = await uuidOf(page);
  await expect.poll(() => savesWritten(page), { timeout: 30_000 }).toBeGreaterThan(before);
  await expect.poll(() => ownerOf(page, uuid), { timeout: 30_000 }).not.toBeNull();
  return uuid;
}

async function enrollNow(page: Page, not: string | null = null): Promise<string> {
  await keepFromMenu(page);
  await expect.poll(() => currentOwner(page), { timeout: 30_000 }).not.toBe(not);
  return (await currentOwner(page))!;
}

test.describe("the library by owner, as a boundary (R-Z sentence 5, Build 2b-2 item 4)", () => {
  test.slow();

  test("signed in as one owner, another owner's document is neither listed nor opened: not by a resume, not by its file", async ({ browser, browserName }) => {
    test.skip(browserName !== "chromium", VIRTUAL_PASSKEY);
    const scratch = mkdtempSync(join(tmpdir(), "dai-boundary-"));
    const [alpha, gamma] = await Promise.all(["Alpha", "Gamma"].map((name) => buildNotes(scratch, name)));
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(RUNNER_URL);
    await addPasskeyProvider(context, page);

    const a = await changed(page, alpha, "alpha's");
    const first = await enrollNow(page);
    await expect.poll(() => ownerOf(page, a), { timeout: 30_000 }).toBe(first);

    // The second owner, signed in here from now on.
    await page.evaluate(() => (window as Any).__runner.owner.leave());
    await page.goto(RUNNER_URL);
    await changed(page, gamma, "gamma's");
    const second = await enrollNow(page, null);
    expect(second).not.toBe(first);
    expect((await page.evaluate(() => (window as Any).__runner.owner.library())).map((e: Any) => e.documentUuid)).not.toContain(a);

    // A resume of the first owner's document: not opened, and nothing said, since nobody asked.
    await page.evaluate(([key, id]) => localStorage.setItem(key, id), [KEYS.RESUME, a] as const);
    const refused = page.waitForEvent("console", { predicate: (m) => m.text().includes(`${a} not opened (the document open last time, resumed)`), timeout: 30_000 });
    await page.reload();
    await refused;
    expect(await loadedUuid(page)).not.toBe(a);
    await expect(page.locator("#report")).toHaveText("");

    // Its file, picked: not opened, and said so.
    await page.setInputFiles("#file", alpha);
    await expect(page.locator("#report")).toContainText("belongs to another owner in this browser", { timeout: 30_000 });
    expect(await loadedUuid(page)).not.toBe(a);
    expect(await ownerOf(page, a)).toBe(first);
    await context.close();
  });

  test("a document no owner holds is claimed by the owner who first changes it, never by an open, a sign-in or an enrollment alone", async ({ browser, browserName }) => {
    test.skip(browserName !== "chromium", VIRTUAL_PASSKEY);
    const scratch = mkdtempSync(join(tmpdir(), "dai-boundary-"));
    const [alpha, eta, epsilon, zeta] = await Promise.all([
      buildNotes(scratch, "Alpha"),
      buildNotes(scratch, "Eta", true),
      buildNotes(scratch, "Epsilon", true),
      buildNotes(scratch, "Zeta", true),
    ]);
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(RUNNER_URL);
    await addPasskeyProvider(context, page);

    // Eta only opened, then an owner enrolls with Alpha: enrollment adopts what was written here, and Eta was not.
    const e = await openedOnly(page, eta);
    const a = await changed(page, alpha, "alpha's");
    const owner = await enrollNow(page);
    await expect.poll(() => ownerOf(page, a), { timeout: 30_000 }).toBe(owner);
    expect(await ownerOf(page, e), "an enrollment does not claim a document only opened here").toBe("none");

    // Signed in, Epsilon opened and its seed saved: nobody changed it, so nobody holds it.
    const p = await openedOnly(page, epsilon);
    expect(await ownerOf(page, p), "an open under a sign-in claims nothing").toBe("none");
    // The first change claims it.
    await changed(page, epsilon, " changed");
    await expect.poll(() => ownerOf(page, p), { timeout: 30_000 }).toBe(owner);

    // Signed out, Zeta changed with no owner; signing in claims nothing; a change does.
    await page.evaluate(() => (window as Any).__runner.owner.leave());
    await page.goto(RUNNER_URL);
    const z = await changed(page, zeta, "zeta's");
    expect(await ownerOf(page, z)).toBe("none");
    expect(await page.evaluate((id) => (window as Any).__runner.owner.signIn(id), owner)).toBe("opened");
    expect(await ownerOf(page, z), "a sign-in claims nothing").toBe("none");
    await changed(page, zeta, " again");
    await expect.poll(() => ownerOf(page, z), { timeout: 30_000 }).toBe(owner);
    await context.close();
  });
});
