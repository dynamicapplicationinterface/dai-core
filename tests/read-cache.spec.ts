import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, test } from "@playwright/test";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(repo, "dist", "bin.js");

/**
 * The read helpers keep what they compiled (src/runtime/bootloader.ts,
 * keepReads), and answer exactly as exec does.
 *
 * selectObjects and selectArrays prepared their SQL on every call, and in a
 * session document preparing was nearly all of a read's cost. They now keep
 * each read-only statement and reset it after use. What must not change is
 * any answer: the same rows as exec, each call's own binding, a schema change
 * seen at once, a bind on a statement with no parameters ignored as exec
 * ignores it, an error thrown and the next read unharmed, and a write through
 * a read helper run every time, as a write.
 */
const APP = `<!doctype html>
<meta charset="utf-8">
<title>Reads</title>
<p id="out">starting</p>
<script type="module">
  const out = document.getElementById("out");
  try {
    const db = await window.dai.openDatabase();
    db.exec("CREATE TABLE IF NOT EXISTS t (a INTEGER, b TEXT)");
    db.exec("INSERT INTO t VALUES (1, 'one'), (2, NULL)");
    const viaExec = db.exec({ sql: "SELECT * FROM t ORDER BY a", rowMode: "object", returnValue: "resultRows" });
    const first = db.selectObjects("SELECT * FROM t ORDER BY a");
    const again = db.selectObjects("SELECT * FROM t ORDER BY a");
    const arrays = db.selectArrays("SELECT * FROM t ORDER BY a");
    const bound = [db.selectObjects("SELECT b FROM t WHERE a = ?", [1]), db.selectObjects("SELECT b FROM t WHERE a = ?", [2])];
    const unbound = db.selectObjects("SELECT 7 AS x", [5]);
    db.exec("ALTER TABLE t ADD COLUMN c INTEGER DEFAULT 3");
    const altered = db.selectObjects("SELECT * FROM t ORDER BY a");
    let threw = "";
    try { db.selectObjects("SELECT nope FROM t"); } catch (error) { threw = String(error.message || error); }
    const after = db.selectObjects("SELECT count(*) AS n FROM t");
    const written = [db.selectObjects("INSERT INTO t (a) VALUES (9) RETURNING a"), db.selectObjects("INSERT INTO t (a) VALUES (9) RETURNING a")];
    const nines = db.selectObjects("SELECT count(*) AS n FROM t WHERE a = 9");
    out.textContent = JSON.stringify({ viaExec, first, again, arrays, bound, unbound, altered, threw, after, written, nines });
  } catch (error) {
    out.textContent = "refused:" + String(error && error.message ? error.message : error);
  }
</script>`;

test("the read helpers keep what they compiled and answer as exec does", async ({ page }) => {
  const dir = mkdtempSync(join(tmpdir(), "dai-read-cache-"));
  writeFileSync(join(dir, "index.html"), APP);
  const container = join(dir, "reads.dai.html");
  execFileSync(process.execPath, [cli, "build", dir, "-o", container, "--quiet"], { cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
  await page.goto(pathToFileURL(container).href);
  const out = page.frameLocator("#dai-app").locator("#out");
  await expect(out).not.toHaveText("starting", { timeout: 30_000 });
  const text = (await out.textContent()) ?? "";
  expect(text, "the application opened and read").not.toMatch(/^refused:/);
  const seen = JSON.parse(text);
  const rows = [{ a: 1, b: "one" }, { a: 2, b: null }];
  expect(seen.viaExec).toEqual(rows);
  expect(seen.first, "the same rows as exec").toEqual(seen.viaExec);
  expect(seen.again, "and again, from the kept statement").toEqual(seen.viaExec);
  expect(seen.arrays).toEqual([[1, "one"], [2, null]]);
  expect(seen.bound, "each call's own binding").toEqual([[{ b: "one" }], [{ b: null }]]);
  expect(seen.unbound, "a bind on a statement with no parameters is ignored, as exec ignores it").toEqual([{ x: 7 }]);
  expect(seen.altered, "a schema change is seen at once").toEqual([{ a: 1, b: "one", c: 3 }, { a: 2, b: null, c: 3 }]);
  expect(seen.threw, "an error is thrown").toMatch(/nope/);
  expect(seen.after, "and the next read is unharmed").toEqual([{ n: 2 }]);
  expect(seen.written, "a write through a read helper runs every time").toEqual([[{ a: 9 }], [{ a: 9 }]]);
  expect(seen.nines).toEqual([{ n: 2 }]);
});
