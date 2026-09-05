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
import type { PublisherPin, PublisherStore } from "../../../src/publisher.js";

export interface LibraryItem {
  documentUuid: string;
  appName: string;
  lastOpened: string;
  html: string;
  publicKeyFingerprint?: string;
}

function openIdb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(IDB_NAME, 4);
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
        const publishers = db.createObjectStore(PUB_STORE, { keyPath: "publicKey" });
        publishers.createIndex("folded", "folded", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function saveToIdb(documentUuid: string, bytes: Uint8Array): Promise<void> {
  const db = await openIdb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readwrite");
    const store = tx.objectStore(DB_STORE);
    const req = store.put(bytes, documentUuid);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
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
        return;
      }
    } catch {
      // Fall through to IDB
    }
  }

  await saveToIdb(documentUuid, databaseBytes);
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
  return new Promise((resolve, reject) => {
    const tx = db.transaction(LIB_STORE, "readwrite");
    const store = tx.objectStore(LIB_STORE);
    const req = store.put(item);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function listCartridgesFromLibrary(): Promise<LibraryItem[]> {
  try {
    const db = await openIdb();
    return new Promise((resolve) => {
      const tx = db.transaction(LIB_STORE, "readonly");
      const store = tx.objectStore(LIB_STORE);
      const req = store.getAll();
      req.onsuccess = () => {
        const items = (req.result as LibraryItem[]) || [];
        items.sort(
          (a, b) =>
            new Date(b.lastOpened).getTime() - new Date(a.lastOpened).getTime(),
        );
        resolve(items);
      };
      req.onerror = () => resolve([]);
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
    return new Promise((resolve, reject) => {
      const tx = db.transaction(LIB_STORE, "readwrite");
      const store = tx.objectStore(LIB_STORE);
      const req = store.delete(documentUuid);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
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

    async byFoldedName(folded) {
      const db = await openIdb();
      return new Promise((resolve, reject) => {
        const request = db
          .transaction(PUB_STORE, "readonly")
          .objectStore(PUB_STORE)
          .index("folded")
          .getAll(folded);
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
  };
}
