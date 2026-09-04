/**
 * DAI v0.1 bootloader runtime.
 *
 * Executes the packaged React application from a `file://` document with no
 * network access of any kind:
 *
 *   1. Decode the Base64 payload out of `#dai-payload`.
 *   2. Unzip it in memory (fflate, bundled into this script).
 *   3. Verify every entry against the manifest, before anything executes.
 *   4. Mount a sandboxed frame containing only a loader.
 *   5. Hand the loader the bytes, and let it mint its own URLs and write the
 *      application's document.
 *
 * Step 5 is arranged that way on purpose. A blob URL belongs to whoever minted
 * it, so passing URLs inward would require the frame to share this origin —
 * and a frame that shares this origin can rewrite the bootloader that a save
 * seals into the next copy. Passing bytes instead costs a message and buys a
 * boundary that actually holds.
 *
 * Service Workers are deliberately not used: they are unavailable on `file://`,
 * which is the primary way a container is opened. See §1 of the Phase 2 spec.
 */
import { unzipSync, zipSync } from "fflate";
// Imported rather than reimplemented: the host derives the same value from the
// same helper, and two spellings of "canonical" would disagree eventually.
import { payloadFingerprint, signedBytes, signedViewOf } from "../core.js";
import { verifySign1 } from "../cose.js";
import { compatibility, type SchemaDeclaration } from "../schema.js";

const APP_PREFIX = "app/";
const SCHEMA_ENTRY = "runtime/schema.json";
const WASM_ENTRY = "runtime/sqlite3.wasm";
const SQLITE_ENTRY = "document.sqlite";
const CONTAINER_ENTRY = "runtime/container.html";
const GLUE_ENTRY = "runtime/sqlite3.mjs";
const MANIFEST_ENTRY = "runtime/manifest.json";
const SAVE_REQUEST = "dai:save";

/**
 * The host bridge's schema version, sent in every message a host might read.
 *
 * A cartridge carries the runtime it was compiled with, so a host meets several
 * vintages at once. Without a version it can only report symptoms — as happened
 * when an older cartridge sent a database with no document and the host could
 * say nothing better than "no document to save".
 */
const BRIDGE_VERSION = 1;

/**
 * A value this container makes up, hands to its host, and expects back.
 *
 * Everything the bridge does was previously accepted from whoever posted it.
 * Any window holding a reference to this one could announce itself as a host
 * and be believed — which turns a save into a message sent to a stranger, and
 * lets a page that never verified anything tell the application its work was
 * written to disk.
 *
 * The nonce does not authenticate the host: a hostile embedder can echo it as
 * easily as an honest one. What it establishes is that a message came from the
 * party this container completed a handshake with, rather than from a third
 * window that was listening. That is a smaller claim than it sounds, and it is
 * the one that can actually be made from inside a frame.
 */
const sessionNonce = ((): string => randomHex(16))();

/**
 * Sixteen random bytes as hex, or a thrown error.
 *
 * The first version fell back to sixteen zero bytes when `crypto` was absent,
 * which is a nonce anyone can guess. A context with no random source has no
 * business completing a handshake; refusing is the honest outcome.
 */
function randomHex(length: number): string {
  const source = (globalThis.crypto as Crypto | undefined)?.getRandomValues;
  if (typeof source !== "function") {
    throw new Error("DAI: no random source in this context, so no session nonce can be made.");
  }
  const bytes = new Uint8Array(length);
  source.call(globalThis.crypto, bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Why a cartridge stopped, in a form a host can record without parsing prose.
 *
 * There is deliberately no SHELL_TAMPERED: a cartridge cannot detect its own
 * bootloader being rewritten, because that check would run inside the code an
 * attacker replaced. Only a separate reader holding the sealed copy can find it,
 * and that finding belongs to the host.
 */
type RefusalReason =
  | "NO_PAYLOAD"
  | "PAYLOAD_UNREADABLE"
  | "MANIFEST_UNREADABLE"
  | "MANIFEST_MISSING"
  | "UNSUPPORTED_ALGORITHM"
  | "UNSUPPORTED_CRYPTO"
  | "DIGEST_MISMATCH"
  | "SIGNATURE_UNVERIFIABLE"
  | "UNVERIFIED_SIGNATURE"
  | "NO_APPLICATION"
  | "KEY_EXPIRED"
  | "SCHEMA_INCOMPATIBLE"
  | "MOUNT_TIMEOUT"
  | "BOOT_FAILED";
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
  /**
   * For a save the host handled: whether it wrote the document in place (an
   * editor) or kept a copy on the device (a viewer). An application that says
   * "saved" should say "saved a copy" when this is false.
   */
  inPlace?: boolean;
  /**
   * Why a host refused, when it did, as a name rather than a sentence:
   * `GENERATION_CONFLICT` (another window saved first; the work in hand is
   * still in hand) or `LOCK_UNAVAILABLE` (another program is saving now; try
   * again). Absent when the save succeeded or failed for a reason with no name.
   */
  code?: string;
}
/**
 * Must match PAYLOAD_TAG_RE in the compiler. Anchored to the payload tag
 * because this very script carries the placeholder literal and is inlined above
 * it, so an unanchored match would rewrite the bootloader's own source.
 */
const PAYLOAD_TAG_RE = /(<script[^>]*id="dai-payload"[^>]*>)<!--DAI_PAYLOAD-->/;
/**
 * Where the time goes between a tap and a usable application.
 *
 * The number that decides whether this is a product on a phone is seconds from
 * tap to interactive, and it cannot be improved by argument. The costs are
 * genuinely unobvious — an 850 kB WebAssembly instantiate looks like the
 * expensive part and may well not be, next to decoding base64, inflating a zip
 * and digesting every entry before anything is allowed to run.
 *
 * So the boot records where it actually spent its time, and hands the table to
 * whoever is hosting it. Marks are cheap, they ship in every container, and a
 * number nobody can see is a number nobody improves.
 */
const timings: { phase: string; at: number; took?: number }[] = [];

/**
 * Records a phase once.
 *
 * Once, because the signal for several of these arrives more than once — the
 * application announcing itself is answered by anything still listening — and a
 * phase recorded three times reads as three phases with implausible durations.
 * The first occurrence is the one that happened.
 */
function mark(phase: string, took?: number): void {
  if (timings.some((entry) => entry.phase === phase)) return;
  timings.push({ phase, at: Math.round(performance.now() * 10) / 10, took });
}

/** The table as elapsed milliseconds per phase, in the order they happened. */
function timingTable(): { phase: string; at: number; took: number }[] {
  return timings.map((entry, index) => ({
    phase: entry.phase,
    at: entry.at,
    // A phase measured somewhere else reports its own duration; everything else
    // is the gap since the phase before it.
    took:
      entry.took ??
      Math.round((entry.at - (index > 0 ? timings[index - 1]!.at : 0)) * 10) / 10,
  }));
}

const HANDSHAKE = "dai:ready";
/** How long the iframe has to report back before we surface a diagnostic. */
const HANDSHAKE_TIMEOUT_MS = 5000;
/**
 * Base for the placeholder URLs that stand in for packaged modules. Never
 * fetched: an import map in the iframe redirects every one of them to a blob.
 */
const SYNTHETIC_ORIGIN = "file:///dai/app/";

/**
 * The nonce the compiler stamped on this script, read back so everything the
 * runtime writes can carry it.
 *
 * The content attribute is hidden from `getAttribute` by every current engine,
 * to stop a script exfiltrating it through the DOM; the IDL property is the
 * supported way to read your own. Falling back to the policy text keeps a
 * container built by an older compiler working, where there is no nonce and the
 * policy still allows inline script.
 */
function shellNonce(): string {
  const tag = document.getElementById("dai-bootloader") as HTMLScriptElement | null;
  if (tag?.nonce) return tag.nonce;

  const meta = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
  const found = /'nonce-([^']+)'/.exec(meta?.getAttribute("content") ?? "");
  return found?.[1] ?? "";
}

/** Attribute text for a script the runtime emits, empty when unnonced. */
function nonceAttr(): string {
  const value = shellNonce();
  return value ? ` nonce="${value}"` : "";
}

/**
 * Stops, says why on screen, and tells the host.
 *
 * The screen alone is not enough. A cartridge that refuses inside a frame shows
 * its reason to whoever is looking at that frame and to nobody else, so a host
 * sees only silence — indistinguishable from a cartridge that never started.
 * Refusals are the entries an audit trail most needs, which makes silence the
 * worst available outcome.
 *
 * Sent unconditionally when framed, without waiting for a handshake: a refusal
 * happens before any handshake, and a parent that is not a host simply ignores
 * an unfamiliar message.
 */
function refuse(reason: RefusalReason, message: string, detail = ""): void {
  // A refusal is an answer. Letting the stall notice arrive twenty seconds
  // later would replace it with a guess.
  clearBootWatch?.();
  setStatus(message, detail);

  if (window.parent === window) return;
  try {
    window.parent.postMessage(
      {
        type: "DAI_HOST_REFUSED",
        payload: {
          bridgeVersion: BRIDGE_VERSION,
          sessionNonce,
          reason,
          message,
          detail,
          // Absent for failures that occur before the manifest is readable.
          documentUuid: refusalUuid,
        },
      },
      "*",
    );
  } catch {
    // A parent that cannot be posted to is not a reason to fail differently.
  }
}

/** Set once the manifest is parsed, so a later refusal can name the document. */
let refusalUuid: string | null = null;

/** Cancels the stall notice. Set when the boot starts watching. */
let clearBootWatch: (() => void) | null = null;

function setStatus(message: string, detail = ""): void {
  const status = document.getElementById("dai-boot-status");
  const detailEl = document.getElementById("dai-boot-detail");
  if (status) status.textContent = message;
  if (detailEl) detailEl.textContent = detail;
}

/**
 * Names the stage that is running, so a boot that stops somewhere says where.
 *
 * The shell used to show one line for the whole of startup, which meant a
 * container that hung was indistinguishable from a container that had not
 * started — including in a screenshot from somebody a long way away, which is
 * the only diagnostic a format like this usually gets.
 */
function stage(message: string): void {
  const status = document.getElementById("dai-boot-status");
  if (status) status.textContent = message;
}

/**
 * Says what to try when startup has plainly stalled.
 *
 * Not a refusal: the boot is still running and may yet finish on a slow device,
 * so nothing is stopped and nothing is claimed to have failed. What changes is
 * that the screen stops implying progress it cannot demonstrate.
 *
 * The runner is named rather than linked. A container that carried a link out
 * would be a self-contained file pointing at a service, and clicking it would
 * tell that service the file had been opened.
 */
function watchBoot(): () => void {
  const timer = setTimeout(() => {
    const detail = document.getElementById("dai-boot-detail");
    if (detail) {
      detail.textContent =
        "Still starting. Some viewers on phones and tablets will display this file " +
        "but not run it. If nothing happens, open it with the DAI runner instead.";
    }
  }, 20000);

  clearBootWatch = () => clearTimeout(timer);
  return clearBootWatch;
}

function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
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
  /*
   * Descriptive fields, listed because the signature covers them.
   *
   * They were absent while only the identity and the digests were signed, and
   * the runtime had no reason to read them. Now that the signed view includes
   * them, a verifier that did not know they existed would rebuild the wrong
   * bytes and reject every signed container.
   */
  appName: string;
  favicon?: string;
  createdAt: string;
  integrityPolicy: string;
  algorithm: string;
  hashes: Record<string, string>;
  signatureAlgorithm?: string;
  publicKeyFingerprint?: string;
  signedEntries?: Record<string, string>;
  signature?: string;
  /** Unix seconds after which this container must not run. Optional. */
  validUntil?: number;
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
  if (manifest.signatureAlgorithm === "ECDSA-P256-SHA256" || manifest.manifestVersion < 2) {
    // Built before the signature became a COSE envelope. Naming the constant
    // would be accurate and useless to whoever is holding the file.
    return {
      ok: false,
      reason:
        "built before the signature format changed, so its signature cannot be " +
        "checked here — rebuild it and it will open",
    };
  }
  if (manifest.signatureAlgorithm !== "COSE-ES256") {
    return { ok: false, reason: `unsupported signature algorithm ${manifest.signatureAlgorithm}` };
  }

  for (const [name, digest] of Object.entries(manifest.signedEntries)) {
    if (manifest.hashes[name] !== digest) {
      return { ok: false, reason: `${name} is signed with a different digest` };
    }
  }
  // The other direction. `hashes` is unsigned, so an entry added to it and
  // to the archive with a matching digest would otherwise pass — including
  // runtime/schema.json, whose SQL this bootloader runs. Everything digested
  // except the database must be in the signed set.
  for (const name of Object.keys(manifest.hashes)) {
    if (name !== SQLITE_ENTRY && !(name in manifest.signedEntries)) {
      return { ok: false, reason: `${name} is not covered by the signature` };
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

  // The payload is rebuilt from the manifest rather than read out of the
  // envelope, which carries none: the signature is detached, so there is only
  // one copy of what was signed and no second one to disagree with it.
  const ok = await verifySign1(
    fromBase64(manifest.signature),
    signedBytes(signedViewOf(manifest)),
    (signature, bytes) =>
      crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        key,
        signature as unknown as BufferSource,
        bytes as unknown as BufferSource,
      ),
  ).catch(() => false);

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
 * (and are renamed by the minifier).
 *
 * It reads its own window rather than the parent's. Reaching across the frame
 * boundary for data is what forced `allow-same-origin`, and under that flag the
 * application shared an origin with the shell meant to contain it — free to
 * read the public key out of the DOM and to rewrite the bootloader that a save
 * would seal into the next copy. The loader hands this object over by
 * `postMessage` and sets it locally instead.
 */
function bridgeMain(): void {
  type Any = Record<string, any>;
  const host: Any = ((window as unknown as Any).__DAI__ as Any) || {};

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
      // Stamped, because this is an inline script created at runtime and the
      // policy no longer allows unnonced inline script. A nonce set through the
      // property is honoured; the attribute is hidden from the DOM by design.
      if (host.nonce) script.nonce = String(host.nonce);
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
    // Timed and reported to the shell, which is the only side keeping the
    // table. The engine starts when the application first asks for the
    // database, which for most applications is after they are on screen — so
    // this is usually not on the path to interactive, and the measurement is
    // how anybody would know that rather than assume it.
    const engineStarted = performance.now();
    const reportEngine = (): void => {
      try {
        window.parent.postMessage(
          {
            type: "dai:timing",
            phase: "engine",
            took: Math.round((performance.now() - engineStarted) * 10) / 10,
          },
          "*",
        );
      } catch {
        /* A parent that is not listening changes nothing about the boot. */
      }
    };
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
        reportEngine();
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
  /**
   * The schema this container declares, if it declares one.
   *
   * An ordinary sealed entry, so it is covered by the manifest digests and by
   * the publisher's signature — a container's account of the shape of its own
   * data cannot be edited any more than its code can.
   */
  /*
   * Whether this container declares a schema at all.
   *
   * The declaration itself stays in the shell, which is where the decision is
   * made. All the frame needs to know is whether to ask.
   */
  const declaresSchema = Boolean(host.schema);

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

  /**
   * Reconciles the data with the code about to run over it.
   *
   * SQLite will open a database whose tables do not match the application: it
   * creates what is missing, ignores what it does not recognise, and reports
   * nothing. Everything the container can check has already passed at this
   * point — the digests match and the signature is valid — because the mismatch
   * is between the code and the data, which is a level no checksum reaches.
   *
   * The decision is not made here. This function is serialized into the frame
   * and has no access to this module, so it reads the stamp, asks the shell
   * what that means, and applies the answer. Inlining a second copy of the rule
   * would be two rules, and the day they disagreed would be a day somebody's
   * data disappeared quietly.
   */
  const reconcileSchema = (db: Any): Promise<void> => {
    db.exec("CREATE TABLE IF NOT EXISTS _dai_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");

    const rows: Any[] = [];
    db.exec({
      sql: "SELECT value FROM _dai_meta WHERE key = 'schema'",
      rowMode: "array",
      resultRows: rows,
    });
    const first = rows[0] as string[] | undefined;
    const actual = first ? first[0] : undefined;

    const id = "schema-" + Math.random().toString(36).slice(2);

    return new Promise<void>((resolve, reject) => {
      const onReply = (event: MessageEvent): void => {
        const data = event.data as Any;
        if (!data || data.type !== "dai:schema-verdict" || data.id !== id) return;
        window.removeEventListener("message", onReply);
        window.clearTimeout(timer);

        if (data.status === "incompatible") {
          reject(new Error(String(data.reason)));
          return;
        }
        if (data.status === "current") {
          resolve();
          return;
        }

        // One transaction for the whole path. A chain that stopped half way
        // would leave the data in a shape no version of the application
        // understands, which is worse than either end of it.
        try {
          db.exec("BEGIN");
          for (const sql of (data.run as string[]) || []) db.exec(sql);
          db.exec({
            sql:
              "INSERT INTO _dai_meta (key, value) VALUES ('schema', ?) " +
              "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            bind: [String(data.digest)],
          });
          db.exec("COMMIT");
          resolve();
        } catch (error) {
          db.exec("ROLLBACK");
          reject(error as Error);
        }
      };

      const timer = window.setTimeout(() => {
        window.removeEventListener("message", onReply);
        // Refusing on silence rather than opening: an unanswered question about
        // whether this data is safe to write to is not a yes.
        reject(new Error("The container did not answer whether this data can be opened."));
      }, 10000);

      window.addEventListener("message", onReply);
      window.parent.postMessage({ type: "dai:schema", id: id, actual: actual ?? null }, "*");
    });
  };

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
    /*
     * Reconciled before the application is given the handle. An application
     * that cannot open the database cannot write over data it does not
     * understand, which is the only protection available at this point: every
     * check the container can make has already passed, because the mismatch is
     * between the code and the data.
     */
    openDatabase: (options?: { pageSize?: number }): Promise<Any> =>
      openDatabase(options).then((db: Any) => {
        if (!declaresSchema) return db;
        // Closed before the error propagates: an application asking for a
        // handle to data it cannot account for does not get one, which is the
        // only protection left at this point.
        return reconcileSchema(db).then(
          () => db,
          (error: Error) => {
            db.close();
            throw error;
          },
        );
      }),
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

/**
 * Runs inside the frame, before the application exists.
 *
 * A blob URL belongs to the origin that minted it, so one created by the shell
 * is unreachable from a frame that does not share that origin — which is
 * precisely why the frame used to be granted one. Minting them here is what
 * lets the sandbox drop `allow-same-origin`, and it means the asset resolution
 * has to live in the frame as well.
 *
 * Serialized with `Function.prototype.toString()`, so like `bridgeMain` this
 * must be entirely self-contained.
 *
 * The sequence matters: the frame announces itself, the shell replies with the
 * bytes, and only then is the document written. An import map has to be in
 * place before any module in the document is fetched, and it cannot be written
 * until the URLs it names exist.
 */
function frameLoader(): void {
  type Any = Record<string, any>;

  /*
   * Web storage, replaced with an in-memory stand-in.
   *
   * At an opaque origin `window.localStorage` does not return null — it throws
   * a SecurityError, and sqlite3ApiBootstrap reads it while looking for
   * configuration. Without this the engine cannot start at all, which is the
   * one thing the isolation work must not cost.
   *
   * Substituting rather than merely surviving is deliberate. A container's data
   * belongs in the file: anything written to browser storage stays on the
   * machine that wrote it, so a document sent to somebody else would arrive
   * empty. An in-memory store gives the same semantics the format already
   * promises — writes succeed, nothing persists, nothing leaks into the
   * browser's own storage for this origin. The compiler warns about
   * localStorage separately, so an author is told rather than left guessing.
   */
  const memoryStorage = (): Any => {
    const entries = new Map<string, string>();
    return {
      get length() {
        return entries.size;
      },
      clear: () => entries.clear(),
      getItem: (key: string) => (entries.has(String(key)) ? entries.get(String(key)) : null),
      key: (index: number) => [...entries.keys()][index] ?? null,
      removeItem: (key: string) => {
        entries.delete(String(key));
      },
      setItem: (key: string, value: string) => {
        entries.set(String(key), String(value));
      },
    };
  };

  for (const name of ["localStorage", "sessionStorage"]) {
    try {
      Object.defineProperty(window, name, { value: memoryStorage(), configurable: true });
    } catch {
      // An engine that refuses the shadow will throw from the getter instead,
      // which the caller sees as the absence of storage.
    }
  }

  const mimeFor = (path: string): string => {
    const table: Record<string, string> = {
      html: "text/html",
      js: "text/javascript",
      mjs: "text/javascript",
      css: "text/css",
      json: "application/json",
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
      wasm: "application/wasm",
      map: "application/json",
      txt: "text/plain",
    };
    return table[path.slice(path.lastIndexOf(".") + 1).toLowerCase()] || "application/octet-stream";
  };

  const normalizePath = (path: string): string => {
    const out: string[] = [];
    for (const part of path.split("/")) {
      if (part === "" || part === ".") continue;
      if (part === "..") out.pop();
      else out.push(part);
    }
    return out.join("/");
  };

  /*
   * The payload is accepted from the shell, once, and never again.
   *
   * Both halves matter. `postMessage` is reachable across origins by anyone
   * holding a `WindowProxy`, and a page that frames a container can reach the
   * application's frame through `contentWindow.frames[0]` — so without the
   * source check any embedder could hand this loader a document of its own to
   * write. The nonce would not stop it: it is derived from the document's UUID,
   * which is public, and the message carries its own.
   *
   * And without the second check the listener stays live for the lifetime of a
   * running application, so the same message would rewrite a document that had
   * been on screen for an hour.
   */
  const onPayload = (event: MessageEvent): void => {
    const data = event.data as Any;
    if (!data || data.type !== "dai:payload") return;
    if (event.source !== parent) return;

    window.removeEventListener("message", onPayload);

    const decoder = new TextDecoder();
    const urls = new Map<string, string>();
    const scripts = new Map<string, string>();
    const imports: Record<string, string> = {};

    const placeholderFor = (path: string): string => String(data.syntheticOrigin) + path;
    const blobUrl = (body: BlobPart, path: string): string =>
      URL.createObjectURL(new Blob([body], { type: mimeFor(path) }));

    for (const [path, buffer] of data.assets as [string, ArrayBuffer][]) {
      if (/\.m?js$/.test(path)) scripts.set(path, decoder.decode(new Uint8Array(buffer)));
      else urls.set(path, blobUrl(new Uint8Array(buffer), path));
    }

    /*
     * Only module specifiers are rewritten. Nothing else in a script is.
     *
     * The first version replaced every spelling of every asset name across
     * the whole source text of every script — strings, comments, regexes —
     * so an application that mentioned its own file name in a string literal
     * ran with a blob URL where the literal had been. The bytes that executed
     * were not the bytes that were signed. A review caught it.
     *
     * A specifier is the quoted string in one of four positions: after
     * `from`, in a bare `import "x"`, inside `import("x")`, and as the first
     * argument of `new URL("x", import.meta.url)`. Those are the only places
     * a reference to a sibling can live and still be a reference; anywhere
     * else it is the application's own text and is left alone.
     */
    const dirOf = (path: string): string => path.slice(0, path.lastIndexOf("/") + 1);
    const baseOf = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

    /** The archive entry a specifier written in `fromPath` refers to, if any. */
    const resolveSpecifier = (spec: string, fromPath: string): string | null => {
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(spec)) return null;
      const stripped = spec.replace(/^\.\//, "");
      const joined = normalizePath(dirOf(fromPath) + stripped);
      const candidates = [spec, stripped, joined];
      for (const candidate of candidates) {
        if (scripts.has(candidate) || urls.has(candidate)) return candidate;
      }
      // Vite writes siblings by basename. Unique by basename, or nothing.
      const base = baseOf(stripped);
      const byBase = [...scripts.keys(), ...urls.keys()].filter((entry) => baseOf(entry) === base);
      return byBase.length === 1 ? (byBase[0] as string) : null;
    };

    const SPECIFIER = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|new\s+URL\s*\(\s*)(["'])([^"'\n]+)\2/g;

    const rewriteSpecifiers = (text: string, fromPath: string): string =>
      text.replace(SPECIFIER, (whole: string, lead: string, quote: string, spec: string) => {
        const entry = resolveSpecifier(spec, fromPath);
        if (!entry) return whole;
        const target = scripts.has(entry) ? placeholderFor(entry) : (urls.get(entry) as string);
        return lead + quote + target + quote;
      });

    for (const [path, source] of scripts) {
      const text = rewriteSpecifiers(
        source.split("import.meta.url").join(JSON.stringify(placeholderFor(path))),
        path,
      );
      urls.set(path, blobUrl(text, path));
    }
    for (const path of scripts.keys()) imports[placeholderFor(path)] = urls.get(path) as string;

    const rewritten = String(data.entryHtml).replace(
      /(\s(?:src|href))="([^"]+)"/g,
      (whole: string, attr: string, value: string) => {
        if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(value)) return whole;
        const url = urls.get(normalizePath(value));
        return url ? attr + '="' + url + '"' : whole;
      },
    );

    // Read before anything below uses it: the object handed to the bridge
    // carries it too, so the glue's dynamically created script can be stamped.
    const nonce = String(data.nonce || "");

    // Set before the document is written. `document.open()` clears the document
    // and keeps the global, so the bridge finds this already waiting.
    (window as unknown as Any).__DAI__ = {
      version: data.facts.version,
      documentUuid: data.facts.documentUuid,
      verified: data.facts.verified,
      signature: data.facts.signature,
      publicKeyFingerprint: data.facts.publicKeyFingerprint,
      nonce: nonce,
      sqlite: new Uint8Array(data.sqlite as ArrayBuffer),
      sqliteWasm: (data.wasm as ArrayBuffer) || null,
      sqliteGlueUrl: data.glueSource
        ? URL.createObjectURL(new Blob([String(data.glueSource)], { type: "text/javascript" }))
        : null,
      // The declared schema travels with the data it describes. Without it the
      // frame has the database and no account of what wrote it, and opens
      // whatever it is handed — which is the failure this exists to prevent.
      schema: (data.schema as string | null) ?? null,
    };

    /*
     * The application's own inline scripts are stamped with the same nonce.
     *
     * The frame inherits the shell's policy, which no longer allows inline
     * script, so without this every sealed application carrying a `<script>`
     * block would stop running. Stamping only what arrived in the payload is
     * the whole point: author code was present when the container was sealed
     * and is covered by its digest, while anything introduced afterwards —
     * a task title rendered into the DOM, a row read back out of the database
     * — has no nonce and does not execute.
     */
    const stamp = nonce ? ' nonce="' + nonce + '"' : "";
    const stamped = nonce
      ? rewritten.replace(/<script(?![^>]*\snonce=)([^>]*)>/gi, (whole: string, attrs: string) =>
          /\ssrc\s*=/i.test(attrs) ? whole : "<script" + attrs + stamp + ">",
        )
      : rewritten;

    const head =
      "<" + "script" + stamp + ' type="importmap">' + JSON.stringify({ imports }) +
      "<" + "/script>" +
      String(data.bridgeSource) +
      String(data.handshakeSource);

    const html = /<head(\s[^>]*)?>/i.test(stamped)
      ? stamped.replace(/<head(\s[^>]*)?>/i, (tag: string) => tag + head)
      : "<head>" + head + "</head>" + stamped;

    document.open();
    document.write(html);
    document.close();
  };

  window.addEventListener("message", onPayload);
  parent.postMessage({ type: "dai:frame-hello" }, "*");
}

/** Serializes frameLoader() into the frame's initial document. */
function loaderScript(): string {
  return "<script" + nonceAttr() + ">(" + frameLoader.toString() + ")()<" + "/script>";
}

/** Serializes bridgeMain() into the frame. See the note on that function. */
function bridgeScript(): string {
  return "<script" + nonceAttr() + ">(" + bridgeMain.toString() + ")()<" + "/script>";
}

/** Injected into the iframe so the host can tell mounting actually succeeded. */
function handshakeScript(): string {
  return (
    `<script${nonceAttr()}>(function(){` +
    `var ok=function(){try{parent.postMessage(${JSON.stringify(HANDSHAKE)},"*")}catch(e){}};` +
    `window.addEventListener("error",function(e){try{parent.postMessage(` +
    `{type:"dai:error",message:String(e.message)},"*")}catch(_){}}, true);` +
    // Several signals, because this document is written rather than navigated
    // to. Firefox does not fire "load" for a document produced by
    // document.write, so waiting only on that left the shell reporting
    // "mounting" forever over an application that had already started. Posting
    // more than once is harmless: the shell latches the first.
    `if(document.readyState!=="loading")ok();else{` +
    `window.addEventListener("DOMContentLoaded",ok);window.addEventListener("load",ok);}` +
    `setTimeout(ok,0);` +
    `})()<\/script>`
  );
}

function mount(srcdoc: string): HTMLIFrameElement {
  const frame = document.createElement("iframe");
  frame.id = "dai-app";
  /*
   * Scripts and forms, and nothing else.
   *
   * `allow-same-origin` used to be here because blob URLs minted by this
   * document only resolve in a frame that shares its origin. The frame mints
   * its own now, so the flag can go — and with it the application's ability to
   * read this document, replace the public key it carries, or rewrite the
   * bootloader that a save seals into the next copy.
   *
   * `allow-popups` goes too. `window.open` carries a URL and a URL carries
   * data, and no CSP directive governs it — `connect-src 'none'` does not close
   * that door. `allow-downloads` and `allow-modals` are capabilities an
   * application should have to be granted rather than be given by default.
   */
  frame.setAttribute("sandbox", "allow-scripts allow-forms");
  // Deny fullscreen to the frame. A same-origin frame inherits the permission
  // by default, which would let the application seize the whole viewport on any
  // gesture it happens to receive. App Mode is the shell's to grant.
  frame.setAttribute("allow", "fullscreen 'none'");
  // Direct property assignment prevents HTML attribute string escaping issues with unescaped double quotes inside app payloads
  mark("frame");
  frame.srcdoc = srcdoc;
  document.body.appendChild(frame);
  return frame;
}

async function boot(): Promise<void> {
  const nameEl = document.getElementById("dai-app-name");
  if (nameEl) nameEl.textContent = document.title;

  // Reaching this line is itself information: the bootloader ran. A viewer that
  // renders the document without executing it never gets here, and the noscript
  // block in the shell is what speaks in that case.
  mark("boot");
  stage("Reading the payload…");
  const stopWatching = watchBoot();

  const violations: string[] = [];
  document.addEventListener("securitypolicyviolation", (event) => {
    violations.push(`${event.violatedDirective} blocked ${event.blockedURI}`);
  });

  const node = document.getElementById("dai-payload");
  const b64 = node?.textContent?.trim() ?? "";
  if (!b64) {
    refuse("NO_PAYLOAD", "Container is sealed but empty — no DAI payload found.");
    return;
  }

  let files: Record<string, Uint8Array>;
  try {
    const decoded = decodeBase64(b64);
    mark("decoded");
    files = unzipSync(decoded);
    mark("unzipped");
  } catch (error) {
    refuse("PAYLOAD_UNREADABLE", "Payload could not be decoded.", String(error));
    return;
  }

  // Integrity gate. Nothing is blobbed, framed or executed until the payload
  // matches its manifest: verification is worthless if it races the mount.
  // WebCrypto exists only in a secure context. A container opened over plain
  // http, or from a host whose origin is not treated as trustworthy, would
  // otherwise die inside the digest call with an opaque TypeError.
  if (policyRequiresCrypto() && !globalThis.crypto?.subtle) {
    refuse("UNSUPPORTED_CRYPTO", 
      "This container cannot verify itself here.",
      `WebCrypto is unavailable at ${location.protocol}//${location.host || "(opaque)"}. ` +
        `Containers must be opened from a file, from localhost, or over HTTPS.`,
    );
    return;
  }

  stage("Checking the seal…");

  const policy = integrityPolicy();
  const manifestBytes = files[MANIFEST_ENTRY];
  let manifest: Manifest | null = null;

  if (manifestBytes) {
    try {
      manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as Manifest;
    } catch (error) {
      refuse("MANIFEST_UNREADABLE", "Container manifest is unreadable.", String(error));
      return;
    }
  }

  // From here on a refusal can name the document it refused.
  refusalUuid = manifest?.documentUuid ?? null;

  if (policy === "required") {
    // A required policy with no manifest is a stripped seal, not an unsealed
    // container: refuse rather than fall back to trusting the payload.
    if (!manifest) {
      refuse("MANIFEST_MISSING", 
        "Integrity check failed — this container has been modified.",
        `${MANIFEST_ENTRY} is missing, but this container requires it`,
      );
      return;
    }
    if (manifest.algorithm !== "SHA-256") {
      refuse("UNSUPPORTED_ALGORITHM", `Unsupported manifest algorithm: ${manifest.algorithm}.`);
      return;
    }
    const problems = await verifyPayload(files, manifest);
    mark("digests");
    if (problems.length > 0) {
      refuse("DIGEST_MISMATCH", 
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
      refuse("SIGNATURE_UNVERIFIABLE", "Signature check failed — this container has no manifest to verify.");
      return;
    }
    const outcome = await verifySignature(manifest, spki);
    if (!outcome.ok) {
      refuse("UNVERIFIED_SIGNATURE", "Signature check failed — this container is not authentic.", outcome.reason ?? "");
      return;
    }
    signatureState = "valid";
    mark("signature");
  }

  const assets = new Map<string, Uint8Array>();
  for (const [name, bytes] of Object.entries(files)) {
    if (name.startsWith(APP_PREFIX)) assets.set(name.slice(APP_PREFIX.length), bytes);
  }

  const entry = assets.get("index.html");
  if (!entry) {
    refuse("NO_APPLICATION", `No ${APP_PREFIX}index.html in the payload.`);
    return;
  }

  /*
   * What the frame is sent, once it says it is listening.
   *
   * Bytes rather than URLs, because a blob URL minted here is meaningless at
   * the frame's own origin. Every buffer is a copy and is transferred, so the
   * archive this document keeps for resealing is untouched and nothing is
   * copied twice on the way across.
   */
  const framePayload = {
    type: "dai:payload",
    entryHtml: new TextDecoder().decode(entry),
    assets: [...assets]
      .filter(([name]) => name !== "index.html")
      .map(([name, bytes]) => [name, toArrayBuffer(bytes)] as [string, ArrayBuffer]),
    // The glue's own `import.meta.url` is neutralized before it travels, for
    // the same reason application chunks need it: blob:null/<uuid> cannot be
    // parsed as a base URL.
    glueSource: files[GLUE_ENTRY]
      ? new TextDecoder()
          .decode(files[GLUE_ENTRY])
          .split("import.meta.url")
          .join(JSON.stringify(`${SYNTHETIC_ORIGIN}sqlite3.mjs`))
      : null,
    wasm: files[WASM_ENTRY] ? toArrayBuffer(files[WASM_ENTRY]) : null,
    sqlite: toArrayBuffer(files[SQLITE_ENTRY] ?? new Uint8Array(0)),
    // Carried across as text: the frame decides whether the data it is about
    // to be handed matches the code that is about to run over it.
    schema: files[SCHEMA_ENTRY] ? new TextDecoder().decode(files[SCHEMA_ENTRY]) : null,
    syntheticOrigin: SYNTHETIC_ORIGIN,
    // So the loader can stamp the import map and the application's own inline
    // scripts; the frame inherits this document's policy.
    nonce: shellNonce(),
    bridgeSource: bridgeScript(),
    handshakeSource: handshakeScript(),
    facts: {
      version: "0.1.0",
      documentUuid: manifest?.documentUuid ?? null,
      verified: policy === "required",
      signature: signatureState,
      publicKeyFingerprint: manifest?.publicKeyFingerprint ?? null,
    },
  };

  const transfer: ArrayBuffer[] = [
    ...framePayload.assets.map(([, buffer]) => buffer),
    framePayload.sqlite,
    ...(framePayload.wasm ? [framePayload.wasm] : []),
  ];

  // Kept for the persistence layer and for a host cross-checking what mounted.
  // The frame no longer reads it — it cannot — so it holds no blob URLs.
  (window as unknown as Record<string, unknown>).__DAI__ = {
    version: "0.1.0",
    documentUuid: manifest?.documentUuid ?? null,
    verified: policy === "required",
    signature: signatureState,
    publicKeyFingerprint: manifest?.publicKeyFingerprint ?? null,
    files,
    assets,
    sqlite: files[SQLITE_ENTRY] ?? new Uint8Array(0),
    /** Where the boot spent its time, for whoever is measuring. */
    get timings() {
      return timingTable();
    },
  };

  let ready = false;
  const documentBytes = files[SQLITE_ENTRY] ?? new Uint8Array(0);

  // Host mode is only entered once a host has answered the handshake. Being
  // framed is not evidence of one: the PWA runner and any ordinary embedder
  // also frame containers, and assuming a host there would post a save into
  // silence and hang the application waiting for an acknowledgement.
  let hostAvailable = false;
  /**
   * What kind of host answered: a viewer keeps a copy on the device and can
   * export; an editor writes the file in place. The application is told
   * which, on every save, so it can say "saved" or "saved a copy" honestly.
   */
  let hostClass: "viewer" | "editor" | null = null;

  /*
   * The frame asking whether the data it just opened may be written to.
   *
   * The decision lives here because `src/schema.ts` lives here: the frame is
   * serialized into its own document and cannot reach this module, and a second
   * copy of the rule would be a second rule. The frame reads the stamp and
   * executes the SQL; nothing else about the decision is its business.
   */
  const declaredSchema = ((): SchemaDeclaration | null => {
    const entry = files[SCHEMA_ENTRY];
    if (!entry) return null;
    try {
      return JSON.parse(new TextDecoder().decode(entry)) as SchemaDeclaration;
    } catch {
      return null;
    }
  })();

  window.addEventListener("message", (event) => {
    const reported = event.data as { type?: string; phase?: string; took?: number };
    if (reported?.type === "dai:timing" && event.source === frame.contentWindow) {
      // Measured inside the frame, which is the only side that can time it.
      mark(String(reported.phase), Number(reported.took));
      return;
    }

    const asked = event.data as { type?: string; id?: string; actual?: string | null };
    if (asked?.type === "dai:schema" && declaredSchema) {
      const verdict = compatibility({
        expected: declaredSchema.digest,
        actual: asked.actual ?? undefined,
        migrations: declaredSchema.migrations,
      });

      (event.source as Window | null)?.postMessage(
        {
          type: "dai:schema-verdict",
          id: asked.id,
          status: verdict.status === "migrate" ? "migrate" : verdict.status,
          digest: declaredSchema.digest,
          run: verdict.status === "migrate" ? verdict.run.map((step) => step.sql) : [],
          reason: verdict.status === "incompatible" ? verdict.reason : "",
        },
        "*",
      );

      if (verdict.status === "incompatible") {
        // Recorded where a host can see it. A refusal the application swallows
        // is a refusal nobody outside the frame ever hears about.
        refuse(
          "SCHEMA_INCOMPATIBLE",
          "This document's data does not match this version of the application.",
          verdict.reason,
        );
      }
      return;
    }

    if (event.data === HANDSHAKE) {
      // The application is on screen. This is the only mark that corresponds to
      // anything a person would call ready.
      mark("interactive");

      /*
       * Sent again, because the handshake went out before this happened.
       *
       * The handshake is posted as soon as the container has verified itself,
       * which is well before the application has painted — so the table it
       * carried could not contain the one number the whole thing is judged on.
       * A host that only read the handshake would have been reading a boot that
       * had not finished.
       */
      if (window.parent !== window) {
        try {
          window.parent.postMessage(
            {
              type: "DAI_HOST_TIMING",
              sessionNonce,
              payload: { bridgeVersion: BRIDGE_VERSION, timings: timingTable() },
            },
            "*",
          );
        } catch {
          /* A parent that is not listening changes nothing about the boot. */
        }
      }
      ready = true;
      // The application is on screen, so the boot line is no longer the truth
      // about anything and the stall notice must not appear behind it.
      stopWatching();
      document.body.classList.add("dai-mounted");
      return;
    }

    if ((event.data as { type?: string })?.type === "DAI_HOST_HANDSHAKE_ACK") {
      // From the window this container is embedded in, carrying the value this
      // container invented. Neither check proves the sender is honest; together
      // they establish that it is the same party the handshake was sent to,
      // which is all that was ever missing here.
      const ack = event.data as { payload?: { sessionNonce?: string; hostClass?: string } };
      if (event.source !== window.parent) return;
      if (ack.payload?.sessionNonce !== sessionNonce) return;
      hostAvailable = true;
      // A host that does not say is taken for a viewer: claiming an in-place
      // save that did not happen is the failure this exists to prevent.
      hostClass = ack.payload?.hostClass === "editor" ? "editor" : "viewer";
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
          // Bound to this request, and to the window that was asked. A reply
          // from anywhere else, or for any other request — a duplicate, a
          // stale one, a forged one from a third window — is not this reply.
          const requestId = randomHex(16);
          const onHostAck = (evt: MessageEvent) => {
            if (evt.source !== window.parent) return;
            const data = evt.data as {
              type?: string;
              status?: string;
              error?: string;
              code?: string;
              requestId?: string;
            };
            if (data?.type !== "DAI_HOST_SAVE_ACK") return;
            if (data.requestId !== requestId) return;
            window.removeEventListener("message", onHostAck);
            window.clearTimeout(hostTimer);
            if (data.status === "ok") {
              reply({
                ok: true,
                result: { saved: true, method: "host", inPlace: hostClass === "editor" },
              });
            } else {
              reply({
                ok: false,
                error: data.error || "The host could not save this container.",
                code: data.code,
              });
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
              sessionNonce,
              requestId,
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
            bridgeVersion: BRIDGE_VERSION,
            sessionNonce,
            documentUuid: manifest?.documentUuid ?? null,
            verified: policy === "required",
            payloadFingerprint: fingerprint,
            // Handed over rather than kept: a host is the only party that can
            // compare one open against another, or against a target.
            timings: timingTable(),
          },
        },
        "*",
      );
    });
  }

  /*
   * The frame starts empty but for the loader, and asks for the payload itself.
   *
   * Posting the bytes before the frame is listening would lose them, and the
   * frame is the only side that knows when its own script has run — so it
   * speaks first. `"*"` as the target origin because the frame has no origin to
   * name; the reply carries no secret the frame did not already hold.
   */
  const frame = mount(loaderScript());

  /*
   * Answered once. The buffers are transferred rather than copied, so they are
   * detached the moment they are sent — and the application that ends up
   * running in the frame satisfies the source check as readily as the loader
   * did, so a second `dai:frame-hello` from anywhere inside it would re-post a
   * transfer list of detached buffers and throw DataCloneError out of this
   * listener.
   */
  const onHello = (event: MessageEvent): void => {
    if ((event.data as { type?: string })?.type !== "dai:frame-hello") return;
    if (event.source !== frame.contentWindow) return;

    window.removeEventListener("message", onHello);
    frame.contentWindow?.postMessage(framePayload, "*", transfer);
  };

  window.addEventListener("message", onHello);

  installAppMode(frame);

  if (window.parent !== window) {
    // pagehide rather than unload: it fires for a page entering the back/forward
    // cache as well as one being destroyed, and unload does not fire reliably at
    // all on mobile. Best-effort by nature — a process killed outright sends
    // nothing, so a host must treat a missing close as normal, not as an error.
    window.addEventListener("pagehide", () => {
      try {
        window.parent.postMessage(
          {
            type: "DAI_HOST_CLOSING",
            payload: {
              bridgeVersion: BRIDGE_VERSION,
              sessionNonce,
              documentUuid: manifest?.documentUuid ?? null,
            },
          },
          "*",
        );
      } catch {
        // Nothing useful to do while the document is going away.
      }
    });
  }

  window.setTimeout(() => {
    if (ready) return;
    refuse("MOUNT_TIMEOUT", 
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
    refuse("BOOT_FAILED", "The container failed to start.", String(error));
  });
};

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", start);
} else {
  start();
}
