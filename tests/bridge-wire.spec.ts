import { expect, test } from "@playwright/test";
import { TO_DOCUMENT, TO_HOST } from "../src/bridge.js";

/**
 * The host bridge's message names, as they travel (D68).
 *
 * The one test that writes these strings out instead of importing them, on
 * purpose. The rule is that a test imports the constants it asserts on, because
 * a spelled-out literal can be disconnected by a rename. Here the spelled-out
 * strings are the subject: every document carries the runtime it was built
 * with, and the opener keeps every earlier host so old links still rebuild, and
 * those runtimes speak exactly these strings forever. A rename made on both
 * sides at once passes `src/bridge.ts`'s own check, since the key and value
 * still agree, and every program in this repository would still talk to itself.
 * It would silently stop talking to every document already in the world. This
 * is what fails instead.
 *
 * Adding a name is allowed, and means adding it here in the same change. What
 * must never happen is an existing string changing or disappearing.
 */

const TO_HOST_ON_THE_WIRE = [
  "DAI_HOST_APPLIED",
  "DAI_HOST_AUTHORED",
  "DAI_HOST_AUTHORED_BATCH",
  "DAI_HOST_CLOSING",
  "DAI_HOST_FLUSHED",
  "DAI_HOST_GROUND",
  "DAI_HOST_HANDSHAKE",
  // The one bridge name with the frame prefix; the probe document posts it (D69).
  "dai:isolation-report",
  "DAI_HOST_MERGE_RESULT",
  "DAI_HOST_REFUSED",
  "DAI_HOST_REPLICA_ID_ANSWER",
  "DAI_HOST_REQUEST_SHARE",
  "DAI_HOST_SAVE",
  "DAI_HOST_SAVE_STATE",
  "DAI_HOST_SESSIONS_ANSWER",
  "DAI_HOST_TIMING",
  "DAI_HOST_USED",
  "DAI_HOST_WAITING",
  "DAI_HOST_WRITE_RULES_REFUSED",
];

const TO_DOCUMENT_ON_THE_WIRE = [
  "DAI_HOST_APPLY_BATCH",
  "DAI_HOST_AUTHORED_SINCE",
  "DAI_HOST_CANVAS",
  "DAI_HOST_FLUSH",
  "DAI_HOST_HANDSHAKE_ACK",
  "DAI_HOST_INSETS",
  "DAI_HOST_MERGE",
  "DAI_HOST_REPLICA_ID",
  "DAI_HOST_SAVE_ACK",
  "DAI_HOST_SESSIONS",
  "DAI_HOST_WRITE_RULES",
];

test.describe("the host bridge's names on the wire", () => {
  test("every message the runtime sends to a host is spelled as it always was", () => {
    expect(Object.values(TO_HOST).sort()).toEqual([...TO_HOST_ON_THE_WIRE].sort());
  });

  test("every message a host sends to the runtime is spelled as it always was", () => {
    expect(Object.values(TO_DOCUMENT).sort()).toEqual([...TO_DOCUMENT_ON_THE_WIRE].sort());
  });
});
