import { DatabaseSync } from "node:sqlite";
import { expect, test } from "@playwright/test";
import { deriveSessionMailbox } from "../src/mailbox.js";
import { rewriteReplicated } from "../src/replicated.js";
import { createEntity, ensureReplica, type Rows } from "../src/replicated-rows.js";
import { authoredBatchAbove, decodeBatch } from "../src/replicated-batch.js";

/**
 * A mailbox per session (T1-D30).
 *
 * The key and id both derive from the document root key and the session id, by
 * HKDF under two labels. The split carries two properties, and these test them
 * as properties rather than examples: the key needs the session id (so the
 * document key alone opens nothing) and the id needs the root (so a relay cannot
 * correlate sessions). And a copy in two sessions publishes only one session's
 * rows to that session's mailbox.
 */

const bytes = (b: number): Uint8Array => new Uint8Array(16).fill(b);
const root = (b: number): Uint8Array => new Uint8Array(32).fill(b);
const S1 = bytes(0x51);
const S2 = bytes(0x52);
const hx = (u: Uint8Array): string => [...u].map((x) => x.toString(16).padStart(2, "0")).join("");

test.describe("the session mailbox derivation (T1-D30)", () => {
  test("both parties derive the same key and id from the same root and session", async () => {
    const a = await deriveSessionMailbox(root(0xaa), S1);
    const b = await deriveSessionMailbox(root(0xaa), S1);
    expect(hx(a.key)).toBe(hx(b.key));
    expect(a.id).toBe(b.id);
  });

  test("the key needs the session id: same root, different session gives a different key", async () => {
    const one = await deriveSessionMailbox(root(0xaa), S1);
    const two = await deriveSessionMailbox(root(0xaa), S2);
    expect(hx(one.key)).not.toBe(hx(two.key));
    expect(one.id).not.toBe(two.id);
  });

  test("the id needs the root: the relay cannot correlate a session across documents", async () => {
    // Same session id under two different document roots — the case a relay
    // serving both would use to link them. The ids must not match.
    const inDocA = await deriveSessionMailbox(root(0xaa), S1);
    const inDocB = await deriveSessionMailbox(root(0xbb), S1);
    expect(inDocA.id).not.toBe(inDocB.id);
    expect(hx(inDocA.key)).not.toBe(hx(inDocB.key));
  });

  test("the key and the id are different derivations, not the same bytes", async () => {
    const m = await deriveSessionMailbox(root(0xaa), S1);
    expect(m.id).not.toBe(hx(m.key));
  });

  test("the id is a relay-safe opaque string, not the session id", async () => {
    const m = await deriveSessionMailbox(root(0xaa), S1);
    expect(m.id).toMatch(/^[0-9a-f]{64}$/);
    expect(m.id).not.toContain(hx(S1));
  });
});

test.describe("the batch scope gains the session (T1-D30)", () => {
  const SCHEMA = `-- dai:profile session max_parties=2
-- dai:replicated
CREATE TABLE moves (
  ply INTEGER NOT NULL,
  san TEXT NOT NULL
);
`;
  const open = (): Rows & { close(): void } => {
    const db = new DatabaseSync(":memory:");
    db.exec(rewriteReplicated(SCHEMA).sql);
    return {
      all: (sql, params = []) => db.prepare(sql).all(...(params as never[])) as Record<string, unknown>[],
      run: (sql, params = []) => {
        db.prepare(sql).run(...(params as never[]));
      },
      close: () => db.close(),
    };
  };
  const A = bytes(0xaa);
  const E1 = bytes(0x11);
  const E2 = bytes(0x22);

  test("a copy in two sessions publishes only the asked session's rows", () => {
    const db = open();
    ensureReplica(db, A);
    createEntity(db, "moves", E1, { ply: 1, san: "e4" }, S1);
    createEntity(db, "moves", E2, { ply: 1, san: "d4" }, S2);

    const forS1 = authoredBatchAbove(db, { replica: "", seq: 0 }, ["moves"], S1);
    const s1 = decodeBatch(forS1.batch!);
    expect(s1.entries.map((e) => e.row.columns["san"])).toEqual(["e4"]);

    const forS2 = authoredBatchAbove(db, { replica: "", seq: 0 }, ["moves"], S2);
    const s2 = decodeBatch(forS2.batch!);
    expect(s2.entries.map((e) => e.row.columns["san"])).toEqual(["d4"]);

    db.close();
  });

  test("with no session, the batch is unscoped — a plain replicated document is unchanged", () => {
    const db = open();
    ensureReplica(db, A);
    createEntity(db, "moves", E1, { ply: 1, san: "e4" }, S1);
    createEntity(db, "moves", E2, { ply: 1, san: "d4" }, S2);

    // No session argument: every authored row, both sessions.
    const all = authoredBatchAbove(db, { replica: "", seq: 0 }, ["moves"]);
    const decoded = decodeBatch(all.batch!);
    expect(decoded.entries.map((e) => e.row.columns["san"]).sort()).toEqual(["d4", "e4"]);
    db.close();
  });
});
