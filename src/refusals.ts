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
  MANIFEST_MISSING: { recoverable: false, means: "No manifest, so nothing can be verified." },
  MANIFEST_UNREADABLE: { recoverable: false, means: "The manifest is not valid JSON." },
  UNSUPPORTED_ALGORITHM: { recoverable: false, means: "A digest algorithm this reader does not implement." },
  UNSUPPORTED_CRYPTO: { recoverable: false, means: "No WebCrypto: not a secure context." },
  SECTION_MISSING: { recoverable: false, means: "A required section is absent; the file is incomplete." },
  UNSUPPORTED_MANIFEST_VERSION: {
    recoverable: false,
    means: "A manifestVersion this reader does not know. The file is not damaged; the host needs updating.",
  },
  RUNTIME_UNAVAILABLE: {
    recoverable: false,
    means: "Published without its engine, for a host that already holds those exact bytes. This one does not.",
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
