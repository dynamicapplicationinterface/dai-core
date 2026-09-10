import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "@playwright/test";
import { rewriteReplicated } from "../src/replicated.js";
import { mergeSibling } from "../src/replicated-frame.js";
import {
  authoredHead,
  authoredSince,
  decodeBatch,
  encodeBatch,
  stageBatch,
  type Batch,
} from "../src/replicated-batch.js";
import {
  canonicalDump,
  changeEntity,
  createEntity,
  ensureReplica,
  type Rows,
} from "../src/replicated-rows.js";
import { openBatch, sealBatch, type Mailbox } from "../src/mailbox.js";
import { fsMailbox } from "../src/mailbox-fs.js";

/**
 * Two copies converge through the relay, with no file passed by hand.
 *
 * This is the whole of slice one below the plumbing: a copy publishes the rows
 * it authored to the mailbox, the other pulls them and merges, and the two hold
 * the same rows — the same claim the chess file-exchange test makes, reached
 * over `append`/`since` instead of a file. The batch is sealed before it is
 * appended and opened after it is pulled, so the relay never holds a row it
 * could read.
 *
 * It runs in-process against node:sqlite. The frame and host that carry these
 * calls over a real relay are the next increment; what is proven here is that
 * the mechanism converges and reuses the file merge exactly — a pulled batch is
 * staged into a throwaway sibling and merged by the same `mergeSibling`.
 */
const SCHEMA = `-- dai:replicated
CREATE TABLE moves (
  ply   INTEGER NOT NULL,
  san   TEXT NOT NULL
);
`;

function open(): Rows & { close(): void } {
  const db = new DatabaseSync(":memory:");
  db.exec(rewriteReplicated(SCHEMA).sql);
  return {
    all: (sql, params = []) => db.prepare(sql).all(...(params as never[])) as Record<string, unknown>[],
    run: (sql, params = []) => {
      db.prepare(sql).run(...(params as never[]));
    },
    close: () => db.close(),
  };
}

const bytes = (byte: number) => new Uint8Array(16).fill(byte);
const A = bytes(0xaa);
const B = bytes(0xbb);
const tables = ["moves"];

/** Publish a copy's newly-authored rows to the mailbox, sealed. */
async function publish(
  db: Rows,
  replica: Uint8Array,
  watermark: number,
  key: Uint8Array,
  mailbox: Mailbox,
  documentId: string,
): Promise<number> {
  const entries = authoredSince(db, replica, watermark, tables);
  if (entries.length === 0) return watermark;
  const lc = Number(db.all("SELECT lc FROM _dai_replica LIMIT 1")[0]?.["lc"] ?? 0);
  const batch: Batch = { replica, lc, entries };
  await mailbox.append(documentId, await sealBatch(encodeBatch(batch), key));
  return authoredHead(db, replica, tables);
}

/** Pull everything new and merge it into a copy, the way the frame will. */
async function pull(
  db: Rows,
  key: Uint8Array,
  mailbox: Mailbox,
  documentId: string,
  cursor: string,
): Promise<string> {
  const { cursor: next, batches } = await mailbox.since(documentId, cursor);
  for (const sealed of batches) {
    const batch = decodeBatch(await openBatch(sealed, key));
    // Stage into a throwaway sibling with the same schema, then merge as a file.
    const staged = open();
    try {
      stageBatch(staged, batch, tables);
      mergeSibling(db, staged, 1);
    } finally {
      staged.close();
    }
  }
  return next;
}

test("two copies converge over the mailbox, with the relay never able to read a move", async () => {
  const key = crypto.getRandomValues(new Uint8Array(32));
  const mailbox = fsMailbox({ root: mkdtempSync(join(tmpdir(), "dai-mb-conv-")) });
  const documentId = "game-1";

  const a = open();
  const b = open();
  ensureReplica(a, A);
  ensureReplica(b, B);

  let aWater = 0;
  let bWater = 0;
  let aCursor = "";
  let bCursor = "";

  // A plays e4 and publishes it. Nothing is uploaded in the clear: what lands
  // in the mailbox is sealed.
  createEntity(a, "moves", crypto.getRandomValues(new Uint8Array(16)), { ply: 1, san: "e4" });
  aWater = await publish(a, A, aWater, key, mailbox, documentId);

  const stored = (await mailbox.since(documentId, "")).batches[0]!;
  expect(new TextDecoder("utf-8", { fatal: false }).decode(stored)).not.toContain("e4");

  // B pulls and now has A's move; B replies e5 and publishes.
  bCursor = await pull(b, key, mailbox, documentId, bCursor);
  expect(b.all("SELECT san FROM moves_current ORDER BY ply")[0]?.["san"]).toBe("e4");
  createEntity(b, "moves", crypto.getRandomValues(new Uint8Array(16)), { ply: 2, san: "e5" });
  bWater = await publish(b, B, bWater, key, mailbox, documentId);

  // A pulls B's reply; A plays Nf3.
  aCursor = await pull(a, key, mailbox, documentId, aCursor);
  createEntity(a, "moves", crypto.getRandomValues(new Uint8Array(16)), { ply: 3, san: "Nf3" });
  aWater = await publish(a, A, aWater, key, mailbox, documentId);

  // B pulls the rest. Both copies now hold the same three moves.
  bCursor = await pull(b, key, mailbox, documentId, bCursor);

  expect(canonicalDump(a, tables)).toBe(canonicalDump(b, tables));
  expect(a.all("SELECT san FROM moves_current ORDER BY ply").map((r) => r["san"])).toEqual([
    "e4",
    "e5",
    "Nf3",
  ]);

  a.close();
  b.close();
});

test("the watermark advances on ack, not on send: a dropped append still arrives", async () => {
  /*
   * The durability rule. `authoredSince` is the only record of what has been
   * published, so if it advances when a batch is *emitted* and the batch never
   * reaches the relay, those rows are never sent again — the silent-loss shape
   * the write flush guards against. So the publisher advances the watermark
   * only after `append` resolves, seals the batch once, and re-sends the
   * identical bytes on failure; the relay dedups by digest, so the retry is a
   * no-op if the first attempt secretly landed.
   */
  const key = crypto.getRandomValues(new Uint8Array(32));
  const real = fsMailbox({ root: mkdtempSync(join(tmpdir(), "dai-mb-drop-")) });
  const id = "game-3";

  // A relay that drops the first append it is given, then behaves.
  let dropsLeft = 1;
  const flaky: Mailbox = {
    async append(documentId, sealed) {
      if (dropsLeft > 0) {
        dropsLeft -= 1;
        throw new Error("relay unreachable");
      }
      return real.append(documentId, sealed);
    },
    head: (documentId) => real.head(documentId),
    since: (documentId, cursor) => real.since(documentId, cursor),
  };

  const a = open();
  const b = open();
  ensureReplica(a, A);
  ensureReplica(b, B);

  createEntity(a, "moves", crypto.getRandomValues(new Uint8Array(16)), { ply: 1, san: "e4" });

  // Publish with the rule: seal once, retry the same bytes until acked, and
  // only then advance the watermark.
  let watermark = 0;
  const entries = authoredSince(a, A, watermark, tables);
  const lc = Number(a.all("SELECT lc FROM _dai_replica LIMIT 1")[0]?.["lc"] ?? 0);
  const sealed = await sealBatch(encodeBatch({ replica: A, lc, entries }), key);

  let acked = false;
  let attempts = 0;
  while (!acked) {
    attempts += 1;
    try {
      await flaky.append(id, sealed);
      acked = true;
    } catch {
      // The watermark is untouched: nothing was acked, so nothing is "sent".
      expect(watermark).toBe(0);
    }
  }
  watermark = authoredHead(a, A, tables);

  expect(attempts).toBe(2); // the first was dropped, the second landed
  expect(watermark).toBe(1);

  // B pulls, and the move that survived a dropped send is there.
  await pull(b, key, flaky, id, "");
  expect(b.all("SELECT san FROM moves_current WHERE ply = 1")[0]?.["san"]).toBe("e4");

  a.close();
  b.close();
});

test("a batch stages into a schema copied from sqlite_schema, as the frame builds it", async () => {
  /*
   * The frame's apply path, exercised the way the frame does it.
   *
   * In the opener, `applyBatch` cannot call `rewriteReplicated` — it has no
   * author schema, only the live database — so it rebuilds the staging sibling
   * from `SELECT sql FROM sqlite_schema`, the rewritten statements sqlite
   * stored. This proves that copy round-trips: a batch staged into a
   * schema-copied sibling merges into a real copy exactly as one staged into a
   * freshly-compiled schema does.
   */
  const key = crypto.getRandomValues(new Uint8Array(32));
  const mailbox = fsMailbox({ root: mkdtempSync(join(tmpdir(), "dai-mb-schema-")) });
  const id = "game-4";

  const a = open();
  const b = open();
  ensureReplica(a, A);
  ensureReplica(b, B);
  createEntity(a, "moves", crypto.getRandomValues(new Uint8Array(16)), { ply: 1, san: "d4" });
  await publish(a, A, 0, key, mailbox, id);

  // B pulls, but stages into a sibling built from B's *own* sqlite_schema —
  // the statements the compiler's rewrite left in the database — rather than
  // from the author schema, which is what the frame has to do.
  const raw = new DatabaseSync(":memory:");
  raw.exec(rewriteReplicated(SCHEMA).sql);
  const schemaFromDb = raw
    .prepare("SELECT sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY rowid")
    .all()
    .map((r) => String((r as { sql: unknown }).sql));
  raw.close();

  const { batches } = await mailbox.since(id, "");
  const batch = decodeBatch(await openBatch(batches[0]!, key));
  const stagedDb = new DatabaseSync(":memory:");
  for (const sql of schemaFromDb) stagedDb.exec(sql);
  const staged: Rows = {
    all: (sql, params = []) => stagedDb.prepare(sql).all(...(params as never[])) as Record<string, unknown>[],
    run: (sql, params = []) => {
      stagedDb.prepare(sql).run(...(params as never[]));
    },
  };
  stageBatch(staged, batch, tables);
  mergeSibling(b, staged, 1);
  stagedDb.close();

  expect(b.all("SELECT san FROM moves_current WHERE ply = 1")[0]?.["san"]).toBe("d4");

  a.close();
  b.close();
});

test("a move changed in place converges through the mailbox too (supersession)", async () => {
  const key = crypto.getRandomValues(new Uint8Array(32));
  const mailbox = fsMailbox({ root: mkdtempSync(join(tmpdir(), "dai-mb-sup-")) });
  const id = "game-2";
  const a = open();
  const b = open();
  ensureReplica(a, A);
  ensureReplica(b, B);

  const entity = crypto.getRandomValues(new Uint8Array(16));
  createEntity(a, "moves", entity, { ply: 1, san: "e4" });
  let aWater = await publish(a, A, 0, key, mailbox, id);
  let bCursor = await pull(b, key, mailbox, id, "");

  // A corrects the row in place; the change is a new appended row that
  // supersedes the first, and B must land on the corrected value.
  changeEntity(a, "moves", entity, { ply: 1, san: "e3" });
  aWater = await publish(a, A, aWater, key, mailbox, id);
  bCursor = await pull(b, key, mailbox, id, bCursor);

  /*
   * The rows converge, which is the claim. The full canonical dump would not
   * be equal here and should not be: this exchange is one-directional — only A
   * published — so B has learned A's replica while A has never heard of B, and
   * the dump includes the replica set. Bidirectional convergence is the first
   * test. Here what matters is that the change reached B and superseded
   * cleanly, so the rows of the shared table are identical on both sides.
   */
  const movesOf = (db: Rows) =>
    JSON.stringify(
      db.all("SELECT _r_seq, san, _r_superseded, _r_parents FROM moves ORDER BY _r_seq"),
    );
  expect(movesOf(a)).toBe(movesOf(b));
  expect(b.all("SELECT san FROM moves_current WHERE ply = 1")[0]?.["san"]).toBe("e3");

  a.close();
  b.close();
});
