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
import { unzipSync } from "fflate";

const APP_PREFIX = "app/";
const WASM_ENTRY = "runtime/sqlite3.wasm";
const SQLITE_ENTRY = "document.sqlite";
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

/**
 * The bridge the application sees as `window.dai`.
 *
 * The engine is handed over as an ArrayBuffer rather than a URL because
 * `connect-src 'none'` neutralizes fetch, and `WebAssembly.instantiateStreaming`
 * is defined in terms of a fetched Response — it cannot work here at all.
 * `WebAssembly.instantiate(buffer)` compiles from memory and touches no network
 * layer. `'wasm-unsafe-eval'` in the container CSP is what permits it.
 *
 * The frame shares this document's origin (it must, for blob URLs to be
 * reachable), so it can read the buffers straight off the parent instead of
 * being handed a structured clone.
 */
function bridgeScript(): string {
  return (
    `<script>(function(){` +
    `var host=parent.__DAI__||{};` +
    // Re-create the buffers using the frame's own intrinsics. A buffer minted
    // in the parent realm fails `instanceof ArrayBuffer` inside the frame, even
    // though WebAssembly accepts it — apps that type-check would break.
    `var adopt=function(src){if(!src)return null;` +
    `var out=new ArrayBuffer(src.byteLength);` +
    `new Uint8Array(out).set(new Uint8Array(src));return out};` +
    `var wasm=adopt(host.sqliteWasm);` +
    `var doc=host.sqlite?new Uint8Array(adopt(host.sqlite.buffer?` +
    `host.sqlite.slice().buffer:host.sqlite)):new Uint8Array(0);` +
    `window.dai={` +
    `version:host.version,` +
    `sqliteWasm:wasm,` +
    `document:doc,` +
    `hasSqliteEngine:!!wasm,` +
    `instantiateSqlite:function(imports){` +
    `if(!wasm)return Promise.reject(` +
    `new Error("No sqlite3.wasm was packaged in this container."));` +
    `return WebAssembly.instantiate(wasm,imports||{})}` +
    `};})()<\/script>`
  );
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
    // ArrayBuffer, not a blob URL: see bridgeScript().
    sqliteWasm: files[WASM_ENTRY] ? toArrayBuffer(files[WASM_ENTRY]) : null,
  };

  let ready = false;
  window.addEventListener("message", (event) => {
    if (event.data === HANDSHAKE) {
      ready = true;
      document.body.classList.add("dai-mounted");
    }
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
