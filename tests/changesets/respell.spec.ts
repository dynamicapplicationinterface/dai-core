import { expect, test } from "@playwright/test";
import { Copy, person } from "./copy.js";
import { base } from "./scenarios.js";

/**
 * 1e-H3: a key respelled under its own collation or storage class is one row
 * to SQLite, and its new spelling travels as a value change: the key's
 * columns are registers like any column, written by a birth and by a
 * respelling, never by an edit of another column. Shown on every copy as the
 * last writer's by (lc, author); concurrent with an edit of another column,
 * with a deletion, and with a copy that still holds the old spelling.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

const KEYED = [
  `CREATE TABLE people (email TEXT PRIMARY KEY COLLATE NOCASE, name TEXT);
   CREATE TABLE nums (k PRIMARY KEY, v TEXT);
   CREATE TABLE pairs (x TEXT COLLATE NOCASE, y INTEGER, v TEXT, PRIMARY KEY (x, y));
   CREATE TABLE grid (x TEXT COLLATE NOCASE, y INTEGER, v TEXT, PRIMARY KEY (x, y)) WITHOUT ROWID;`,
  `INSERT INTO people (email, name) VALUES ('bob@x.com', 'Bob');
   INSERT INTO nums (k, v) VALUES (1, 'one');
   INSERT INTO pairs (x, y, v) VALUES ('Key', 1, 'p');
   INSERT INTO grid (x, y, v) VALUES ('Key', 1, 'g');`,
];

async function swap(a: Copy, b: Copy): Promise<boolean> {
  const [ab, bb] = [await a.bytes(), await b.bytes()];
  await a.mergeFrom(bb);
  await b.mergeFrom(ab);
  return a.state() === b.state();
}

/** Each row's key as stored: its text or value, and its storage class. */
const spelled = (c: Copy): unknown => ({
  people: c.db.selectArrays("SELECT email, name FROM people"),
  nums: c.db.selectArrays("SELECT typeof(k), v FROM nums"),
  pairs: c.db.selectArrays("SELECT x, v FROM pairs"),
  grid: c.db.selectArrays("SELECT x, v FROM grid"),
});

test("1e-H3: a respelled key travels, and a later edit on the other copy does not take it back", async () => {
  const { a, b } = await base({ extra: KEYED });
  a.db.exec(`UPDATE people SET email = 'Bob@X.com' WHERE email = 'bob@x.com';
    UPDATE nums SET k = 1.0 WHERE k = 1;
    UPDATE pairs SET x = 'KEY' WHERE x = 'Key';
    UPDATE grid SET x = 'KEY' WHERE x = 'Key';`);
  await b.mergeFrom(await a.bytes());
  const want = { people: [["Bob@X.com", "Bob"]], nums: [["real", "one"]], pairs: [["KEY", "p"]], grid: [["KEY", "g"]] };
  expect(spelled(b), "B has A's spelling").toEqual(want);
  // B edits another column, holding A's spelling; A merges it back.
  b.db.exec("UPDATE people SET name = 'Robert'; UPDATE nums SET v = 'uno'; UPDATE pairs SET v = 'p2'; UPDATE grid SET v = 'g2';");
  expect(await swap(a, b), "converged").toBe(true);
  for (const c of [a, b]) {
    expect(spelled(c)).toEqual({ people: [["Bob@X.com", "Robert"]], nums: [["real", "uno"]], pairs: [["KEY", "p2"]], grid: [["KEY", "g2"]] });
    expect(c.flags(), "nothing flagged").toEqual([]);
  }
  a.close();
  b.close();
});

test("1e-H3: a respelling concurrent with another column's edit, and with a copy holding the old spelling", async () => {
  const { a, b } = await base({ extra: KEYED });
  a.db.exec("UPDATE people SET email = 'Bob@X.com' WHERE email = 'bob@x.com'; UPDATE pairs SET x = 'KEY' WHERE x = 'Key';");
  // B still spells the keys the old way, and edits another column of each row.
  b.db.exec("UPDATE people SET name = 'Robert' WHERE email = 'bob@x.com'; UPDATE pairs SET v = 'p2' WHERE x = 'Key';");
  expect(await swap(a, b), "converged").toBe(true);
  for (const c of [a, b]) {
    expect(c.db.selectArrays("SELECT email, name FROM people"), "A's spelling, B's name").toEqual([["Bob@X.com", "Robert"]]);
    expect(c.db.selectArrays("SELECT x, v FROM pairs")).toEqual([["KEY", "p2"]]);
    expect(c.flags(), "nothing flagged").toEqual([]);
  }
  a.close();
  b.close();
});

test("1e-H3: a respelling concurrent with a deletion keeps the row, under the new spelling, flagged", async () => {
  const { a, b } = await base({ extra: KEYED });
  a.db.exec("UPDATE people SET email = 'Bob@X.com' WHERE email = 'bob@x.com'");
  b.db.exec("DELETE FROM people WHERE email = 'bob@x.com'");
  expect(await swap(a, b), "converged").toBe(true);
  for (const c of [a, b]) {
    expect(c.db.selectArrays("SELECT email, name FROM people")).toEqual([["Bob@X.com", "Bob"]]);
    expect(c.flags().map((f: Any) => [f.tbl, f.kind])).toEqual([["people", "delete-conflict"]]);
  }
  a.close();
  b.close();
});

test("1e-H3: two concurrent respellings show the last writer's by (lc, author) on every copy, both kept", async () => {
  const { a, b } = await base({ extra: KEYED });
  a.db.exec("UPDATE people SET email = 'Bob@X.com' WHERE email = 'bob@x.com'");
  b.db.exec("UPDATE people SET email = 'BOB@X.COM' WHERE email = 'bob@x.com'");
  expect(await swap(a, b), "converged").toBe(true);
  const versions = a.rows.all("SELECT val, lc, author FROM _cs_cell WHERE tbl = 'people' AND col = 'email' AND val IN ('Bob@X.com', 'BOB@X.COM')");
  expect(versions.map((v) => v["val"]).sort(), "both spellings kept").toEqual(["BOB@X.COM", "Bob@X.com"]);
  const last = versions.sort((x, y) => Number(y["lc"]) - Number(x["lc"]) || (String(y["author"]) < String(x["author"]) ? -1 : 1))[0]!["val"];
  for (const c of [a, b]) expect(c.db.selectValue("SELECT email FROM people"), "the last writer's").toBe(last);
  a.close();
  b.close();
});

test("1e-H3: a copy that opens after the respelling, from the log alone, shows it", async () => {
  const { a, b } = await base({ extra: KEYED });
  a.db.exec("UPDATE people SET email = 'Bob@X.com' WHERE email = 'bob@x.com'");
  const c = await Copy.open(await person(), await a.bytes());
  expect(c.db.selectValue("SELECT email FROM people")).toBe("Bob@X.com");
  for (const x of [a, b, c]) x.close();
});
