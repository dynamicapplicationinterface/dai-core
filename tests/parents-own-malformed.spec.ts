import { DatabaseSync } from "node:sqlite";
import { expect, test } from "@playwright/test";
import { rewriteReplicated } from "../src/replicated.js";
import { applyRow, changeEntity, type Rows } from "../src/replicated-rows.js";
import { SESSION_ID_FUNCTION, sessionIdOf } from "../src/session-id.js";

/**
 * A copy's own malformed row names nothing (docs/format.md,
 * `parents-own-malformed`; the step 6 review, Pass 1).
 *
 * A merge never takes a row whose parents are not the one shape, so the only
 * such row a copy can hold is one it wrote itself. Its views read parents with
 * `json_each`, which walks 257 ids where the format reads none, and throws on
 * text that is not JSON or nests past depth 1000: one such row stopped every
 * read of its table's heads, and every write that versions its entity. The
 * format says a reader checks the shape before it reads a row's parents for any
 * purpose (`parents-malformed`), and reads a malformed row's as naming
 * nothing.
 */

function openWith(schema: string): Rows & { close(): void } {
  const db = new DatabaseSync(":memory:");
  db.function(SESSION_ID_FUNCTION, { deterministic: true }, (author, seq, seat, seats, close) => sessionIdOf(author, seq, seat, seats, close));
  db.exec(rewriteReplicated(schema).sql);
  return {
    all: (sql, params = []) => db.prepare(sql).all(...(params as never[])) as Record<string, unknown>[],
    run: (sql, params = []) => {
      db.prepare(sql).run(...(params as never[]));
    },
    close: () => db.close(),
  };
}

const bytes = (byte: number): Uint8Array => new Uint8Array(16).fill(byte);
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const A = bytes(0xaa);
const B = bytes(0xbb);
const E = bytes(0x01);

function put(
  db: Rows,
  table: string,
  replica: Uint8Array,
  seq: number,
  entity: Uint8Array,
  columns: Record<string, unknown>,
  parents: string,
  session?: Uint8Array,
) {
  applyRow(db, table, {
    _r_replica: replica,
    _r_seq: seq,
    _r_lc: seq,
    _r_entity: entity,
    _r_parents: parents,
    _r_deleted: 0,
    ...(session ? { _r_session: session } : {}),
    columns,
  });
}

/** Every view of the document, each read whole: none may throw. */
const readsEveryView = (db: Rows): Record<string, number> =>
  Object.fromEntries(
    db
      .all("SELECT name FROM sqlite_schema WHERE type = 'view' ORDER BY name")
      .map((v) => String(v["name"]))
      .map((name) => [name, Number(db.all(`SELECT count(*) AS n FROM "${name}"`)[0]!["n"])]),
  );

const NOT_JSON = "not json";
const TOO_DEEP = "[".repeat(1001) + "]".repeat(1001);

const PLAIN = `-- dai:replicated
CREATE TABLE notes (
  body TEXT NOT NULL
);
`;

test("a plain table: a row naming 257 parents names none of them, so all 258 are heads", () => {
  const db = openWith(PLAIN);
  const ids: string[] = [];
  for (let seq = 1; seq <= 257; seq += 1) {
    put(db, "notes", A, seq, E, { body: `v${seq}` }, "[]");
    ids.push(`${hex(A)}:${seq}`);
  }
  put(db, "notes", A, 258, E, { body: "too many" }, JSON.stringify(ids));
  expect(Number(db.all("SELECT count(*) AS n FROM notes_heads")[0]!["n"]), "every version is a head").toBe(258);
  expect(Number(db.all("SELECT _r_conflicted AS c FROM notes_current")[0]!["c"]), "and the entity shows as conflicted").toBe(1);
  db.close();
});

for (const [what, text] of [
  ["text that is not JSON", NOT_JSON],
  ["JSON nested past depth 1000", TOO_DEEP],
] as const) {
  test(`a plain table: ${what} names nothing, and the heads and the next write read on`, () => {
    const db = openWith(PLAIN);
    put(db, "notes", A, 1, E, { body: "first" }, "[]");
    put(db, "notes", A, 2, E, { body: "malformed" }, text);
    expect(() => readsEveryView(db), "every view reads").not.toThrow();
    expect(db.all("SELECT body FROM notes_heads ORDER BY body").map((r) => r["body"])).toEqual(["first", "malformed"]);
    // Another row arrives, and this copy versions the entity: both read the parents of every row of it.
    put(db, "notes", B, 1, bytes(0x02), { body: "Bo's" }, "[]");
    db.run("INSERT INTO _dai_replica (id, seq, lc) VALUES (?, 2, 2)", [A]);
    const next = changeEntity(db, "notes", E, { body: "next" });
    expect(JSON.parse(next._r_parents).sort(), "the next version names both heads").toEqual([`${hex(A)}:1`, `${hex(A)}:2`]);
    expect(db.all("SELECT body FROM notes_heads ORDER BY body").map((r) => r["body"])).toEqual(["Bo's", "next"]);
    db.close();
  });
}

test("a session document: a member's malformed rows, in an author table, a seated one and the roster, stop no view", () => {
  const S = sessionIdOf(A, 1, bytes(0xa1), bytes(0xa2), "any")!; // Ada's seat row is her seq 1, declaring the open seat
  const db = openWith(`-- dai:profile session max_parties=2
-- dai:replicated
CREATE TABLE notes (
  body TEXT NOT NULL
);
-- dai:replicated seat=seat
CREATE TABLE moves (
  san TEXT NOT NULL,
  seat BLOB
);
`);
  db.run("INSERT INTO _dai_replica (id, seq, lc) VALUES (?, 0, 0)", [A]);
  put(db, "_dai_seat", A, 1, bytes(0x11), { seat: bytes(0xa1), seats: bytes(0xa2), close: "any" }, "[]", S);
  put(db, "_dai_seat", A, 2, bytes(0x12), { seat: bytes(0xa2) }, "[]", S); // a seat row that counts for nothing (R14)
  put(db, "_dai_binding", B, 1, bytes(0x14), { seat: bytes(0xa2) }, "[]", S);
  put(db, "_dai_confirm", A, 3, bytes(0x13), { seat: bytes(0xa2), holder: B }, "[]", S);
  put(db, "notes", A, 4, E, { body: "first" }, "[]", S);
  put(db, "moves", A, 5, bytes(0x21), { san: "e4", seat: bytes(0xa1) }, "[]", S);
  const before = readsEveryView(db);

  // Ada's own malformed rows: a note, a move, and a version of a seat row of hers.
  put(db, "notes", A, 6, E, { body: "malformed" }, NOT_JSON, S);
  put(db, "moves", A, 7, bytes(0x21), { san: "d4", seat: bytes(0xa1) }, TOO_DEEP, S);
  put(db, "_dai_seat", A, 8, bytes(0x12), { seat: bytes(0xa2) }, NOT_JSON, S);
  const after = readsEveryView(db);
  expect(after["_dai_holder"], "Bo still holds his seat").toBe(before["_dai_holder"]);
  expect(db.all("SELECT body FROM notes_heads ORDER BY body").map((r) => r["body"]), "the note names nothing").toEqual([
    "first",
    "malformed",
  ]);
  expect(db.all("SELECT san FROM moves_heads ORDER BY san").map((r) => r["san"]), "nor does the move").toEqual(["d4", "e4"]);
  expect(db.all("SELECT count(*) AS n FROM moves_foreign")[0]!["n"], "and it crosses nothing").toBe(0);
  expect(db.all("SELECT count(*) AS n FROM moves_other_seat")[0]!["n"]).toBe(0);

  db.run("UPDATE _dai_replica SET seq = 8, lc = 8");
  const next = changeEntity(db, "notes", E, { body: "next" }, S);
  expect(JSON.parse(next._r_parents).sort(), "the next version names both heads").toEqual([`${hex(A)}:4`, `${hex(A)}:6`]);
  db.close();
});
