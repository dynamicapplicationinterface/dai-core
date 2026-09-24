/**
 * Every `dai:` key the opener writes into a browser's own stores (D73).
 *
 * The fifth namespace, and the one with the least to say for itself: local
 * storage, session storage and the Web Locks manager are all flat maps shared
 * by everything on the origin, and each key was written where it was used —
 * `main.ts`, `install.ts`, and the lock helper. One namespace, three files, no
 * one place that could see a collision. That is D56's shape (`u` meaning two
 * things in one fragment) waiting to happen in a store where the cost is worse:
 * two keys that collide do not fail, they overwrite.
 *
 * These are private to this opener and not format. Nothing outside reads them;
 * a rename costs the thing the key remembered, once, per device — an install
 * prompt shown again, a colour re-learned, an opens counter back to zero — and
 * never a document. `storage-keys.spec` holds them to this file and refuses a
 * second definer.
 */
export const KEYS = {
  /** Session storage: which document the reload `keepHere` asked for is for. */
  KEEP_AFTER_RELOAD: "dai:keep-after-reload",
  /** Session storage: the iOS reload was taken, read by the load it caused (d22/D79 arrival line). */
  IOS_RELOAD_TAKEN: "dai:ios-reload-taken",
  /** Session storage: why a document's manifest was last written as a data: URL, for the launch panel. */
  MANIFEST_FALLBACK: "dai:manifest-fallback",
  /** Local storage: the document this device was last showing, for a resume. */
  RESUME: "dai:resume",
  /**
   * IndexedDB, the opener's key store: this device's person key (docs/identity.md).
   * One per device, not per document. Made on first use, never at boot; losing
   * it makes this device a new author, and nothing re-creates the old one.
   */
  PERSON_KEY: "dai:person-key",
} as const;

/** Local storage: the colour under the clock this document last declared, per colour scheme. */
export const groundKey = (documentUuid: string, scheme: string): string => `dai:ground:${documentUuid}:${scheme}`;

/** Local storage: this document's install prompt has been offered once already. */
export const installAskedKey = (documentUuid: string): string => `dai:install-asked:${documentUuid}`;

/** Local storage: how many times this document has been opened on this device. */
export const opensKey = (documentUuid: string): string => `dai:opens:${documentUuid}`;

/**
 * The Web Lock every writer of a document's library record takes.
 *
 * Spelled once here because it has been spelled twice before: the save path
 * took `dai:<uuid>` under a local alias, so a guard reading the source reported
 * every writer as unlocked (D41).
 */
export const libraryLock = (documentUuid: string): string => `dai:${documentUuid}`;

/** Every key-making function here, for a check that wants to see them all. */
export const KEY_MAKERS = { groundKey, installAskedKey, opensKey, libraryLock } as const;
