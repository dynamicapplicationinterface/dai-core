/**
 * An invite into one session, made on this device (T1-D28, backlog D4).
 *
 * The invite itself is made by `exportSession` (src/replicated-export.ts): the
 * database filtered to one session by `filterToSession` — which rows travel,
 * the same-session-parents check, the local tables emptied — and the document
 * resealed around it with the application and its signature untouched. This
 * file supplies the one thing that module cannot: an engine on this page to
 * filter a scratch copy of the database in, never the live one.
 *
 * The engine is the one this opener already stages under /runtime for thin
 * documents (see engine.ts), loaded only when somebody first sends an invite.
 */
import type { ParsedContainer } from "../../../src/container.js";
import { exportSession, type ScratchEngine } from "../../../src/replicated-export.js";
import type { Rows } from "../../../src/replicated-rows.js";

// sqlite-wasm ships untyped; its surface is used exactly as the bootloader uses it.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

let engine: Promise<Any> | undefined;

function sqlite(): Promise<Any> {
  engine ??= (async () => {
    const url = new URL("runtime/sqlite3.mjs", document.baseURI).href;
    const mod = (await import(/* @vite-ignore */ url)) as { default: () => Promise<Any> };
    return mod.default();
  })();
  return engine;
}

const fromHex = (text: string): Uint8Array => {
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16);
  return out;
};

/** A scratch database in the staged engine: loaded from bytes, filtered in place, exported. */
async function wasmScratch(): Promise<ScratchEngine> {
  const api = await sqlite();
  let db: Any | undefined;
  return {
    open(data) {
      db = new api.oo1.DB();
      const pointer = api.wasm.allocFromTypedArray(data);
      const rc = api.capi.sqlite3_deserialize(
        db.pointer,
        "main",
        pointer,
        data.byteLength,
        data.byteLength,
        api.capi.SQLITE_DESERIALIZE_FREEONCLOSE | api.capi.SQLITE_DESERIALIZE_RESIZEABLE,
      );
      if (rc !== 0) throw new Error("NOT_A_DATABASE");
      // Read the schema once, so the connection reports the file's settings.
      db.exec("SELECT count(*) FROM sqlite_schema");
      const rows: Rows = {
        all: (sql, params = []) => db.selectObjects(sql, params.length ? [...params] : undefined),
        run: (sql, params = []) => {
          if (params.length) db.exec({ sql, bind: [...params] });
          else db.exec(sql);
        },
      };
      return rows;
    },
    serialize() {
      return api.capi.sqlite3_js_db_export(db.pointer) as Uint8Array;
    },
    close() {
      db?.close();
    },
  };
}

/**
 * How many of `author`'s rows in these database bytes would leave unsigned:
 * pending (`_r_batch` NULL), or naming a batch the bytes hold no header for.
 *
 * The host opens the outgoing bytes itself, in its own engine, rather than
 * taking the frame's word for them (cold review of identity step 3, #2): the
 * frame belongs to the document. 0 means every row of this author's is sealed.
 */
export async function unsealedOwnRows(bytes: Uint8Array, author: Uint8Array): Promise<number> {
  if (bytes.byteLength === 0) return 0;
  const scratch = await wasmScratch();
  try {
    const rows = scratch.open(bytes);
    const hasBatches = rows.all("SELECT 1 AS x FROM sqlite_schema WHERE type = 'table' AND name = '_dai_batch'").length > 0;
    let unsealed = 0;
    for (const table of rows.all("SELECT name FROM sqlite_schema WHERE type = 'table'").map((r) => String(r["name"]))) {
      const columns = rows.all(`SELECT name FROM pragma_table_info('${table.replace(/'/g, "''")}')`).map((c) => String(c["name"]));
      if (!columns.includes("_r_replica") || !columns.includes("_r_batch")) continue;
      const known = hasBatches ? " OR _r_batch NOT IN (SELECT id FROM _dai_batch)" : "";
      unsealed += Number(
        rows.all(`SELECT count(*) AS n FROM "${table}" WHERE _r_replica = ? AND (_r_batch IS NULL${known})`, [author])[0]?.["n"] ?? 0,
      );
    }
    return unsealed;
  } finally {
    scratch.close();
  }
}

/** One header of the person's in bytes about to leave: its id, lowercase hex, and every seq it could be signed over. */
export interface LeavingHeader {
  id: string;
  seqs: number[];
}

/**
 * What `author`'s headers in these database bytes cover, read in the host's
 * own engine (docs/format.md, `floor`). `headers` is each header of the
 * author's, with the seqs it lists as stored and the seqs of the author's rows
 * naming it, since the signed list is the stored one or the rows naming the id
 * (`verify-lists-tried`): what the egress rule reads. `top` is the highest of
 * those seqs, and of any row of the author's naming a header the bytes hold:
 * what the left floor rises to once the bytes have landed or are published.
 * Higher than the truth only ever refuses; a pending row names no header and
 * does not count. Empty and 0 when there is none.
 */
export async function leavingIn(bytes: Uint8Array, author: Uint8Array): Promise<{ top: number; headers: LeavingHeader[] }> {
  if (bytes.byteLength === 0) return { top: 0, headers: [] };
  const scratch = await wasmScratch();
  try {
    const rows = scratch.open(bytes);
    if (rows.all("SELECT 1 AS x FROM sqlite_schema WHERE type = 'table' AND name = '_dai_batch'").length === 0) {
      return { top: 0, headers: [] };
    }
    const seqsOf = new Map<string, Set<number>>();
    const add = (id: string, seq: unknown): void => {
      if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq <= 0) return;
      seqsOf.get(id)?.add(seq);
    };
    let top = 0;
    for (const header of rows.all("SELECT lower(hex(id)) AS id, covers FROM _dai_batch WHERE author = ?", [author])) {
      const id = String(header["id"]);
      seqsOf.set(id, seqsOf.get(id) ?? new Set());
      let listed: unknown = null;
      try {
        listed = JSON.parse(String(header["covers"] ?? "[]"));
      } catch {
        listed = null;
      }
      if (!Array.isArray(listed)) continue;
      for (const pair of listed) add(id, Array.isArray(pair) ? pair[1] : null);
    }
    for (const table of rows.all("SELECT name FROM sqlite_schema WHERE type = 'table'").map((r) => String(r["name"]))) {
      const columns = rows.all(`SELECT name FROM pragma_table_info('${table.replace(/'/g, "''")}')`).map((c) => String(c["name"]));
      if (!columns.includes("_r_replica") || !columns.includes("_r_batch") || !columns.includes("_r_seq")) continue;
      for (const row of rows.all(
        `SELECT lower(hex(_r_batch)) AS id, _r_seq AS s FROM "${table.replace(/"/g, '""')}" WHERE _r_replica = ? AND _r_batch IN (SELECT id FROM _dai_batch)`,
        [author],
      )) {
        const seq = Number(row["s"]);
        if (Number.isSafeInteger(seq) && seq > top) top = seq;
        add(String(row["id"]), seq);
      }
    }
    const headers = [...seqsOf].map(([id, seqs]) => ({ id, seqs: [...seqs] }));
    for (const { seqs } of headers) for (const seq of seqs) if (seq > top) top = seq;
    return { top, headers };
  } finally {
    scratch.close();
  }
}

/**
 * The batch format versions of the headers these database bytes hold, read in
 * the host's own engine: what decides whether this host may write the copy
 * (D108). Empty when the bytes hold no header, or no header table.
 */
export async function batchVersionsIn(bytes: Uint8Array): Promise<number[]> {
  if (bytes.byteLength === 0) return [];
  const scratch = await wasmScratch();
  try {
    const rows = scratch.open(bytes);
    if (rows.all("SELECT 1 AS x FROM sqlite_schema WHERE type = 'table' AND name = '_dai_batch'").length === 0) return [];
    return rows.all("SELECT DISTINCT version FROM _dai_batch").map((r) => Number(r["version"]));
  } finally {
    scratch.close();
  }
}

/**
 * The invite for `sessionHex`: this document with its database filtered to
 * that session's rows, resealed. Not yet re-verified — the caller does that
 * before it hands the document on.
 *
 * Throws `SESSION_EXPORT_INCOMPLETE` (from the filter) for a source whose rows
 * cross sessions, rather than making an invite with a parent that never arrives.
 */
export async function inviteFor(
  container: ParsedContainer,
  database: Uint8Array,
  sessionHex: string,
): Promise<ParsedContainer> {
  if (!/^[0-9a-f]{32}$/.test(sessionHex)) throw new Error("That is not a session id.");
  return exportSession(container, database, fromHex(sessionHex), await wasmScratch());
}
