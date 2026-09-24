import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type FrameLocator, type Page } from "@playwright/test";
import { test } from "./fixtures.js";
import { compileDirectory } from "../src/compile.js";
import { decodeBatch } from "../src/replicated-batch.js";
import { play } from "./chess-play.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER_URL = "http://localhost:5175/";
const app = (page: Page): FrameLocator => page.frameLocator("iframe").frameLocator("iframe");
const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");

/**
 * A batch is published only after the save that holds its seal has landed
 * (identity ruling #3, ordering): seal, save landed, publish.
 *
 * "Landed" is the host's word, not the frame's: the host acknowledged a write
 * of the database to this device's store. A save the frame posted and the host
 * refused has not landed, and a batch published on it is a signed batch the
 * device itself may not hold after a reload — the relay would carry a seal this
 * copy lost.
 *
 * The store is made to refuse from the host's own window (the file system and
 * the fallback both), a move is played, and the frame is asked, as the mailbox
 * asks, what it would send. The move is sealed, and nothing of it may come back
 * until a save of it lands. Then the store is given back, the retry lands, and
 * the frame says so unasked (the nudge), and the move comes back.
 */
test("a sealed batch is not published until the save that holds it has landed", async ({ page }) => {
  test.slow();
  const built = await compileDirectory({
    sourceDir: join(repo, "tests", "fixture", "chess"),
    root: repo,
    appName: "Velvet Chess",
  });
  const file = join(mkdtempSync(join(tmpdir(), "dai-landed-")), "velvet-chess.dai.html");
  writeFileSync(file, built.html, "utf8");

  let refused = 0;
  page.on("console", (message) => {
    if (/^dai: save \d+ refused/.test(message.text())) refused += 1;
  });

  await page.goto(RUNNER_URL);
  await page.setInputFiles("#file", file);
  await page.locator("#card-open").click({ timeout: 60_000 });
  const ui = app(page);
  await expect(ui.locator("#app")).toBeVisible({ timeout: 60_000 });
  await ui.locator("[data-new-game]:visible").first().click();
  await ui.locator("#setup-you").fill("Ada");
  await ui.locator("#setup-them").fill("Bo");
  await ui.locator('input[name="color"][value="w"]').check();
  await ui.locator("#new-game-form button[type=submit]").click();

  const pendingOwn = () =>
    ui.locator("#app").evaluate(() => {
      const db = (window as any).daiKit.db;
      const me = db.selectObjects("SELECT id FROM _dai_replica")[0].id;
      let n = 0;
      for (const { name } of db.selectObjects("SELECT name FROM sqlite_schema WHERE type = 'table'")) {
        const cols = db.selectObjects(`SELECT name FROM pragma_table_info('${name}')`).map((c: any) => c.name);
        if (cols.includes("_r_batch") && cols.includes("_r_replica")) {
          n += Number(db.selectObjects(`SELECT count(*) AS n FROM "${name}" WHERE _r_replica = ? AND _r_batch IS NULL`, [me])[0].n);
        }
      }
      return n;
    });
  const headerIds = () =>
    ui.locator("#app").evaluate(() =>
      ((window as any).daiKit.db.selectObjects("SELECT lower(hex(id)) AS id FROM _dai_batch") as { id: string }[]).map((r) => r.id),
    );
  const saves = () =>
    page.evaluate(() => ({
      asked: Number((window as any).__runner.saves ?? 0),
      written: Number((window as any).__runner.savesWritten ?? 0),
    }));

  // The new game sealed and every save asked written: what is held so far has landed.
  await expect
    .poll(async () => (await pendingOwn()) === 0 && (await saves()).asked === (await saves()).written && (await saves()).written > 0, {
      timeout: 30_000,
      message: "the new game is sealed and its saves are written",
    })
    .toBe(true);
  const landedBefore = new Set(await headerIds());
  const replica = await ui.locator("#app").evaluate(() =>
    Array.from((window as any).daiKit.db.selectObjects("SELECT id FROM _dai_replica")[0].id as Uint8Array)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join(""),
  );

  // The store refuses: the file system, and the fallback the host falls to.
  await page.evaluate(() => {
    const w = window as any;
    if (typeof FileSystemFileHandle !== "undefined" && "createWritable" in FileSystemFileHandle.prototype) {
      w.__keptCreateWritable = (FileSystemFileHandle.prototype as any).createWritable;
      (FileSystemFileHandle.prototype as any).createWritable = () => Promise.reject(new Error("test: the disk refused"));
    }
    w.__keptPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (this: IDBObjectStore, ...args: any[]) {
      if (this.name === "sqlite_databases") throw new DOMException("test: the disk refused", "QuotaExceededError");
      return w.__keptPut.apply(this, args);
    } as any;
  });

  await play(ui, "e2", "e4");
  // Sealed (the seal comes before the save), and the save of it refused.
  await expect.poll(pendingOwn, { timeout: 30_000, message: "the move is sealed" }).toBe(0);
  await expect.poll(() => refused, { timeout: 30_000, message: "the save that holds the seal was refused" }).toBeGreaterThan(0);
  const unlanded = (await headerIds()).filter((id) => !landedBefore.has(id));
  expect(unlanded.length, "the move made a sealed batch the store never took").toBeGreaterThan(0);

  /** Everything the frame would publish from the start, as the mailbox walks it. */
  const published = async (): Promise<{ ids: string[]; errors: string[] }> => {
    const ids: string[] = [];
    const errors: string[] = [];
    let seq = 0;
    for (let step = 0; step < 64; step++) {
      const answer = (await page.evaluate(
        ([seq, replica]) =>
          new Promise<{ head: number; batch: number[] | null; error?: string }>((resolveAnswer) => {
            const id = `landed-${Math.random().toString(36).slice(2)}`;
            const onMessage = (event: MessageEvent): void => {
              const data = event.data as any;
              if (data?.type !== "DAI_HOST_AUTHORED_BATCH" || data.id !== id) return;
              window.removeEventListener("message", onMessage);
              resolveAnswer({
                head: Number(data.head),
                batch: data.batch instanceof Uint8Array ? Array.from(data.batch) : null,
                ...(typeof data.error === "string" ? { error: data.error } : {}),
              });
            };
            window.addEventListener("message", onMessage);
            document.querySelector("iframe")!.contentWindow!.postMessage({ type: "DAI_HOST_AUTHORED_SINCE", id, seq, replica }, "*");
          }),
        [seq, replica] as const,
      )) as { head: number; batch: number[] | null; error?: string };
      if (answer.error) errors.push(answer.error);
      if (!answer.batch) break;
      const batch = decodeBatch(Uint8Array.from(answer.batch)) as { id?: Uint8Array };
      if (batch.id) ids.push(hex(batch.id));
      if (answer.head <= seq) break;
      seq = answer.head;
    }
    return { ids, errors };
  };

  const whileRefused = await published();
  for (const id of unlanded) {
    expect(whileRefused.ids, `batch ${id.slice(0, 12)} is published only after a save of it has landed`).not.toContain(id);
  }

  // The store takes writes again; the retry lands, and the frame says there is
  // something to send without being asked.
  let nudges = 0;
  await page.exposeFunction("__landedNudge", () => {
    nudges += 1;
  });
  await page.evaluate(() => {
    window.addEventListener("message", (event) => {
      if ((event.data as any)?.type === "DAI_HOST_AUTHORED") (window as any).__landedNudge();
    });
    const w = window as any;
    if (w.__keptCreateWritable) (FileSystemFileHandle.prototype as any).createWritable = w.__keptCreateWritable;
    IDBObjectStore.prototype.put = w.__keptPut;
  });
  await expect.poll(() => nudges, { timeout: 90_000, message: "a landed save that carries a seal nudges a publish" }).toBeGreaterThan(0);
  const afterLanding = await published();
  expect(afterLanding.errors).toEqual([]);
  for (const id of unlanded) {
    expect(afterLanding.ids, `batch ${id.slice(0, 12)} is published once its save has landed`).toContain(id);
  }
});
