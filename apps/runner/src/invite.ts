/**
 * An invite into one session, made on this device (T1-D28, backlog D4).
 *
 * The filter itself — which rows travel, the same-session-parents check, the
 * local tables emptied — is `filterToSession`, the reviewed and tested row logic
 * in src/replicated-rows.ts. It had no caller: the share sheet sent the whole
 * document, so an invite into one game carried every game in the file. This is
 * the missing half: an engine on this page to run it against a scratch copy of
 * the database, never the live one.
 *
 * The engine is the one this opener already stages under /runtime for thin
 * documents (see engine.ts), loaded only when somebody first sends an invite.
 */
import { filterToSession, type Rows } from "../../../src/replicated-rows.js";

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

/**
 * The database bytes with only `sessionHex`'s rows left in the replicated
 * tables, the local tables emptied, and the document tables kept.
 *
 * Throws `SESSION_EXPORT_INCOMPLETE` (from the filter) for a source whose rows
 * cross sessions, rather than making an invite with a parent that never arrives.
 */
export async function filterToOneSession(database: Uint8Array, sessionHex: string): Promise<Uint8Array> {
  if (!/^[0-9a-f]{32}$/.test(sessionHex)) throw new Error("That is not a session id.");
  const api = await sqlite();
  const db = new api.oo1.DB();
  try {
    const pointer = api.wasm.allocFromTypedArray(database);
    const rc = api.capi.sqlite3_deserialize(
      db.pointer,
      "main",
      pointer,
      database.byteLength,
      database.byteLength,
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
    filterToSession(rows, fromHex(sessionHex));
    return api.capi.sqlite3_js_db_export(db.pointer) as Uint8Array;
  } finally {
    db.close();
  }
}
