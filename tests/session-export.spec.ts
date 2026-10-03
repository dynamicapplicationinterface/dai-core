import { DatabaseSync } from "node:sqlite";
import { withSessionId } from "./session-db.js";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { verifyContainer } from "../src/container.js";
import { MANIFEST_ENTRY, sha256Hex } from "../src/core.js";
import { rewriteReplicated } from "../src/replicated.js";
import { createEntity, ensureReplica, type Rows } from "../src/replicated-rows.js";
import { exportSession, type ScratchEngine } from "../src/replicated-export.js";

const here = dirname(fileURLToPath(import.meta.url));
/** Built and signed by the global setup, so the signature under test is a real one. */
const FIXTURE = resolve(here, "fixture/fixture.dai.html");
const DATABASE = "document.sqlite";

/**
 * The invite carrier: a document filtered to one session (T1-D28).
 *
 * The property that matters is the seam. An invite must be the sender's
 * document with only its database changed: every application file byte for
 * byte, and the same publisher signature still verifying — or the recipient's
 * sibling test will not recognise it as the same document. These wrap a
 * two-session database in the signed fixture, export one session, and check
 * both halves: the right rows survived, and nothing but the database moved.
 * The opener's share sheet makes its invites through this same function
 * (`apps/runner/src/invite.ts`); `invite-one-session.spec.ts` follows one
 * through the real share.
 */

const SESSION_SCHEMA = `-- dai:profile session max_parties=2
-- dai:replicated
CREATE TABLE moves (
  ply INTEGER NOT NULL,
  san TEXT NOT NULL
);
`;

const A = new Uint8Array(16).fill(0xaa);
const E1 = new Uint8Array(16).fill(0x11);
const E2 = new Uint8Array(16).fill(0x22);
const S1 = new Uint8Array(16).fill(0x51);
const S2 = new Uint8Array(16).fill(0x52);
const hx = (u: unknown): string => (u instanceof Uint8Array ? Buffer.from(u).toString("hex") : "");

/** `node:sqlite` behind the `Rows` interface, backed by a temp file. */
function rowsOn(path: string): Rows & { db: DatabaseSync } {
  const db = withSessionId(new DatabaseSync(path));
  return {
    db,
    all: (sql, params = []) => db.prepare(sql).all(...(params as never[])) as Record<string, unknown>[],
    run: (sql, params = []) => {
      db.prepare(sql).run(...(params as never[]));
    },
  };
}

/** A database with two sessions' rows, returned as SQLite file bytes. */
function twoSessionDatabase(): Uint8Array {
  const path = join(mkdtempSync(join(tmpdir(), "dai-src-")), "document.sqlite");
  const rows = rowsOn(path);
  rows.db.exec(rewriteReplicated(SESSION_SCHEMA).sql);
  ensureReplica(rows, A);
  createEntity(rows, "moves", E1, { ply: 1, san: "e4" }, S1);
  createEntity(rows, "moves", E2, { ply: 1, san: "d4" }, S2);
  rows.db.close();
  return new Uint8Array(readFileSync(path));
}

/** A scratch engine over a fresh temp file, for `exportSession`. */
function nodeEngine(): ScratchEngine {
  const path = join(mkdtempSync(join(tmpdir(), "dai-scratch-")), "document.sqlite");
  let handle: (Rows & { db: DatabaseSync }) | undefined;
  return {
    open(data) {
      writeFileSync(path, data);
      handle = rowsOn(path);
      return handle;
    },
    serialize() {
      // Autocommit flushes each statement to the main file (default journal
      // mode), so the file is current without closing the connection.
      return new Uint8Array(readFileSync(path));
    },
    close() {
      handle?.db.close();
    },
  };
}

function sessionsIn(database: Uint8Array): string[] {
  const path = join(mkdtempSync(join(tmpdir(), "dai-check-")), "document.sqlite");
  writeFileSync(path, database);
  const check = withSessionId(new DatabaseSync(path));
  const sessions = check
    .prepare("SELECT _r_session FROM moves")
    .all()
    .map((r) => hx((r as { _r_session: unknown })._r_session));
  check.close();
  return sessions;
}

test.describe("the invite carrier, end to end (T1-D28)", () => {
  test("an invite is the sender's document with only its database changed, and it still verifies", async () => {
    const source = await verifyContainer(readFileSync(FIXTURE, "utf8"));
    expect(source.publicKeyFingerprint, "the fixture is signed, so a real signature is under test").toBeTruthy();

    const invite = await exportSession(source, twoSessionDatabase(), S1, nodeEngine());
    const reread = await verifyContainer(invite.html);

    // The same publisher's signature, still verifying: the sibling test's seam.
    expect(reread.publicKeyFingerprint).toBe(source.publicKeyFingerprint);
    // Every application file byte for byte; only the database and the
    // manifest's record of it differ.
    for (const [name, bytes] of Object.entries(source.archive)) {
      if (name === DATABASE || name === MANIFEST_ENTRY) continue;
      expect(Buffer.from(reread.archive[name]!), name).toEqual(Buffer.from(bytes));
    }
    // And the database now holds only the chosen session's game.
    expect(sessionsIn(reread.archive[DATABASE]!)).toEqual([hx(S1)]);
  });

  test("the manifest's record of the database matches the filtered database it describes", async () => {
    // A stale digest is how a rolled-back or half-written save reads; the
    // invite must not look like one.
    const source = await verifyContainer(readFileSync(FIXTURE, "utf8"));
    const invite = await exportSession(source, twoSessionDatabase(), S1, nodeEngine());
    expect(invite.manifest.hashes[DATABASE]).toBe(await sha256Hex(invite.archive[DATABASE]!));
  });
});
