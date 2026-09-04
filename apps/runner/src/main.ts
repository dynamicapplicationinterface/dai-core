/**
 * The DAI Runner: a hosted, installable player for containers.
 *
 * A `.dai.html` cannot install itself on a phone — `file://` forbids service
 * workers and manifest registration, so there is nothing for the OS to install.
 * The runner inverts that: the *player* is the installable PWA, and containers
 * are opened from the user's own files. The console, not the cartridge.
 */
import { ContainerError, readCartridge, resealCartridge, type Cartridge } from "./cartridge.js";
import { handOff } from "../../../src/handoff.js";
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

/**
 * The document to reopen when the app is next launched.
 *
 * An installed app that opens on an empty console has not remembered anything,
 * whatever it has stored: somebody who added tasks yesterday expects to see
 * them, not a file picker. This is the smallest thing that has to be
 * remembered — which document was open — and the library already holds the
 * rest.
 *
 * Cleared by ejecting, because ejecting is how somebody says they are done
 * with it.
 */
const RESUME_KEY = "dai:resume";

function rememberOpen(documentUuid: string): void {
  try {
    localStorage.setItem(RESUME_KEY, documentUuid);
  } catch {
    // A browser refusing storage costs the resume, not the session.
  }
}

function forgetOpen(): void {
  try {
    localStorage.removeItem(RESUME_KEY);
  } catch {
    /* As above. */
  }
}

function eject(): void {
  forgetOpen();
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

    rememberOpen(loaded.manifest.documentUuid);
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

/**
 * Opens a container named by the address that opened this page.
 *
 * `?open=<url>` is what makes a container shareable: a link, not an attachment.
 * Any address this page is allowed to read works — a file on Dropbox, in an S3
 * bucket, on a GitHub raw URL, on a company file share — so sharing a container
 * needs no infrastructure belonging to this project. A relay would be a
 * convenience for people with nowhere to put a file, not the mechanism, and the
 * difference is what keeps "the file needs no server" true.
 *
 * Nothing about verification changes. The bytes are checked exactly as a chosen
 * file is, before anything runs, because where they came from says nothing
 * about what they are.
 */
async function openFromUrl(address: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(address, location.href);
  } catch {
    say(`"${address}" is not an address this can open.`, true);
    return;
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    say(`This can only open http and https addresses, and that one is ${url.protocol}`, true);
    return;
  }

  slot.classList.add("busy");
  say(`Fetching ${url.hostname}…`);

  let response: Response;
  try {
    response = await fetch(url.href, { mode: "cors", credentials: "omit" });
  } catch {
    /*
     * Almost always CORS, and worth saying so.
     *
     * A cross-origin fetch that the other server does not allow fails
     * identically to one that could not connect at all — the browser reports
     * neither — and somebody whose link does not work will otherwise conclude
     * that this is broken rather than that their file host does not permit it.
     */
    slot.classList.remove("busy");
    say(
      `Could not read ${url.hostname}. Either it is unreachable, or it does not allow ` +
        `other sites to read its files. A link from Dropbox, S3, or a GitHub raw URL will work; ` +
        `many web servers will not without being configured to.`,
      true,
    );
    return;
  }

  if (!response.ok) {
    slot.classList.remove("busy");
    say(`${url.hostname} answered ${response.status} for that file.`, true);
    return;
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  const name = url.pathname.split("/").pop() || "container.dai";
  slot.classList.remove("busy");
  await ingest(new File([bytes], name, { type: "text/html" }));
}

/**
 * Takes a shared container out of the worker's hands.
 *
 * Removed as it is read: a file left here would be opened again by the next
 * launch, which is somebody's document reappearing without being asked for.
 */
async function collectSharedContainer(): Promise<File | null> {
  try {
    const cache = await caches.open("dai-shared-v1");
    const response = await cache.match("./shared-container");
    if (!response) return null;

    const name = decodeURIComponent(response.headers.get("x-dai-name") ?? "shared.dai");
    const bytes = await response.arrayBuffer();
    await cache.delete("./shared-container");
    return new File([bytes], name, {
      type: response.headers.get("content-type") ?? "application/octet-stream",
    });
  } catch {
    return null;
  }
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

    rememberOpen(loaded.manifest.documentUuid);
    mount(loaded);
  } catch (error) {
    const message =
      error instanceof ContainerError
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

  // The same decision the website makes, from the same place. A device that
  // will not take a file directly is why the download link below exists, and
  // two implementations of "can this device take a file" would eventually
  // disagree about the device somebody is holding.
  const handed = await handOff(navigator, file, name);
  // Dismissed rather than failed: offering a download after somebody declined
  // to save would be the app arguing with them.
  if (handed.shared || !handed.error) return;

  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([activeCartridge.html], { type: "text/html" }));
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
}

/**
 * The value the mounted container invented, echoed back on the acknowledgement
 * and required on everything after it.
 *
 * Without it this window acts on any message of the right shape from any
 * window that has a reference to it — including a save, which writes to storage
 * under a document's own identity. The nonce does not say the container is
 * trustworthy; it says the message came from the one this runner mounted.
 */
let mountedNonce: string | null = null;

/** Milliseconds from the container starting to the application being usable. */
let lastOpenMs: number | null = null;

function recordTimings(timings?: { phase: string; at: number }[]): void {
  if (!timings?.length) return;

  (window as unknown as { __daiTimings?: unknown }).__daiTimings = timings;

  const interactive = timings.find((entry) => entry.phase === "interactive");
  if (!interactive) return;

  lastOpenMs = interactive.at;
  if (new URLSearchParams(location.search).has("timing")) {
    say(
      `Interactive in ${Math.round(lastOpenMs)} ms — ` +
        timings.map((entry) => `${entry.phase} ${Math.round(entry.at)}`).join(", "),
    );
  }
}

/** Whether a message came from the container this runner is showing. */
function fromMountedContainer(event: MessageEvent, data: { sessionNonce?: string }): boolean {
  if (event.source !== cartridgeFrame.contentWindow) return false;
  return Boolean(mountedNonce) && data.sessionNonce === mountedNonce;
}

// Host-Runner Bridge Protocol: handle DAI_HOST_HANDSHAKE and DAI_HOST_SAVE
window.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || typeof data !== "object") return;

  if (data.type === "DAI_HOST_HANDSHAKE") {
    // The frame this runner mounted, and no other window.
    if (event.source !== cartridgeFrame.contentWindow) return;
    handshakeEstablished = true;
    mountedNonce = (data.payload?.sessionNonce as string) ?? null;

    /*
     * How long the container took to become usable, on this device.
     *
     * The number that decides whether this is a product on a phone is seconds
     * from tap to interactive, and it cannot be measured anywhere else: a
     * desktop is not a mid-range Android over cellular. The container reports
     * where it spent its time; this is the only place that can say how long
     * that took on the hardware somebody is actually holding.
     *
     * Kept on the window rather than shown, until there is a reason to show it.
     */
    recordTimings(data.payload?.timings as { phase: string; at: number }[] | undefined);

    (event.source as Window | null)?.postMessage(
      { type: "DAI_HOST_HANDSHAKE_ACK", payload: { sessionNonce: mountedNonce } },
      "*",
    );
  } else if (data.type === "DAI_HOST_TIMING") {
    // The boot finished. The handshake went out before the application had
    // painted, so this is the message carrying the number that matters.
    if (fromMountedContainer(event, data)) {
      recordTimings(data.payload?.timings as { phase: string; at: number }[] | undefined);
    }
  } else if (data.type === "DAI_HOST_SAVE") {
    // A save writes to this device's storage under a document's identity, so it
    // is answered only for the container that handshook.
    if (!fromMountedContainer(event, data)) return;
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

/*
 * Files the operating system hands us.
 *
 * The manifest registers this app as a handler for .dai, which is what puts it
 * in the "open with" list and makes a tap on an attachment reach us. Declaring
 * that without consuming the launch is worse than not declaring it: the app
 * opens, shows an empty library, and the person is left thinking the file
 * failed to open.
 */
const launch = (window as unknown as { launchQueue?: { setConsumer(fn: (p: LaunchParams) => void): void } })
  .launchQueue;

interface LaunchParams {
  files?: FileSystemFileHandle[];
}

launch?.setConsumer((params: LaunchParams) => {
  const handle = params.files?.[0];
  if (!handle) return;
  void handle.getFile().then((file) => ingest(file));
});

/**
 * Reopens what was open, or shows the library.
 *
 * The verification is the same one a chosen file gets — `launchFromLibrary`
 * reads and verifies the stored container before mounting it. Resuming must
 * not be a route that skips the gate, or the gate applies to the way people
 * open a container once and not to the way they open it every day after.
 *
 * A container that no longer verifies, or is no longer in the library, leaves
 * the library on screen with the reason, rather than an app that silently
 * stopped being the one they had.
 */
async function start(): Promise<void> {
  await refreshLibrary();

  const parameters = new URLSearchParams(location.search);

  /*
   * A container shared to this app from somewhere else on the device.
   *
   * Android delivers a shared file as a POST to the share target, which cannot
   * navigate the app, so the service worker parks the file and redirects here
   * to collect it. Both of those are explicit instructions and outrank
   * reopening whatever was last used.
   */
  if (parameters.has("shared")) {
    const collected = await collectSharedContainer();
    if (collected) {
      await ingest(collected);
      return;
    }
    say("Nothing arrived from the share. Try opening the file instead.", true);
    return;
  }

  // An address in the link is an explicit instruction too: somebody who
  // followed a link to a container meant that container.
  const asked = parameters.get("open");
  if (asked) {
    await openFromUrl(asked);
    return;
  }

  let resume: string | null = null;
  try {
    resume = localStorage.getItem(RESUME_KEY);
  } catch {
    /* Storage refused; the library is already on screen. */
  }
  if (!resume) return;

  const item = (await listCartridgesFromLibrary()).find(
    (candidate) => candidate.documentUuid === resume,
  );
  if (!item) {
    forgetOpen();
    return;
  }

  await launchFromLibrary(item);
}

void start();

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
