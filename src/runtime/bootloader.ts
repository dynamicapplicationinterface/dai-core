/**
 * DAI v0.1 bootloader runtime.
 *
 * Executes the packaged React application from a `file://` document with no
 * network access of any kind:
 *
 *   1. Decode the Base64 payload out of `#dai-payload`.
 *   2. Unzip it in memory (fflate, bundled into this script).
 *   3. Turn every packaged asset into a `blob:` URL.
 *   4. Rewrite the packaged `index.html` to point at those URLs.
 *   5. Mount the result in a sandboxed iframe via `srcdoc`.
 *
 * Service Workers are deliberately not used: they are unavailable on `file://`,
 * which is the primary way a container is opened. See §1 of the Phase 2 spec.
 */
import { unzipSync, zipSync } from "fflate";
// Imported rather than reimplemented: the host derives the same value from the
// same helper, and two spellings of "canonical" would disagree eventually.
import { payloadFingerprint } from "../core.js";

const APP_PREFIX = "app/";
const WASM_ENTRY = "runtime/sqlite3.wasm";
const SQLITE_ENTRY = "document.sqlite";
const CONTAINER_ENTRY = "runtime/container.html";
const GLUE_ENTRY = "runtime/sqlite3.mjs";
const MANIFEST_ENTRY = "runtime/manifest.json";
const SAVE_REQUEST = "dai:save";
const APP_MODE_EVENT = "dai:appmode";

/** How a save should be attempted. */
type SaveMethod = "auto" | "picker" | "download" | "host";
/**
 * What a save actually did. `cancelled` means the dialog was dismissed;
 * `unsupported` means the picker was demanded but this engine has none;
 * `host` means the save was handled by a parent host player.
 */
interface SaveResult {
  saved: boolean;
  method: "picker" | "download" | "cancelled" | "unsupported" | "host";
}
/**
 * Must match PAYLOAD_TAG_RE in the compiler. Anchored to the payload tag
 * because this very script carries the placeholder literal and is inlined above
 * it, so an unanchored match would rewrite the bootloader's own source.
 */
const PAYLOAD_TAG_RE = /(<script[^>]*id="dai-payload"[^>]*>)<!--DAI_PAYLOAD-->/;
const HANDSHAKE = "dai:ready";
/** How long the iframe has to report back before we surface a diagnostic. */
const HANDSHAKE_TIMEOUT_MS = 5000;
/**
 * Base for the placeholder URLs that stand in for packaged modules. Never
 * fetched: an import map in the iframe redirects every one of them to a blob.
 */
const SYNTHETIC_ORIGIN = "file:///dai/app/";

const MIME_TYPES: Record<string, string> = {
  js: "text/javascript",
  mjs: "text/javascript",
  css: "text/css",
  html: "text/html",
  json: "application/json",
  wasm: "application/wasm",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  map: "application/json",
  txt: "text/plain",
};

function mimeFor(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return MIME_TYPES[ext] ?? "application/octet-stream";
}

function setStatus(message: string, detail = ""): void {
  const status = document.getElementById("dai-boot-status");
  const detailEl = document.getElementById("dai-boot-detail");
  if (status) status.textContent = message;
  if (detailEl) detailEl.textContent = detail;
}

function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** Collapses `./a/../b` style references so archive lookups are exact. */
function normalizePath(path: string): string {
  const out: string[] = [];
  for (const segment of path.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") out.pop();
    else out.push(segment);
  }
  return out.join("/");
}

/**
 * Rewrites every `src`/`href` in the packaged HTML to the blob URL for that
 * asset. Anything not present in the archive is left untouched — with
 * `connect-src 'none'` and no network, an unresolved reference simply fails to
 * load rather than reaching out.
 */
function rewriteHtml(html: string, urls: Map<string, string>): string {
  return html.replace(
    /(\s(?:src|href))="([^"]+)"/g,
    (whole, attr: string, value: string) => {
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(value)) return whole;
      const url = urls.get(normalizePath(value));
      return url ? `${attr}="${url}"` : whole;
    },
  );
}

/**
 * Copies a view's bytes into a standalone ArrayBuffer.
 *
 * fflate hands back views onto a shared buffer, and `WebAssembly.instantiate`
 * must be given the module bytes alone.
 */
function toArrayBuffer(view: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(view.byteLength);
  copy.set(view);
  return copy.buffer;
}

interface Manifest {
  manifestVersion: number;
  documentUuid: string;
  algorithm: string;
  hashes: Record<string, string>;
  signatureAlgorithm?: string;
  publicKeyFingerprint?: string;
  signedEntries?: Record<string, string>;
  signature?: string;
}

/**
 * Whether integrity is enforced, read from the shell rather than the payload.
 *
 * The manifest deliberately has no say here. A policy stored inside the archive
 * it governs could be switched off by the same edit that alters the archive,
 * which would make the whole check theatre.
 */
/** Verification needs WebCrypto; an advisory container can run without it. */
function policyRequiresCrypto(): boolean {
  return integrityPolicy() === "required";
}

function integrityPolicy(): "required" | "advisory" {
  const meta = document.querySelector('meta[name="dai-integrity"]');
  return meta?.getAttribute("content") === "advisory" ? "advisory" : "required";
}

/** Lowercase hex SHA-256, matching the digests the compiler wrote. */
async function sha256(bytes: Uint8Array): Promise<string> {
  const view = new Uint8Array(bytes.byteLength);
  view.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", view);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Verifies every payload entry against the manifest.
 *
 * The manifest cannot cover itself — a digest cannot include the field holding
 * it — so it is excluded and every other entry is checked. An entry present in
 * the payload but absent from the manifest counts as tampering just as much as
 * a mismatched digest: otherwise anything could be added freely.
 */
async function verifyPayload(
  files: Record<string, Uint8Array>,
  manifest: Manifest,
): Promise<string[]> {
  const problems: string[] = [];

  for (const [name, bytes] of Object.entries(files)) {
    if (name === MANIFEST_ENTRY) continue;
    const expected = manifest.hashes[name];
    if (!expected) {
      problems.push(`${name} is not listed in the manifest`);
      continue;
    }
    const actual = await sha256(bytes);
    if (actual !== expected) {
      problems.push(`${name} does not match its digest`);
    }
  }

  for (const name of Object.keys(manifest.hashes)) {
    if (!(name in files)) problems.push(`${name} is missing from the payload`);
  }

  return problems;
}

/** Base64 to bytes, for keys and signatures carried as text. */
function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** The publisher's key, read from the shell. Empty when unsigned. */
function publicKeyFromShell(): string {
  const meta = document.querySelector('meta[name="dai-public-key"]');
  return meta?.getAttribute("content")?.trim() ?? "";
}

/**
 * Rebuilds the exact bytes the compiler signed.
 *
 * Sorted by entry name so the string depends only on content, never on archive
 * order. Must stay byte-identical to canonicalPayload() in the compiler.
 */
function canonicalPayload(uuid: string, entries: Record<string, string>): string {
  const sorted = Object.keys(entries)
    .sort()
    .map((name) => name + ":" + entries[name])
    .join("\n");
  return "dai-v1\n" + uuid + "\n" + sorted + "\n";
}

/**
 * Checks the publisher's signature over the application and runtime.
 *
 * `document.sqlite` is deliberately outside the signed set: the application is
 * immutable but its database is not, and a container carries no private key to
 * re-sign with after a save. Integrity of the database is covered by `hashes`.
 *
 * Every signed entry is re-checked against the manifest here rather than
 * trusted from the integrity pass, so a signature can never be verified over
 * digests that differ from the ones just validated.
 */
async function verifySignature(
  manifest: Manifest,
  spki: string,
): Promise<{ ok: boolean; reason?: string }> {
  if (!manifest.signature || !manifest.signedEntries) {
    return { ok: false, reason: "the container carries a public key but no signature" };
  }
  if (manifest.signatureAlgorithm !== "ECDSA-P256-SHA256") {
    return { ok: false, reason: `unsupported signature algorithm ${manifest.signatureAlgorithm}` };
  }

  for (const [name, digest] of Object.entries(manifest.signedEntries)) {
    if (manifest.hashes[name] !== digest) {
      return { ok: false, reason: `${name} is signed with a different digest` };
    }
  }

  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      "spki",
      fromBase64(spki) as unknown as BufferSource,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
  } catch (error) {
    return { ok: false, reason: `public key is unreadable (${String(error)})` };
  }

  const ok = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    fromBase64(manifest.signature) as unknown as BufferSource,
    new TextEncoder().encode(
      canonicalPayload(manifest.documentUuid, manifest.signedEntries),
    ) as unknown as BufferSource,
  );

  return ok ? { ok: true } : { ok: false, reason: "signature does not match the publisher key" };
}

/** btoa() over a large binary string blows the argument limit; chunk it. */
function toBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * Rebuilds the container around a new database and hands it to the user.
 *
 * The shell comes from `runtime/container.html` *inside the payload*, not from
 * the compiler that produced this file. A saved document therefore carries the
 * same bootloader it was compiled with: its runtime semantics are fixed at
 * compile time and survive every save, rather than drifting toward whatever
 * dai-core happens to be installed later.
 *
 * This runs in the top document, never the sandboxed frame: showSaveFilePicker
 * needs a non-sandboxed context and its own user activation.
 */
/**
 * Rebuilds the container document around a new database.
 *
 * Split out so the host bridge can send a finished document rather than raw
 * database bytes. A native host that spliced the payload itself would have to
 * re-zip, re-digest every entry and rewrite the manifest — reimplementing this
 * function in another language, where the two could drift apart and produce a
 * file that refuses to open.
 */
async function resealContainer(
  files: Record<string, Uint8Array>,
  sqlite: Uint8Array,
): Promise<string> {
  const shellBytes = files[CONTAINER_ENTRY];
  if (!shellBytes) {
    throw new Error(
      `This container has no ${CONTAINER_ENTRY}; it was built before ` +
        `self-perpetuating saves and cannot rewrite itself.`,
    );
  }

  const next: Record<string, Uint8Array> = { ...files, [SQLITE_ENTRY]: sqlite };

  // Reseal. The database just changed, so the manifest's digest for it is now
  // stale — leaving it would produce a file that refuses to open. The document
  // UUID is deliberately carried over: a save is a new revision of the same
  // document, not a new document.
  const previous = files[MANIFEST_ENTRY];
  if (previous) {
    const manifest = JSON.parse(new TextDecoder().decode(previous)) as Manifest &
      Record<string, unknown>;
    const hashes: Record<string, string> = {};
    for (const [name, bytes] of Object.entries(next)) {
      if (name === MANIFEST_ENTRY) continue;
      hashes[name] = await sha256(bytes);
    }
    next[MANIFEST_ENTRY] = new TextEncoder().encode(
      JSON.stringify({ ...manifest, savedAt: new Date().toISOString(), hashes }, null, 2) +
        "\n",
    );
  }

  const payload = toBase64(zipSync(next, { level: 9 }));
  const shell = new TextDecoder().decode(shellBytes);
  return shell.replace(PAYLOAD_TAG_RE, (_match, open: string) => open + payload);
}

async function writeContainer(
  files: Record<string, Uint8Array>,
  sqlite: Uint8Array,
  method: SaveMethod = "auto",
): Promise<SaveResult> {
  const html = await resealContainer(files, sqlite);

  const name = `${document.title || "document"}.dai.html`;
  const blob = new Blob([html], { type: "text/html" });

  const picker = method === "download" ? undefined : (
    window as unknown as {
      showSaveFilePicker?: (options: unknown) => Promise<{
        createWritable: () => Promise<{
          write: (data: Blob) => Promise<void>;
          close: () => Promise<void>;
        }>;
      }>;
    }
  ).showSaveFilePicker;

  // An explicit "picker" request must not silently become a download: Safari
  // and Firefox have no picker at all, and the caller needs to know that rather
  // than believe it overwrote the original file.
  if (!picker && method === "picker") {
    return { saved: false, method: "unsupported" };
  }

  if (picker) {
    try {
      const handle = await picker({
        suggestedName: name,
        types: [
          {
            description: "DAI container",
            accept: { "text/html": [".dai.html"] },
          },
        ],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return { saved: true, method: "picker" };
    } catch (error) {
      // AbortError means the dialog was dismissed. Report it rather than
      // resolving silently: the caller cannot otherwise tell a save from a
      // cancel, and headless browsers auto-dismiss the picker.
      if ((error as { name?: string }).name === "AbortError") {
        return { saved: false, method: "cancelled" };
      }
      // Anything else (Safari, Firefox, a blocked picker) falls through.
    }
  }

  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
  return { saved: true, method: "download" };
}

/**
 * Everything the application sees as `window.dai`, run inside the frame.
 *
 * This function is serialized with `Function.prototype.toString()` and injected
 * into the frame, so it MUST be self-contained: it may not reference anything
 * from this module's scope, because those bindings do not exist in the frame
 * (and are renamed by the minifier). Everything it needs comes off
 * `parent.__DAI__`.
 */
function bridgeMain(): void {
  type Any = Record<string, any>;
  const host: Any = ((parent as unknown as Any).__DAI__ as Any) || {};

  /**
   * Re-creates a buffer with this frame's intrinsics. A buffer minted in the
   * parent realm fails `instanceof ArrayBuffer` here even though WebAssembly
   * accepts it, which breaks any app that type-checks its input.
   */
  const adopt = (src: ArrayBufferLike | null): ArrayBuffer | null => {
    if (!src) return null;
    const out = new ArrayBuffer(src.byteLength);
    new Uint8Array(out).set(new Uint8Array(src));
    return out;
  };

  const wasm = adopt(host.sqliteWasm as ArrayBuffer | null);
  const seedSource = host.sqlite as Uint8Array | undefined;
  const seed = seedSource
    ? new Uint8Array(adopt(seedSource.slice().buffer)!)
    : new Uint8Array(0);
  const glueUrl: string | null = (host.sqliteGlueUrl as string) || null;

  /**
   * Page size for newly created databases. 4096 is SQLite's own documented
   * default and the most widely interoperable value.
   */
  const DEFAULT_PAGE_SIZE = 4096;

  let sqlite3: Any | null = null;
  let booting: Promise<Any> | null = null;

  /** Loads the glue via an inline module script: no dynamic import, no eval. */
  const loadGlue = (): Promise<Any> =>
    new Promise((resolve, reject) => {
      if (!glueUrl) {
        reject(new Error("No Emscripten glue was packaged in this container."));
        return;
      }
      const token = "__daiGlue" + Date.now();
      const script = document.createElement("script");
      script.type = "module";
      script.textContent =
        "import init from " + JSON.stringify(glueUrl) + ";" +
        "window[" + JSON.stringify(token) + "]={ok:init};" +
        "window.dispatchEvent(new Event(" + JSON.stringify(token) + "));";
      window.addEventListener(token, () => {
        const slot = (window as unknown as Any)[token] as Any;
        delete (window as unknown as Any)[token];
        if (slot && slot.ok) resolve(slot.ok as Any);
        else reject(new Error("Glue exported no initializer."));
      });
      script.onerror = () => reject(new Error("Glue module failed to load."));
      document.head.appendChild(script);
    });

  /**
   * Boots the engine entirely from memory.
   *
   * `instantiateWasm` is what makes this work under `connect-src 'none'`: it
   * hands Emscripten an instance compiled from the embedded bytes, so
   * `locateFile()` is never consulted and no fetch is ever attempted.
   */
  const initSqlite = (): Promise<Any> => {
    if (booting) return booting;
    if (!wasm) {
      return Promise.reject(
        new Error("No sqlite3.wasm was packaged in this container."),
      );
    }

    // Emscripten probes OPFS at startup, which rejects on an opaque origin.
    // Swallow those rejections so they cannot surface as an unhandled error and
    // abort the boot; the in-memory VFS is the fallback either way.
    const muffle = (event: PromiseRejectionEvent): void => {
      const reason = event.reason as Any;
      const text = String((reason && reason.message) || reason || "");
      if (/opfs|storage|getDirectory|SharedArrayBuffer/i.test(text)) {
        event.preventDefault();
      }
    };
    window.addEventListener("unhandledrejection", muffle);

    booting = loadGlue()
      .then((init) =>
        (init as unknown as (config: Any) => Promise<Any>)({
          instantiateWasm(
            imports: WebAssembly.Imports,
            receive: (i: WebAssembly.Instance, m: WebAssembly.Module) => void,
          ) {
            WebAssembly.instantiate(wasm as ArrayBuffer, imports).then((result) =>
              receive(result.instance, result.module),
            );
            // Async path: Emscripten waits for `receive` when this returns {}.
            return {};
          },
          print: () => {},
          printErr: () => {},
          locateFile(path: string) {
            // Should never run: instantiateWasm satisfies the only asset.
            throw new Error(
              "DAI: refusing to locate " + path + "; no network is available.",
            );
          },
        }),
      )
      .then((instance) => {
        sqlite3 = instance;
        window.removeEventListener("unhandledrejection", muffle);
        return instance;
      })
      .catch((error: unknown) => {
        booting = null;
        window.removeEventListener("unhandledrejection", muffle);
        throw error;
      });

    return booting;
  };

  /**
   * Opens the packaged document, or a fresh database when there is no seed.
   *
   * A fresh database gets an explicitly pinned page size. SQLite's default
   * varies by build — this engine defaults to 8192 — so leaving it implicit
   * makes a document's on-disk geometry an accident of whichever engine version
   * first wrote it. Pinning it keeps files openable as engines change.
   * `PRAGMA page_size` only takes effect while the database is still empty, so
   * it must run before anything creates a table.
   *
   * A seeded database keeps whatever page size its bytes already declare: the
   * pragma cannot change an existing file, and silently rewriting someone's
   * document geometry would be worse than honouring it.
   */
  const openDatabase = (options?: { pageSize?: number }): Promise<Any> =>
    initSqlite().then((api2) => {
      const db = new api2.oo1.DB() as Any;
      if (seed.byteLength === 0) {
        const pageSize = (options && options.pageSize) || DEFAULT_PAGE_SIZE;
        db.exec("PRAGMA page_size=" + pageSize);
        return db;
      }

      const pointer = api2.wasm.allocFromTypedArray(seed);
      const rc = api2.capi.sqlite3_deserialize(
        db.pointer,
        "main",
        pointer,
        seed.byteLength,
        seed.byteLength,
        api2.capi.SQLITE_DESERIALIZE_FREEONCLOSE |
          api2.capi.SQLITE_DESERIALIZE_RESIZEABLE,
      );
      if (rc !== 0) throw new Error("sqlite3_deserialize failed (rc=" + rc + ").");

      // Touch the schema so the connection actually reads the deserialized
      // header. Until something does, PRAGMA page_size still reports the
      // connection's default rather than the file's real geometry — which makes
      // a 4096-page document look like an 8192-page one to the application.
      db.exec("SELECT count(*) FROM sqlite_schema");
      return db;
    });

  /** Extracts the live database as bytes, ready to be written back. */
  const exportDatabase = (db: Any): Uint8Array => {
    if (!sqlite3) throw new Error("SQLite is not initialized.");
    return sqlite3.capi.sqlite3_js_db_export(db.pointer) as Uint8Array;
  };

  /**
   * Asks the host to rewrite the container: the frame is sandboxed and cannot.
   *
   * Resolves with `{saved, method}` rather than plain undefined, because a
   * dismissed save-file dialog is otherwise indistinguishable from a successful
   * write — and headless browsers dismiss it automatically. Pass
   * `{method:"download"}` to skip the picker entirely.
   */
  const saveState = (
    bytes?: Uint8Array | null,
    options?: { method?: "auto" | "picker" | "download" },
  ): Promise<Any> =>
    new Promise((resolve, reject) => {
      const id = Math.random().toString(36).slice(2);
      const done = (event: MessageEvent): void => {
        const data = event.data as Any;
        if (!data || data.id !== id) return;
        window.removeEventListener("message", done);
        if (data.ok) resolve(data.result);
        else reject(new Error(String(data.error)));
      };
      window.addEventListener("message", done);
      parent.postMessage(
        {
          type: "dai:save",
          id: id,
          sqlite: bytes ? new Uint8Array(bytes) : null,
          method: (options && options.method) || "auto",
        },
        "*",
      );
    });

  // App Mode state, pushed from the shell. The app can observe it but cannot
  // request it: only the top document may go fullscreen, and only on a gesture.
  let appMode = false;
  const appModeListeners = new Set<(active: boolean) => void>();

  window.addEventListener("message", (event: MessageEvent) => {
    const data = event.data as Any;
    if (!data || data.type !== "dai:appmode") return;
    appMode = !!data.active;
    appModeListeners.forEach((listener) => listener(appMode));
  });

  const api: Any = {
    version: host.version,
    get appMode() {
      return appMode;
    },
    onAppModeChange: (listener: (active: boolean) => void) => {
      appModeListeners.add(listener);
      return () => appModeListeners.delete(listener);
    },
    // Document identity, from the sealed manifest.
    documentUuid: host.documentUuid,
    verified: host.verified,
    signature: host.signature,
    publicKeyFingerprint: host.publicKeyFingerprint,
    sqliteWasm: wasm,
    document: seed,
    hasSqliteEngine: !!wasm,
    hasSqliteGlue: !!glueUrl,
    compileSqlite: () =>
      wasm
        ? WebAssembly.compile(wasm)
        : Promise.reject(
            new Error("No sqlite3.wasm was packaged in this container."),
          ),
    instantiateSqlite: (imports?: WebAssembly.Imports) => {
      if (!wasm) {
        return Promise.reject(
          new Error("No sqlite3.wasm was packaged in this container."),
        );
      }
      if (imports) return WebAssembly.instantiate(wasm, imports);
      // The engine declares ~36 imports; satisfying them is the glue's job.
      return WebAssembly.compile(wasm).then((module) => {
        const needed = WebAssembly.Module.imports(module);
        const first = needed[0];
        throw new Error(
          "sqlite3.wasm needs " + needed.length + " imports (first: " +
            (first ? first.module + "." + first.name : "none") + "). Use initSqlite() to " +
            "boot it through the Emscripten glue, or compileSqlite() to validate it.",
        );
      });
    },
    initSqlite: initSqlite,
    openDatabase: openDatabase,
    /** Page size declared by a serialized database, read from its header. */
    pageSizeOf: (bytes: Uint8Array) => {
      if (bytes.byteLength < 20) return 0;
      const high = bytes[16] as number;
      const low = bytes[17] as number;
      const raw = (high << 8) | low;
      // The header stores 65536 as 1, since the field is only 16 bits wide.
      return raw === 1 ? 65536 : raw;
    },
    exportDatabase: exportDatabase,
    saveDatabase: (db: Any, options?: Any) => saveState(exportDatabase(db), options),
    saveState: saveState,
  };

  (window as unknown as Any).dai = api;
  (window as unknown as Any).daiSaveState = (bytes?: Uint8Array, options?: Any) =>
    saveState(bytes, options);
}

/**
 * Wires the App Mode control.
 *
 * Fullscreen can only be requested by the top document, and only from a user
 * gesture — a sandboxed frame cannot ask for it, and forwarding the capability
 * would mean granting the app the right to seize the viewport unprompted. So
 * the shell owns the control and the app merely observes the state.
 */
function installAppMode(frame: HTMLIFrameElement): void {
  const button = document.getElementById("dai-app-mode") as HTMLButtonElement | null;
  if (!button) return;

  const supported =
    typeof document.documentElement.requestFullscreen === "function" &&
    document.fullscreenEnabled !== false;
  if (!supported) return;

  button.hidden = false;

  const active = (): boolean => document.fullscreenElement !== null;

  const notify = (): void => {
    document.body.classList.toggle("dai-app-mode", active());
    button.textContent = active() ? "Exit App Mode" : "Enter App Mode";
    // Apps that want to lay out differently in App Mode can listen for this.
    frame.contentWindow?.postMessage({ type: APP_MODE_EVENT, active: active() }, "*");
  };

  button.addEventListener("click", () => {
    // Failures are reported rather than thrown: a blocked request must not take
    // the document down with it, and the app keeps running windowed.
    const request = active()
      ? document.exitFullscreen()
      : document.documentElement.requestFullscreen({ navigationUI: "hide" });
    void Promise.resolve(request).catch((error: unknown) => {
      button.textContent = "App Mode unavailable";
      window.setTimeout(notify, 2000);
      console.warn("DAI: App Mode was refused.", error);
    });
  });

  // Covers Escape and any other route out of fullscreen, not just the button.
  document.addEventListener("fullscreenchange", notify);
  notify();
}

/** Serializes bridgeMain() into the frame. See the note on that function. */
function bridgeScript(): string {
  return "<script>(" + bridgeMain.toString() + ")()<" + "/script>";
}

/** Injected into the iframe so the host can tell mounting actually succeeded. */
function handshakeScript(): string {
  return (
    `<script>(function(){` +
    `var ok=function(){try{parent.postMessage(${JSON.stringify(HANDSHAKE)},"*")}catch(e){}};` +
    `window.addEventListener("error",function(e){try{parent.postMessage(` +
    `{type:"dai:error",message:String(e.message)},"*")}catch(_){}}, true);` +
    `if(document.readyState==="complete")ok();else window.addEventListener("load",ok);` +
    `})()<\/script>`
  );
}

function mount(srcdoc: string): HTMLIFrameElement {
  const frame = document.createElement("iframe");
  frame.id = "dai-app";
  // allow-same-origin is required: blob: URLs minted by this document are only
  // reachable from the frame if the frame shares its origin.
  frame.setAttribute(
    "sandbox",
    "allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-downloads",
  );
  // Deny fullscreen to the frame. A same-origin frame inherits the permission
  // by default, which would let the application seize the whole viewport on any
  // gesture it happens to receive. App Mode is the shell's to grant.
  frame.setAttribute("allow", "fullscreen 'none'");
  // Direct property assignment prevents HTML attribute string escaping issues with unescaped double quotes inside app payloads
  frame.srcdoc = srcdoc;
  document.body.appendChild(frame);
  return frame;
}

/** Predictable, parseable stand-in URL for a packaged module. */
function placeholderFor(path: string): string {
  return `${SYNTHETIC_ORIGIN}${path}`;
}

interface ResolvedAssets {
  /** Archive path -> blob URL. */
  urls: Map<string, string>;
  /** Placeholder URL -> blob URL, for the iframe's import map. */
  imports: Record<string, string>;
}

/**
 * Turns every packaged asset into a `blob:` URL.
 *
 * Two problems make this more than a wrapper call:
 *
 * 1. Vite resolves siblings with `new URL(dep, import.meta.url)`. Under a blob
 *    module `import.meta.url` is `blob:null/<uuid>` — an opaque path that throws
 *    when parsed as a base, before `dep` is even considered.
 * 2. A blob's content is frozen at creation, so a module cannot be rewritten to
 *    point at a blob that does not exist yet. Vite's chunk graph is cyclic in
 *    practice — a lazy chunk imports shared code back from the entry chunk — so
 *    no ordering of blob creation can satisfy both directions.
 *
 * Both are solved with one indirection. Chunk-to-chunk references are rewritten
 * to `SYNTHETIC_ORIGIN` placeholder URLs, which are absolute (nothing to
 * resolve against a base) and known before any blob exists (so cycles are
 * irrelevant). An import map in the iframe then redirects each placeholder to
 * its real blob URL. Non-JS assets have no cycles and are substituted directly.
 */
function resolveAssets(assets: Map<string, Uint8Array>): ResolvedAssets {
  const urls = new Map<string, string>();
  const imports: Record<string, string> = {};
  const decoder = new TextDecoder();
  const scripts = new Map<string, string>();

  const blobUrl = (data: BlobPart, path: string): string =>
    URL.createObjectURL(new Blob([data], { type: mimeFor(path) }));

  for (const [path, bytes] of assets) {
    if (path === "index.html") continue;
    if (/\.m?js$/.test(path)) scripts.set(path, decoder.decode(bytes));
    else urls.set(path, blobUrl(bytes as BlobPart, path));
  }

  /**
   * Every spelling a chunk may use for an asset. Vite emits sibling references
   * by basename (`./Lazy-abc123.js`) while the archive keys them by path
   * (`assets/Lazy-abc123.js`), so both must be matched. Longest first, so a full
   * path is never partially consumed by its own basename.
   */
  const spellings = (path: string): string[] => {
    const base = path.slice(path.lastIndexOf("/") + 1);
    const forms = [`./${path}`, path, `./${base}`, base];
    return [...new Set(forms)].sort((a, b) => b.length - a.length);
  };

  /** Escapes a literal for regex use by wrapping metacharacters in classes. */
  const escapeRe = (value: string): string =>
    [...value].map((c) => (/[a-zA-Z0-9_/-]/.test(c) ? c : `[${c}]`)).join("");

  /**
   * Replaces every spelling of `target` in one pass. Sequential per-form
   * replacement would corrupt the output: after `./Lazy-abc.js` becomes an
   * absolute URL, the bare-basename form would match inside the URL just
   * inserted and substitute again. Alternation is ordered longest-first so the
   * most specific spelling wins at any given position.
   */
  const substitute = (text: string, target: string, replacement: string): string => {
    const pattern = new RegExp(spellings(target).map(escapeRe).join("|"), "g");
    return text.replace(pattern, () => replacement);
  };

  for (const [path, source] of scripts) {
    // Give `import.meta.url` a parseable value; every specifier paired with it
    // has already been made absolute, so the base is never actually applied.
    let text = source
      .split("import.meta.url")
      .join(JSON.stringify(placeholderFor(path)));
    for (const asset of urls.keys()) text = substitute(text, asset, urls.get(asset)!);
    for (const dep of scripts.keys()) {
      if (dep !== path) text = substitute(text, dep, placeholderFor(dep));
    }
    urls.set(path, blobUrl(text, path));
  }

  for (const path of scripts.keys()) imports[placeholderFor(path)] = urls.get(path)!;

  return { urls, imports };
}

async function boot(): Promise<void> {
  const nameEl = document.getElementById("dai-app-name");
  if (nameEl) nameEl.textContent = document.title;

  const violations: string[] = [];
  document.addEventListener("securitypolicyviolation", (event) => {
    violations.push(`${event.violatedDirective} blocked ${event.blockedURI}`);
  });

  const node = document.getElementById("dai-payload");
  const b64 = node?.textContent?.trim() ?? "";
  if (!b64) {
    setStatus("Container is sealed but empty — no DAI payload found.");
    return;
  }

  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(decodeBase64(b64));
  } catch (error) {
    setStatus("Payload could not be decoded.", String(error));
    return;
  }

  // Integrity gate. Nothing is blobbed, framed or executed until the payload
  // matches its manifest: verification is worthless if it races the mount.
  // WebCrypto exists only in a secure context. A container opened over plain
  // http, or from a host whose origin is not treated as trustworthy, would
  // otherwise die inside the digest call with an opaque TypeError.
  if (policyRequiresCrypto() && !globalThis.crypto?.subtle) {
    setStatus(
      "This container cannot verify itself here.",
      `WebCrypto is unavailable at ${location.protocol}//${location.host || "(opaque)"}. ` +
        `Containers must be opened from a file, from localhost, or over HTTPS.`,
    );
    return;
  }

  const policy = integrityPolicy();
  const manifestBytes = files[MANIFEST_ENTRY];
  let manifest: Manifest | null = null;

  if (manifestBytes) {
    try {
      manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as Manifest;
    } catch (error) {
      setStatus("Container manifest is unreadable.", String(error));
      return;
    }
  }

  if (policy === "required") {
    // A required policy with no manifest is a stripped seal, not an unsealed
    // container: refuse rather than fall back to trusting the payload.
    if (!manifest) {
      setStatus(
        "Integrity check failed — this container has been modified.",
        `${MANIFEST_ENTRY} is missing, but this container requires it`,
      );
      return;
    }
    if (manifest.algorithm !== "SHA-256") {
      setStatus(`Unsupported manifest algorithm: ${manifest.algorithm}.`);
      return;
    }
    const problems = await verifyPayload(files, manifest);
    if (problems.length > 0) {
      setStatus(
        "Integrity check failed — this container has been modified.",
        problems.slice(0, 4).join("; "),
      );
      return;
    }
  }

  // Authenticity. A container that ships a public key must satisfy it: silently
  // running an unsigned or badly signed payload would make the key decorative.
  const spki = publicKeyFromShell();
  let signatureState: "valid" | "unsigned" = "unsigned";
  if (spki) {
    if (!manifest) {
      setStatus("Signature check failed — this container has no manifest to verify.");
      return;
    }
    const outcome = await verifySignature(manifest, spki);
    if (!outcome.ok) {
      setStatus("Signature check failed — this container is not authentic.", outcome.reason ?? "");
      return;
    }
    signatureState = "valid";
  }

  const assets = new Map<string, Uint8Array>();
  for (const [name, bytes] of Object.entries(files)) {
    if (name.startsWith(APP_PREFIX)) assets.set(name.slice(APP_PREFIX.length), bytes);
  }

  const entry = assets.get("index.html");
  if (!entry) {
    setStatus(`No ${APP_PREFIX}index.html in the payload.`);
    return;
  }

  const { urls, imports } = resolveAssets(assets);

  const html = new TextDecoder().decode(entry);
  // The import map must be in place before any module in the frame is fetched.
  const importMap =
    `<script type="importmap">${JSON.stringify({ imports })}<\/script>`;
  const srcdoc = rewriteHtml(html, urls).replace(
    /<head(\s[^>]*)?>/i,
    (head) => head + importMap + bridgeScript() + handshakeScript(),
  );

  // Expose the decoded archive for the persistence layer (Phase 2 §3).
  (window as unknown as Record<string, unknown>).__DAI__ = {
    version: "0.1.0",
    documentUuid: manifest?.documentUuid ?? null,
    verified: policy === "required",
    signature: signatureState,
    publicKeyFingerprint: manifest?.publicKeyFingerprint ?? null,
    files,
    assets,
    urls,
    sqlite: files[SQLITE_ENTRY] ?? new Uint8Array(0),
    // ArrayBuffer, not a blob URL: see bridgeMain().
    sqliteWasm: files[WASM_ENTRY] ? toArrayBuffer(files[WASM_ENTRY]) : null,
    // The glue is a module the frame imports, so it does need a URL. Its own
    // `import.meta.url` is neutralized first, for the same reason app chunks
    // need it: blob:null/<uuid> cannot be parsed as a base.
    sqliteGlueUrl: files[GLUE_ENTRY]
      ? URL.createObjectURL(
          new Blob(
            [
              new TextDecoder()
                .decode(files[GLUE_ENTRY])
                .split("import.meta.url")
                .join(JSON.stringify(`${SYNTHETIC_ORIGIN}sqlite3.mjs`)),
            ],
            { type: "text/javascript" },
          ),
        )
      : null,
  };

  let ready = false;
  const documentBytes = files[SQLITE_ENTRY] ?? new Uint8Array(0);

  // Host mode is only entered once a host has answered the handshake. Being
  // framed is not evidence of one: the PWA runner and any ordinary embedder
  // also frame containers, and assuming a host there would post a save into
  // silence and hang the application waiting for an acknowledgement.
  let hostAvailable = false;

  window.addEventListener("message", (event) => {
    if (event.data === HANDSHAKE) {
      ready = true;
      document.body.classList.add("dai-mounted");
      return;
    }

    if ((event.data as { type?: string })?.type === "DAI_HOST_HANDSHAKE_ACK") {
      hostAvailable = true;
      return;
    }

    const request = event.data as {
      type?: string;
      id?: string;
      sqlite?: Uint8Array;
      method?: SaveMethod;
    };
    if (request?.type !== SAVE_REQUEST) return;

    const reply = (payload: Record<string, unknown>): void =>
      (event.source as Window | null)?.postMessage({ id: request.id, ...payload }, "*");

    if (hostAvailable && request.method !== "download" && request.method !== "picker") {
      // The host is given a finished document, not a database. Splicing a new
      // payload means re-zipping and resealing the manifest, and a host doing
      // that itself would be a second implementation of resealContainer.
      const databaseBytes = request.sqlite ?? documentBytes;
      resealContainer(files, databaseBytes)
        .then((html) => {
          const onHostAck = (evt: MessageEvent) => {
            const data = evt.data as { type?: string; status?: string; error?: string };
            if (data?.type !== "DAI_HOST_SAVE_ACK") return;
            window.removeEventListener("message", onHostAck);
            window.clearTimeout(hostTimer);
            if (data.status === "ok") {
              reply({ ok: true, result: { saved: true, method: "host" } });
            } else {
              reply({ ok: false, error: data.error || "The host could not save this container." });
            }
          };

          // A host that never answers must not leave the app waiting forever.
          const hostTimer = window.setTimeout(() => {
            window.removeEventListener("message", onHostAck);
            reply({ ok: false, error: "The host did not respond to the save request." });
          }, 15000);

          window.addEventListener("message", onHostAck);
          window.parent.postMessage(
            {
              type: "DAI_HOST_SAVE",
              // Both, because hosts need different things: a native host
              // writes the document verbatim, while a browser host stores the
              // database on its own and would otherwise have to unzip the
              // payload just to reach it.
              payload: {
                html,
                databaseBytes,
                documentUuid: manifest?.documentUuid ?? "",
              },
            },
            "*",
          );
        })
        .catch((error: unknown) => reply({ ok: false, error: String(error) }));
      return;
    }

    writeContainer(files, request.sqlite ?? documentBytes, request.method ?? "auto")
      .then((result) => reply({ ok: true, result }))
      .catch((error: unknown) => reply({ ok: false, error: String(error) }));
  });

  if (window.parent !== window) {
    // What this container verified, for a host that verified the same file
    // independently to compare against. Sent only once the checks above have
    // passed, so it reports a conclusion rather than an intention.
    void (manifest
      ? payloadFingerprint(manifest.documentUuid, manifest.hashes)
      : Promise.resolve(null)
    ).then((fingerprint) => {
      window.parent.postMessage(
        {
          type: "DAI_HOST_HANDSHAKE",
          payload: {
            documentUuid: manifest?.documentUuid ?? null,
            verified: policy === "required",
            payloadFingerprint: fingerprint,
          },
        },
        "*",
      );
    });
  }

  const frame = mount(srcdoc);
  installAppMode(frame);

  window.setTimeout(() => {
    if (ready) return;
    setStatus(
      "The application did not finish mounting.",
      violations.length
        ? `CSP: ${violations.join("; ")}`
        : "No CSP violations were reported.",
    );
    document.body.classList.remove("dai-mounted");
  }, HANDSHAKE_TIMEOUT_MS);
}

const start = (): void => {
  void boot().catch((error: unknown) => {
    setStatus("The container failed to start.", String(error));
  });
};

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", start);
} else {
  start();
}
