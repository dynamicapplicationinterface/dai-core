/**
 * The changeset spike's test 4, through the real runtime.
 *
 * The ten apps are the spike's cold replies as parsed (apps/, replies/): ten
 * Sonnet subagents each read the model file of 18 October and answered "Make
 * me a …" with nothing else. Each is compiled by the real compiler, opened in
 * the real host, and driven by clicking; nothing calls the database.
 *
 *   1. Device A opens the new document and sends it on (a0). Device B opens a0.
 *   2. Both write through the page: every visible form filled and submitted
 *      twice, the first row control clicked, and on A a delete control clicked.
 *   3. Each saves out and opens the other's file into its own copy.
 *   4. Both copies hold the same tables and flags.
 *   5. Both reopen (a refresh): the app starts, and shows text the other typed.
 *   6. Recovery: device C, a new author with nothing, opens A's merged file;
 *      its tables come only from the admitted log. C must equal A, start, take
 *      a write, and A must hold that write once it opens C's file.
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { expect, test, type Browser, type FrameLocator, type Page } from "@playwright/test";
import { compileDirectory } from "../../src/compile.js";
import { decode as cborDecode } from "../../src/cbor.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");
const RUNNER_URL = "http://localhost:5175/";
const out = join(here, "out");
mkdirSync(out, { recursive: true });
const APPS = readdirSync(join(here, "apps")).sort();
const DELETE = /delete|remove|discard|clear|×|✕|✖|🗑|trash/i;

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;
type Side = { page: Page; app: FrameLocator; tag: string; errors: string[] };

const appIn = (page: Page): FrameLocator => page.frameLocator("iframe").frameLocator("iframe");

async function device(browser: Browser, tag: string): Promise<Side> {
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 900, height: 1000 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console: ${m.text()}`);
  });
  page.on("dialog", (d) => void d.accept().catch(() => {}));
  return { page, app: appIn(page), tag, errors };
}

async function firstOpen(side: Side, file: string): Promise<void> {
  await side.page.goto(RUNNER_URL);
  await side.page.setInputFiles("#file", file);
  await side.page.locator("#card-open").click({ timeout: 60_000 });
  await expect(side.page.locator("iframe")).toBeVisible({ timeout: 60_000 });
  await side.app.locator("body").waitFor({ timeout: 60_000 });
  await ready(side);
}

/*
 * The page is ready when the kit says so (data-dai-kit="ready" on the app's
 * root: every element defined, every view drawn once). A page with none of the
 * kit's elements is ready when it has started. Never a guess at time: a fixed
 * wait typed into a page whose kit had not started, and the typing was lost.
 */
async function ready(side: Side): Promise<void> {
  await expect
    .poll(
      () =>
        side.app
          .locator("body")
          .evaluate(() => {
            if (document.documentElement.getAttribute("data-dai-kit") === "ready") return true;
            const kit = document.querySelector("dai-rows, dai-value, dai-form, dai-attach, dai-save");
            const opening = [...document.querySelectorAll("body *")].some(
              (e) => /^\s*Opening/.test(e.textContent ?? "") && e.children.length === 0 && (e as HTMLElement).offsetParent !== null,
            );
            return !kit && !opening && !document.querySelector("main[hidden][inert], #app[hidden][inert]");
          })
          .catch(() => false),
      { timeout: 60_000, message: "the page is ready" },
    )
    .toBe(true)
    .catch(() => undefined);
}

/** Opens another copy's file into this device's copy. Only the first merge on a device asks. */
async function mergeIn(side: Side, file: string): Promise<void> {
  await side.page.setInputFiles("#file", file);
  const card = side.page.locator("#card-open");
  if (await card.waitFor({ timeout: 10_000 }).then(() => true, () => false)) {
    if (/Open in my copy/.test((await card.innerText().catch(() => "")) ?? "")) await card.click();
  }
  await ready(side);
}

async function saveOut(side: Side, to: string): Promise<string> {
  await side.page.evaluate(() => {
    delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  });
  const downloading = side.page.waitForEvent("download", { timeout: 60_000 });
  await side.page.evaluate(() => (window as Any).__runner.exportContainer());
  writeFileSync(to, readFileSync(await (await downloading).path()));
  return to;
}

async function stored(side: Side): Promise<Uint8Array> {
  const bytes = await side.page.evaluate(async () => {
    const runner = (window as Any).__runner;
    const held = await runner.loadStored(runner.loaded.manifest.documentUuid);
    return held ? [...held] : null;
  });
  return bytes ? Uint8Array.from(bytes) : new Uint8Array();
}

function withDb<T>(bytes: Uint8Array, f: (db: DatabaseSync) => T, fallback: T): T {
  if (bytes.byteLength === 0) return fallback;
  const dir = mkdtempSync(join(tmpdir(), "dai-ten-db-"));
  const path = join(dir, "stored.sqlite");
  writeFileSync(path, bytes);
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return f(db);
  } catch {
    return fallback;
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const INTERNAL = /^(_dai|_cs_|sqlite_)/;
/** The application's tables as a stored copy holds them, and its flags: what two converged copies agree on. */
function stateOf(bytes: Uint8Array): Any {
  return withDb(
    bytes,
    (db) => {
      const tables: Record<string, unknown[]> = {};
      const names = (db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all() as Any[]).map((r) => String(r.name)).filter((n) => !INTERNAL.test(n));
      for (const t of names) {
        const cols = (db.prepare(`SELECT name FROM pragma_table_info('${t}')`).all() as Any[]).map((c) => String(c.name)).filter((c) => !c.startsWith("_r_") || c === "_r_replica" || c === "_r_seq");
        const list = cols.map((c) => `"${c}"`).join(", ");
        tables[t] = (db.prepare(`SELECT ${list} FROM "${t}" ORDER BY ${list}`).all() as Any[]).map((r) =>
          Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v instanceof Uint8Array ? `<${v.length}>` : v])),
        );
      }
      const hasFlags = db.prepare("SELECT 1 FROM sqlite_schema WHERE name = '_cs_flag'").get();
      const flags = hasFlags ? (db.prepare("SELECT tbl, pk, kind FROM _cs_flag ORDER BY tbl, pk, kind").all() as Any[]) : [];
      return { tables, flags: flags.map((f) => ({ ...f })) };
    },
    { tables: {}, flags: [] },
  );
}
const unsealed = (bytes: Uint8Array): number =>
  withDb(bytes, (db) => Number((db.prepare("SELECT count(*) AS n FROM _cs_log WHERE _r_batch IS NULL").get() as Any)?.n ?? 0), -1);

/** Waits until the stored copy holds every save, sealed, and stops moving. */
async function settled(side: Side): Promise<Uint8Array> {
  let last = "";
  for (let i = 0; i < 40; i++) {
    await side.page.waitForTimeout(1000);
    const bytes = await stored(side);
    const state = JSON.stringify(stateOf(bytes));
    if (state === last && unsealed(bytes) <= 0) return bytes;
    last = state;
  }
  return stored(side);
}

/** The inserts, updates and deletes this author's own saves carry, from the log. */
function ownOps(bytes: Uint8Array, side: Side): Any {
  return withDb(
    bytes,
    (db) => {
      const me = (db.prepare("SELECT id FROM _dai_replica LIMIT 1").get() as Any)?.id;
      const counts: Record<string, number> = { I: 0, U: 0, D: 0 };
      for (const r of db.prepare("SELECT payload FROM _cs_log WHERE _r_replica = ?").all(me) as Any[]) {
        for (const op of (cborDecode(r.payload) as Any)[1]) counts[op[2]] = (counts[op[2]] ?? 0) + 1;
      }
      void side;
      return counts;
    },
    null,
  );
}

async function writeForms(side: Side, rounds: number): Promise<string[]> {
  const app = side.app;
  const typed: string[] = [];
  for (let r = 0; r < rounds; r++) {
    const forms = app.locator("dai-form, form");
    const n = await forms.count();
    for (let f = 0; f < Math.min(n, 4); f++) {
      const form = forms.nth(f);
      if (!(await form.isVisible().catch(() => false))) continue;
      const fields = form.locator("input, textarea, select");
      const m = await fields.count();
      let filled = 0;
      for (let i = 0; i < m; i++) {
        const el = fields.nth(i);
        if (!(await el.isVisible().catch(() => false)) || !(await el.isEditable().catch(() => false))) continue;
        const tag = await el.evaluate((e) => e.tagName.toLowerCase());
        const type = ((await el.getAttribute("type")) ?? "text").toLowerCase();
        try {
          if (tag === "select") {
            const options = await el.locator("option").evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value).filter((v) => v !== ""));
            if (options.length) await el.selectOption(options[Math.min(r, options.length - 1)]!);
          } else if (["checkbox", "radio", "submit", "button", "file", "hidden", "range", "color"].includes(type)) {
            continue;
          } else if (type === "number") {
            const min = Number((await el.getAttribute("min")) ?? 1);
            await el.fill(String(Math.max(min, 1) + r + 1));
          } else if (type === "date") {
            await el.fill(`2026-10-${String(20 + r).padStart(2, "0")}`);
          } else if (type === "time") {
            await el.fill("08:30");
          } else if (type === "email") {
            await el.fill(`${side.tag.toLowerCase()}${r}@example.com`);
          } else if (type === "url") {
            await el.fill(`https://example.com/${side.tag}${r}`);
          } else {
            const marker = `${side.tag}-${f}-${r} ${["alpha", "bravo", "charlie", "delta"][r % 4]}`;
            await el.fill(marker);
            typed.push(marker);
          }
          filled++;
        } catch {
          /* A field that will not take text is left alone. */
        }
      }
      if (!filled) continue;
      // As a person submits it: a kit form by its own button (the kit runs on its button, whatever its type),
      // a form by its submit button; with neither, Enter in a text field, never in a select.
      const kitForm = await form.evaluate((e) => e.tagName === "DAI-FORM");
      const submit = kitForm ? form.locator("button").first() : form.locator("button[type=submit], button:not([type]), input[type=submit]").first();
      if (await submit.count()) await submit.click({ timeout: 3000 }).catch(() => {});
      else await form.locator("input:not([type=checkbox]):not([type=radio]), textarea").first().press("Enter").catch(() => {});
      await side.page.waitForTimeout(300);
    }
  }
  return typed;
}

async function clickControl(side: Side, wantDelete: boolean): Promise<string | null> {
  const controls = side.app.locator("main [data-run], main button, main input[type=checkbox], body > [data-run], body button, body input[type=checkbox]");
  const n = await controls.count();
  for (let i = 0; i < n; i++) {
    const el = controls.nth(i);
    if (!(await el.isVisible().catch(() => false))) continue;
    if (await el.evaluate((e) => !!e.closest("dai-form, form, dialog, nav, header"))) continue;
    const label = `${(await el.innerText().catch(() => "")) ?? ""} ${(await el.getAttribute("aria-label")) ?? ""} ${(await el.getAttribute("title")) ?? ""} ${(await el.getAttribute("data-run")) ?? ""}`;
    const isDelete = DELETE.test(label) || /\bDELETE\b/i.test(label);
    if (isDelete !== wantDelete) continue;
    await el.click({ timeout: 3000 }).catch(() => {});
    await side.page.waitForTimeout(500);
    return label.trim().slice(0, 80);
  }
  return null;
}

const isStarted = (side: Side): Promise<boolean> =>
  side.app
    .locator("body")
    .evaluate(() => {
      const opening = [...document.querySelectorAll("body *")].some(
        (e) => /^\s*Opening/.test(e.textContent ?? "") && e.children.length === 0 && (e as HTMLElement).offsetParent !== null,
      );
      const blocked = !!document.querySelector("main[hidden][inert], #app[hidden][inert]");
      return !opening && !blocked;
    })
    .catch(() => false);
const textOf = (side: Side): Promise<string> => side.app.locator("body").innerText().catch(() => "");

for (const name of APPS) {
  test(name, async ({ browser }) => {
    const scratch = mkdtempSync(join(tmpdir(), `dai-ten-${name}-`));
    const src = join(scratch, "src");
    cpSync(join(here, "apps", name), src, { recursive: true });
    const row: Any = { name, steps: {} };
    const sides: Side[] = [];
    try {
      const built = await compileDirectory({ sourceDir: src, root: repo, appName: name });
      row.shape = built.manifest.replication?.tables.includes("_cs_log") ? "ordinary tables" : `replicated: ${built.manifest.replication?.tables.join(", ") ?? "none"}`;
      const file = join(scratch, `${name}.dai.html`);
      writeFileSync(file, built.html, "utf8");

      // 1. Two devices on one document.
      const a = await device(browser, "A");
      sides.push(a);
      await firstOpen(a, file);
      row.steps.openA = await isStarted(a);
      await settled(a);
      const a0 = await saveOut(a, join(scratch, "a0.dai.html"));
      const b = await device(browser, "B");
      sides.push(b);
      await firstOpen(b, a0);
      row.steps.openB = await isStarted(b);

      // 2. Both write, through the page.
      const typedA = await writeForms(a, 2);
      const typedB = await writeForms(b, 2);
      row.update = { a: await clickControl(a, false), b: await clickControl(b, false) };
      row.delete = { a: await clickControl(a, true) };
      const beforeA = await settled(a);
      const beforeB = await settled(b);
      row.ops = { a: ownOps(beforeA, a), b: ownOps(beforeB, b) };
      row.typed = { a: typedA.length, b: typedB.length };
      row.steps.wroteBoth = typedA.length + typedB.length > 0;

      // 3. Exchange, by file.
      const a1 = await saveOut(a, join(scratch, "a1.dai.html"));
      const b1 = await saveOut(b, join(scratch, "b1.dai.html"));
      await mergeIn(a, b1);
      await mergeIn(b, a1);
      const stateA = stateOf(await settled(a));
      const stateB = stateOf(await settled(b));

      // 4. Converged.
      row.steps.converged = JSON.stringify(stateA) === JSON.stringify(stateB);
      if (!row.steps.converged) row.diff = { a: stateA, b: stateB };
      row.flags = stateA.flags.map((f: Any) => `${f.tbl}:${f.kind}`);

      // 5. Reopen both: the app starts and shows the other side's typing.
      await a.page.reload();
      await b.page.reload();
      await ready(a);
      await ready(b);
      const textA = await textOf(a);
      const textB = await textOf(b);
      row.shows = {
        aShowsB: typedB.length ? typedB.some((t) => textA.includes(t)) : null,
        bShowsA: typedA.length ? typedA.some((t) => textB.includes(t)) : null,
      };
      row.steps.reopened = (await isStarted(a)) && (await isStarted(b)) && row.shows.aShowsB !== false && row.shows.bShowsA !== false;
      await a.page.screenshot({ path: join(out, `${name}-A-merged.png`) });
      await b.page.screenshot({ path: join(out, `${name}-B-merged.png`) });

      // 6. Recovery: a new device, from A's file alone.
      const a2 = await saveOut(a, join(scratch, "a2.dai.html"));
      const c = await device(browser, "C");
      sides.push(c);
      await firstOpen(c, a2);
      const stateC = stateOf(await settled(c));
      const stateA2 = stateOf(await settled(a));
      row.recovery = { equalsA: JSON.stringify(stateC) === JSON.stringify(stateA2), startedC: await isStarted(c) };
      if (!row.recovery.equalsA) row.recovery.diff = { a: stateA2, c: stateC };
      const typedC = await writeForms(c, 1);
      await settled(c);
      const c1 = await saveOut(c, join(scratch, "c1.dai.html"));
      await mergeIn(a, c1);
      const afterC = JSON.stringify(stateOf(await settled(a)));
      row.recovery.aHoldsC = typedC.length ? typedC.some((t) => afterC.includes(t)) : null;
      await c.page.screenshot({ path: join(out, `${name}-C-recovered.png`) });
      row.steps.recovered = row.recovery.equalsA && row.recovery.startedC && row.recovery.aHoldsC !== false;
    } catch (e) {
      row.exception = String((e as Error).stack ?? e).split("\n").slice(0, 3).join(" | ");
    } finally {
      row.errors = Object.fromEntries(sides.map((s) => [s.tag, s.errors.slice(0, 6)]));
      for (const s of sides) await s.page.context().close().catch(() => {});
    }
    row.pass = Object.keys(row.steps).length === 6 && Object.values(row.steps).every(Boolean) && !row.exception;
    writeFileSync(join(out, `${name}.json`), JSON.stringify(row, null, 1) + "\n");
    expect(row.pass, JSON.stringify(row.steps) + (row.exception ? ` ${row.exception}` : "")).toBe(true);
  });
}
