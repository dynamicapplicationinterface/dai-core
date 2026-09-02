/**
 * DAI Native Desktop Shell Frontend Controller.
 *
 * Bridges container postMessage calls to Tauri v2 native IPC commands (read_cartridge, save_cartridge)
 * for silent, in-place disk persistence without browser download prompts.
 */

const cartridgeFrame = document.getElementById("cartridge") as HTMLIFrameElement;
const openBtn = document.getElementById("open-btn") as HTMLButtonElement;
const chooseBtn = document.getElementById("choose-btn") as HTMLButtonElement;
const ejectBtn = document.getElementById("eject-btn") as HTMLButtonElement;
const fileInput = document.getElementById("file-input") as HTMLInputElement;
const badge = document.getElementById("badge") as HTMLElement;
const statusEl = document.getElementById("status") as HTMLElement;

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

    // Refuse anything that is not a container rather than mounting it. Without
    // this the shell frames arbitrary bytes and the user gets a blank panel
    // with nothing said about why.
    if (!/<script[^>]*id="dai-payload"[^>]*>\s*[A-Za-z0-9+/=]/.test(text)) {
      statusEl.textContent =
        `${file.name} is not a DAI container: it has no payload. ` +
        `It may be an ordinary web page, or a truncated download.`;
      return;
    }

    // A browser File has no filesystem path, so a cartridge chosen here cannot
    // be saved back in place — there is nothing to overwrite. Passing the bare
    // name on would make the host write into its working directory instead.
    const nativePath = (file as File & { path?: string }).path;
    mountHtml(text, nativePath);
    statusEl.textContent = nativePath
      ? `Loaded ${file.name}`
      : `Loaded ${file.name} — read-only. Open it by double-clicking the file to save changes in place.`;
  } catch (err) {
    statusEl.textContent = `Failed to open file: ${(err as Error).message}`;
  }
}

// Check if launched via double-click CLI argument in Tauri
async function checkOpenedFile(): Promise<void> {
  if (isTauri()) {
    try {
      const openedPath = await invokeTauri<string | null>("get_opened_file");
      if (openedPath) {
        const content = await invokeTauri<string>("read_cartridge", { path: openedPath });
        mountHtml(content, openedPath);
      }
    } catch {
      // Ignore if no CLI path
    }
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
    mountHtml(content, selected);
    statusEl.textContent = `Loaded ${selected}`;
  } catch (error) {
    statusEl.textContent = `Failed to open cartridge: ${String(error)}`;
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
