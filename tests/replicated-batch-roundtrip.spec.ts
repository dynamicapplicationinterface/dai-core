import { DatabaseSync } from "node:sqlite";
import { expect, test } from "@playwright/test";
import { rewriteReplicated } from "../src/replicated.js";
import { decodeBatch, encodeBatch, stageBatch, type Batch } from "../src/replicated-batch.js";
import {
  authorColumnsOf,
  CARRIED_R_FIELDS,
  createEntity,
  ensureReplica,
  readRow,
  UNTRANSPORTED_R_COLUMNS,
  type ReplicatedRow,
  type Rows,
} from "../src/replicated-rows.js";

/**
 * The carried `_r_` fields survive a batch round-trip — every one, by the list.
 *
 * `_r_session` slipped out of the mailbox format because encode, decode and
 * stage each kept their own hand-written copy of the field list and one was
 * short a field. It surfaced as an empty merge, not an error, because
 * `INSERT OR IGNORE` swallowed the `NOT NULL` it violated. No unit test that
 * builds its rows by hand would have caught it — the carrier e2e did, at the far
 * end of the plumbing.
 *
 * So this pins the mechanism the carrier proved: a row goes
 * encode → decode → stage → read back, and *every* field named in
 * `CARRIED_R_FIELDS` is asserted to arrive unchanged, enumerated from that one
 * list rather than typed out here. The moment a field is added to the list and
 * not carried through by one of the three, this fails — the list a caller could
 * once get wrong with no complaint now complains.
 */

const hex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

function open(schema: string): Rows & { close(): void } {
  const db = new DatabaseSync(":memory:");
  db.exec(rewriteReplicated(schema).sql);
  return {
    all: (sql, params = []) => db.prepare(sql).all(...(params as never[])) as Record<string, unknown>[],
    run: (sql, params = []) => {
      db.prepare(sql).run(...(params as never[]));
    },
    close: () => db.close(),
  };
}

/** The value of one carried field, in a form two rows can be compared by. */
function fieldValue(row: ReplicatedRow, col: (typeof CARRIED_R_FIELDS)[number]["col"]): unknown {
  const value = (row as unknown as Record<string, unknown>)[col];
  return value instanceof Uint8Array ? hex(value) : value;
}

const SESSION_SCHEMA = `-- dai:profile session max_parties=2 close=any
-- dai:replicated
CREATE TABLE moves (
  ply INTEGER NOT NULL,
  san TEXT NOT NULL
);
`;

const PLAIN_SCHEMA = `-- dai:replicated
CREATE TABLE moves (
  ply INTEGER NOT NULL,
  san TEXT NOT NULL
);
`;

/** Read a row back out of a table by its (replica, seq) key, as a ReplicatedRow. */
function storedRow(db: Rows, table: string, replica: Uint8Array, seq: number): ReplicatedRow {
  const record = db.all(`SELECT * FROM "${table}" WHERE _r_replica = ? AND _r_seq = ?`, [replica, seq])[0];
  expect(record, "the row was staged, not silently dropped").toBeTruthy();
  return readRow(record!, authorColumnsOf(db, table));
}

/** Every `_r_` column present on a table, by shape rather than by a hand-list. */
function rColumnsOf(db: Rows, table: string): string[] {
  return db
    .all(`SELECT name FROM pragma_table_info(?)`, [table])
    .map((r) => String(r["name"]))
    .filter((name) => name.startsWith("_r_"));
}

test("the carried-field descriptor is complete against the schema the rewrite emits", () => {
  /*
   * The completeness half of CARRIED_R_FIELDS, the same shape as the trigger and
   * merge coverage checks. The round-trip test proves a field *arrives*; this
   * proves none is *missing from the descriptor* — the bug one level up, where a
   * column the schema grows is in neither the carried list nor the deliberate
   * exclusions and so silently does not travel. Enumerated off a rewritten table
   * by shape, so the schema is the source and the descriptor is checked against
   * it, never the reverse.
   */
  const carried = new Set(CARRIED_R_FIELDS.map((f) => f.col as string));
  const excluded = new Set(Object.keys(UNTRANSPORTED_R_COLUMNS));
  const classify = (columns: string[]) =>
    columns.filter((name) => !carried.has(name) && !excluded.has(name));

  // A session document: author tables carry `_r_session`, and the roster tables
  // (_dai_seat, _dai_binding, _dai_close) are replicated and carry it too, so
  // every `_r_` column that can appear anywhere is on the board here.
  const session = open(SESSION_SCHEMA);
  for (const table of ["moves", "_dai_seat", "_dai_binding", "_dai_close"]) {
    const unclassified = classify(rColumnsOf(session, table));
    expect(unclassified, `${table} has an _r_ column neither carried nor excluded: ${unclassified}`).toEqual(
      [],
    );
  }
  // The deliberate exclusion is real, not vacuous: `_r_superseded` is on the
  // table and is the one column held back.
  expect(rColumnsOf(session, "moves")).toContain("_r_superseded");
  expect(excluded.has("_r_superseded")).toBe(true);

  // A plain document: every non-optional carried field is a real column, so the
  // descriptor names no phantom, and `_r_session` is correctly absent.
  const plain = open(PLAIN_SCHEMA);
  const plainCols = new Set(rColumnsOf(plain, "moves"));
  for (const field of CARRIED_R_FIELDS) {
    if (field.optional) expect(plainCols.has(field.col as string), `${field.col} absent when plain`).toBe(false);
    else expect(plainCols.has(field.col as string), `${field.col} is a real column`).toBe(true);
  }

  session.close();
  plain.close();
});

test("a session document's row keeps every carried _r_ field through a batch", () => {
  const source = open(SESSION_SCHEMA);
  const replica = new Uint8Array(16).fill(0xaa);
  const session = new Uint8Array(16).fill(0x5e);
  ensureReplica(source, replica);
  const written = createEntity(source, "moves", crypto.getRandomValues(new Uint8Array(16)), { ply: 1, san: "e4" }, session);

  // The row as it left the author, read back from storage the way authoredSince
  // reads it — this is the ground truth the round-trip must not lose.
  const authored = storedRow(source, "moves", replica, written._r_seq);
  expect(authored._r_session, "a session row carries its session at rest").toBeInstanceOf(Uint8Array);

  // encode → decode.
  const batch: Batch = { replica, lc: written._r_lc, entries: [{ table: "moves", row: authored }] };
  const decoded = decodeBatch(encodeBatch(batch));
  const carried = decoded.entries[0]!.row;

  // stage into a fresh sibling, then read the row back out of it.
  const sibling = open(SESSION_SCHEMA);
  stageBatch(sibling, decoded, ["moves"]);
  const restaged = storedRow(sibling, "moves", replica, written._r_seq);

  // Every field the carried-field list names arrives unchanged at both hops.
  for (const field of CARRIED_R_FIELDS) {
    expect(fieldValue(carried, field.col), `${field.col} survives encode/decode`).toEqual(
      fieldValue(authored, field.col),
    );
    expect(fieldValue(restaged, field.col), `${field.col} survives staging`).toEqual(
      fieldValue(authored, field.col),
    );
  }
  // And the author columns come through too, so the assertion above is over a
  // row that is otherwise whole.
  expect(restaged.columns).toEqual({ ply: 1, san: "e4" });

  source.close();
  sibling.close();
});

test("a plain document carries no session, and staging still restores the row", () => {
  const source = open(PLAIN_SCHEMA);
  const replica = new Uint8Array(16).fill(0xbb);
  ensureReplica(source, replica);
  const written = createEntity(source, "moves", crypto.getRandomValues(new Uint8Array(16)), { ply: 1, san: "d4" });

  const authored = storedRow(source, "moves", replica, written._r_seq);
  expect(authored._r_session, "a plain row has no session field").toBeUndefined();

  const decoded = decodeBatch(
    encodeBatch({ replica, lc: written._r_lc, entries: [{ table: "moves", row: authored }] }),
  );
  const sibling = open(PLAIN_SCHEMA);
  stageBatch(sibling, decoded, ["moves"]);
  const restaged = storedRow(sibling, "moves", replica, written._r_seq);

  // The optional field is absent on both sides — not null, absent — and every
  // required field still round-trips.
  expect(decoded.entries[0]!.row._r_session).toBeUndefined();
  expect(restaged._r_session).toBeUndefined();
  for (const field of CARRIED_R_FIELDS.filter((f) => !f.optional)) {
    expect(fieldValue(restaged, field.col), `${field.col} survives`).toEqual(fieldValue(authored, field.col));
  }
  expect(restaged.columns).toEqual({ ply: 1, san: "d4" });

  source.close();
  sibling.close();
});

test("staging the same row twice is a no-op, but a real constraint violation throws", () => {
  /*
   * The one exception `INSERT OR IGNORE` was standing in for, made explicit.
   *
   * A duplicate (_r_replica, _r_seq) is the expected no-op — the same row seen
   * twice on two pulls. Anything else is a bug that must surface: the blanket
   * amnesty is what let a `NOT NULL` violation pass as a dropped row. Here a row
   * whose session is missing in a session table must throw, not vanish.
   */
  const replica = new Uint8Array(16).fill(0xcc);
  const session = new Uint8Array(16).fill(0x5e);
  const source = open(SESSION_SCHEMA);
  ensureReplica(source, replica);
  const written = createEntity(source, "moves", crypto.getRandomValues(new Uint8Array(16)), { ply: 1, san: "c4" }, session);
  const authored = storedRow(source, "moves", replica, written._r_seq);
  const decoded = decodeBatch(
    encodeBatch({ replica, lc: written._r_lc, entries: [{ table: "moves", row: authored }] }),
  );

  const sibling = open(SESSION_SCHEMA);
  stageBatch(sibling, decoded, ["moves"]);
  const countBefore = sibling.all("SELECT count(*) AS n FROM moves")[0]!["n"];
  // Same batch again: the duplicate key is skipped, not errored, and adds nothing.
  expect(() => stageBatch(sibling, decoded, ["moves"])).not.toThrow();
  expect(sibling.all("SELECT count(*) AS n FROM moves")[0]!["n"]).toBe(countBefore);

  // A row that violates a real constraint — a session table row with its session
  // stripped — throws rather than being swallowed.
  const stripped = open(SESSION_SCHEMA);
  const bad: ReplicatedRow = { ...authored };
  delete (bad as { _r_session?: unknown })._r_session;
  expect(() => stageBatch(stripped, { replica, lc: 1, entries: [{ table: "moves", row: bad }] }, ["moves"])).toThrow();

  source.close();
  sibling.close();
  stripped.close();
});
