/**
 * Origin Private File System (OPFS) & Storage layer for DAI Runner.
 *
 * Saves and retrieves cartridge SQLite databases and manages the IndexedDB Cartridge Library.
 */

const IDB_NAME = "dai_runner_storage";
const DB_STORE = "sqlite_databases";
const LIB_STORE = "cartridges";
/** Which key each document was first opened with. */
const PIN_STORE = "pins";
/** Publishers this device has seen sign something, by key (4.3). */
const PUB_STORE = "publishers";

import type { PinnedKey, TrustStore } from "../../../src/trust.js";
import type { PublisherPin, PublisherStore, RootPublisher } from "../../../src/publisher.js";
import type { SigstoreRoot } from "../../../src/identity.js";

export interface LibraryItem {
  documentUuid: string;
  appName: string;
  lastOpened: string;
  html: string;
  publicKeyFingerprint?: string;
  /**
   * Counts the saves this device has committed for the document. A tab
   * saving against a revision it did not see last is behind another tab,
   * and its whole-database write would put the newer work back.
   */
  revision?: number;
  /**
   * When the copy this device holds was last saved, from the manifest that
   * was sealed around it (`savedAt`).
   *
   * Kept so an arriving copy of the same document can be told apart from the
   * one already here: a document that comes back — a move returned in a game
   * played by link — carries data this device has never seen, and a document
   * opened again from the file it came from carries data older than what has
   * been done to it since.
   */
  savedAt?: string;
  /**
   * Links this device made through the store for the document, with the
   * token that retires each. Kept so the person who shared can unshare.
   */
  shares?: Share[];
  /**
   * The person said to keep this copy up to date (T1-D23).
   *
   * Set once, by pressing it on the launch card the first time another copy of
   * this document arrives. After that, copies this host would have permitted
   * anyway merge without asking — because §8.2 requires the person to choose
   * and a choice can be a standing one. Nobody approves each message from a
   * sender they have already accepted.
   *
   * Per document, per copy, and local: it is a fact about what this person
   * decided on this device, never part of the document and never merged. It
   * would be meaningless in somebody else's copy and dangerous if it travelled
   * — a consent nobody on that device ever gave.
   *
   * Absent means not yet asked. Explicitly false means asked and declined, and
   * is not the same thing: declined means offer again, and this device keeps
   * opening arriving copies separately until told otherwise.
   */
  mergeStanding?: boolean;
}

export interface Share {
  hash: string;
  retire: string;
  at: string;
  /**
   * A card for a document that travelled inside its link, rather than the
   * document itself. Retiring it takes the card down; the link still opens,
   * because the app is in it.
   */
  card?: true;
}

/*
 * One connection to the library database, opened once and reused.
 *
 * This opened a fresh connection on every call and closed none. A session
 * makes dozens of these calls — every library read, every trust check, every
 * publisher lookup — and on iOS Safari the leaked connections accumulate until
 * `indexedDB.open` stops firing any event at all: not onsuccess, not onerror,
 * not onblocked. The call that reads the library then waits forever with no
 * error, which is the launch a phone reported stalled at "reading the library".
 *
 * A single cached connection opens once and is handed back thereafter; a
 * version change or a close drops the cache so the next call opens fresh rather
 * than reusing a dead handle, and a failed or timed-out open drops it too so a
 * later attempt is not stuck with a rejected promise.
 */
let idbConnection: Promise<IDBDatabase> | null = null;

/** A failure the details panel can show, since a caught IDB error is otherwise silent. */
function noteIdbFailure(what: string): void {
  try {
    const ring = (globalThis as unknown as { __daiLog?: string[] }).__daiLog;
    if (!ring) return;
    ring.push(`${new Date().toISOString().slice(11, 23)} idb: ${what}`);
    if (ring.length > 30) ring.shift();
  } catch {
    /* The log is a convenience; never let it throw into a storage path. */
  }
}

function openIdb(): Promise<IDBDatabase> {
  if (idbConnection) return idbConnection;
  idbConnection = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(IDB_NAME, 5);
    /*
     * A bound on the open itself. iOS Safari can leave `indexedDB.open`
     * pending with no event ever firing; without this the whole launch waits
     * on it. Five seconds is far longer than a working open and still a
     * failure rather than a hang — the caller falls back to an empty result,
     * so a document opens (as unfamiliar) rather than not at all.
     */
    const timer = setTimeout(() => {
      noteIdbFailure("open timed out after 5s");
      reject(new Error("IDB_OPEN_TIMEOUT"));
    }, 5000);
    request.onblocked = () => {
      clearTimeout(timer);
      noteIdbFailure("open blocked");
      reject(new Error("IDB_OPEN_BLOCKED"));
    };
    request.onupgradeneeded = (event) => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DB_STORE)) {
        db.createObjectStore(DB_STORE);
      }
      // Version 3 adds the pin store. Somebody with a library from before this
      // existed keeps it: the upgrade adds, and every document they already
      // have is pinned on its next open, which is a first use as far as this
      // host is concerned.
      if (!db.objectStoreNames.contains(PIN_STORE)) {
        db.createObjectStore(PIN_STORE);
      }
      if (!db.objectStoreNames.contains(LIB_STORE)) {
        db.createObjectStore(LIB_STORE, { keyPath: "documentUuid" });
      }
      // Version 4 adds publishers: the key, the name it signs under, and the
      // documents opened under it. Indexed on the folded name, so "is this
      // name one I know under another key" is one lookup.
      if (!db.objectStoreNames.contains(PUB_STORE)) {
        db.createObjectStore(PUB_STORE, { keyPath: "publicKey" });
      }
      // Version 5: names are found by UTS #39 skeleton (spec §9.6), and a pin
      // carries one per name it goes by — the asserted name and the person's
      // label — so the index is multi-entry. The version 4 records had a
      // single folded name; they are re-skeletoned lazily as they are met.
      const publishers = request.transaction!.objectStore(PUB_STORE);
      if (publishers.indexNames.contains("folded")) publishers.deleteIndex("folded");
      if (!publishers.indexNames.contains("skeletons")) {
        publishers.createIndex("skeletons", "skeletons", { unique: false, multiEntry: true });
      }
    };
    request.onsuccess = () => {
      clearTimeout(timer);
      const db = request.result;
      // A superseded or closed connection must not be handed out again.
      db.onversionchange = () => {
        db.close();
        idbConnection = null;
      };
      db.onclose = () => {
        idbConnection = null;
      };
      resolve(db);
    };
    request.onerror = () => {
      clearTimeout(timer);
      reject(request.error);
    };
  }).catch((error: unknown) => {
    // Drop the cache so the next call opens a fresh connection rather than
    // awaiting the one that already failed.
    idbConnection = null;
    throw error;
  });
  return idbConnection;
}

/**
 * A write is acknowledged when its transaction commits, not when the request
 * succeeds. A request can succeed and its transaction still abort — quota,
 * a version change, a closing page — and a promise resolved on the request
 * had already told the caller its data was kept. Every write below goes
 * through here.
 */
function committed(tx: IDBTransaction, run: (store: IDBObjectStore) => IDBRequest): Promise<void> {
  return new Promise((resolve, reject) => {
    let requestError: DOMException | null = null;
    const req = run(tx.objectStore(tx.objectStoreNames[0]!));
    req.onerror = () => {
      requestError = req.error;
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? requestError ?? new Error("The write did not commit."));
    tx.onabort = () => reject(tx.error ?? requestError ?? new Error("The write was abandoned before it committed."));
  });
}

async function saveToIdb(documentUuid: string, bytes: Uint8Array): Promise<void> {
  const db = await openIdb();
  await committed(db.transaction(DB_STORE, "readwrite"), (store) => store.put(bytes, documentUuid));
}

async function loadFromIdb(documentUuid: string): Promise<Uint8Array | null> {
  try {
    const db = await openIdb();
    return new Promise((resolve) => {
      const tx = db.transaction(DB_STORE, "readonly");
      const store = tx.objectStore(DB_STORE);
      const req = store.get(documentUuid);
      req.onsuccess = () => {
        const val = req.result;
        if (val instanceof Uint8Array) resolve(val);
        else if (val instanceof ArrayBuffer) resolve(new Uint8Array(val));
        else resolve(null);
      };
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

async function deleteFromIdb(documentUuid: string): Promise<void> {
  try {
    const db = await openIdb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, "readwrite");
      const store = tx.objectStore(DB_STORE);
      const req = store.delete(documentUuid);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch {
    // Ignore error if missing
  }
}

/**
 * One place holds a document's database at a time.
 *
 * The file system is preferred and IndexedDB is the fallback. A read that
 * preferred any non-empty file over the fallback let an older file win over
 * a newer fallback write — a save acknowledged in IndexedDB, and the reopened
 * document showing the state before it. So whichever store takes the write,
 * the other's copy is removed, and a read finds one answer.
 */
export async function saveDatabaseToOpfs(
  documentUuid: string,
  databaseBytes: Uint8Array,
): Promise<void> {
  if (navigator.storage?.getDirectory) {
    try {
      const root = await navigator.storage.getDirectory();
      const fileHandle = await root.getFileHandle(`${documentUuid}.sqlite`, {
        create: true,
      });

      if (
        "createWritable" in fileHandle &&
        typeof (fileHandle as { createWritable?: unknown }).createWritable === "function"
      ) {
        const writable = await (
          fileHandle as unknown as {
            createWritable: () => Promise<{
              write: (b: Uint8Array) => Promise<void>;
              close: () => Promise<void>;
            }>;
          }
        ).createWritable();
        await writable.write(databaseBytes);
        await writable.close();
        await deleteFromIdb(documentUuid).catch(() => undefined);
        return;
      }
    } catch {
      // Fall through to IDB
    }
  }

  await saveToIdb(documentUuid, databaseBytes);
  // The fallback is now the authority; a stale file must not outrank it.
  await removeOpfsFile(documentUuid).catch(() => undefined);
}

async function removeOpfsFile(documentUuid: string): Promise<void> {
  if (!navigator.storage?.getDirectory) return;
  const root = await navigator.storage.getDirectory();
  await root.removeEntry(`${documentUuid}.sqlite`).catch(() => undefined);
}

export async function loadDatabaseFromOpfs(
  documentUuid: string,
): Promise<Uint8Array | null> {
  if (navigator.storage?.getDirectory) {
    try {
      const root = await navigator.storage.getDirectory();
      const fileHandle = await root.getFileHandle(`${documentUuid}.sqlite`);
      const file = await fileHandle.getFile();
      const buffer = await file.arrayBuffer();
      if (buffer.byteLength > 0) {
        return new Uint8Array(buffer);
      }
    } catch {
      // Fall through to IDB
    }
  }

  return loadFromIdb(documentUuid);
}

export async function deleteDatabaseFromOpfs(documentUuid: string): Promise<void> {
  if (navigator.storage?.getDirectory) {
    try {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry(`${documentUuid}.sqlite`);
    } catch {
      // Ignore if file doesn't exist
    }
  }
  await deleteFromIdb(documentUuid);
}

export async function saveCartridgeToLibrary(item: LibraryItem): Promise<void> {
  const db = await openIdb();
  await committed(db.transaction(LIB_STORE, "readwrite"), (store) => store.put(item));
}

/** One document's library record, or null when this device does not hold it. */
export async function getCartridgeFromLibrary(documentUuid: string): Promise<LibraryItem | null> {
  const db = await openIdb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(LIB_STORE, "readonly").objectStore(LIB_STORE).get(documentUuid);
    req.onsuccess = () => resolve((req.result as LibraryItem | undefined) ?? null);
    req.onerror = () => reject(req.error);
  });
}

export async function listCartridgesFromLibrary(): Promise<LibraryItem[]> {
  try {
    const db = await openIdb();
    return new Promise((resolve) => {
      // The transaction is bounded like the open: a request that never fires
      // its event resolves to an empty library rather than hanging the launch.
      const timer = setTimeout(() => {
        noteIdbFailure("library read timed out after 5s");
        resolve([]);
      }, 5000);
      const done = (items: LibraryItem[]): void => {
        clearTimeout(timer);
        resolve(items);
      };
      const tx = db.transaction(LIB_STORE, "readonly");
      const store = tx.objectStore(LIB_STORE);
      const req = store.getAll();
      req.onsuccess = () => {
        const items = (req.result as LibraryItem[]) || [];
        items.sort(
          (a, b) =>
            new Date(b.lastOpened).getTime() - new Date(a.lastOpened).getTime(),
        );
        done(items);
      };
      req.onerror = () => done([]);
    });
  } catch {
    return [];
  }
}

export async function deleteCartridgeFromLibrary(
  documentUuid: string,
): Promise<void> {
  try {
    const db = await openIdb();
    await committed(db.transaction(LIB_STORE, "readwrite"), (store) => store.delete(documentUuid));
  } catch {
    // Ignore error
  }
}

/**
 * Where this device remembers which key signed each document.
 *
 * The decision is in `src/trust.ts` and is shared with the desktop host. This
 * is only the storage — and it is per-device by nature, which is the honest
 * shape of trust on first use: a pin means "the key this browser saw the first
 * time", not a claim anybody else can check.
 */
export function trustStore(): TrustStore {
  return {
    async get(documentUuid) {
      const db = await openIdb();
      return new Promise((resolve, reject) => {
        const request = db.transaction(PIN_STORE, "readonly").objectStore(PIN_STORE).get(documentUuid);
        request.onsuccess = () => resolve((request.result as PinnedKey | undefined) ?? null);
        request.onerror = () => reject(request.error);
      });
    },

    async pin(documentUuid, key) {
      const db = await openIdb();
      await new Promise<void>((resolve, reject) => {
        const write = db.transaction(PIN_STORE, "readwrite");
        // `add` rather than `put`: trust on first use means the first use, and
        // a store that let a later open replace the record would be remembering
        // whatever it was last told rather than what it first saw.
        const request = write.objectStore(PIN_STORE).add(key, documentUuid);
        request.onerror = () => {
          // Already pinned by a race. Not an error: the pin that is there is
          // the one that counts.
          request.transaction?.abort();
        };
        write.oncomplete = () => resolve();
        write.onabort = () => resolve();
        write.onerror = () => reject(write.error);
      });
    },

    async forget(documentUuid) {
      const db = await openIdb();
      await new Promise<void>((resolve, reject) => {
        const write = db.transaction(PIN_STORE, "readwrite");
        write.objectStore(PIN_STORE).delete(documentUuid);
        write.oncomplete = () => resolve();
        write.onerror = () => reject(write.error);
      });
    },
  };
}

/**
 * Publishers, by key.
 *
 * The decision about what a name means lives in `src/publisher.ts` and is
 * shared with the desktop; this is only where this host keeps the records.
 */
export function publisherStore(): PublisherStore {
  return {
    async byKey(publicKey) {
      const db = await openIdb();
      return new Promise((resolve, reject) => {
        const request = db.transaction(PUB_STORE, "readonly").objectStore(PUB_STORE).get(publicKey);
        request.onsuccess = () => resolve((request.result as PublisherPin | undefined) ?? null);
        request.onerror = () => reject(request.error);
      });
    },

    async bySkeleton(skeleton) {
      const db = await openIdb();
      return new Promise((resolve, reject) => {
        const request = db
          .transaction(PUB_STORE, "readonly")
          .objectStore(PUB_STORE)
          .index("skeletons")
          .getAll(skeleton);
        request.onsuccess = () => resolve((request.result as PublisherPin[]) ?? []);
        request.onerror = () => reject(request.error);
      });
    },

    async save(pin) {
      const db = await openIdb();
      await new Promise<void>((resolve, reject) => {
        const write = db.transaction(PUB_STORE, "readwrite");
        write.objectStore(PUB_STORE).put(pin);
        write.oncomplete = () => resolve();
        write.onerror = () => reject(write.error);
      });
    },

    roots: rootList,
  };
}

/**
 * Keys an organisation told this opener to know (spec §9.6, root lists).
 *
 * Read from `roots.json` beside the opener, so a mirror an organisation runs
 * can ship one with the build and a public opener simply has none. Fetched
 * once; a missing file is an empty list, not an error.
 */
interface RootFile {
  formatVersion?: number;
  publishers?: RootPublisher[];
  sigstore?: SigstoreRoot[];
}
let rootsLoading: Promise<RootFile> | undefined;
function rootFile(): Promise<RootFile> {
  rootsLoading ??= fetch(new URL("roots.json", document.baseURI))
    .then(async (response) => (response.ok ? ((await response.json()) as RootFile) : {}))
    .then((list) => (list?.formatVersion === 1 ? list : {}))
    .catch(() => ({}));
  return rootsLoading;
}
export async function rootList(): Promise<RootPublisher[]> {
  const list = await rootFile();
  return (list.publishers ?? []).filter((p) => typeof p?.spki === "string" && typeof p?.name === "string");
}
/** The Fulcio and Rekor roots this opener holds (spec §9.5). None on a public opener. */
export async function sigstoreRoots(): Promise<SigstoreRoot[]> {
  const list = await rootFile();
  return (list.sigstore ?? []).filter((r) => Array.isArray(r?.fulcioRoots) && Array.isArray(r?.rekorKeys));
}
