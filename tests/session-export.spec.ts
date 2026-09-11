import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { rewriteReplicated } from "../src/replicated.js";
import { createEntity, ensureReplica, type Rows } from "../src/replicated-rows.js";
import { exportSession, type ScratchEngine } from "../src/replicated-export.js";
import { readContainerFile, sectionBytes, SECTION, writeContainerFile } from "../src/format.js";

/**
 * The invite carrier, end to end: a container filtered to one session.
 *
 * The property that matters is the seam. An invite must differ from the sender's
 * copy in exactly one section (the database) and the footer; the manifest and
 * payload — and so the signature over the manifest — must be byte-identical, or
 * the recipient's sibling test will not recognise it. These build a two-session
 * database, wrap it in a container, export one session, and check both halves:
 * the right rows survived, and nothing but the data and the footer moved.
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
  const db = new DatabaseSync(path);
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

async function container(data: Uint8Array): Promise<{ bytes: Uint8Array; manifest: Uint8Array; payload: Uint8Array }> {
  const manifest = new TextEncoder().encode('{"documentUuid":"abc","manifestVersion":4}');
  const payload = new TextEncoder().encode("PAYLOAD-BYTES-stand-in-for-the-app-zip");
  const bytes = await writeContainerFile({ manifest, payload, data });
  return { bytes, manifest, payload };
}

test.describe("the invite carrier, end to end (T1-D28)", () => {
  test("exports one session, and moves only the data section and the footer", async () => {
    const source = await container(twoSessionDatabase());
    const before = readContainerFile(source.bytes);

    const invite = await exportSession(source.bytes, ["moves"], S1, nodeEngine());
    const after = readContainerFile(invite);

    // The seam: manifest and payload byte-identical, so the signature over the
    // manifest still holds and the sibling test still recognises the document.
    expect(Buffer.from(sectionBytes(invite, after, SECTION.MANIFEST)!)).toEqual(Buffer.from(source.manifest));
    expect(Buffer.from(sectionBytes(invite, after, SECTION.PAYLOAD)!)).toEqual(Buffer.from(source.payload));

    // The data section and the footer are the only things that moved.
    expect(after.dataDigest).not.toBe(before.dataDigest);
    expect(after.generation).toBe(before.generation + 1);

    // And the data now holds only the chosen session's game.
    const path = join(mkdtempSync(join(tmpdir(), "dai-check-")), "document.sqlite");
    writeFileSync(path, sectionBytes(invite, after, SECTION.DATA)!);
    const check = new DatabaseSync(path);
    const sessions = check
      .prepare("SELECT _r_session FROM moves")
      .all()
      .map((r) => hx((r as { _r_session: unknown })._r_session));
    check.close();
    expect(sessions).toEqual([hx(S1)]);
  });

  test("the footer's data digest matches the filtered database it describes", async () => {
    // A stale footer is how a rolled-back or half-written save reads; the invite
    // must not look like one.
    const source = await container(twoSessionDatabase());
    const invite = await exportSession(source.bytes, ["moves"], S1, nodeEngine());
    const file = readContainerFile(invite);
    const { sha256Hex } = await import("../src/core.js");
    const data = sectionBytes(invite, file, SECTION.DATA)!;
    expect(await sha256Hex(data)).toBe(file.dataDigest);
  });
});
