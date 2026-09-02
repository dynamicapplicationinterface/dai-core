/**
 * DAI Native Desktop Shell Frontend Controller.
 *
 * Bridges container postMessage calls to Tauri v2 native IPC commands (read_cartridge, save_cartridge)
 * for silent, in-place disk persistence without browser download prompts.
 */

import { ContainerError, verifyContainer } from "../../../src/container.js";
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

function clearAlert(): void {
  alertEl.hidden = true;
  alertEl.textContent = "";
}

let currentFilePath: string | undefined;
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

function mountHtml(html: string, filePath?: string): void {
  clearAlert();
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
    const text = await file.text();

    // Full verification, not a shape check: digests both ways, the shell
    // against its sealed copy, and the publisher signature when one is carried.
    const container = await verifyContainer(text);
    const trust = await gateOnTrust(container);

    // A browser File has no filesystem path, so a cartridge chosen here cannot
    // be saved back in place — there is nothing to overwrite. Passing the bare
    // name on would make the host write into its working directory instead.
    const nativePath = (file as File & { path?: string }).path;
    mountHtml(container.html, nativePath);
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

  if (!openedPath) return;

  try {
    statusEl.textContent = `Loading ${openedPath}...`;
    const content = await invokeTauri<string>("read_cartridge", { path: openedPath });

    const container = await verifyContainer(content);
    const trust = await gateOnTrust(container);

    mountHtml(container.html, openedPath);
    statusEl.textContent = `Loaded ${openedPath} — ${trust}`;
  } catch (error) {
    // A cartridge that fails on launch leaves an empty window, so the reason
    // has to be on screen: there is nothing else for the user to look at.
    fail(
      error instanceof ContainerError
        ? error.message
        : `Could not open ${openedPath}: ${String(error)}`,
    );
  }
}

// Listen for container Host-Bridge postMessages (DAI_HOST_HANDSHAKE, DAI_HOST_SAVE)
window.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || typeof data !== "object") return;

  if (data.type === "DAI_HOST_HANDSHAKE") {
    // The container is alive; it can report its own problems from here.
    clearBootWatchdog();
    (event.source as Window | null)?.postMessage({ type: "DAI_HOST_HANDSHAKE_ACK" }, "*");
  } else if (data.type === "DAI_HOST_SAVE") {
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
    const { html } = (data.payload || {}) as { html?: string };

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
    invokeTauri("save_cartridge", { path: currentFilePath, html })
      .then(() => reply("ok"))
      .catch((error: unknown) => reply("error", String(error)));
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
    const content = await invokeTauri<string>("read_cartridge", { path: selected });

    // The same gate the runner uses. A cartridge refused there must not open
    // here: one reader, one verdict.
    const container = await verifyContainer(content);
    const trust = await gateOnTrust(container);

    mountHtml(container.html, selected);
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

function showModal(): void {
  createModal.classList.add("open");
  mintStatus.textContent = "";
}

function hideModal(): void {
  createModal.classList.remove("open");
}

createBtn.addEventListener("click", showModal);
heroCreateBtn.addEventListener("click", showModal);
closeModalBtn.addEventListener("click", hideModal);

mintBtn.addEventListener("click", async () => {
  mintBtn.disabled = true;
  mintStatus.textContent = "Packaging, compiling, and signing cartridge...";

  try {
    const { buildContainer } = await import("../../../src/core.js");
    const { CONTAINER_TEMPLATE, RUNTIME_SOURCE } = await import("../../../dist/templates.js");

    const appName = appNameInput.value.trim() || "Untitled Cartridge";
    const htmlSource = htmlSourceInput.value;

    // Mint a fresh WebCrypto ECDSA P-256 key pair for signing
    const keyPair = await window.crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"]
    );

    const built = await buildContainer({
      files: {
        "index.html": new TextEncoder().encode(htmlSource),
      },
      template: CONTAINER_TEMPLATE,
      runtime: RUNTIME_SOURCE,
      appName,
      signingKey: keyPair,
    });

    hideModal();
    mountHtml(built.html, `${appName.toLowerCase().replace(/\s+/g, "-")}.dai.html`);
    badge.textContent = `Signed (${built.publicKeyFingerprint?.slice(0, 8)}) · ${appName}`;
  } catch (err) {
    mintStatus.textContent = `Failed to mint cartridge: ${(err as Error).message}`;
  } finally {
    mintBtn.disabled = false;
  }
});

void checkOpenedFile();
