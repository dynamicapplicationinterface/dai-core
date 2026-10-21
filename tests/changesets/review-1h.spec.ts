import { expect, test } from "@playwright/test";
import { Copy, boot, person, statementsOf, openBytes, DOC } from "./copy.js";
import { SCHEMA, base, item } from "./scenarios.js";
import * as merge from "../../src/replicated-frame.js";

/**
 * The review of Build 1h (`handoff-2026-10-19.md`, "Code review — PR #9,
 * Build 1h"): its high finding and its reopened medium, each red first.
 *
 * 1h-H1: application code runs as the runtime. It only has to replace a method
 * of its own handle, or `Stmt.prototype.step`, and the runtime — reading
 * through those during a trusted operation — runs it with the authorizer off.
 * 1h-M2: the VACUUM statement's own exec runs application code by five routes.
 *
 * The fix: the runtime calls only the engine primitives it captured before the
 * application had the handle, so nothing the application can replace runs while
 * the runtime reads, writes or runs a VACUUM.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;
const m = merge as Any;

/** A chain that attaches a database outside the document and writes it: refused unless app code runs trusted. */
const CHAIN = "ATTACH '' AS t; CREATE TABLE t.x (y); INSERT INTO t.x VALUES ('in window')";
const databases = (db: Any): string[] => db.selectValues("SELECT name FROM pragma_database_list ORDER BY name");
/** Runs `f`, keeping any error it throws. */
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

/** A normal exchange after an attack: the copies still converge, and nothing the attack wrote lingers. */
async function converges(a: Copy, b: Copy): Promise<void> {
  b.db.exec("INSERT INTO items (title) VALUES ('Lamp')");
  await a.mergeFrom(await b.bytes());
  await b.mergeFrom(await a.bytes());
  expect(a.changes.dirty, "A has nothing uncaptured").toBe(false);
  expect(a.state(), "the copies converge").toBe(b.state());
}

const categoriesStatement = async (): Promise<string> =>
  statementsOf(await boot(), SCHEMA).find((x) => /CREATE TABLE IF NOT EXISTS categories/.test(x))!;

test("1h-H1: a patched Stmt.prototype.step runs no code while the runtime reads sqlite_schema for an admitted CREATE", async () => {
  const { a, b } = await base();
  const categories = await categoriesStatement();
  const run = protoExec(a.db);
  const proto = stmtProtoOf(a.db);
  const realStep = proto.step;
  let fired = 0;
  proto.step = function (this: Any, ...args: Any[]): Any {
    if (fired === 0) {
      fired = 1;
      tried(() => run(CHAIN));
    }
    return realStep.apply(this, args);
  };
  try {
    // The runtime reads sqlite_schema in pieces() to verify the admitted statement.
    tried(() => a.db.exec(categories));
  } finally {
    proto.step = realStep;
  }
  expect(databases(a.db), "nothing attached by code riding the runtime's own read").toEqual(["main", "temp"]);
  expect(() => a.db.exec("INSERT INTO t.x VALUES ('after')"), "no table outside the document").toThrow();
  expect(a.changes.refused, "no runtime object was forged").toEqual([]);
  await converges(a, b);
  a.close();
  b.close();
});

// Each handle read the runtime makes during a trusted operation, patched: the schema read in pieces()
// (selectValue), and the reads of a save (selectObjects). The first patched call is the runtime's own.
for (const [method, trigger] of [
  ["selectValue", "an admitted CREATE's schema read"],
  ["selectObjects", "a save's reads"],
] as const) {
  test(`1h-H1: a patched handle.${method} runs no code during ${trigger}`, async () => {
    const { a, b } = await base();
    const categories = await categoriesStatement();
    const run = protoExec(a.db);
    const real = (a.db as Any)[method].bind(a.db);
    let fired = 0;
    (a.db as Any)[method] = (...args: Any[]): Any => {
      if (fired === 0) {
        fired = 1;
        tried(() => run(CHAIN));
      }
      return real(...args);
    };
    try {
      if (method === "selectValue") {
        a.db.exec(categories);
      } else {
        a.db.exec("UPDATE items SET qty = qty + 1 WHERE title = 'Map'");
        a.save();
      }
    } finally {
      delete (a.db as Any)[method];
    }
    expect(databases(a.db), "nothing attached").toEqual(["main", "temp"]);
    expect(() => a.db.exec("INSERT INTO t.x VALUES ('after')")).toThrow();
    expect(a.changes.refused, "no write to a runtime table").toEqual([]);
    await converges(a, b);
    a.close();
    b.close();
  });
}

test("1h-M2: the runtime never iterates an application-owned saveSql inside the VACUUM's exec", async () => {
  const { a, b } = await base();
  const run = protoExec(a.db);
  const evil: Any = [];
  evil.push = (): number => {
    tried(() => run(CHAIN));
    return 0;
  };
  tried(() => a.db.exec({ sql: "VACUUM", saveSql: evil }));
  expect(databases(a.db), "the VACUUM ran, nothing rode its saveSql").toEqual(["main", "temp"]);
  expect(() => a.db.exec("INSERT INTO t.x VALUES ('after')")).toThrow();
  await converges(a, b);
  a.close();
  b.close();
});

test("1h-M2: a patched Stmt.prototype.step runs no code while the runtime steps a VACUUM, by exec and by prepare+step", async () => {
  const { a, b } = await base();
  const run = protoExec(a.db);
  const proto = stmtProtoOf(a.db);
  const realStep = proto.step;
  const routes: [string, () => unknown][] = [
    ["exec", () => a.db.exec("VACUUM")],
    ["prepare+step", () => {
      const s = a.db.prepare("VACUUM");
      try {
        s.step();
      } finally {
        s.finalize();
      }
    }],
  ];
  for (const [name, route] of routes) {
    let fired = 0;
    proto.step = function (this: Any, ...args: Any[]): Any {
      if (fired === 0) {
        fired = 1;
        tried(() => run(CHAIN));
      }
      return realStep.apply(this, args);
    };
    try {
      tried(route);
    } finally {
      proto.step = realStep;
    }
    expect(databases(a.db), `${name}: nothing attached`).toEqual(["main", "temp"]);
    tried(() => a.db.exec("DETACH t"));
  }
  await converges(a, b);
  a.close();
  b.close();
});

test("1h-M2: a patched capi.sqlite3_prepare_v3 runs no code while the runtime prepares a VACUUM", async () => {
  const { a, b } = await base();
  const sqlite3 = await boot();
  const run = protoExec(a.db);
  const real = sqlite3.capi.sqlite3_prepare_v3;
  let fired = 0;
  sqlite3.capi.sqlite3_prepare_v3 = function (this: Any, ...args: Any[]): Any {
    if (fired === 0) {
      fired = 1;
      tried(() => run(CHAIN));
    }
    return real.apply(this, args);
  };
  try {
    tried(() => a.db.exec("VACUUM"));
  } finally {
    sqlite3.capi.sqlite3_prepare_v3 = real;
  }
  expect(databases(a.db), "nothing attached").toEqual(["main", "temp"]);
  expect(() => a.db.exec("INSERT INTO t.x VALUES ('after')")).toThrow();
  await converges(a, b);
  a.close();
  b.close();
});

test("1h-M2: an application progress handler does not fire while the runtime steps a VACUUM", async () => {
  const { a, b } = await base();
  const sqlite3 = await boot();
  const run = protoExec(a.db);
  let fired = 0;
  const cb = (): number => {
    if (fired === 0) {
      fired = 1;
      tried(() => run(CHAIN));
    }
    return 0;
  };
  sqlite3.capi.sqlite3_progress_handler(a.db.pointer, 1, cb, 0);
  try {
    tried(() => a.db.exec("VACUUM"));
  } finally {
    tried(() => sqlite3.capi.sqlite3_progress_handler(a.db.pointer, 0, 0, 0));
  }
  expect(databases(a.db), "nothing attached by a progress handler").toEqual(["main", "temp"]);
  expect(() => a.db.exec("INSERT INTO t.x VALUES ('after')")).toThrow();
  await converges(a, b);
  a.close();
  b.close();
});

test("1h-H1: with every handle method and every Stmt.prototype method replaced to throw, a save and a merge still run", async () => {
  const { a, b } = await base();
  const bread = item(a, "Bread");
  b.db.exec({ sql: "UPDATE items SET qty = 9 WHERE id = ?", bind: [bread] });
  // A's own edit, captured but not yet saved: the save below logs it, through the captured engine alone.
  a.db.exec({ sql: "UPDATE items SET note = 'A note' WHERE id = ?", bind: [bread] });
  // The sibling is read through the captured engine, as the frame reads it, so a replaced prototype cannot
  // break the merge any more than it can hijack it.
  const bBytes = await b.bytes();
  const sib = await openBytes(bBytes);
  const sibRows = m.createRows(sib.sqlite3, sib.db);
  const verdicts = await m.verifyBatches(sibRows, m.mergeTablesOf(sibRows), DOC);

  const dbProto = Object.getPrototypeOf(a.db);
  const stmtProto = stmtProtoOf(a.db);
  const saved: [Any, string, Any][] = [];
  const poison = (proto: Any): void => {
    for (const name of Object.getOwnPropertyNames(proto)) {
      const d = Object.getOwnPropertyDescriptor(proto, name)!;
      if (typeof d.value === "function" && name !== "constructor") {
        saved.push([proto, name, d.value]);
        proto[name] = (): never => {
          throw new Error(`handle.${name} must not be called by the runtime`);
        };
      }
    }
  };
  // Instance-own wrappers the runtime installed (exec, prepare, changes, createFunction) too.
  for (const name of Object.getOwnPropertyNames(a.db)) {
    const d = Object.getOwnPropertyDescriptor(a.db, name)!;
    if (typeof d.value === "function") {
      saved.push([a.db, name, d.value]);
      (a.db as Any)[name] = (): never => {
        throw new Error(`instance.${name} must not be called by the runtime`);
      };
    }
  }
  poison(dbProto);
  poison(stmtProto);
  try {
    expect(a.save()?.ops, "the save logged A's own change").toBe(1);
    a.changes.trusted(() => m.mergeVerified(a.rows, sibRows, { document: DOC, author: a.author.author, verdicts }));
    a.changes.projectAdmitted();
  } finally {
    for (const [target, name, fn] of saved.reverse()) target[name] = fn;
    sib.db.close();
  }
  const row = a.db.selectObject("SELECT qty, note FROM items WHERE id = ?", [bread]) as Any;
  expect(row, "A's own save and B's merged value both landed").toEqual({ qty: 9, note: "A note" });
  a.close();
  b.close();
});
