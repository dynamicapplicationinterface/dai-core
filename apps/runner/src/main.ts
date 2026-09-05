/**
 * The DAI Runner: a hosted, installable player for containers.
 *
 * A `.dai.html` cannot install itself on a phone — `file://` forbids service
 * workers and manifest registration, so there is nothing for the OS to install.
 * The runner inverts that: the *player* is the installable PWA, and containers
 * are opened from the user's own files. The console, not the cartridge.
 */
import { ContainerError, readCartridge, resealCartridge, type Cartridge } from "./cartridge.js";
import { hostShell } from "../../../src/container.js";
// The shell this host runs, shipped with this host: never the container's own.
import HOST_TEMPLATE from "../../../dist/template.html?raw";
import HOST_RUNTIME from "../../../dist/dai-runtime.js?raw";
import { handOff } from "../../../src/handoff.js";
import { receiveHandoff } from "../../../src/handoff-tab.js";
import { ISOLATION_CLAUSES } from "../../../src/host-profile.js";
import { describeSelf, watchForInstall } from "./install.js";
import { platform } from "./platform.js";
import { checkTrust, forgetTrust } from "../../../src/trust.js";
import {
  deleteCartridgeFromLibrary,
  deleteDatabaseFromOpfs,
  listCartridgesFromLibrary,
  loadDatabaseFromOpfs,
  saveCartridgeToLibrary,
  trustStore,
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
const title = document.getElementById("title") as HTMLElement;
const sheet = document.getElementById("sheet") as HTMLElement;
const sheetNote = document.getElementById("sheet-note") as HTMLElement;
const moreButton = document.getElementById("more") as HTMLButtonElement;
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
const installBar = document.getElementById("install") as HTMLElement;
const keeper = watchForInstall();

const RESUME_KEY = "dai:resume";

/** The isolation probe's last report, with what this host claimed. For CI. */
let lastIsolationReport: unknown = null;

/*
 * Who may hand this app a document directly.
 *
 * Not a safety property of the document — everything is verified and sandboxed
 * however it arrives. It is about consent: without a list, any page on the web
 * could open this one and put something in front of somebody who believes they
 * opened it themselves.
 */
/*
 * Who may hand this app a document directly.
 *
 * Not a safety property of the document — everything is verified and sandboxed
 * however it arrives. It is about consent: without a list, any page on the web
 * could open this one and put something in front of somebody who believes they
 * opened it themselves.
 *
 * Localhost is allowed so the flow can be developed and tested at all. A page
 * on somebody's own machine handing them a document is not a thing this can
 * protect them from, and pretending otherwise would only mean the handoff is
 * exercised for the first time in production.
 */
function mayHandOver(origin: string): boolean {
  if (origin === "https://www.dynamicapplicationinterface.io") return true;
  if (origin === "https://dynamicapplicationinterface.io") return true;
  try {
    const { hostname } = new URL(origin);
    return hostname === "localhost" || hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

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
  installBar.hidden = true;
  describeSelf();
  sheet.hidden = true;
  title.textContent = "";
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

    // Checked on the way back in as well. A document reopened from the library
    // has been sitting in storage this app does not exclusively control, and a
    // gate that only applied the first time would apply to the way people open
    // a container once and not to the way they open it every day.
    const verdict = await checkTrust(trustStore(), cartridge);
    if (verdict.status === "mismatch") {
      say(verdict.message, true);
      slot.classList.remove("busy");
      return;
    }

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
    await mount(loaded);
  } catch (error) {
    say(`Failed to load ${item.appName} (${(error as Error).message})`, true);
  } finally {
    slot.classList.remove("busy");
  }
}

async function deleteApp(documentUuid: string): Promise<void> {
  await deleteCartridgeFromLibrary(documentUuid);
  await deleteDatabaseFromOpfs(documentUuid);
  // And the pin: somebody who removes a document and is later handed a new one
  // under a new key has made a decision, and a pin that outlived the document
  // would refuse it for ever with no way to say otherwise.
  await forgetTrust(trustStore(), documentUuid);
  if (loaded?.manifest.documentUuid === documentUuid) {
    eject();
  } else {
    await refreshLibrary();
  }
}

/**
 * Mounts a verified container.
 */
async function mount(cartridge: Cartridge): Promise<void> {
  /*
   * The host's own shell around the verified archive — never the container's
   * document. The container's bootloader is the publisher's code, and it
   * would run here with this origin, this library and these pinned keys in
   * reach. See hostShell.
   */
  const shell = await hostShell(cartridge, { template: HOST_TEMPLATE, runtime: HOST_RUNTIME });
  const blob = new Blob([shell], { type: "text/html" });
  mountedUrl = URL.createObjectURL(blob);
  cartridgeFrame.src = mountedUrl;

  document.body.classList.add("loaded");

  /*
   * Now, and not before: an offer to keep something is meaningless until there
   * is something to keep, and on an empty chooser it reads as being asked to
   * bookmark a file picker.
   */
  const name = cartridge.manifest.appName ?? "container";
  keeper?.offer({
    uuid: cartridge.manifest.documentUuid,
    name,
    favicon: cartridge.manifest.favicon,
    savedAsFile: arrivedAsFile,
  });
  title.textContent = name;

  /*
   * Who signed it, in the sheet rather than the bar.
   *
   * "signed a3cab3dd" is a sentence for somebody who already knows what a key
   * fingerprint is. It is worth being able to find, and it is not worth a fifth
   * of a phone screen in front of somebody opening their first document.
   */
  sheetNote.textContent = cartridge.publicKeyFingerprint
    ? `${name} — signed by ${cartridge.publicKeyFingerprint.slice(0, 8)}`
    : `${name} — not signed`;
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

  /*
   * A click, first.
   *
   * A link used to fetch and mount with no step in between, so any page could
   * put a full-screen application — one asking for a password, say — in front
   * of somebody who had merely followed a link. The handoff from the website
   * checks where it came from; a URL checks nothing. So the address is shown,
   * with the host it will read from, and nothing is fetched until asked.
   */
  await new Promise<void>((proceed) => {
    say(`Open a document from ${url.hostname}?`);
    const button = document.createElement("button");
    button.id = "open-link";
    button.type = "button";
    button.textContent = `Open it from ${url.hostname}`;
    button.addEventListener("click", () => {
      button.remove();
      proceed();
    });
    report.appendChild(button);
  });

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

/**
 * Whether the open document exists as a file somewhere the person can find.
 *
 * Chosen from a picker or shared in: yes. Handed straight over from the page
 * that built it: no — and on iOS that is the difference between "add to Home
 * Screen" working and the new icon having nothing to open.
 */
let arrivedAsFile = true;

async function ingest(file: File): Promise<void> {
  slot.classList.add("busy");
  say(`Reading ${file.name}…`);

  startHostTiming();

  try {
    const cartridge = await readCartridge(file);
    hostMark("verified");

    /*
     * Whose document is this?
     *
     * Verification proves nothing has changed since this container was signed.
     * It cannot prove who signed it, because somebody who alters a container
     * can replace the key and re-sign — every check passes, against their key.
     *
     * This device remembers which key each document was first opened with, so a
     * later copy signed by somebody else is visible. It matters more now than
     * when the desktop got it: this app takes containers from a link, and an
     * address that serves an update is an address that can serve an
     * impersonation.
     */
    const verdict = await checkTrust(trustStore(), cartridge);
    if (verdict.status === "mismatch") {
      say(verdict.message, true);
      slot.classList.remove("busy");
      return;
    }

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
    hostMark("prepared");
    await mount(loaded);
    hostMark("mounted");
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

  // Once a copy exists as a file, the iOS home-screen steps get shorter.
  arrivedAsFile = true;

  /*
   * A phone shares; a computer saves.
   *
   * Windows Edge answers yes to "can you share a file", and the answer put a
   * Windows share sheet — Teams, Outlook, Nearby Sharing — in front of
   * somebody who had pressed Save a copy. On a computer a copy is a file on
   * the disk: the save dialog where the browser has one, a download where it
   * does not.
   */
  if (platform() === "desktop") {
    const picker = (window as { showSaveFilePicker?: (o: unknown) => Promise<FileSystemFileHandle> })
      .showSaveFilePicker;
    if (picker) {
      try {
        const handle = await picker({
          suggestedName: fileName,
          types: [{ description: "DAI document", accept: { "text/html": [".html"] } }],
        });
        const writable = await handle.createWritable();
        await writable.write(activeCartridge.html);
        await writable.close();
        return;
      } catch (error) {
        // Cancelled is a choice; anything else falls through to a download.
        if ((error as { name?: string }).name === "AbortError") return;
      }
    }
  } else {
    // The same decision the website makes, from the same place. A device that
    // will not take a file directly is why the download below exists, and two
    // implementations of "can this device take a file" would eventually
    // disagree about the device somebody is holding.
    const handed = await handOff(
      navigator,
      file,
      name,
      // What a recipient with nothing installed needs, in the only place it
      // can reach them: the message the file arrives in.
      `${name} — a DAI document. It holds the app and its data in one file. ` +
        `Open it at ${OPENER}`,
    );
    // Dismissed rather than failed: offering a download after somebody
    // declined to save would be the app arguing with them.
    if (handed.shared || !handed.error) return;
  }

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

/**
 * Where somebody holding one of these can find out what to do with it.
 *
 * "Open" rather than "run", in both the verb and the address: a person opens a
 * document, and a message telling a stranger to *run* a file they were sent is
 * the sentence everybody has been trained to delete.
 */
const OPENER = "opendai.app";

/** Milliseconds from the container starting to the application being usable. */
let lastOpenMs: number | null = null;

/**
 * What this app spends before the container starts.
 *
 * The container measures its own boot and can see nothing before it, so a chain
 * that stopped at its first mark would be optimising the visible half. Reading
 * the file, verifying every digest and assembling the document to mount all
 * happen here — and for the sectioned form the last of those is not free, since
 * the manifest and the payload have to be put back together before a shell can
 * carry them.
 */
let lastHostPhases: { phase: string; at: number }[] = [];
let hostStarted = 0;

function startHostTiming(): void {
  hostStarted = performance.now();
  lastHostPhases = [];
}

function hostMark(phase: string): void {
  lastHostPhases.push({
    phase,
    at: Math.round((performance.now() - hostStarted) * 10) / 10,
  });
}

function recordTimings(timings?: { phase: string; at: number }[]): void {
  if (!timings?.length) return;

  (window as unknown as { __daiTimings?: unknown }).__daiTimings = timings;

  const interactive = timings.find((entry) => entry.phase === "interactive");
  if (!interactive) return;

  lastOpenMs = interactive.at;

  // The whole chain, in the order a person experiences it: what this app did
  // with the file, then what the container did with itself.
  const host = lastHostPhases.length ? lastHostPhases[lastHostPhases.length - 1]!.at : 0;
  (window as unknown as { __daiHostTimings?: unknown }).__daiHostTimings = lastHostPhases;

  if (new URLSearchParams(location.search).has("timing")) {
    say(
      `Usable in ${Math.round(host + lastOpenMs)} ms — ` +
        `host ${Math.round(host)} ms (` +
        lastHostPhases.map((entry) => `${entry.phase} ${Math.round(entry.at)}`).join(", ") +
        `), container ${Math.round(lastOpenMs)} ms (` +
        timings.map((entry) => `${entry.phase} ${Math.round(entry.at)}`).join(", ") +
        ")",
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

  if (data.type === "dai:isolation-report") {
    // Kept for the harness that holds this host's claim against the probe.
    if (event.source === cartridgeFrame.contentWindow) lastIsolationReport = data;
    return;
  }

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
      {
        type: "DAI_HOST_HANDSHAKE_ACK",
        // A viewer: this host keeps a copy on the device and can export. It
        // cannot write the file it was given in place, and it says so.
        // What this host applies, by the probe's own ids. A claim, checked in
        // CI by mounting the probe here; see src/host-profile.ts.
        payload: { sessionNonce: mountedNonce, hostClass: "viewer", applied: ISOLATION_CLAUSES },
      },
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
    // Echoed on the reply so the container can tell this answer from any
    // other message that happens to be shaped like one.
    const requestId = typeof data.requestId === "string" ? data.requestId : undefined;
    const { databaseBytes, documentUuid } = data.payload || {};
    if (databaseBytes && documentUuid) {
      const bytes = new Uint8Array(databaseBytes);
      /*
       * One save at a time per document, across every tab of this origin.
       * Two tabs on one document each write the whole database; without the
       * lock the second write can land under the first's reseal and the
       * library keeps a copy that matches neither.
       */
      const key = `dai:${documentUuid}`;
      const locked = <T,>(work: () => Promise<T>): Promise<T> =>
        navigator.locks?.request
          ? navigator.locks.request(key, { mode: "exclusive" }, work)
          : work();
      locked(() => saveDatabaseToOpfs(documentUuid, bytes))
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
            { type: "DAI_HOST_SAVE_ACK", status: "ok", requestId },
            "*",
          );
        })
        .catch((error: unknown) => {
          (event.source as Window | null)?.postMessage(
            { type: "DAI_HOST_SAVE_ACK", status: "error", error: String(error), requestId },
            "*",
          );
        });
    }
  }
});

const closeSheet = (): void => {
  sheet.hidden = true;
};

openButton.addEventListener("click", () => fileInput.click());
moreButton.addEventListener("click", () => {
  sheet.hidden = false;
});
// Anywhere off the panel dismisses it, which is what a sheet does everywhere
// else on a phone.
sheet.addEventListener("click", (event) => {
  if (event.target === sheet) closeSheet();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeSheet();
});

ejectButton.addEventListener("click", () => {
  closeSheet();
  eject();
});
exportButton.addEventListener("click", () => {
  closeSheet();
  void exportContainer();
});
document.getElementById("keep")?.addEventListener("click", () => {
  // Stays in the sheet: the steps are written into it.
  keeper?.keep();
});
document.getElementById("open-another")?.addEventListener("click", () => {
  closeSheet();
  fileInput.click();
});

fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (file) {
    arrivedAsFile = true;
    void ingest(file);
  }
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

  /*
   * A document handed straight over by the page that built it.
   *
   * The alternative was telling somebody on a phone to save the file, leave
   * the browser, find it in a Files app and pick it out of a chooser — which
   * is the flow a tester gave up on, and fairly. The bytes come across by
   * message instead: no download, no upload, nothing on the network.
   *
   * The document is read and verified here exactly as a chosen file is. Where
   * bytes arrived from says nothing about what they are.
   */
  if (location.hash === "#handoff" && !window.opener) {
    /*
     * Opened for a handoff, and the page that opened us is not reachable.
     * A Cross-Origin-Opener-Policy on either side does this silently, and
     * for a while it did: the symptom was this page's empty chooser, with
     * nothing anywhere saying why.
     */
    say(
      "This page was opened to receive a document, but lost touch with the page " +
        "that opened it. Go back and use Save instead, then open the file here.",
      true,
    );
    return;
  }

  if (location.hash === "#handoff" && window.opener) {
    say("Waiting for the document…");
    receiveHandoff(
      window.opener as Window,
      ({ name, bytes }) => {
        arrivedAsFile = false;
        void ingest(new File([bytes as BlobPart], name, { type: "text/html" }));
      },
      { allows: mayHandOver, window },
    );
    return;
  }

  // An address in the link is an explicit instruction too: somebody who
  // followed a link to a container meant that container.
  const asked = parameters.get("open");
  if (asked) {
    await openFromUrl(asked);
    return;
  }

  /*
   * An icon for one document.
   *
   * A document kept as an app launches here with its id in the address. If
   * this opener has it, that is the document to open — not whatever was open
   * last. If it does not, this is an iOS home-screen app, which gets storage
   * of its own and has never seen the file; the address carries the name so
   * this can ask for exactly that file rather than showing an empty chooser.
   */
  const wanted = parameters.get("doc");
  if (wanted) {
    const item = (await listCartridgesFromLibrary()).find(
      (candidate) => candidate.documentUuid === wanted,
    );
    if (item) {
      await launchFromLibrary(item);
      return;
    }
    const name = parameters.get("name") ?? "your document";
    say(
      `This icon is for ${name}. Open ${name} from your files once — tap Open a file ` +
        `and choose it — and it will be here every time after that.`,
    );
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
    get isolationReport() {
      return lastIsolationReport;
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

  /*
   * A new worker taking over mid-page means this page is the build before
   * it. Reloading once picks up the current one — but only while nothing is
   * open, because a reload under somebody's document is worse than a stale
   * shell. A page waiting on a handoff is safe to reload: the sender waits
   * for a ready that the fresh page will send.
   */
  // Only an update, never a first install. On a first visit the new worker
  // claims the page too, and reloading then threw away a document that had
  // just been handed over — the sender had delivered and stopped listening
  // before the reloaded page asked again.
  const updating = Boolean(navigator.serviceWorker.controller);
  let reloaded = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!updating || reloaded || document.body.classList.contains("loaded")) return;
    reloaded = true;
    location.reload();
  });
}
