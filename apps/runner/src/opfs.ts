/**
 * Origin Private File System (OPFS) & Storage layer for DAI Runner.
 *
 * Saves and retrieves cartridge SQLite databases keyed by documentUuid.
 * Uses OPFS File System Access API when available, falling back to IndexedDB
 * for environments (such as WebKit builds) where OPFS createWritable is absent on main thread.
 */

const IDB_NAME = "dai_runner_storage";
const IDB_STORE = "sqlite_databases";

function openIdb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(IDB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function saveToIdb(documentUuid: string, bytes: Uint8Array): Promise<void> {
  const db = await openIdb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    const store = tx.objectStore(IDB_STORE);
    const req = store.put(bytes, documentUuid);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function loadFromIdb(documentUuid: string): Promise<Uint8Array | null> {
  try {
    const db = await openIdb();
    return new Promise((resolve) => {
      const tx = db.transaction(IDB_STORE, "readonly");
      const store = tx.objectStore(IDB_STORE);
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

      if ("createWritable" in fileHandle && typeof (fileHandle as { createWritable?: unknown }).createWritable === "function") {
        const writable = await (fileHandle as unknown as { createWritable: () => Promise<{ write: (b: Uint8Array) => Promise<void>; close: () => Promise<void> }> }).createWritable();
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
