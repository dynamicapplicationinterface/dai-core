/**
 * R-X's fixture (`docs/backlog.md`, "R-X red test"): three authors, one row,
 * a coupled (qty, unit). A and B each write the tuple from the common start
 * and exchange, so the tuple is pending and shows B's (3, "kg"); C writes
 * (4, "kg") from the same start, and its batch is withheld.
 */
import { expect } from "@playwright/test";
import { Copy, person, type Person } from "./copy.js";
import { decode as cborDecode } from "../../src/cbor.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

export const RX_SCHEMA = `CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY,
    qty INTEGER NOT NULL,
    unit TEXT NOT NULL,
    note TEXT
    -- dai:coupled qty unit
);`;

const hexOf = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** A person whose author id sorts after `than`'s: on a clock tie, the later author shows (`later`). */
async function after(than: Person): Promise<Person> {
  for (;;) {
    const p = await person();
    if (hexOf(p.author) > hexOf(than.author)) return p;
  }
}

export interface Rx {
  a: Copy;
  b: Copy;
  c: Copy;
  /** C's batch, withheld from A and B. */
  cBytes: Uint8Array;
  /** The base every copy started from. */
  baseBytes: Uint8Array;
}

/** The arranged conflict: on A and B, (qty, unit) pending between A's (2, "kg") and B's (3, "kg"), showing B's. */
export async function rx(): Promise<Rx> {
  const pa = await person();
  const a = await Copy.open(pa, undefined, RX_SCHEMA);
  a.db.exec("INSERT INTO items (id, qty, unit, note) VALUES (7, 1, 'kg', '')");
  const baseBytes = await a.bytes();
  const b = await Copy.open(await after(pa), baseBytes, RX_SCHEMA);
  const c = await Copy.open(await person(), baseBytes, RX_SCHEMA);
  a.db.exec("UPDATE items SET qty = 2 WHERE id = 7");
  b.db.exec("UPDATE items SET qty = 3 WHERE id = 7");
  c.db.exec("UPDATE items SET qty = 4 WHERE id = 7");
  const cBytes = await c.bytes();
  const [ab, bb] = [await a.bytes(), await b.bytes()];
  await a.mergeFrom(bb);
  await b.mergeFrom(ab);
  for (const x of [a, b]) {
    expect(x.db.selectObject("SELECT qty, unit, note FROM items WHERE id = 7"), "the fixture shows B's tuple").toEqual({ qty: 3, unit: "kg", note: "" });
    expect(pendingCols(x), "the tuple is pending").toEqual(["qty", "unit"]);
  }
  return { a, b, c, cBytes, baseBytes };
}

/** The pending entries of row 7, by column, each with its alternatives' values sorted. */
export function pendingOf(c: Copy, table = "items", key = "[7]"): Record<string, unknown[]> {
  const f = c.flags().find((x: Any) => x.tbl === table && x.pk === key && x.kind === "pending");
  if (!f) return {};
  const out: Record<string, unknown[]> = {};
  for (const e of JSON.parse(f.detail) as Any[]) out[e.col] = e.values.map((v: Any) => v.val).sort();
  return out;
}

export const pendingCols = (c: Copy, table = "items", key = "[7]"): string[] => Object.keys(pendingOf(c, table, key)).sort();

/** This author's log entries at seq > `from`: each op decoded, with every field it carries. */
export function opsAfter(c: Copy, from: number): { table: string; key: unknown[]; code: string; wrote: string[]; op: Any[] }[] {
  const out: { table: string; key: unknown[]; code: string; wrote: string[]; op: Any[] }[] = [];
  for (const r of c.rows.all("SELECT payload FROM _cs_log WHERE _r_replica = ? AND _r_seq > ? ORDER BY _r_seq", [c.author.author, from])) {
    for (const op of (cborDecode(r["payload"] as Uint8Array) as Any)[1] as Any[]) {
      out.push({ table: op[0], key: op[1], code: op[2], wrote: [...(op[3] as Map<string, unknown>).keys()].sort(), op });
    }
  }
  return out;
}

export const lastSeq = (c: Copy): number => Number(c.db.selectValue("SELECT max(_r_seq) FROM _cs_log WHERE _r_replica = ?", [c.author.author]) ?? 0);

/** The version string of this author's save at `seq`. */
export const verOf = (c: Copy, seq: number): string => `${hexOf(c.author.author)}:${seq}`;
