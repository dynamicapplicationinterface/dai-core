/**
 * Origin Private File System (OPFS) & Storage layer for DAI Runner.
 *
 * Saves and retrieves cartridge SQLite databases and manages the IndexedDB Cartridge Library.
 */

const IDB_NAME = "dai_runner_storage";
const DB_STORE = "sqlite_databases";
const LIB_STORE = "cartridges";

export interface LibraryItem {
  documentUuid: string;
  appName: string;
  lastOpened: string;
  html: string;
  publicKeyFingerprint?: string;
}

function openIdb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(IDB_NAME, 2);
    request.onupgradeneeded = (event) => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DB_STORE)) {
        db.createObjectStore(DB_STORE);
      }
      if (!db.objectStoreNames.contains(LIB_STORE)) {
        db.createObjectStore(LIB_STORE, { keyPath: "documentUuid" });
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
