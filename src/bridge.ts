/**
 * The message names of the host bridge, defined in one place (D68).
 *
 * A document's runtime and the host that framed it speak over `postMessage`,
 * and each message names itself by a `type`. Those names were string literals
 * written wherever a message was sent or checked, in the runtime
 * (`src/runtime/bootloader.ts`), in the web opener (`apps/runner/src/main.ts`,
 * `mailbox-session.ts`) and in the desktop host, with nothing that held the set.
 * A name spelled differently on one side does not fail; it is a message nobody
 * hears. So the names are written here, both programs import them, and this
 * module refuses to load if the set is inconsistent.
 *
 * **The values are wire format and never change.** Every document carries the
 * runtime it was built with, and the opener keeps every earlier host so old
 * links still rebuild (`scripts/retain-host.mjs`). Those runtimes speak these
 * exact strings forever. The code that uses the names can be refactored; a
 * value cannot be renamed, not even on both sides at once.
 * `tests/bridge-wire.spec.ts` holds every value, written out in full.
 *
 * Split by direction because every message flows one way (measured 18
 * September: the parser for handlers, a runtime tap for sends). A runtime that
 * sent a host-to-document name would be a type error, not a silent message.
 */

/** Sent by the document runtime, received by the host. */
export const TO_HOST = {
  APPLIED: "DAI_HOST_APPLIED",
  AUTHORED: "DAI_HOST_AUTHORED",
  AUTHORED_BATCH: "DAI_HOST_AUTHORED_BATCH",
  /**
   * The document is going away. Best-effort. Received only by the desktop host
   * (`apps/desktop/src/main.ts`): the web opener has no handler for it, and
   * that is deliberate for now (D68, 18 September). The runtime sends it on
   * every host, so it stays in the set.
   */
  CLOSING: "DAI_HOST_CLOSING",
  FLUSHED: "DAI_HOST_FLUSHED",
  GROUND: "DAI_HOST_GROUND",
  HANDSHAKE: "DAI_HOST_HANDSHAKE",
  MERGE_RESULT: "DAI_HOST_MERGE_RESULT",
  REFUSED: "DAI_HOST_REFUSED",
  REQUEST_SHARE: "DAI_HOST_REQUEST_SHARE",
  SAVE: "DAI_HOST_SAVE",
  SAVE_STATE: "DAI_HOST_SAVE_STATE",
  SESSIONS_ANSWER: "DAI_HOST_SESSIONS_ANSWER",
  TIMING: "DAI_HOST_TIMING",
  USED: "DAI_HOST_USED",
  WAITING: "DAI_HOST_WAITING",
  WRITE_RULES_REFUSED: "DAI_HOST_WRITE_RULES_REFUSED",
} as const;

/** Sent by the host, received by the document runtime. */
export const TO_DOCUMENT = {
  APPLY_BATCH: "DAI_HOST_APPLY_BATCH",
  AUTHORED_SINCE: "DAI_HOST_AUTHORED_SINCE",
  CANVAS: "DAI_HOST_CANVAS",
  FLUSH: "DAI_HOST_FLUSH",
  HANDSHAKE_ACK: "DAI_HOST_HANDSHAKE_ACK",
  INSETS: "DAI_HOST_INSETS",
  MERGE: "DAI_HOST_MERGE",
  REPLICA_ID: "DAI_HOST_REPLICA_ID",
  SAVE_ACK: "DAI_HOST_SAVE_ACK",
  SESSIONS: "DAI_HOST_SESSIONS",
  WRITE_RULES: "DAI_HOST_WRITE_RULES",
} as const;

export type ToHost = (typeof TO_HOST)[keyof typeof TO_HOST];
export type ToDocument = (typeof TO_DOCUMENT)[keyof typeof TO_DOCUMENT];

/**
 * Everything wrong with a set of bridge names, in words; empty when it is sound.
 *
 * Two rules. Each value is `DAI_HOST_` followed by its own key, so the name the
 * code uses and the string on the wire cannot drift apart. And no value appears
 * twice, in either direction: one string must never be two messages.
 * Exported so the check can be shown to fire, not only to stay quiet.
 */
export function bridgeProblems(
  sets: Readonly<Record<string, Readonly<Record<string, string>>>>,
): string[] {
  const problems: string[] = [];
  const seen = new Map<string, string>();
  for (const [direction, names] of Object.entries(sets)) {
    for (const [key, value] of Object.entries(names)) {
      if (value !== `DAI_HOST_${key}`) problems.push(`${direction}.${key} is "${value}", not "DAI_HOST_${key}"`);
      const earlier = seen.get(value);
      if (earlier) problems.push(`"${value}" is both ${earlier} and ${direction}.${key}`);
      else seen.set(value, `${direction}.${key}`);
    }
  }
  return problems;
}

// At the point of definition: an inconsistent set is not a warning for later.
const problems = bridgeProblems({ TO_HOST, TO_DOCUMENT });
if (problems.length > 0) throw new Error(`bridge names are inconsistent: ${problems.join("; ")}`);
