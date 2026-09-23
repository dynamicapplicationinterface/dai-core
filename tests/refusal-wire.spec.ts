import { expect, test } from "@playwright/test";
import { REFUSALS } from "../src/refusals.js";

/**
 * Every refusal code, spelled out, as the readers on the wire spell them (D75).
 *
 * Written out on purpose; the strings are the subject. A refusal code is a
 * word two implementations agree on: the TypeScript reader, the bootloader in
 * every container and the Python reader all emit these, the conformance cases
 * assert them by name, and a host shows a person what to do from them. Rename
 * one consistently — the registry, the thrower, the conformance vector — and
 * every check in this repository still agrees with itself, while a reader
 * built last month, a host already deployed and a kept conformance case all
 * stop recognising the reason.
 *
 * `refusal-registry.spec` holds the other half: that every code raised in the
 * source is registered. It cannot see a rename, because it reads today's source
 * and today's registry. This is what fails instead.
 *
 * A new code means adding it here in the same change. An existing one never
 * changes its spelling and never disappears.
 */
const ON_THE_WIRE = [
  "APPLY_FAILED",
  "BATCH_DIGEST_MISMATCH",
  "BATCH_SIGNATURE_INVALID",
  "BATCH_UNSIGNED",
  "BLOB_MISMATCH",
  "BLOB_UNDECRYPTABLE",
  "BOOT_FAILED",
  "CANNOT_RESEAT",
  "CLOSE_NOT_PERMITTED",
  "DATA_DAMAGED",
  "DIGEST_MISMATCH",
  "GENERATION_CONFLICT",
  "HOST_REFUSED",
  "KEY_EXPIRED",
  "LINK_DAMAGED",
  "LINK_UNRECONSTRUCTABLE",
  "LINK_UNSUPPORTED",
  "LOCK_UNAVAILABLE",
  "MAILBOX_APPEND_FAILED",
  "MAILBOX_BATCH_MALFORMED",
  "MAILBOX_BATCH_TRUNCATED",
  "MAILBOX_BATCH_UNKNOWN_TABLE",
  "MAILBOX_KEY_INVALID",
  "MALFORMED_SESSION_PROFILE",
  "MANIFEST_MISSING",
  "MANIFEST_UNREADABLE",
  "MERGE_COVERAGE",
  "MERGE_FAILED",
  "MERGE_MODULE_MISMATCH",
  "MERGE_MODULE_UNUSABLE",
  "MERGE_UNAVAILABLE",
  "MOUNT_TIMEOUT",
  "NOT_A_DATABASE",
  "NOT_REPLICATED",
  "NOT_SEAT_CREATOR",
  "NO_APPLICATION",
  "NO_DOCUMENT_OPEN",
  "NO_PAYLOAD",
  "NO_SOURCE",
  "PAYLOAD_TOO_LARGE",
  "PAYLOAD_UNREADABLE",
  "PUBLISHER_MISMATCH",
  "REPLICATED_TABLE_IMMUTABLE",
  "REPLICATION_SCHEMA_INVALID",
  "ROLE_NOT_PERMITTED",
  "ROW_REJECTED",
  "RUNTIME_UNAVAILABLE",
  "SCHEMA_AHEAD",
  "SCHEMA_INCOMPATIBLE",
  "SCHEMA_MISMATCH",
  "SEATS_EXCEED_CAP",
  "SEAT_ALREADY_BOUND",
  "SECTION_MISMATCH",
  "SECTION_MISSING",
  "SESSION_EXPORT_INCOMPLETE",
  "SHELL_MISMATCH",
  "SHELL_MISSING",
  "SIGNATURE_UNSUPPORTED",
  "SIGNATURE_UNVERIFIABLE",
  "SIGNED_SET_MISMATCH",
  "STORE_REFUSED",
  "UNSUPPORTED_ALGORITHM",
  "UNSUPPORTED_CAPABILITY",
  "UNSUPPORTED_CRYPTO",
  "UNSUPPORTED_LEVEL",
  "UNSUPPORTED_MANIFEST_VERSION",
  "UNVERIFIED_SIGNATURE",
  "WRITE_RULES_NOT_DELIVERED",
  "WRITE_SURFACE_UNAVAILABLE",
];

test("every refusal code is spelled as the readers already spell it", () => {
  expect(Object.keys(REFUSALS).sort()).toEqual([...ON_THE_WIRE].sort());
});

test("the list is the registry's own, not a copy that drifted", () => {
  // The guard against this test rotting into a second registry: each name must
  // still be a key, and the count must match, so a code deleted from the
  // registry cannot pass by remaining in the list here.
  expect(ON_THE_WIRE).toHaveLength(Object.keys(REFUSALS).length);
  for (const code of ON_THE_WIRE) {
    expect(Object.prototype.hasOwnProperty.call(REFUSALS, code), `${code} is still in the registry`).toBe(true);
  }
});
