import type { DatabaseSync } from "node:sqlite";
import { SESSION_ID_FUNCTION, sessionIdOf } from "../src/session-id.js";

/**
 * A test's connection, able to read the roster views: they check who created a
 * session with `dai_session_id` (src/session-id.ts), which every connection the
 * runtime opens registers. One without it fails on the first roster read.
 */
export function withSessionId<T extends DatabaseSync>(db: T): T {
  db.function(SESSION_ID_FUNCTION, { deterministic: true }, (author, nonce) => sessionIdOf(author, nonce));
  return db;
}
