import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Page } from "@playwright/test";
import { test } from "./fixtures.js";
import { RUNNER_URL, addPasskeyProvider, buildNotes, currentOwner, keepFromMenu, openFile, storedHolds, typeNote, uuidOf, withKeyStore } from "./owner.js";

/**
 * The library by owner, in this browser, Build 2b-1 (R-Z sentence 5's first
 * half; R-B: the library is keyed by owner).
 *
 * The opener lists the documents held here under the owner signed in, and a
 * document no owner holds as this browser's; another owner's documents are not
 * listed. A mechanism test: nothing in 2b-1 shows the list, and nothing but a
 * recovery (2b-2) signs a context in as an owner it already holds, so the list
 * is read from the opener, and signing out and in are asked of it, against
 * this test's own passkey provider.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

const VIRTUAL_PASSKEY = "two owners need passkeys with PRF: Chromium's virtual authenticator";

type Entry = { documentUuid: string; holder: "owner" | "this browser" };
const library = (page: Page): Promise<Entry[]> =>
  page.evaluate(async () =>
    ((await (window as Any).__runner.owner.library()) as Entry[])
      .map(({ documentUuid, holder }) => ({ documentUuid, holder }))
      .sort((a, b) => a.documentUuid.localeCompare(b.documentUuid)),
  );
const sorted = (entries: Entry[]): Entry[] => [...entries].sort((a, b) => a.documentUuid.localeCompare(b.documentUuid));

/** Opens a document, makes a change, and waits until it is saved here and its data key is held as it should be. */
async function used(page: Page, file: string, text: string, owner: string | null): Promise<string> {
  await page.goto(RUNNER_URL);
  const app = await openFile(page, file);
  const uuid = await uuidOf(page);
  await typeNote(app, text);
  await expect.poll(() => storedHolds(page, uuid, text), { timeout: 30_000 }).toBe(true);
  await expect
    .poll(() => withKeyStore<string | null>(page, 'const r = await get("dai:data-key:" + arg); return r ? (r.owner ?? "none") : null;', uuid), { timeout: 30_000 })
    .toBe(owner ?? "none");
  return uuid;
}

test.describe("the library by owner, in this browser (R-Z, R-B)", () => {
  test.slow();

  test("two owners in one browser each see only their own documents, and a document no owner holds is this browser's", async ({ browser, browserName }) => {
    test.skip(browserName !== "chromium", VIRTUAL_PASSKEY);
    const scratch = mkdtempSync(join(tmpdir(), "dai-library-"));
    const [alpha, beta, gamma, delta] = await Promise.all(["Alpha", "Beta", "Gamma", "Delta"].map((name) => buildNotes(scratch, name)));
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(RUNNER_URL);
    await addPasskeyProvider(context, page);

    // The first owner enrolls with Alpha here, and Beta is saved while it is signed in.
    const a = await used(page, alpha, "alpha", null);
    await keepFromMenu(page);
    await expect.poll(() => currentOwner(page), { timeout: 30_000 }).not.toBeNull();
    const first = (await currentOwner(page))!;
    const b = await used(page, beta, "beta", first);

    // Signed out, Gamma is saved with no owner; the second owner enrolls and takes it.
    await page.evaluate(() => (window as Any).__runner.owner.leave());
    const c = await used(page, gamma, "gamma", null);
    await keepFromMenu(page);
    await expect.poll(() => currentOwner(page), { timeout: 30_000 }).not.toBe(null);
    const second = (await currentOwner(page))!;
    expect(second).not.toBe(first);
    await expect
      .poll(() => withKeyStore<string>(page, 'return (await get("dai:data-key:" + arg)).owner;', c), { timeout: 30_000 })
      .toBe(second);

    // Signed out again, Delta is saved with no owner, and stays this browser's.
    await page.evaluate(() => (window as Any).__runner.owner.leave());
    const d = await used(page, delta, "delta", null);
    expect(await library(page)).toEqual([{ documentUuid: d, holder: "this browser" }]);

    expect(await page.evaluate((id) => (window as Any).__runner.owner.signIn(id), first)).toBe("opened");
    expect(await library(page)).toEqual(
      sorted([
        { documentUuid: a, holder: "owner" },
        { documentUuid: b, holder: "owner" },
        { documentUuid: d, holder: "this browser" },
      ]),
    );

    expect(await page.evaluate((id) => (window as Any).__runner.owner.signIn(id), second)).toBe("opened");
    expect(await library(page)).toEqual(
      sorted([
        { documentUuid: c, holder: "owner" },
        { documentUuid: d, holder: "this browser" },
      ]),
    );
    await context.close();
  });
});
