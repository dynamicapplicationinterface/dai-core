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

const APP_PREFIX = "app/";
const WASM_ENTRY = "runtime/sqlite3.wasm";
const SQLITE_ENTRY = "document.sqlite";
const CONTAINER_ENTRY = "runtime/container.html";
const GLUE_ENTRY = "runtime/sqlite3.mjs";
const SAVE_REQUEST = "dai:save";

/** How a save should be attempted. */
type SaveMethod = "auto" | "picker" | "download";
/** What a save actually did. `cancelled` means the picker was dismissed. */
interface SaveResult {
  saved: boolean;
  method: "picker" | "download" | "cancelled";
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
async function writeContainer(
  files: Record<string, Uint8Array>,
  sqlite: Uint8Array,
  method: SaveMethod = "auto",
): Promise<SaveResult> {
  const shellBytes = files[CONTAINER_ENTRY];
  if (!shellBytes) {
    throw new Error(
      `This container has no ${CONTAINER_ENTRY}; it was built before ` +
        `self-perpetuating saves and cannot rewrite itself.`,
    );
  }

  const next: Record<string, Uint8Array> = { ...files, [SQLITE_ENTRY]: sqlite };
  const payload = toBase64(zipSync(next, { level: 9 }));
  const shell = new TextDecoder().decode(shellBytes);
  const html = shell.replace(PAYLOAD_TAG_RE, (_match, open: string) => open + payload);

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
        if (method === "picker") return { saved: false, method: "cancelled" };
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

  /** Opens the packaged document, or a fresh database when there is no seed. */
  const openDatabase = (): Promise<Any> =>
    initSqlite().then((api2) => {
      const db = new api2.oo1.DB() as Any;
      if (seed.byteLength === 0) return db;

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

  const api: Any = {
    version: host.version,
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
    exportDatabase: exportDatabase,
    saveDatabase: (db: Any, options?: Any) => saveState(exportDatabase(db), options),
    saveState: saveState,
  };

  (window as unknown as Any).dai = api;
  (window as unknown as Any).daiSaveState = (bytes?: Uint8Array, options?: Any) =>
    saveState(bytes, options);
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
  frame.setAttribute("srcdoc", srcdoc);
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

function boot(): void {
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

  window.addEventListener("message", (event) => {
    if (event.data === HANDSHAKE) {
      ready = true;
      document.body.classList.add("dai-mounted");
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

    writeContainer(files, request.sqlite ?? documentBytes, request.method ?? "auto")
      .then((result) => reply({ ok: true, result }))
      .catch((error: unknown) => reply({ ok: false, error: String(error) }));
  });

  mount(srcdoc);

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

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
