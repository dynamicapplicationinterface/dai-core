import { DatabaseSync } from "node:sqlite";
import { expect, test } from "@playwright/test";
import { rewriteReplicated } from "../src/replicated.js";
import { applyRow, filterToSession, type Rows } from "../src/replicated-rows.js";
import { SESSION_ID_FUNCTION, sessionIdOf } from "../src/session-id.js";

/**
 * A parent outside the row's own entity hides nothing (cold review of identity
 * step 5, finding 5; it predates that step).
 *
 * A row supersedes the rows it names as parents, and that is how an edit
 * replaces what it edits. A row may only replace its own entity's history: a
 * row that names a row of another entity as its parent says nothing about that
 * entity, so the named row stays a head. Otherwise any author could hide any
 * other entity's current row, a move for Black burying White's move, by listing
 * it as a parent.
 */

function openWith(schema: string): Rows & { close(): void } {
  const db = new DatabaseSync(":memory:");
  db.function(SESSION_ID_FUNCTION, { deterministic: true }, (author, nonce) => sessionIdOf(author, nonce));
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

function put(db: Rows, table: string, replica: Uint8Array, seq: number, lc: number, entity: Uint8Array, columns: Record<string, unknown>, parents: string[] = [], session?: Uint8Array) {
  applyRow(db, table, {
    _r_replica: replica,
    _r_seq: seq,
    _r_lc: lc,
    _r_entity: entity,
    _r_parents: JSON.stringify(parents),
    _r_deleted: 0,
    ...(session ? { _r_session: session } : {}),
    columns,
  });
}

test("a plain table: a row naming another entity's row as its parent does not supersede it", () => {
  const db = openWith(`-- dai:replicated
CREATE TABLE notes (
  body TEXT NOT NULL
);
`);
  put(db, "notes", A, 1, 1, bytes(0x01), { body: "Ada's note" });
  put(db, "notes", B, 1, 2, bytes(0x02), { body: "Bo's note" }, [`${hex(A)}:1`]);
  const current = db.all("SELECT body FROM notes_current ORDER BY body").map((r) => r["body"]);
  expect(current, "Ada's note is still its entity's head").toEqual(["Ada's note", "Bo's note"]);
  const flag = db.all("SELECT _r_superseded AS f FROM notes WHERE _r_replica = ?", [A])[0]!["f"];
  expect(Number(flag), "and its stored flag says so").toBe(0);
  db.close();
});

test("a plain table: the parent may arrive after the row that names it, and is still not buried", () => {
  const db = openWith(`-- dai:replicated
CREATE TABLE notes (
  body TEXT NOT NULL
);
`);
  put(db, "notes", B, 1, 2, bytes(0x02), { body: "Bo's note" }, [`${hex(A)}:1`]);
  put(db, "notes", A, 1, 1, bytes(0x01), { body: "Ada's note" });
  const current = db.all("SELECT body FROM notes_current ORDER BY body").map((r) => r["body"]);
  expect(current).toEqual(["Ada's note", "Bo's note"]);
  db.close();
});

test("a session table: an admitted row naming another entity's admitted row hides nothing", () => {
  const nonce = bytes(0x07);
  const S = sessionIdOf(A, nonce)!;
  const db = openWith(`-- dai:profile session max_parties=2
-- dai:replicated
CREATE TABLE moves (
  san TEXT NOT NULL
);
`);
  // Ada's session, on her copy; Bo asked for the open seat and she confirmed him.
  db.run("INSERT INTO _dai_replica (id, seq, lc) VALUES (?, 0, 0)", [A]);
  put(db, "_dai_seat", A, 1, 1, bytes(0x11), { seat: bytes(0xa1), nonce }, [], S);
  put(db, "_dai_seat", A, 2, 2, bytes(0x12), { seat: bytes(0xa2), nonce: null }, [], S);
  put(db, "_dai_binding", B, 1, 3, bytes(0x14), { seat: bytes(0xa2) }, [], S);
  put(db, "_dai_confirm", A, 3, 4, bytes(0x13), { seat: bytes(0xa2), holder: B }, [], S);
  put(db, "moves", A, 4, 5, bytes(0x21), { san: "e4" }, [], S);
  // Bo's own move lists Ada's e4 as a parent.
  put(db, "moves", B, 2, 6, bytes(0x22), { san: "e5" }, [`${hex(A)}:4`], S);
  const current = db.all("SELECT san FROM moves_current ORDER BY san").map((r) => r["san"]);
  expect(current, "Ada's e4 is not buried by Bo's move").toEqual(["e4", "e5"]);
  db.close();
});

test("an invite: a parent in another session's entity is not history, so the export is not refused", () => {
  const S1 = bytes(0x51);
  const S2 = bytes(0x52);
  const db = openWith(`-- dai:profile session max_parties=2
-- dai:replicated
CREATE TABLE moves (
  san TEXT NOT NULL
);
`);
  put(db, "moves", A, 1, 1, bytes(0x21), { san: "e4" }, [], S1);
  // A row in the other game names the first game's move as its parent.
  put(db, "moves", B, 1, 2, bytes(0x22), { san: "d4" }, [`${hex(A)}:1`], S2);
  expect(() => filterToSession(db, S2), "the invite for the second game still exports").not.toThrow();
  expect(db.all("SELECT san FROM moves").map((r) => r["san"])).toEqual(["d4"]);
  db.close();
});

test("within one entity, a parent is still superseded: an edit replaces what it edits", () => {
  const db = openWith(`-- dai:replicated
CREATE TABLE notes (
  body TEXT NOT NULL
);
`);
  put(db, "notes", A, 1, 1, bytes(0x01), { body: "first" });
  put(db, "notes", B, 1, 2, bytes(0x01), { body: "edited" }, [`${hex(A)}:1`]);
  expect(db.all("SELECT body FROM notes_current").map((r) => r["body"])).toEqual(["edited"]);
  db.close();
});
