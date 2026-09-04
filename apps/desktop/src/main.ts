/**
 * DAI Native Desktop Shell Frontend Controller.
 *
 * Bridges container postMessage calls to Tauri v2 native IPC commands (read_cartridge, save_cartridge)
 * for silent, in-place disk persistence without browser download prompts.
 */

import { ContainerError, looksSectioned, verifyContainer } from "../../../src/container.js";
import { readContainerFile } from "../../../src/format.js";
import { payloadFingerprint } from "../../../src/core.js";
import {
  compileInBrowser,
  isNoise,
  loadRuntimeAssets,
  stripCommonPrefix,
  unpackZip,
  type RuntimeAssets,
} from "../../../src/browser.js";
import { lintFiles } from "../../../src/lint.js";
import { checkTrust, type TrustVerdict } from "./trust.js";


const cartridgeFrame = document.getElementById("cartridge") as HTMLIFrameElement;
const openBtn = document.getElementById("open-btn") as HTMLButtonElement;
const chooseBtn = document.getElementById("choose-btn") as HTMLButtonElement;
const ejectBtn = document.getElementById("eject-btn") as HTMLButtonElement;
const fileInput = document.getElementById("file-input") as HTMLInputElement;
const badge = document.getElementById("badge") as HTMLElement;
const statusEl = document.getElementById("status") as HTMLElement;
const alertEl = document.getElementById("alert") as HTMLElement;
const trustEl = document.getElementById("trust") as HTMLElement;

/**
 * Reports a refusal where it can actually be seen.
 *
 * statusEl lives inside #slot, which is hidden once a cartridge mounts, so
 * anything written there is invisible from the second open onward. A refused
 * cartridge would then look like nothing happening at all — the failure mode
 * this exists to prevent. Console too, so DevTools shows a trace rather than
 * silence.
 */
function fail(message: string): void {
  console.error("DAI:", message);
  alertEl.textContent = message;

  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.className = "alert-dismiss";
  dismiss.textContent = "Dismiss";
  dismiss.addEventListener("click", () => clearAlert());
  alertEl.prepend(dismiss);

  alertEl.hidden = false;
  // Also in the slot, for the cold-start case where the slot is what is on screen.
  statusEl.textContent = message;
}

/**
 * Shows who signed the running cartridge, and whether that is who signed it
 * last time.
 *
 * A first use is styled differently from a match on purpose: pinning is the
 * moment the host decides what it will trust from then on, and it is the one
 * open where nothing has been checked against memory yet.
 */
function showTrust(text: string, firstUse: boolean): void {
  console.info(`DAI: ${text}`);
  trustEl.textContent = text;
  trustEl.dataset.state = firstUse ? "first-use" : "matched";
  trustEl.hidden = false;
}

function clearTrust(): void {
  trustEl.hidden = true;
  trustEl.textContent = "";
}

/**
 * Stops a cartridge that has already been mounted.
 *
 * Unmounts first and reports second: leaving it running while showing a warning
 * would let the very execution being objected to continue while the user reads
 * about it.
 */
function abortMount(message: string): void {
  eject();
  fail(`Execution stopped — ${message}`);
}

function clearAlert(): void {
  alertEl.hidden = true;
  alertEl.textContent = "";
}

let currentFilePath: string | undefined;
/**
 * Whether the open file is the sectioned binary rather than the viewer form.
 *
 * It decides how a save is written, and it is set from the file's leading bytes
 * when it was opened — never from its name, because a name is a claim made by
 * whoever renamed it.
 */
let currentFileIsSectioned = false;

/**
 * Which save of this document was read, for the next one to check against.
 *
 * Two windows on one document have no lock. The footer counts saves, so a
 * window that read save 7 and is asked to write on top of 8 can be told that
 * somebody else got there first — and the work it is holding is still in
 * memory, which is a great deal better than the last writer quietly winning.
 */
let currentGeneration: number | undefined;
let mountedUrl: string | undefined;

interface TauriWindow {
  __TAURI_INTERNALS__?: unknown;
}

function isTauri(): boolean {
  return typeof (window as TauriWindow).__TAURI_INTERNALS__ !== "undefined";
}

async function invokeTauri<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const win = window as any;
  if (win.__TAURI_INTERNALS__ && typeof win.__TAURI_INTERNALS__.invoke === "function") {
    return win.__TAURI_INTERNALS__.invoke(cmd, args) as Promise<T>;
  }
  if (win.__TAURI__ && typeof win.__TAURI__.core?.invoke === "function") {
    return win.__TAURI__.core.invoke(cmd, args) as Promise<T>;
  }
  try {
    const api = await import(/* @vite-ignore */ "@tauri-apps/api/core");
    return api.invoke<T>(cmd, args);
  } catch {
    throw new Error("Not running inside Tauri desktop environment");
  }
}

/**
 * Fires if a mounted container never signals the host.
 *
 * A container reports failures into its own DOM — but if its bootloader is
 * blocked outright (a CSP nonce disabling 'unsafe-inline', a missing
 * WebCrypto), there is no code left to report anything, and the boot screen
 * simply sits there. The host has to notice on the container's behalf.
 */
let bootWatchdog: number | undefined;

/**
 * What the host concluded about the cartridge it mounted.
 *
 * The container verifies the same file again with a separate implementation and
 * reports what it found. Comparing the two catches drift between what was
 * checked and what is executing — a stale mount, a bug in either verifier, a
 * refactor that mounts bytes nobody looked at.
 *
 * It is a check between two verifiers, not a defence against a compromised
 * host: code that could tamper with the payload here could equally choose what
 * to compare against.
 */
let expectedFingerprint: string | undefined;

/**
 * Whether the running cartridge confirmed what the host verified.
 *
 * False for a cartridge whose runtime predates the cross-check. Worth surfacing
 * rather than hiding: the container is no less verified, but one of the two
 * independent opinions is missing, and an audit trail should record which.
 */
let crossChecked = true;

/** The newest host-bridge schema this host understands. */
const HOST_BRIDGE_VERSION = 1;

/**
 * The value the mounted container invented, echoed on the acknowledgement and
 * required on everything after it.
 *
 * Without it this window acts on any message of the right shape from any window
 * holding a reference to it, and one of those messages overwrites a file on
 * disk. It does not establish that the container is honest — it establishes
 * that the message came from the one this host mounted.
 */
let mountedNonce: string | null = null;

function armBootWatchdog(): void {
  clearBootWatchdog();
  bootWatchdog = window.setTimeout(() => {
    const doc = cartridgeFrame.contentDocument;
    const bootloaderRan = Boolean(
      (cartridgeFrame.contentWindow as unknown as { __DAI__?: unknown })?.__DAI__,
    );
    const shownStatus = doc?.getElementById("dai-boot-status")?.textContent?.trim();

    if (bootloaderRan) return; // It started; whatever happens next it can report.

    statusEl.textContent = shownStatus
      ? `The cartridge stopped at "${shownStatus}" and its bootloader never ran. ` +
        `This usually means inline scripts were blocked — check the CSP for a ` +
        `script-src nonce, which makes 'unsafe-inline' be ignored. Open DevTools for the exact refusal.`
      : "The cartridge did not start and produced no boot screen. Open DevTools for details.";
  }, 8000);
}

function clearBootWatchdog(): void {
  if (bootWatchdog !== undefined) {
    window.clearTimeout(bootWatchdog);
    bootWatchdog = undefined;
  }
}

function mountHtml(html: string, filePath?: string, fingerprint?: string): void {
  clearAlert();
  expectedFingerprint = fingerprint;
  crossChecked = true;
  if (mountedUrl) {
    URL.revokeObjectURL(mountedUrl);
  }
  currentFilePath = filePath;
  const blob = new Blob([html], { type: "text/html" });
  mountedUrl = URL.createObjectURL(blob);
  cartridgeFrame.src = mountedUrl;

  armBootWatchdog();

  document.body.classList.add("loaded");
  ejectBtn.hidden = false;
  badge.hidden = false;
  badge.textContent = filePath ? `Desktop · ${filePath.split(/[/\\]/).pop()}` : "Desktop · Unsaved";
}

function eject(): void {
  if (mountedUrl) {
    URL.revokeObjectURL(mountedUrl);
    mountedUrl = undefined;
  }
  clearBootWatchdog();
  clearTrust();
  cartridgeFrame.src = "about:blank";
  currentFilePath = undefined;
  document.body.classList.remove("loaded");
  ejectBtn.hidden = true;
  badge.hidden = true;
  statusEl.textContent = "";
}

async function openFile(file: File): Promise<void> {
  statusEl.textContent = `Loading ${file.name}...`;
  try {
    // Bytes, then the leading magic: a dropped `.dai` is binary, and reading it
    // as text replaces most of a database with U+FFFD before anything gets to
    // check it.
    const bytes = new Uint8Array(await file.arrayBuffer());
    const sectioned = looksSectioned(bytes);
    const text: string | Uint8Array = sectioned ? bytes : new TextDecoder().decode(bytes);
    // A dropped file carries no path, so nothing here can be saved in place
    // whichever form it is.
    currentFileIsSectioned = sectioned;

    // Full verification, not a shape check: digests both ways, the shell
    // against its sealed copy, and the publisher signature when one is carried.
    const container = await verifyContainer(text);
    const trust = await gateOnTrust(container);

    // A browser File has no filesystem path, so a cartridge chosen here cannot
    // be saved back in place — there is nothing to overwrite. Passing the bare
    // name on would make the host write into its working directory instead.
    const nativePath = (file as File & { path?: string }).path;
    mountHtml(
      container.html,
      nativePath,
      await payloadFingerprint(container.manifest.documentUuid, container.manifest.hashes),
    );
    statusEl.textContent = nativePath
      ? `Loaded ${file.name} — ${trust}`
      : `Loaded ${file.name} — ${trust}. Read-only: open it by double-clicking to save in place.`;
  } catch (err) {
    // A refusal names what is wrong with the file; anything else is a fault
    // in the host and should say so rather than blaming the cartridge.
    fail(
      err instanceof ContainerError
        ? err.message
        : `Failed to open file: ${(err as Error).message}`,
    );
  }
}

// Check if launched via double-click CLI argument in Tauri
/**
 * Opens the cartridge the app was launched with, if any.
 *
 * This is the path a file association uses, which makes it the way most
 * cartridges will actually be opened — so it runs the same gate as every other
 * entry point rather than a shortened version of it. Mounting here without
 * verifying would mean the checks apply to the route users rarely take and not
 * the one they do.
 */

/**
 * Reads a cartridge from disk as whichever form it turns out to be.
 *
 * Both forms come back as bytes and the leading magic decides. Reading a
 * sectioned container as text would not fail loudly — it would replace every
 * byte that is not valid UTF-8, which is most of a database, and hand the
 * verifier a file that was damaged on the way in.
 */
async function readCartridgeSource(path: string): Promise<string | Uint8Array> {
  const base64 = await invokeTauri<string>("read_cartridge_bytes", { path });
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  currentFileIsSectioned = looksSectioned(bytes);
  currentGeneration = currentFileIsSectioned ? readContainerFile(bytes).generation : undefined;
  return currentFileIsSectioned ? bytes : new TextDecoder().decode(bytes);
}

/** base64 for the bridge, which carries strings and not byte arrays. */
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  // Chunked because a single spread of a large database overflows the argument
  // limit, and a save that throws on a big document is a save that fails for
  // exactly the users who have the most to lose.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/**
 * Opens a cartridge from a filesystem path.
 *
 * The single place the host mounts anything it was handed a path to: startup
 * arguments, and a second launch forwarded by the single-instance plugin. Both
 * run verification and the trust check, because a route that skipped them would
 * be the route an attacker picks.
 */
async function openCartridgeByPath(path: string): Promise<void> {
  try {
    statusEl.textContent = `Loading ${path}...`;
    const source = await readCartridgeSource(path);

    const container = await verifyContainer(source);
    const trust = await gateOnTrust(container);

    mountHtml(
      container.html,
      path,
      await payloadFingerprint(container.manifest.documentUuid, container.manifest.hashes),
    );
    statusEl.textContent = `Loaded ${path} — ${trust}`;
  } catch (error) {
    // A cartridge that fails on launch leaves an empty window, so the reason
    // has to be on screen: there is nothing else for the user to look at.
    fail(
      error instanceof ContainerError
        ? error.message
        : `Could not open ${path}: ${String(error)}`,
    );
  }
}

/**
 * Opens the cartridge this process was launched with, if any.
 *
 * This is the path a file association uses, which makes it the way most
 * cartridges will actually be opened.
 */
async function checkOpenedFile(): Promise<void> {
  if (!isTauri()) return;

  let openedPath: string | null = null;
  try {
    openedPath = await invokeTauri<string | null>("get_opened_file");
  } catch (error) {
    // No argument is the normal case and not worth reporting; a failure to ask
    // is not, so it is logged rather than swallowed.
    console.warn("DAI: could not read the launch argument.", error);
    return;
  }

  if (openedPath) await openCartridgeByPath(openedPath);
}

/**
 * Accepts a cartridge from a second launch.
 *
 * Double-clicking another cartridge starts a process that hands its arguments
 * to this one and exits, so the path arrives as an event rather than as argv.
 * Two hosts would otherwise share one trust registry, which is read, modified
 * and written with no lock — and a lost pin fails open.
 */
async function listenForForwardedCartridges(): Promise<void> {
  if (!isTauri()) return;

  try {
    const { listen } = await import("@tauri-apps/api/event");
    await listen<string>("dai://open-cartridge", (event) => {
      // Replaces whatever is mounted. A host that ignored the request would
      // leave the user looking at the wrong document with no explanation.
      void openCartridgeByPath(event.payload);
    });
  } catch (error) {
    console.warn("DAI: could not listen for forwarded cartridges.", error);
  }
}


// Listen for container Host-Bridge postMessages (DAI_HOST_HANDSHAKE, DAI_HOST_SAVE)
window.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || typeof data !== "object") return;

  if (data.type === "DAI_HOST_REFUSED") {
    // The cartridge stopped and said why. Without this the host sees only
    // silence and its watchdog guesses — and a refusal is the entry an audit
    // trail most wants, so guessing is the worst outcome available.
    clearBootWatchdog();
    const refusal = (data.payload ?? {}) as {
      reason?: string;
      message?: string;
      detail?: string;
      documentUuid?: string | null;
    };

    console.error("DAI: cartridge refused to run", refusal);
    abortMount(
      `the cartridge refused to run (${refusal.reason ?? "UNKNOWN"}).` +
        `
${refusal.message ?? ""}` +
        (refusal.detail ? `
${refusal.detail}` : ""),
    );
    return;
  }

  if (data.type === "DAI_HOST_CLOSING") {
    // Best-effort by nature: a process killed outright sends nothing, so a
    // missing close is normal rather than an error.
    console.info("DAI: cartridge closing", data.payload);
    return;
  }

  if (data.type === "DAI_HOST_HANDSHAKE") {
    // The frame this host mounted, and no other window. Everything below acts
    // on what the message says — including writing over a file on disk.
    if (event.source !== cartridgeFrame.contentWindow) return;

    // The container is alive; it can report its own problems from here.
    clearBootWatchdog();
    mountedNonce = ((data.payload ?? {}) as { sessionNonce?: string }).sessionNonce ?? null;

    const reported = (data.payload ?? {}) as {
      bridgeVersion?: number;
      verified?: boolean;
      payloadFingerprint?: string | null;
    };

    // A cartridge carries the runtime it was compiled with, so a host meets
    // several vintages. An unknown one is reported rather than guessed at.
    if (reported.bridgeVersion !== undefined && reported.bridgeVersion > HOST_BRIDGE_VERSION) {
      abortMount(
        `this cartridge speaks host-bridge version ${reported.bridgeVersion}, ` +
          `and this host understands ${HOST_BRIDGE_VERSION}. Update the host.`,
      );
      return;
    }

    // Abort before acknowledging. An acknowledged container is one the host has
    // accepted, and a disagreement is exactly the case where it should not.
    // Silence and disagreement are different findings, and conflating them
    // breaks every cartridge built before the cross-check existed. A container
    // carries the runtime it was compiled with, so older bridges are permanent
    // residents rather than a transitional problem: one that reports nothing is
    // not claiming anything false, it simply cannot answer.
    //
    // The host has already verified this file itself, and that verdict is what
    // gates mounting. The cross-check only adds a second opinion, so its absence
    // costs the second opinion and nothing more.
    if (reported.payloadFingerprint === undefined || reported.payloadFingerprint === null) {
      crossChecked = false;
      // Said out loud. The container is no less verified, but one of the two
      // independent opinions is missing, and a chip identical to a fully
      // cross-checked mount would overstate what was confirmed.
      if (trustEl && !trustEl.hidden) {
        trustEl.textContent = `${trustEl.textContent} · cross-check unavailable`;
      }
      console.info(
        "DAI: this cartridge predates the payload cross-check, so only the host’s " +
          "own verification applies.",
      );
    } else if (expectedFingerprint && reported.payloadFingerprint !== expectedFingerprint) {
      abortMount(
        "The running cartridge does not match the file that was verified." +
          `\nVerified: ${expectedFingerprint.slice(0, 16)}` +
          `\nRunning:  ${reported.payloadFingerprint.slice(0, 16)}`,
      );
      return;
    }

    if (expectedFingerprint && reported.verified === false) {
      abortMount(
        "The cartridge reported that it did not verify itself, although the host " +
          "accepted it. The two disagree, so it has been stopped.",
      );
      return;
    }

    (event.source as Window | null)?.postMessage(
      {
        type: "DAI_HOST_HANDSHAKE_ACK",
        payload: { bridgeVersion: HOST_BRIDGE_VERSION, sessionNonce: mountedNonce },
      },
      "*",
    );
  } else if (data.type === "DAI_HOST_SAVE") {
    // This writes over a file on disk. It is answered only for the container
    // this host mounted, carrying the value that container invented.
    if (event.source !== cartridgeFrame.contentWindow) return;
    if (!mountedNonce || (data as { sessionNonce?: string }).sessionNonce !== mountedNonce) return;

    const reply = (status: "ok" | "error", error?: string): void => {
      (event.source as Window | null)?.postMessage(
        { type: "DAI_HOST_SAVE_ACK", status, error },
        "*",
      );
      statusEl.textContent =
        status === "ok" ? `Saved ${currentFilePath ?? "cartridge"}` : `Save failed: ${error}`;
    };

    // The container sends a finished document. Resealing it here would be a
    // second implementation of the runtime's own logic.
    const { html, databaseBytes } = (data.payload || {}) as {
      html?: string;
      databaseBytes?: Uint8Array;
    };

    if (!html) {
      // A container carries the runtime it was compiled with, by design, so an
      // older cartridge still speaks the older protocol and sends only database
      // bytes. The host cannot reseal those itself without reimplementing the
      // runtime's zipping, digesting and manifest rewriting.
      reply(
        "error",
        "This cartridge was built before in-place saving and cannot be saved here. " +
          "Rebuild it with the current compiler.",
      );
      return;
    }
    if (!isTauri()) {
      reply("error", "Native saving is only available in the desktop host.");
      return;
    }
    if (!currentFilePath) {
      reply("error", "This cartridge has no file on disk to overwrite.");
      return;
    }

    // Never acknowledge a save that did not happen. Reporting "ok" when
    // nothing was written is worse than reporting nothing: the application
    // believes the user's work is on disk and stops offering to save it.
    //
    // A sectioned container is saved by writing its database and nothing else.
    // The document the container sealed is discarded here, because rewriting
    // the whole file would replace a manifest the publisher signed with one
    // this host assembled — and nothing here holds a key to sign it with.
    const written =
      currentFileIsSectioned && databaseBytes
        ? invokeTauri<number>("save_cartridge_data", {
            path: currentFilePath,
            dataBase64: toBase64(new Uint8Array(databaseBytes)),
            expectedGeneration: currentGeneration ?? null,
          }).then((generation) => {
            // Kept, so a second save from this window is checked against what
            // this window actually wrote rather than what it first read.
            currentGeneration = generation;
          })
        : invokeTauri("save_cartridge", { path: currentFilePath, html });

    written.then(() => reply("ok")).catch((error: unknown) => reply("error", String(error)));
  }
});

/**
 * Opens a cartridge through the native chooser.
 *
 * The webview's own file input cannot be used here: a browser `File` exposes no
 * filesystem path, so a cartridge opened that way can be read but never written
 * back, and in-place saving is the whole point of the desktop host. The native
 * dialog returns a canonical absolute path, which is what save_cartridge needs.
 */
/**
 * Applies the trust registry after core verification.
 *
 * Returns a line to show the user, or throws to refuse the mount. Refusing is
 * the point: a mismatch means the file is validly signed by somebody other than
 * whoever signed it last time, which is exactly what a warning-only path would
 * let a user click through.
 */
async function gateOnTrust(container: Awaited<ReturnType<typeof verifyContainer>>): Promise<string> {
  // Only meaningful in the host; the registry lives in Rust.
  if (!isTauri()) {
    const text = container.signature === "valid" ? "signature verified" : "unsigned";
    showTrust(text, false);
    return text;
  }

  let verdict: TrustVerdict;
  try {
    verdict = await checkTrust(invokeTauri, container);
  } catch (error) {
    // A registry that cannot be consulted must not silently downgrade to
    // trusting everything, so this refuses rather than continuing. The common
    // cause is not a security condition at all: the frontend hot-reloads on
    // save while the Rust binary does not, so a newly added command is missing
    // until tauri dev is restarted. Say that, rather than leaving someone
    // hunting a phantom attack.
    const detail = String(error);
    const looksMissing = /not found|not allowed|unknown command|not registered/i.test(detail);
    throw new ContainerError(
      looksMissing
        ? "The publisher registry is unavailable, so this cartridge was not opened. " +
          "The host binary appears to predate the registry commands — restart " +
          "tauri dev so the Rust side rebuilds.\n" + detail
        : "The publisher registry could not be consulted, so this cartridge was " +
          "not opened.\n" + detail,
    );
  }

  if (verdict.status === "mismatch") {
    throw new ContainerError(
      `Publisher mismatch — refusing to open.
${verdict.message}` +
        (verdict.expected ? `
Expected key: ${verdict.expected}` : "") +
        (verdict.received ? `
This copy: ${verdict.received}` : ""),
    );
  }

  if (verdict.status === "pinned") {
    const text = verdict.fingerprint
      ? `publisher ${verdict.fingerprint.slice(0, 8)} · trusted on first use`
      : "unsigned · recorded on first use";
    showTrust(text, true);
    return text;
  }

  const text = verdict.fingerprint
    ? `publisher ${verdict.fingerprint.slice(0, 8)} · matches pinned key`
    : "unsigned · as first seen";
  showTrust(text, false);
  return text;
}

async function openViaNativeDialog(): Promise<void> {
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({
      multiple: false,
      directory: false,
      title: "Open DAI cartridge",
      filters: [
        // .dai.html is a double extension; the filter matches on the last one,
        // so both are listed or such files would be hidden from the dialog.
        { name: "DAI cartridge", extensions: ["dai", "html"] },
      ],
    });

    // Null means the user dismissed the dialog: not an error, and not
    // something to report as one.
    if (typeof selected !== "string") return;

    statusEl.textContent = `Loading ${selected}...`;
    const source = await readCartridgeSource(selected);

    // The same gate the runner uses. A cartridge refused there must not open
    // here: one reader, one verdict.
    const container = await verifyContainer(source);
    const trust = await gateOnTrust(container);

    mountHtml(
      container.html,
      selected,
      await payloadFingerprint(container.manifest.documentUuid, container.manifest.hashes),
    );
    statusEl.textContent = `Loaded ${selected} — ${trust}`;
  } catch (error) {
    fail(
      error instanceof ContainerError
        ? error.message
        : `Failed to open cartridge: ${String(error)}`,
    );
  }
}

openBtn.addEventListener("click", () => {
  // Outside the host there is no native dialog, so the webview input remains
  // the way in — read-only, as openFile explains.
  if (isTauri()) void openViaNativeDialog();
  else fileInput.click();
});
chooseBtn.addEventListener("click", () => fileInput.click());
ejectBtn.addEventListener("click", eject);

fileInput.addEventListener("change", () => {
  // Cleared below so that re-picking the same file fires "change" again.
  // Without this, choosing the already-open cartridge does nothing at all and
  // the shell gives no sign that the click was received.
  const file = fileInput.files?.[0];
  if (file) void openFile(file).finally(() => {
    fileInput.value = "";
  });
});

// Cartridge Studio UI Elements & Modal Handler
const createBtn = document.getElementById("create-btn") as HTMLButtonElement;
const heroCreateBtn = document.getElementById("hero-create-btn") as HTMLButtonElement;
const createModal = document.getElementById("create-modal") as HTMLElement;
const closeModalBtn = document.getElementById("close-modal-btn") as HTMLButtonElement;
const mintBtn = document.getElementById("mint-btn") as HTMLButtonElement;
const appNameInput = document.getElementById("app-name-input") as HTMLInputElement;
const htmlSourceInput = document.getElementById("html-source-input") as HTMLTextAreaElement;
const mintStatus = document.getElementById("mint-status") as HTMLElement;
const dropZone = document.getElementById("drop") as HTMLElement;
const dropEmpty = document.getElementById("drop-empty") as HTMLElement;
const dropFilled = document.getElementById("drop-filled") as HTMLElement;
const loadedSummary = document.getElementById("loaded-summary") as HTMLElement;
const loadedList = document.getElementById("loaded-list") as HTMLUListElement;
const pickFilesBtn = document.getElementById("pick-files-btn") as HTMLButtonElement;
const pickFolderBtn = document.getElementById("pick-folder-btn") as HTMLButtonElement;
const clearFilesBtn = document.getElementById("clear-files-btn") as HTMLButtonElement;
const sourceFiles = document.getElementById("source-files") as HTMLInputElement;
const sourceFolder = document.getElementById("source-folder") as HTMLInputElement;

/**
 * The application being packaged, keyed by path.
 *
 * A real application is several files, and an assistant hands one over as a
 * folder or a zip. Accepting only pasted text meant asking somebody to flatten
 * their app by hand before this window would take it.
 */
let sourceTree: Record<string, Uint8Array> = {};

function describeSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} KB`;
}

function renderFiles(): void {
  const names = Object.keys(sourceTree).sort();
  dropEmpty.hidden = names.length > 0;
  dropFilled.hidden = names.length === 0;
  dropZone.classList.toggle("filled", names.length > 0);

  const total = names.reduce((sum, name) => sum + sourceTree[name]!.byteLength, 0);
  loadedSummary.textContent = `${names.length} files · ${describeSize(total)}`;

  loadedList.replaceChildren(
    ...names.map((name) => {
      const item = document.createElement("li");
      if (name === "index.html") item.className = "entry";

      const path = document.createElement("code");
      path.textContent = name;

      const size = document.createElement("span");
      size.textContent = describeSize(sourceTree[name]!.byteLength);

      item.append(path, size);
      return item;
    }),
  );
}

async function acceptFiles(list: FileList | null): Promise<void> {
  if (!list || list.length === 0) return;
  const picked = [...list];
  mintStatus.textContent = "";

  // A single archive is the common case: it is what a model produces when asked
  // for more than one file.
  if (picked.length === 1 && /\.zip$/i.test(picked[0]!.name)) {
    try {
      const unpacked = unpackZip(new Uint8Array(await picked[0]!.arrayBuffer()));
      sourceTree = Object.fromEntries(
        Object.entries(unpacked).filter(([name]) => !isNoise(name)),
      );
      if (appNameInput.value === "My App") {
        appNameInput.value = picked[0]!.name.replace(/\.zip$/i, "");
      }
    } catch (error) {
      mintStatus.style.color = "var(--bad)";
      mintStatus.textContent = `That zip could not be read: ${String(error)}`;
      return;
    }
    renderFiles();
    return;
  }

  const loaded: Record<string, Uint8Array> = {};
  for (const file of picked) {
    const path = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
    if (isNoise(path)) continue;
    loaded[path] = new Uint8Array(await file.arrayBuffer());
  }

  sourceTree = stripCommonPrefix(loaded);

  const folder = (picked[0] as File & { webkitRelativePath?: string }).webkitRelativePath;
  if (appNameInput.value === "My App" && folder && folder.includes("/")) {
    appNameInput.value = folder.split("/")[0]!;
  }

  renderFiles();
}

pickFilesBtn.addEventListener("click", () => sourceFiles.click());
pickFolderBtn.addEventListener("click", () => sourceFolder.click());
sourceFiles.addEventListener("change", () => void acceptFiles(sourceFiles.files));
sourceFolder.addEventListener("change", () => void acceptFiles(sourceFolder.files));

clearFilesBtn.addEventListener("click", () => {
  sourceTree = {};
  sourceFiles.value = "";
  sourceFolder.value = "";
  renderFiles();
});

dropZone.addEventListener("dragover", (event) => {
  event.preventDefault();
  dropZone.classList.add("dragging");
});
dropZone.addEventListener("dragleave", () => dropZone.classList.remove("dragging"));
dropZone.addEventListener("drop", (event) => {
  event.preventDefault();
  dropZone.classList.remove("dragging");
  void acceptFiles(event.dataTransfer?.files ?? null);
});

function showModal(): void {
  createModal.classList.add("open");
  mintStatus.textContent = "";
}

function hideModal(): void {
  createModal.classList.remove("open");
}

renderFiles();

createBtn.addEventListener("click", showModal);
heroCreateBtn.addEventListener("click", showModal);
closeModalBtn.addEventListener("click", hideModal);

/**
 * The runtime pieces a container is built from, loaded once.
 *
 * The engine is the part that used to be missing. Cartridges minted here were
 * compiled without it, so every one of them opened with no database — silently,
 * because a container without an engine is still a valid container. Anything
 * built by this window claimed to hold a data layer and did not.
 *
 * The assets are staged into public/runtime by scripts/stage-runtime.mjs and
 * read by the same loader the website uses, so this window and that page cannot
 * disagree about what a container is made of.
 */
let runtimeAssets: RuntimeAssets | undefined;

mintBtn.addEventListener("click", async () => {
  mintBtn.disabled = true;
  mintStatus.style.color = "#94a3b8";
  mintStatus.textContent = "Loading the engine...";

  try {
    const appName = appNameInput.value.trim() || "My App";
    const pasted = htmlSourceInput.value;
    const usingFiles = Object.keys(sourceTree).length > 0;

    if (!usingFiles && !pasted.trim()) {
      mintStatus.style.color = "var(--bad)";
      mintStatus.textContent = "Bring a folder, a zip, or paste a single file.";
      return;
    }

    if (usingFiles && !("index.html" in sourceTree)) {
      mintStatus.style.color = "var(--bad)";
      mintStatus.textContent =
        "There is no index.html. A container opens that first, so this would show nothing.";
      return;
    }

    // The same checks the website and the MCP server run. Without them somebody
    // brings what an assistant wrote, mints it, and opens a blank page with
    // nothing to explain why.
    const decoder = new TextDecoder();
    const readable: Record<string, string> = usingFiles
      ? Object.fromEntries(
          Object.entries(sourceTree)
            .filter(([name]) => /\.(?:html?|m?js|ts|css)$/i.test(name))
            .map(([name, bytes]) => [name, decoder.decode(bytes)]),
        )
      : { "index.html": pasted };

    const findings = lintFiles(readable);
    const fatal = findings.filter(
      (finding) => finding.id === "await-in-classic-script" || finding.id === "cdn-script",
    );
    if (fatal.length > 0) {
      mintStatus.style.color = "#f87171";
      mintStatus.textContent = fatal[0].what + " " + fatal[0].fix;
      return;
    }

    mintStatus.textContent = "Packaging, compiling and signing...";
    runtimeAssets ??= await loadRuntimeAssets();

    const built = await compileInBrowser({
      files: usingFiles ? sourceTree : { "index.html": pasted },
      appName,
      assets: runtimeAssets,
    });

    hideModal();
    mountHtml(built.html, appName.toLowerCase().replace(/\s+/g, "-") + ".dai.html");
    badge.textContent =
      "Signed (" + (built.publicKeyFingerprint ?? "").slice(0, 8) + ") · " + appName;

    if (findings.length > 0) {
      fail("Built, but worth fixing: " + findings.map((finding) => finding.what).join(" "));
    }
  } catch (err) {
    mintStatus.style.color = "#f87171";
    mintStatus.textContent = "Failed to mint cartridge: " + (err as Error).message;
  } finally {
    mintBtn.disabled = false;
  }
});

void checkOpenedFile();
void listenForForwardedCartridges();
