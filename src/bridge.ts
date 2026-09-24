/**
 * The message names of the host bridge, defined in one place (D68).
 *
 * A document's runtime and the host that framed it speak over `postMessage`,
 * and each message names itself by a `type`. Those names were string literals
 * written wherever a message was sent or checked, in the runtime
 * (`src/runtime/bootloader.ts`), in the web opener (`apps/runner/src/main.ts`,
 * `mailbox-session.ts`) and in the desktop host, with nothing that held the set.
 * A name spelled differently on one side does not fail; it is a message nobody
 * hears. So the names are written here and both programs import them. Their
 * consistency is checked at build and in tests (`src/names-check.ts`), not as
 * this module loads: that check once ran in every document's runtime, where the
 * strings are already fixed and it could never fire (D70).
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
  /**
   * The isolation probe's report, relayed to the host. **The one name that does
   * not follow `DAI_HOST_` + key**, and the one named exception in the check
   * (`scripts/check-names.mjs`). It was spelled with the frame's prefix before
   * the bridge had an owner, and the probe document's own application code
   * (`conformance/isolation/probe.js`) posts it. That code travels in documents,
   * so the value is wire format and cannot be respelled (D69).
   */
  ISOLATION_REPORT: "dai:isolation-report",
  MERGE_RESULT: "DAI_HOST_MERGE_RESULT",
  REFUSED: "DAI_HOST_REFUSED",
  /**
   * The shell asking the host to check database bytes before it writes them
   * to a file itself (a download or a picker save): the host opens them and
   * refuses any row of this author's left unsigned (identity step 3, #2).
   */
  LEAVE_CHECK: "DAI_HOST_LEAVE_CHECK",
  /** The mounted copy's replica id, answering TO_DOCUMENT.REPLICA_ID. Once spelled by hand on both sides (D100). */
  REPLICA_ID_ANSWER: "DAI_HOST_REPLICA_ID_ANSWER",
  REQUEST_SHARE: "DAI_HOST_REQUEST_SHARE",
  SAVE: "DAI_HOST_SAVE",
  SAVE_STATE: "DAI_HOST_SAVE_STATE",
  SESSIONS_ANSWER: "DAI_HOST_SESSIONS_ANSWER",
  /**
   * Sign this batch header with the person key (docs/identity.md, step 3). The
   * private key never leaves the host; the host signs only for its own author
   * and the mounted document, and raises the sequence floor first.
   */
  SIGN: "DAI_HOST_SIGN",
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
  /** The host's answer to a leave check: the bytes may go, or why not. */
  LEAVE_CHECKED: "DAI_HOST_LEAVE_CHECKED",
  MERGE: "DAI_HOST_MERGE",
  REPLICA_ID: "DAI_HOST_REPLICA_ID",
  SAVE_ACK: "DAI_HOST_SAVE_ACK",
  SESSIONS: "DAI_HOST_SESSIONS",
  /** The signature, or why the host would not sign. */
  SIGNED: "DAI_HOST_SIGNED",
  WRITE_RULES: "DAI_HOST_WRITE_RULES",
} as const;

export type ToHost = (typeof TO_HOST)[keyof typeof TO_HOST];
export type ToDocument = (typeof TO_DOCUMENT)[keyof typeof TO_DOCUMENT];
