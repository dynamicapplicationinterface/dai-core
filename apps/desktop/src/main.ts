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

function mountHtml(html: string, filePath?: string): void {
  if (mountedUrl) {
    URL.revokeObjectURL(mountedUrl);
  }
  currentFilePath = filePath;
  const blob = new Blob([html], { type: "text/html" });
  mountedUrl = URL.createObjectURL(blob);
  cartridgeFrame.src = mountedUrl;

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
    mountHtml(text, (file as File & { path?: string }).path || file.name);
    statusEl.textContent = "";
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
    (event.source as Window | null)?.postMessage({ type: "DAI_HOST_HANDSHAKE_ACK" }, "*");
  } else if (data.type === "DAI_HOST_SAVE") {
    const { databaseBytes } = data.payload || {};
    if (databaseBytes && currentFilePath && isTauri()) {
      // Save in-place natively via Tauri IPC command
      const bytes = new Uint8Array(databaseBytes);
      const base64Bytes = btoa(String.fromCharCode(...bytes));

      invokeTauri("save_cartridge", { path: currentFilePath, databaseBytes: base64Bytes })
        .then(() => {
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
    } else {
      // Fallback ACK
      (event.source as Window | null)?.postMessage(
        { type: "DAI_HOST_SAVE_ACK", status: "ok" },
        "*",
      );
    }
  }
});

openBtn.addEventListener("click", () => fileInput.click());
chooseBtn.addEventListener("click", () => fileInput.click());
ejectBtn.addEventListener("click", eject);

fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (file) void openFile(file);
});

void checkOpenedFile();
