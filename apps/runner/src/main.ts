/**
 * The DAI Runner: a hosted, installable player for containers.
 *
 * A `.dai.html` cannot install itself on a phone — `file://` forbids service
 * workers and manifest registration, so there is nothing for the OS to install.
 * The runner inverts that: the *player* is the installable PWA, and containers
 * are opened from the user's own files. The console, not the cartridge.
 */
import { CartridgeError, readCartridge, resealCartridge, type Cartridge } from "./cartridge.js";
import {
  deleteCartridgeFromLibrary,
  deleteDatabaseFromOpfs,
  listCartridgesFromLibrary,
  loadDatabaseFromOpfs,
  saveCartridgeToLibrary,
  saveDatabaseToOpfs,
  type LibraryItem,
} from "./opfs.js";

const openButton = document.getElementById("open") as HTMLButtonElement;
const ejectButton = document.getElementById("eject") as HTMLButtonElement;
const exportButton = document.getElementById("export") as HTMLButtonElement;
const fileInput = document.getElementById("file") as HTMLInputElement;
const cartridgeFrame = document.getElementById("cartridge") as HTMLIFrameElement;
const report = document.getElementById("report") as HTMLElement;
const slot = document.getElementById("slot") as HTMLElement;
const badge = document.getElementById("badge") as HTMLElement;
const libraryEl = document.getElementById("library") as HTMLElement;

let mountedUrl: string | undefined;
let loaded: Cartridge | undefined;
let handshakeEstablished = false;

// Storage Eviction Defense: call navigator.storage.persist() on boot
if ("storage" in navigator && typeof navigator.storage?.persist === "function") {
  void navigator.storage.persist().catch(() => {
    // Permission denied or non-fatal failure
  });
}

function say(message: string, isError = false): void {
  report.textContent = message;
  report.classList.toggle("error", isError);
}

function eject(): void {
  if (mountedUrl) {
    URL.revokeObjectURL(mountedUrl);
    mountedUrl = undefined;
  }
  // about:blank rather than removing the frame: the element keeps its sandbox
  // attributes, so the next cartridge cannot inherit a laxer configuration.
  cartridgeFrame.src = "about:blank";
  loaded = undefined;
  handshakeEstablished = false;
  document.body.classList.remove("loaded");
  ejectButton.hidden = true;
  exportButton.hidden = true;
  badge.hidden = true;
  say("");
  fileInput.value = "";
  void refreshLibrary();
}

async function refreshLibrary(): Promise<void> {
  if (!libraryEl) return;
  const items = await listCartridgesFromLibrary();
  if (items.length === 0) {
    libraryEl.innerHTML = "";
    return;
  }

  libraryEl.innerHTML = "";
  const header = document.createElement("div");
  header.style.fontSize = "13px";
  header.style.fontWeight = "600";
  header.style.color = "#9ca3af";
  header.style.textAlign = "left";
  header.style.marginBottom = "4px";
  header.textContent = "Recent Cartridges";
  libraryEl.appendChild(header);

  for (const item of items) {
    const card = document.createElement("div");
    card.className = "tray-item";

    const info = document.createElement("div");
    info.className = "tray-info";

    const title = document.createElement("div");
    title.className = "tray-title";
    title.textContent = item.appName;

    const sub = document.createElement("div");
    sub.className = "tray-sub";
    const sigText = item.publicKeyFingerprint
      ? `signed ${item.publicKeyFingerprint.slice(0, 8)}`
      : "unsigned";
    sub.textContent = `${sigText} · ${item.documentUuid.slice(0, 8)}…`;

    info.appendChild(title);
    info.appendChild(sub);

    const actions = document.createElement("div");
    actions.className = "tray-actions";

    const runBtn = document.createElement("button");
    runBtn.type = "button";
    runBtn.textContent = "Run";
    runBtn.addEventListener("click", () => void launchFromLibrary(item));

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "btn-del";
    delBtn.textContent = "Delete";
    delBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      void deleteApp(item.documentUuid);
    });

    actions.appendChild(runBtn);
    actions.appendChild(delBtn);

    card.appendChild(info);
    card.appendChild(actions);

    libraryEl.appendChild(card);
  }
}

async function launchFromLibrary(item: LibraryItem): Promise<void> {
  slot.classList.add("busy");
  say(`Loading ${item.appName}…`);

  try {
    const file = new File([item.html], `${item.appName}.dai.html`, { type: "text/html" });
    const cartridge = await readCartridge(file);

    const opfsDb = await loadDatabaseFromOpfs(cartridge.manifest.documentUuid);
    if (opfsDb && opfsDb.byteLength > 0) {
      loaded = await resealCartridge(cartridge, opfsDb);
    } else {
      loaded = cartridge;
    }

    // Update last opened time in library
    await saveCartridgeToLibrary({
      documentUuid: loaded.manifest.documentUuid,
      appName: loaded.manifest.appName ?? "container",
      lastOpened: new Date().toISOString(),
      html: loaded.html,
      publicKeyFingerprint: loaded.publicKeyFingerprint,
    });

    mount(loaded);
  } catch (error) {
    say(`Failed to load ${item.appName} (${(error as Error).message})`, true);
  } finally {
    slot.classList.remove("busy");
  }
}

async function deleteApp(documentUuid: string): Promise<void> {
  await deleteCartridgeFromLibrary(documentUuid);
  await deleteDatabaseFromOpfs(documentUuid);
  if (loaded?.manifest.documentUuid === documentUuid) {
    eject();
  } else {
    await refreshLibrary();
  }
}

/**
 * Mounts a verified container.
 */
function mount(cartridge: Cartridge): void {
  const blob = new Blob([cartridge.html], { type: "text/html" });
  mountedUrl = URL.createObjectURL(blob);
  cartridgeFrame.src = mountedUrl;

  document.body.classList.add("loaded");
  ejectButton.hidden = false;
  exportButton.hidden = false;

  const name = cartridge.manifest.appName ?? "container";
  badge.hidden = false;
  badge.textContent = cartridge.publicKeyFingerprint
    ? `${name} · signed ${cartridge.publicKeyFingerprint.slice(0, 8)}`
    : `${name} · unsigned`;
  badge.title = `document ${cartridge.manifest.documentUuid}`;
}

async function ingest(file: File): Promise<void> {
  slot.classList.add("busy");
  say(`Reading ${file.name}…`);

  try {
    const cartridge = await readCartridge(file);

    // If an OPFS database exists for this documentUuid, mount the latest database.
    const opfsDb = await loadDatabaseFromOpfs(cartridge.manifest.documentUuid);
    if (opfsDb && opfsDb.byteLength > 0) {
      loaded = await resealCartridge(cartridge, opfsDb);
    } else {
      loaded = cartridge;
    }

    // Save/update cartridge in IndexedDB Library
    await saveCartridgeToLibrary({
      documentUuid: loaded.manifest.documentUuid,
      appName: loaded.manifest.appName ?? "container",
      lastOpened: new Date().toISOString(),
      html: loaded.html,
      publicKeyFingerprint: loaded.publicKeyFingerprint,
    });

    mount(loaded);
  } catch (error) {
    const message =
      error instanceof CartridgeError
        ? error.message
        : `This file could not be opened (${(error as Error).message}).`;
    say(message, true);
  } finally {
    slot.classList.remove("busy");
    void refreshLibrary();
  }
}

async function exportContainer(): Promise<void> {
  if (!loaded) return;

  const opfsDb = await loadDatabaseFromOpfs(loaded.manifest.documentUuid);
  const activeCartridge = opfsDb ? await resealCartridge(loaded, opfsDb) : loaded;
  loaded = activeCartridge;

  const name = activeCartridge.manifest.appName ?? "container";
  const fileName = `${name}.dai.html`;
  const file = new File([activeCartridge.html], fileName, { type: "text/html" });

  if (navigator.share && (!navigator.canShare || navigator.canShare({ files: [file] }))) {
    try {
      await navigator.share({ files: [file], title: name });
      return;
    } catch (error) {
      if ((error as Error).name === "AbortError") return;
    }
  }

  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([activeCartridge.html], { type: "text/html" }));
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
}

// Host-Runner Bridge Protocol: handle DAI_HOST_HANDSHAKE and DAI_HOST_SAVE
window.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || typeof data !== "object") return;

  if (data.type === "DAI_HOST_HANDSHAKE") {
    handshakeEstablished = true;
    (event.source as Window | null)?.postMessage({ type: "DAI_HOST_HANDSHAKE_ACK" }, "*");
  } else if (data.type === "DAI_HOST_SAVE") {
    const { databaseBytes, documentUuid } = data.payload || {};
    if (databaseBytes && documentUuid) {
      const bytes = new Uint8Array(databaseBytes);
      saveDatabaseToOpfs(documentUuid, bytes)
        .then(async () => {
          if (loaded && loaded.manifest.documentUuid === documentUuid) {
            loaded = await resealCartridge(loaded, bytes);
            await saveCartridgeToLibrary({
              documentUuid: loaded.manifest.documentUuid,
              appName: loaded.manifest.appName ?? "container",
              lastOpened: new Date().toISOString(),
              html: loaded.html,
              publicKeyFingerprint: loaded.publicKeyFingerprint,
            });
          }
          (event.source as Window | null)?.postMessage(
            { type: "DAI_HOST_SAVE_ACK", status: "ok" },
            "*",
          );
        })
        .catch((error: unknown) => {
          (event.source as Window | null)?.postMessage(
            { type: "DAI_HOST_SAVE_ACK", status: "error", error: String(error) },
            "*",
          );
        });
    }
  }
});

openButton.addEventListener("click", () => fileInput.click());
ejectButton.addEventListener("click", eject);
exportButton.addEventListener("click", () => void exportContainer());

fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (file) void ingest(file);
});

// Render library on page boot
void refreshLibrary();

// Exposed for tests and for the storage layer.
Object.defineProperty(window, "__runner", {
  value: {
    get loaded() {
      return loaded;
    },
    get handshakeEstablished() {
      return handshakeEstablished;
    },
    eject,
    exportContainer,
    deleteApp,
    refreshLibrary,
    listLibrary: listCartridgesFromLibrary,
  },
});

/**
 * Registers the service worker that makes the runner itself work offline.
 */
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("./sw.js", { scope: "./" }).catch((error: unknown) => {
      console.warn("DAI Runner: offline support unavailable.", error);
    });
  });
}
