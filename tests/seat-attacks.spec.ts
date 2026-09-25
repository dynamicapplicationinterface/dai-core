import { DatabaseSync } from "node:sqlite";
import { expect, test } from "@playwright/test";
import { showAuthorId } from "../src/identity.js";
import { rewriteReplicated } from "../src/replicated.js";
import { mergeSibling } from "../src/replicated-frame.js";
import { applyRow, type Rows } from "../src/replicated-rows.js";
import { SESSION_ID_FUNCTION, sessionIdOf } from "../src/session-id.js";

/**
 * The attacks that broke the first seat model (cold review of identity step 5).
 *
 * Each test is an attack a joiner can make with rows alone, and asserts what a
 * sound seat model must answer. Bo is the joiner and holds the open seat
 * honestly; everything he does beyond that is the attack. Ada is the creator.
 *
 * `honestRoster` is the one part of this file that follows the seat model: it
 * builds the session every attack starts from, the way the kit would. The
 * attack rows and the assertions do not depend on the model.
 */

const SCHEMA = `-- dai:profile session max_parties=2 close=creator
-- dai:replicated
CREATE TABLE games (
  title TEXT NOT NULL
);
-- dai:replicated seat=seat
CREATE TABLE moves (
  seat BLOB,
  san TEXT NOT NULL
);
`;

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
const ADA = bytes(0xc0); // the creator
const BO = bytes(0x10); // the joiner; his id sorts below Ada's
const NONCE = bytes(0x07); // on Ada's own seat row
const S = sessionIdOf(ADA, NONCE)!; // the session, which commits to Ada
const ADA_SEAT = bytes(0xa1);
const OPEN_SEAT = bytes(0xa2);

let counter = 0;
const nextEntity = (): Uint8Array => {
  counter += 1;
  const e = new Uint8Array(16);
  e[0] = 0x30;
  e[15] = counter;
  return e;
};

function put(
  db: Rows,
  table: string,
  author: Uint8Array,
  seq: number,
  lc: number,
  columns: Record<string, unknown>,
  o: { entity?: Uint8Array; batch?: Uint8Array } = {},
): Uint8Array {
  const entity = o.entity ?? nextEntity();
  applyRow(db, table, {
    _r_replica: author,
    _r_seq: seq,
    _r_lc: lc,
    _r_entity: entity,
    _r_parents: "[]",
    _r_deleted: 0,
    _r_session: S,
    ...(o.batch ? { _r_batch: o.batch } : {}),
    columns,
  });
  return entity;
}

/** A header this copy holds for an author's rows, so they count as signed here. */
function signedBy(db: Rows, author: Uint8Array, id: number): Uint8Array {
  const batch = bytes(id);
  db.run(
    "INSERT INTO _dai_batch (id, author, lc, sig, pub, att, version, digest, covers) VALUES (?, ?, 1, x'00', x'00', NULL, 1, ?, '[]')",
    [batch, author, new Uint8Array(32)],
  );
  return batch;
}

/**
 * Ada's session with Bo in the open seat, as the kit leaves it: her own seat
 * carrying the nonce the session id commits to, the open seat, Bo's ask for it,
 * and Ada's confirmation. Returns the entity of Ada's own seat row. Ada's rows
 * use seqs 1–3 and Bo's seq 1. `own` is the copy's own author; the rows are
 * signed only when `sign` says.
 */
function honestRoster(db: Rows, own: Uint8Array | null, sign?: { ada: Uint8Array; bo: Uint8Array }): Uint8Array {
  if (own) {
    db.run("INSERT INTO _dai_replica (id, seq, lc) VALUES (?, 0, 0)", [own]);
  }
  const adaSeat = put(db, "_dai_seat", ADA, 1, 1, { seat: ADA_SEAT, nonce: NONCE }, { batch: sign?.ada });
  put(db, "_dai_seat", ADA, 2, 2, { seat: OPEN_SEAT, nonce: null }, { batch: sign?.ada });
  put(db, "_dai_binding", BO, 1, 3, { seat: OPEN_SEAT }, { batch: sign?.bo });
  put(db, "_dai_confirm", ADA, 3, 4, { seat: OPEN_SEAT, holder: BO }, { batch: sign?.ada });
  return adaSeat;
}

const admitted = (db: Rows): string[] => db.all("SELECT san FROM moves_current ORDER BY san").map((r) => String(r["san"]));
const creators = (db: Rows): string[] => db.all("SELECT lower(hex(replica)) AS r FROM _dai_creator").map((r) => String(r["r"]));

test.describe("a joiner's binding to the creator's seat takes nothing", () => {
  test("backdated, and merged into the creator's copy: her move stands, his is not admitted, and the merge says so", async () => {
    const ada = openWith(SCHEMA);
    honestRoster(ada, ADA);
    put(ada, "moves", ADA, 4, 5, { seat: ADA_SEAT, san: "e4" });

    const bo = openWith(SCHEMA);
    honestRoster(bo, BO);
    // Bo binds Ada's seat at a clock before any of hers, then plays White.
    put(bo, "_dai_binding", BO, 2, 0, { seat: ADA_SEAT });
    put(bo, "moves", BO, 3, 7, { seat: ADA_SEAT, san: "Qh5" });

    const report = await mergeSibling(ada, bo);
    expect(admitted(ada), "Ada's e4 stands and Bo's White move is not admitted").toEqual(["e4"]);
    expect(report.refusedBatches, "the merge names Bo's move as not his seat's").toContainEqual({
      author: showAuthorId(BO),
      reason: "SEAT_NOT_HELD",
    });
    ada.close();
    bo.close();
  });

  test("at the creator's own clock, with an author id that sorts first: her move stands", () => {
    const db = openWith(SCHEMA);
    honestRoster(db, ADA);
    put(db, "moves", ADA, 4, 5, { seat: ADA_SEAT, san: "e4" });
    put(db, "_dai_binding", BO, 2, 3, { seat: ADA_SEAT });
    put(db, "moves", BO, 3, 6, { seat: ADA_SEAT, san: "Qh5" });
    expect(admitted(db)).toEqual(["e4"]);
    db.close();
  });
});

test.describe("a joiner's seat row does not make the joiner the creator", () => {
  test("backdated and unsigned: Ada is still the creator, and a move for Bo's own seat is not admitted", () => {
    const db = openWith(SCHEMA);
    honestRoster(db, ADA);
    put(db, "moves", ADA, 4, 5, { seat: ADA_SEAT, san: "e4" });
    const MINE = bytes(0xb7);
    put(db, "_dai_seat", BO, 2, -5, { seat: MINE });
    put(db, "_dai_binding", BO, 3, -4, { seat: MINE });
    put(db, "moves", BO, 4, 7, { seat: MINE, san: "Nc6" });
    expect(creators(db), "the creator is Ada").toEqual([hex(ADA)]);
    expect(admitted(db), "Bo's move for a seat he minted is not admitted").toEqual(["e4"]);
    db.close();
  });

  test("backdated with every row signed: Ada is still the creator", () => {
    const db = openWith(SCHEMA);
    const sign = { ada: signedBy(db, ADA, 0xe1), bo: signedBy(db, BO, 0xe2) };
    honestRoster(db, null, sign);
    put(db, "moves", ADA, 4, 5, { seat: ADA_SEAT, san: "e4" }, { batch: sign.ada });
    put(db, "_dai_seat", BO, 2, 0, { seat: bytes(0xb7) }, { batch: sign.bo });
    expect(creators(db)).toEqual([hex(ADA)]);
    expect(admitted(db)).toEqual(["e4"]);
    db.close();
  });
});

test("a member's version of the creator's seat entity voids none of her moves", () => {
  const db = openWith(SCHEMA);
  const adaSeat = honestRoster(db, ADA);
  put(db, "moves", ADA, 4, 5, { seat: ADA_SEAT, san: "e4" });
  put(db, "moves", ADA, 5, 8, { seat: ADA_SEAT, san: "Nf3" });
  expect(admitted(db)).toEqual(["Nf3", "e4"]);
  // Bo writes a new version of Ada's seat row, same value, at a clock between her moves.
  put(db, "_dai_seat", BO, 2, 6, { seat: ADA_SEAT }, { entity: adaSeat });
  expect(admitted(db), "both of Ada's moves stand").toEqual(["Nf3", "e4"]);
  db.close();
});
