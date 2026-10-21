import { expect, test } from "@playwright/test";
import { boot, openBytes, DOC } from "./copy.js";
import { base, item } from "./scenarios.js";
import * as merge from "../../src/replicated-frame.js";

/**
 * The review of Build 1i (`handoff-2026-10-19.md`, "Code review — PR #9,
 * Build 1i"): its observation and its low finding, each red first.
 *
 * The observation: capturing oo1's `Stmt.prototype.step` did not capture what
 * that function calls. Its body reaches `capi.sqlite3_step` by property at each
 * call, and the engine read `wasm.pstack` at each call, so an application that
 * replaced either still ran code on the runtime's own path. The fix: the
 * runtime's path calls the module's WebAssembly exports, captured before the
 * application has the handle, and reads and writes the module's memory itself.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;
const m = merge as Any;

/** A chain that attaches a database outside the document and writes it: refused unless app code runs trusted. */
const CHAIN = "ATTACH '' AS t; CREATE TABLE t.x (y); INSERT INTO t.x VALUES ('in window')";
const databases = (db: Any): string[] => db.selectValues("SELECT name FROM pragma_database_list ORDER BY name");
const tried = (f: () => unknown): unknown => {
  try {
    return f();
  } catch (e) {
    return e;
  }
};
/** The pristine oo1 exec, bound to the handle: the attack's way to run SQL with the authorizer as the runtime left it. */
const protoExec = (db: Any): ((sql: unknown) => unknown) => Object.getPrototypeOf(db).exec.bind(db);
const stmtProtoOf = (db: Any): Any => {
  const s = db.prepare("SELECT 1");
  const proto = Object.getPrototypeOf(s);
  s.finalize();
  return proto;
};

/** Replaces every writable function property of `target` with `make(name)`, recording the original in `saved`. */
function replaceAll(target: Any, saved: [Any, string, Any][], make: (name: string) => Any): void {
  for (const name of Object.getOwnPropertyNames(target)) {
    const d = Object.getOwnPropertyDescriptor(target, name)!;
    if (typeof d.value === "function" && d.writable && name !== "constructor") {
      saved.push([target, name, d.value]);
      target[name] = make(name);
    }
  }
}

test("1i observation: a replaced capi.sqlite3_step runs no code while the runtime steps a save", async () => {
  const { a, b } = await base();
  const sqlite3 = await boot();
  const run = protoExec(a.db);
  a.db.exec("UPDATE items SET qty = qty + 1 WHERE title = 'Map'");
  const real = sqlite3.capi.sqlite3_step;
  let fired = 0;
  sqlite3.capi.sqlite3_step = function (this: Any, ...args: Any[]): Any {
    if (fired === 0) {
      fired = 1;
      tried(() => run(CHAIN));
    }
    return real.apply(this, args);
  };
  try {
    tried(() => a.save());
  } finally {
    sqlite3.capi.sqlite3_step = real;
  }
  expect(databases(a.db), "nothing attached by code riding the runtime's own step").toEqual(["main", "temp"]);
  expect(() => a.db.exec("INSERT INTO t.x VALUES ('after')"), "no table outside the document").toThrow();
  expect(a.changes.refused, "no runtime object was forged").toEqual([]);
  a.close();
  b.close();
});

test("1i observation: a replaced wasm.cstrToJs runs no code while the runtime's authorizer reads its own prepare", async () => {
  const { a, b } = await base();
  const sqlite3 = await boot();
  const run = protoExec(a.db);
  a.db.exec("UPDATE items SET qty = qty + 1 WHERE title = 'Map'");
  const real = sqlite3.wasm.cstrToJs;
  // Tried at every call until it lands: the reads outside the authorizer are the application's own, and refused.
  let busy = false;
  let landed = false;
  sqlite3.wasm.cstrToJs = function (this: Any, ...args: Any[]): Any {
    if (!busy && !landed) {
      busy = true;
      landed = !(tried(() => run(CHAIN)) instanceof Error);
      busy = false;
    }
    return real.apply(this, args);
  };
  try {
    tried(() => a.save());
  } finally {
    sqlite3.wasm.cstrToJs = real;
  }
  expect(databases(a.db), "nothing attached by code riding the authorizer's reading").toEqual(["main", "temp"]);
  expect(() => a.db.exec("INSERT INTO t.x VALUES ('after')"), "no table outside the document").toThrow();
  a.close();
  b.close();
});

test("1i observation: with every handle, Stmt.prototype, capi, pstack and wasm function replaced to throw, a save and a merge still run", async () => {
  const { a, b } = await base();
  const sqlite3 = await boot();
  const bread = item(a, "Bread");
  b.db.exec({ sql: "UPDATE items SET qty = 9 WHERE id = ?", bind: [bread] });
  // A's own edit, captured but not yet saved: the save below logs it, through the captured engine alone.
  a.db.exec({ sql: "UPDATE items SET note = 'A note' WHERE id = ?", bind: [bread] });
  const sib = await openBytes(await b.bytes());
  const sibRows = m.createRows(sib.sqlite3, sib.db);
  const verdicts = await m.verifyBatches(sibRows, m.mergeTablesOf(sibRows), DOC);

  const saved: [Any, string, Any][] = [];
  const thrower = (where: string) => (name: string) => (): never => {
    throw new Error(`${where}.${name} must not be called by the runtime`);
  };
  const stmtProto = stmtProtoOf(a.db);
  replaceAll(a.db, saved, thrower("instance"));
  replaceAll(Object.getPrototypeOf(a.db), saved, thrower("handle"));
  replaceAll(stmtProto, saved, thrower("Stmt.prototype"));
  replaceAll(sqlite3.capi, saved, thrower("capi"));
  replaceAll(sqlite3.wasm.pstack, saved, thrower("pstack"));
  replaceAll(sqlite3.wasm, saved, thrower("wasm"));
  let ops: unknown;
  try {
    ops = a.save()?.ops;
    a.changes.trusted(() => m.mergeVerified(a.rows, sibRows, { document: DOC, author: a.author.author, verdicts }));
    a.changes.projectAdmitted();
  } finally {
    for (const [target, name, fn] of saved.reverse()) target[name] = fn;
    sib.db.close();
  }
  expect(ops, "the save logged A's own change").toBe(1);
  const row = a.db.selectObject("SELECT qty, note FROM items WHERE id = ?", [bread]) as Any;
  expect(row, "A's own save and B's merged value both landed").toEqual({ qty: 9, note: "A note" });
  a.close();
  b.close();
});
