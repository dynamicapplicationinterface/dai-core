import { expect, test } from "@playwright/test";
import { Copy, boot, person, statementsOf, openBytes, DOC } from "./copy.js";
import { SCHEMA, base, item, forgingFull } from "./scenarios.js";
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

/* ------------------------------------------------------------ 1h-M1: receipts */

const rejected = (c: Copy): [string, string][] => c.changes.refusedChanges().map((r: Any) => [r.ver, r.reason]);
/** F's own version at its highest seq. */
const fVer = (f: Copy): string => `${f.changes.authorHex}:${f.db.selectValue("SELECT max(_r_seq) FROM _cs_log WHERE _r_replica = ?", [f.author.author])}`;

function pendingTitles(c: Copy, tent: number): unknown[] {
  const flag = c.flags().find((x: Any) => x.tbl === "items" && x.pk === JSON.stringify([tent]) && x.kind === "pending");
  if (!flag) return [];
  for (const e of JSON.parse(flag.detail) as Any[]) if (e.col === "title") return e.values.map((v: Any) => v.val);
  return [];
}

/**
 * 1h-M1's arrangement: F opened from A's base and edited elsewhere (so its clock runs ahead), never having
 * seen A retitle Tent. F then edits Tent, its basis naming A's retitle, and signs a receipt it did not earn.
 * The reader A holds its own batches, so it checks each receipt entry against the batch it holds.
 */
async function arrange(): Promise<{ a: Copy; f: Copy; tent: number; aTitle: string }> {
  const { a, b } = await base();
  b.close();
  const tent = item(a, "Tent");
  const f = await Copy.open(await person(), await a.bytes(), a.schema);
  for (const note of ["f1", "f2", "f3"]) {
    f.db.exec({ sql: "UPDATE items SET note = ? WHERE title = 'Rope'", bind: [note] });
    f.save();
  }
  a.db.exec({ sql: "UPDATE items SET title = 'Tent (A)' WHERE id = ?", bind: [tent] });
  a.save();
  const aTitle = `${a.changes.authorHex}:${a.db.selectValue("SELECT max(_r_seq) FROM _cs_log WHERE _r_replica = ?", [a.author.author])}`;
  return { a, f, tent, aTitle };
}

/** F's title edit, its basis naming A's retitle (so it would erase it) and its receipt forged by `receipt`. */
function forgeTitle(f: Copy, tent: number, aTitle: string, receipt: (r: Map<string, Any>) => Map<string, Any> | void): void {
  f.db.exec({ sql: "UPDATE items SET title = 'Tent (F)' WHERE id = ?", bind: [tent] });
  forgingFull(f, {
    bases: (op) => {
      if (op[0] === "items" && op[3] instanceof Map && op[3].has("title")) op[5].set("title", [...(op[5].get("title") ?? []), aTitle]);
    },
    receipt,
  });
}

test("1h-M1 control: an honest edit and receipt are accepted; A's retitle and F's are both pending", async () => {
  const { a, f, tent } = await arrange();
  // F's honest edit supersedes only what it showed (A's base title); its receipt is what the runtime built.
  f.db.exec({ sql: "UPDATE items SET title = 'Tent (F)' WHERE id = ?", bind: [tent] });
  f.save();
  await a.mergeFrom(await f.bytes());
  expect(rejected(a), "nothing refused").toEqual([]);
  expect(pendingTitles(a, tent).sort(), "both titles pending").toEqual(["Tent (A)", "Tent (F)"]);
  a.close();
  f.close();
});

for (const [name, receipt] of [
  ["raised to a seq it did not receive, with a forged digest", (r: Map<string, Any>, aTitle: string): void => void r.set(aTitle.split(":")[0]!, [Number(aTitle.split(":")[1]), "00000000000000000000000000000000"])],
  ["a seq at or above its own clock", (r: Map<string, Any>, aTitle: string): void => void r.set(aTitle.split(":")[0]!, [999, "00000000000000000000000000000000"])],
] as const) {
  test(`1h-M1: a receipt ${name} is refused; A's retitle stands`, async () => {
    const { a, f, tent, aTitle } = await arrange();
    forgeTitle(f, tent, aTitle, (r) => receipt(r, aTitle));
    const fv = fVer(f);
    await a.mergeFrom(await f.bytes());
    expect(rejected(a), `${name}: refused receipt-forged`).toEqual([[fv, "receipt-forged"]]);
    expect(a.db.selectValue("SELECT title FROM items WHERE id = ?", [tent]), "A's retitle stands").toBe("Tent (A)");
    expect(a.rows.all("SELECT 1 FROM _cs_cell WHERE ver = ?", [fv]), "F's version in no cell").toEqual([]);
    a.close();
    f.close();
  });
}

test("1h-M1: a receipt going backwards between two of a signer's batches is refused", async () => {
  const { a, f } = await arrange();
  const by = a.changes.authorHex;
  // F's first batch carries its honest receipt (it holds A's base batch); its second un-claims it — backwards.
  f.db.exec({ sql: "UPDATE items SET note = 'f-first' WHERE title = 'Rope'" });
  f.save();
  const first = fVer(f);
  f.db.exec({ sql: "UPDATE items SET note = 'f-second' WHERE title = 'Rope'" });
  forgingFull(f, { receipt: (r) => void r.delete(by) });
  const second = fVer(f);
  await a.mergeFrom(await f.bytes());
  const reasons = Object.fromEntries(rejected(a));
  expect(reasons[first], "the first, honest batch is not refused").toBeUndefined();
  expect(reasons[second], "the backwards batch refused").toBe("receipt-forged");
  a.close();
  f.close();
});
