/**
 * Every reason a conforming implementation may refuse, by name.
 *
 * Hosts refused in prose, and prose is fine for a person and useless for a
 * second implementation: a conformance case can say "this must be refused"
 * but not "and for this reason" unless the reason has a name both readers
 * emit. Three readers now emit these — the TypeScript reader, the bootloader
 * inside every container, and the Python reader written from the
 * specification — and the conformance suite checks the name, not only the
 * refusal.
 *
 * The bootloader's names came first and are already read by hosts through
 * the bridge, so they are kept exactly; the reader-only reasons are added
 * beside them. Renaming a vocabulary that is already on the wire would buy a
 * tidier list at the price of every host that reads it.
 *
 * `recoverable` says whether the person's work is still in hand — a lost race
 * or a busy lock — as opposed to a file that is not what it claims.
 */
export const REFUSALS = {
  // ---- not a container, or not one this reader can read
  NO_PAYLOAD: { recoverable: false, means: "No payload: probably not a container at all." },
  PAYLOAD_UNREADABLE: { recoverable: false, means: "The payload did not decode or unzip." },
  PAYLOAD_TOO_LARGE: { recoverable: false, means: "The archive declares, or inflates to, more than this reader will hold." },
  MANIFEST_MISSING: { recoverable: false, means: "No manifest, so nothing can be verified." },
  MANIFEST_UNREADABLE: { recoverable: false, means: "The manifest is not valid JSON." },
  UNSUPPORTED_ALGORITHM: { recoverable: false, means: "A digest algorithm this reader does not implement." },
  UNSUPPORTED_CRYPTO: { recoverable: false, means: "No WebCrypto: not a secure context." },
  SECTION_MISSING: { recoverable: false, means: "A required section is absent; the file is incomplete." },
  UNSUPPORTED_MANIFEST_VERSION: {
    recoverable: false,
    means: "A manifestVersion this reader does not know. The file is not damaged; the host needs updating.",
  },
  UNSUPPORTED_CAPABILITY: {
    recoverable: false,
    means:
      "The document names a capability this reader does not implement. The file is not damaged; " +
      "the host needs updating. Never opened without the capability: for rosters, sessions and " +
      "confidentiality that is the hole the capability closes.",
  },
  RUNTIME_UNAVAILABLE: {
    recoverable: false,
    means: "Published without its engine, for a host that already holds those exact bytes. This one does not.",
  },
  MALFORMED_SESSION_PROFILE: {
    recoverable: false,
    means:
      "A session block without requires:[session], the requirement without the block, or a " +
      "max_parties that is not a positive integer. The two are one declaration; half of it is " +
      "malformed, not a plain replicated document to open (T1-D27).",
  },
  SESSION_EXPORT_INCOMPLETE: {
    recoverable: false,
    means:
      "Exporting an invite for one session, a kept row named a parent in another session: the " +
      "source document is malformed, an entity's history having crossed sessions. Refused rather " +
      "than shipping an invite with a parent that never arrives (T1-D28).",
  },
  SEAT_ALREADY_BOUND: {
    recoverable: false,
    means:
      "A session seat carries bindings from two or more replicas — two parties opened the same " +
      "invite. The seat is contested and admits neither, order-free and without a clock deciding " +
      "it. The creator can revoke the seat and issue a new invite (T1-D29).",
  },
  SEATS_EXCEED_CAP: {
    recoverable: false,
    means:
      "A session declares more seats than its signed max_parties allows. The cap is the creator's " +
      "signed statement of how many may join, so more seats than the cap is malformed (T1-D29).",
  },
  MERGE_COVERAGE: {
    recoverable: false,
    means:
      "A replicated table is neither an author table nor a named system table, so a merge would " +
      "converge some tables and silently diverge on it. Refused rather than merged incompletely — " +
      "a system table added without wiring it into the merge set (T1-D29).",
  },
  CLOSE_NOT_PERMITTED: {
    recoverable: false,
    means:
      "A session declares close=creator, and a replica that is not the creator tried to close it. " +
      "Only the creator may end this session; the close is refused rather than written as a row " +
      "that closes nothing (T1-D32).",
  },
  ROLE_NOT_PERMITTED: {
    recoverable: false,
    means:
      "A write named a table that only one party in a session may author, and the other party made " +
      "it: the creator wrote a joiner-only table, or the joiner a creator-only one. The message names " +
      "which, and the table. Refused at the write rather than written as a row every copy would drop " +
      "(D15).",
  },
  CANNOT_RESEAT: {
    recoverable: false,
    means:
      "A reseat was asked for on a session with no contested seat. Reseating replaces a seat's " +
      "value, dropping every binding to the old one — a repair for a seat two parties opened, and " +
      "damage to a healthy one. Refused unless a seat is actually contested (T1-D29).",
  },

  // ---- shared tables, while a document is open
  REPLICATED_TABLE_IMMUTABLE: {
    recoverable: false,
    means:
      "A write tried to change or delete a row of a shared table in place. Shared tables are " +
      "append-only: a change is a new row and a removal a tombstone, both through " +
      "window.dai.replicated. What SQLite says when an application writes one with plain SQL.",
  },
  ROW_REJECTED: {
    recoverable: false,
    means:
      "A row that breaks the replication rules: a second, different row under an id already " +
      "used (a replica issues each sequence number once), a row with no session in a session " +
      "document, a superseded row made current again, or a write before this copy has a replica.",
  },
  WRITE_SURFACE_UNAVAILABLE: {
    recoverable: false,
    means:
      "window.dai.replicated is not in place, so a shared table cannot be written. The reason " +
      "follows in parentheses: the write rules were refused, never arrived, or the host did not " +
      "say the document is replicated. The document is still readable.",
  },
  WRITE_RULES_NOT_DELIVERED: {
    recoverable: false,
    means:
      "The host said this document has shared tables and then sent no write rules within the " +
      "wait, so the document opens read-only rather than writing shared rows it cannot check.",
  },
  NO_SOURCE: {
    recoverable: false,
    means: "The host sent write rules with no module in them.",
  },
  MERGE_MODULE_MISMATCH: {
    recoverable: false,
    means:
      "The write-rules and merge module the host supplied is not the one this runtime is pinned " +
      "to, by digest. Refused rather than run: it is the code that decides which rows are kept.",
  },
  MERGE_MODULE_UNUSABLE: {
    recoverable: false,
    means:
      "The module matched its digest and could not be loaded — a policy the frame runs under " +
      "refused it. Reported as itself, because it reads nothing like a mismatch.",
  },
  NO_DOCUMENT_OPEN: {
    recoverable: false,
    means: "A write, a merge or a mailbox batch arrived while no database was open to take it.",
  },
  NOT_SEAT_CREATOR: {
    recoverable: false,
    means: "A seat change only a session's creator may make was asked for by another replica.",
  },

  // ---- merging another copy
  MERGE_UNAVAILABLE: {
    recoverable: false,
    means: "A merge was asked for and the host supplied no merge module to run it.",
  },
  NOT_A_DATABASE: {
    recoverable: false,
    means: "The other copy's data section is empty or is not a SQLite database.",
  },
  NOT_REPLICATED: {
    recoverable: false,
    means:
      "Neither copy declares shared tables, so there is nothing a merge could combine — refused " +
      "as an answer rather than reported as a merge that changed nothing.",
  },
  SCHEMA_MISMATCH: {
    recoverable: false,
    means:
      "The other copy's shared tables are not the same tables with the same columns as this " +
      "one's, so its rows cannot be merged in.",
  },
  UNSUPPORTED_LEVEL: {
    recoverable: false,
    means:
      "The other copy asks for a replication level this runtime does not implement. Refused " +
      "rather than merged as though it were the level this one knows — checks it expected would " +
      "not have run.",
  },
  MERGE_FAILED: {
    recoverable: false,
    means: "A merge failed for a reason with no name of its own; the message says what.",
  },
  APPLY_FAILED: {
    recoverable: false,
    means: "A batch from the mailbox failed to apply for a reason with no name of its own; the message says what.",
  },

  // ---- the mailbox
  MAILBOX_KEY_INVALID: {
    recoverable: false,
    means: "A mailbox key that is not 32 bytes: the key in the link was cut or edited.",
  },
  MAILBOX_BATCH_TRUNCATED: {
    recoverable: false,
    means: "A sealed batch shorter than its own header, so it cannot be opened. Dropped; the next one is read.",
  },
  MAILBOX_BATCH_MALFORMED: {
    recoverable: false,
    means: "A batch that opened under its key and is not the shape a batch has. Dropped; the next one is read.",
  },
  MAILBOX_BATCH_UNKNOWN_TABLE: {
    recoverable: false,
    means:
      "A batch carries rows for a table this document does not have as a shared table — from a " +
      "copy with a different schema. Refused rather than guessing where its rows belong; the " +
      "message names the table.",
  },
  MAILBOX_APPEND_FAILED: {
    recoverable: true,
    means:
      "The relay did not accept a batch after every retry. The move is kept on this device and " +
      "sent when the connection returns.",
  },

  // ---- building a document
  REPLICATION_SCHEMA_INVALID: {
    recoverable: false,
    means:
      "The schema's shared tables break a rule the build enforces — a column with the reserved " +
      "_r_ prefix, a PRIMARY KEY or AUTOINCREMENT of the author's own, a session profile with " +
      "nothing to scope, or an append-only trigger that does not name every column. Refused at " +
      "build, where the author is.",
  },

  // ---- a link, rather than a file
  LINK_DAMAGED: { recoverable: false, means: "The link does not decode: probably cut or wrapped in transit." },
  LINK_UNSUPPORTED: { recoverable: false, means: "The link names a carrier version or dictionary this reader does not have." },
  LINK_UNRECONSTRUCTABLE: {
    recoverable: false,
    means: "The link leaves out an entry expecting this host's copy to match the sealed digest, and it does not.",
  },

  // ---- a blob a link named, from a store
  BLOB_MISMATCH: { recoverable: false, means: "The store returned bytes that do not hash to what the link names." },
  BLOB_UNDECRYPTABLE: { recoverable: false, means: "The link's key does not open the blob: the link was cut or edited." },
  STORE_REFUSED: { recoverable: false, means: "A store declined to hold this: not a DAI document, too large, or the sidecar disagrees." },

  // ---- modified
  DIGEST_MISMATCH: { recoverable: false, means: "An entry does not match its digest, is missing, or is unlisted." },
  SECTION_MISMATCH: { recoverable: false, means: "The manifest or application section does not match its digest." },
  DATA_DAMAGED: { recoverable: false, means: "Only the database disagrees with its record: an interrupted save. The application is intact." },
  SHELL_MISSING: { recoverable: false, means: "No sealed copy of the shell, so the bootloader cannot be checked." },
  SHELL_MISMATCH: { recoverable: false, means: "The shell does not match the sealed copy inside it." },

  // ---- authenticity
  SIGNATURE_UNVERIFIABLE: { recoverable: false, means: "A publisher key is present but there is nothing usable to check." },
  SIGNATURE_UNSUPPORTED: { recoverable: false, means: "A signature format this reader does not implement." },
  SIGNED_SET_MISMATCH: { recoverable: false, means: "The signed list and the digest list disagree, in either direction." },
  UNVERIFIED_SIGNATURE: { recoverable: false, means: "The signature does not verify against the key the file carries." },
  KEY_EXPIRED: { recoverable: false, means: "The container's expiry has passed." },
  PUBLISHER_MISMATCH: { recoverable: false, means: "Signed by a different key than this host pinned for the document." },

  // ---- the application and its data
  NO_APPLICATION: { recoverable: false, means: "Verified, but there is no index.html to run." },
  SCHEMA_INCOMPATIBLE: { recoverable: false, means: "The data's shape is not one the application declared, and no migration reaches it." },
  SCHEMA_AHEAD: { recoverable: true, means: "The data is newer than the application. Do not migrate backwards; offer read-only or an update." },

  // ---- saving
  GENERATION_CONFLICT: { recoverable: true, means: "Another window saved first. The work in hand is still in hand." },
  LOCK_UNAVAILABLE: { recoverable: true, means: "Another program is saving this document right now." },

  // ---- the host itself
  MOUNT_TIMEOUT: { recoverable: false, means: "The application never reported that it started." },
  BOOT_FAILED: { recoverable: false, means: "The bootloader threw." },
  HOST_REFUSED: { recoverable: false, means: "The host declined for a reason of its own; see the message." },
} as const;

export type RefusalCode = keyof typeof REFUSALS;

/** Whether a string is one of the names above. */
export function isRefusalCode(value: unknown): value is RefusalCode {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(REFUSALS, value);
}
