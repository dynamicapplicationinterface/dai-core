import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Browser, type Frame, type Page } from "@playwright/test";
import { test } from "./fixtures.js";
import { compileDirectory } from "../src/compile.js";
import { resealContainer, verifyContainer } from "../src/container.js";
import { authorIdOf, mintPersonKey, rawPublicKey } from "../src/identity.js";
import { rewriteReplicated } from "../src/replicated.js";
import { pendingBatches, recordSeal, signBatch } from "../src/replicated-batch.js";
import { mergeTablesOf } from "../src/replicated-frame.js";
import { createEntity, ensureReplica, startSession, type Rows } from "../src/replicated-rows.js";
import { SESSION_ID_FUNCTION, sessionIdOf } from "../src/session-id.js";

/**
 * A read-only mount offers no write (D170).
 *
 * A host mounts read-only a document holding a header of a batch format it
 * does not write, either way (D108, docs/format.md `version-read-only`), and
 * says so over the document. Refusing the write when it is pressed is not
 * enough: the page must not offer it. So on such a mount every control that
 * writes shared rows is absent or disabled, the sentence is shown, and a write
 * a script attempts anyway is refused with the sentence.
 *
 * The controls are named here, per example, by what they write, not read from
 * the mark the kit acts on: a control the application forgot to mark is still
 * on this list, and the test fails on it.
 */

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER_URL = "http://localhost:5175/";
const SENTENCE = "This app needs an update before it can be written to; what's here is kept";
const rnd = (): Uint8Array => crypto.getRandomValues(new Uint8Array(16));
const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");

const appFrame = (page: Page): Frame => {
  const frame = page.frames().find((f) => f.parentFrame()?.parentFrame() === page.mainFrame());
  if (!frame) throw new Error("app frame not found (main → shell → app)");
  return frame;
};

interface Example {
  name: string;
  dir: string;
  /** Selectors for every control that writes shared rows, whatever its state. */
  writes: string[];
  /** A write control a fresh copy would be offered: on screen here, so the check is not empty. */
  offered: string;
  /** Ada's shared rows in her session, beside the seats. */
  fill: (db: Rows, session: Uint8Array) => void;
  /** A shared write as a script would make it, in Ada's session. */
  scripted: { table: string; values: Record<string, unknown> };
}

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

const EXAMPLES: Example[] = [
  {
    name: "chess",
    dir: "tests/fixture/chess",
    writes: [
      "[data-new-game]",
      "#new-game-form button[type=submit]",
      "#play-move",
      "#rematch",
      "#close-match",
      "#accept-draw",
      "#decline-draw",
      "#offer-draw",
      "#claim-draw",
      "#resign",
      "#conflict-choices button",
      "#names-choices button",
      "#rename-form button[type=submit]",
      "#name-form button[type=submit]",
    ],
    offered: "[data-new-game]",
    fill: (db, session) => {
      createEntity(db, "games", rnd(), { white_name: "Ada", black_name: "", creator_color: "w", initial_fen: START }, session);
    },
    scripted: { table: "games", values: { white_name: "Mal", black_name: "", creator_color: "w", initial_fen: START } },
  },
  {
    name: "tic-tac-toe",
    dir: "examples/tic-tac-toe",
    writes: [
      "#new-game button[type=submit]",
      "#board .cell",
      "#rename",
      "#rename-form button[type=submit]",
      "#close-match",
      "#fresh-invite",
      "#collision-choices button",
      "#name-versions button",
    ],
    offered: "#new-game button[type=submit]",
    fill: (db, session) => {
      createEntity(db, "games", rnd(), { x_name: "Ada", o_name: "Bo" }, session);
    },
    scripted: { table: "games", values: { x_name: "Mal", o_name: "Bo" } },
  },
  {
    name: "request",
    dir: "examples/request",
    writes: [
      "#compose",
      "#new-request button[type=submit]",
      "#add-question button[type=submit]",
      "#submit",
      "#close",
      "#fresh-invite",
      "#questions button",
    ],
    offered: "#compose, #new-request button[type=submit]",
    fill: (db, session) => {
      createEntity(db, "requests", rnd(), { from_name: "Ada", title: "Start date", note: "", due_on: null }, session);
    },
    scripted: { table: "requests", values: { from_name: "Mal", title: "Mine", note: "", due_on: null } },
  },
];

/**
 * The example, built, with a database holding Ada's signed session and rows,
 * every header of hers stamped `version`, resealed as a file a person could
 * pick.
 */
async function documentWith(example: Example, version: number): Promise<{ file: string; session: Uint8Array }> {
  const built = await compileDirectory({
    sourceDir: join(repo, example.dir),
    root: repo,
    appName: example.name,
    signingKey: resolve(repo, "conformance", "signing-key.pem"),
    allowTestKey: true,
  });
  const dir = mkdtempSync(join(tmpdir(), "dai-read-only-"));
  const path = join(dir, "document.sqlite");
  const sqlite = new DatabaseSync(path);
  sqlite.function(SESSION_ID_FUNCTION, { deterministic: true }, (a, n, seat, seats, close) => sessionIdOf(a, n, seat, seats, close));
  sqlite.exec(rewriteReplicated(readFileSync(join(repo, example.dir, "schema.sql"), "utf8")).sql);
  const db: Rows = {
    all: (sql, params = []) => sqlite.prepare(sql).all(...(params as never[])) as Record<string, unknown>[],
    run: (sql, params = []) => {
      sqlite.prepare(sql).run(...(params as never[]));
    },
  };
  const keys = await mintPersonKey();
  const author = await authorIdOf(await rawPublicKey(keys.publicKey));
  ensureReplica(db, author);
  const session = startSession(db, { creatorSeat: rnd(), openSeats: [rnd()], close: "any", entity: rnd() });
  example.fill(db, session);
  for (const batch of pendingBatches(db, author, mergeTablesOf(db))) {
    recordSeal(db, await signBatch(batch, { document: built.manifest.documentUuid, keys }));
  }
  db.run("UPDATE _dai_batch SET version = ? WHERE author = ?", [version, author]);
  sqlite.close();
  const resealed = await resealContainer(await verifyContainer(built.html), new Uint8Array(readFileSync(path)));
  const file = join(dir, `${example.name}.dai.html`);
  writeFileSync(file, resealed.html, "utf8");
  return { file, session };
}

/** A fresh device opens the file from the chooser, and the application runs. */
async function openOnAFreshDevice(browser: Browser, file: string): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(RUNNER_URL);
  const chooser = page.waitForEvent("filechooser");
  await page.locator("#open").click();
  await (await chooser).setFiles(file);
  await page.locator("#card-open").click({ timeout: 60_000 });
  await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });
  await expect
    .poll(
      async () => {
        try {
          return await appFrame(page).evaluate(() => Boolean((window as any).daiKit?.db));
        } catch {
          return false;
        }
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  return { page, close: () => context.close() };
}

/**
 * Every element the selectors match that a person could press: on screen, and
 * neither disabled nor inside something inert or disabled. Described by the
 * selector and the element's text, for the failure message.
 */
const pressable = (page: Page, selectors: string[]): Promise<string[]> =>
  appFrame(page).evaluate((list) => {
    const found: string[] = [];
    for (const selector of list) {
      for (const el of Array.from(document.querySelectorAll<HTMLElement>(selector))) {
        const box = el.getBoundingClientRect();
        const shown = box.width > 0 && box.height > 0 && getComputedStyle(el).visibility !== "hidden";
        if (!shown) continue;
        const disabled = (el as HTMLButtonElement).disabled === true || el.matches(":disabled") || el.closest("[inert]") !== null;
        if (!disabled) found.push(`${selector}: "${(el.textContent ?? "").trim().slice(0, 40)}"`);
      }
    }
    return found;
  }, selectors);

const shownCount = (page: Page, selector: string): Promise<number> =>
  appFrame(page).evaluate(
    (s) => Array.from(document.querySelectorAll<HTMLElement>(s)).filter((el) => el.getBoundingClientRect().width > 0).length,
    selector,
  );

test.describe("a read-only mount offers no write (D170)", () => {
  test.slow();

  for (const example of EXAMPLES) {
    for (const version of [1, 3]) {
      test(`${example.name}, holding a batch format ${version} header: every write control absent or disabled, the sentence shown, a scripted write refused`, async ({ browser }) => {
        const { file, session } = await documentWith(example, version);
        const { page, close } = await openOnAFreshDevice(browser, file);
        await expect(page.locator("#doc-note")).toHaveText(`${SENTENCE}.`, { timeout: 30_000 });
        expect(await appFrame(page).evaluate(() => (window as any).dai.replicated.writable()), "the mount is read-only").toBe(false);

        // Not an empty check: the control a fresh copy is offered is on screen.
        expect(await shownCount(page, example.offered), `${example.offered} is on screen`).toBeGreaterThan(0);
        // The kit acts once the mount says it cannot write; the page settles on it.
        await expect.poll(() => pressable(page, example.writes), { timeout: 10_000 }).toEqual([]);

        // A write attempted by script is refused, with the sentence, and lands nothing.
        const before = await appFrame(page).evaluate(
          (t) => Number((window as any).daiKit.db.selectObjects(`SELECT count(*) AS n FROM ${t}`)[0].n),
          example.scripted.table,
        );
        const refusal = await appFrame(page).evaluate(
          ([t, v, s]) => {
            try {
              (window as any).dai.replicated.insert(t, v, s);
              return "written";
            } catch (error) {
              return String((error as Error).message);
            }
          },
          [example.scripted.table, example.scripted.values, hex(session)] as const,
        );
        expect(refusal).toContain(SENTENCE);
        const after = await appFrame(page).evaluate(
          (t) => Number((window as any).daiKit.db.selectObjects(`SELECT count(*) AS n FROM ${t}`)[0].n),
          example.scripted.table,
        );
        expect(after, "the refused write landed nothing").toBe(before);
        await close();
      });
    }
  }
});
