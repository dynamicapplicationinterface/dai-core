/**
 * The DAI Runner: a hosted, installable player for containers.
 *
 * A `.dai.html` cannot install itself on a phone — `file://` forbids service
 * workers and manifest registration, so there is nothing for the OS to install.
 * The runner inverts that: the *player* is the installable PWA, and containers
 * are opened from the user's own files. The console, not the cartridge.
 */
import { CartridgeError, readCartridge, type Cartridge } from "./cartridge.js";

const openButton = document.getElementById("open") as HTMLButtonElement;
const ejectButton = document.getElementById("eject") as HTMLButtonElement;
const fileInput = document.getElementById("file") as HTMLInputElement;
const cartridgeFrame = document.getElementById("cartridge") as HTMLIFrameElement;
const report = document.getElementById("report") as HTMLElement;
const slot = document.getElementById("slot") as HTMLElement;
const badge = document.getElementById("badge") as HTMLElement;

let mountedUrl: string | undefined;
let loaded: Cartridge | undefined;

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
  document.body.classList.remove("loaded");
  ejectButton.hidden = true;
  badge.hidden = true;
  say("");
  fileInput.value = "";
}

/**
 * Mounts a verified container.
 *
 * A blob URL rather than `srcdoc`, deliberately. The container gets a real
 * document URL on this origin, which means `import.meta.url` inside its own
 * blob modules resolves against a parseable base — the exact failure that makes
 * `blob:null/<uuid>` unusable. It also lets the container's `<meta>` CSP apply
 * to a document of its own rather than an inherited one.
 */
function mount(cartridge: Cartridge): void {
  const blob = new Blob([cartridge.html], { type: "text/html" });
  mountedUrl = URL.createObjectURL(blob);
  cartridgeFrame.src = mountedUrl;

  document.body.classList.add("loaded");
  ejectButton.hidden = false;

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
    loaded = cartridge;
    mount(cartridge);
  } catch (error) {
    // A rejected cartridge must say why. "Failed to load" would leave the user
    // unable to tell a corrupted download from a file that was never a
    // container in the first place.
    const message =
      error instanceof CartridgeError
        ? error.message
        : `This file could not be opened (${(error as Error).message}).`;
    say(message, true);
  } finally {
    slot.classList.remove("busy");
  }
}

openButton.addEventListener("click", () => fileInput.click());
ejectButton.addEventListener("click", eject);

fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (file) void ingest(file);
});

// Exposed for tests and for the storage layer that comes next.
Object.defineProperty(window, "__runner", {
  value: {
    get loaded() {
      return loaded;
    },
    eject,
  },
});

/**
 * Registers the service worker that makes the runner itself work offline.
 *
 * Only in a built app: a dev server hands out unbundled modules, and a
 * cache-first worker would freeze them and make every later edit invisible.
 */
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("./sw.js", { scope: "./" }).catch((error: unknown) => {
      // Registration failing is not fatal — the runner still works online.
      console.warn("DAI Runner: offline support unavailable.", error);
    });
  });
}
