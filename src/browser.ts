/**
 * Compiling a container from inside a browser.
 *
 * The counterpart to compile.ts. That one resolves assets on a filesystem for
 * the plugin, the command line and an MCP server; this one fetches them over
 * HTTP for a page, and mints a throwaway identity because a browser has nowhere
 * safe to keep a real one. Both then hand off to the same `buildContainer`.
 *
 * Two front ends already needed this and each grew its own copy: the same
 * asset fetch, the same key generation, the same PEM assembly, written twice
 * within an hour of each other. That is how one engine quietly becomes several,
 * so it lives here now and `tests/one-engine.spec.ts` keeps it that way.
 */
import { unzipSync } from "fflate";
import { buildContainer, type BuildContainerResult } from "./core.js";

export interface RuntimeAssets {
  template: string;
  runtime: string;
  wasm: Uint8Array;
  glue: Uint8Array;
}

/**
 * Fetches the shell, the bootloader and the SQLite engine.
 *
 * These are served as static files rather than bundled into the page: the
 * engine alone is well over a megabyte, and a visitor who never builds anything
 * should not pay for it.
 */
export async function loadRuntimeAssets(baseUrl = "/runtime"): Promise<RuntimeAssets> {
  const text = async (name: string): Promise<string> => {
    const response = await fetch(`${baseUrl}/${name}`);
    if (!response.ok) throw new Error(`${baseUrl}/${name} → HTTP ${response.status}`);
    return response.text();
  };
  const bytes = async (name: string): Promise<Uint8Array> => {
    const response = await fetch(`${baseUrl}/${name}`);
    if (!response.ok) throw new Error(`${baseUrl}/${name} → HTTP ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  };

  const [template, runtime, wasm, glue] = await Promise.all([
    text("template.html"),
    text("dai-runtime.js"),
    bytes("sqlite3.wasm"),
    bytes("sqlite3.mjs"),
  ]);

  return { template, runtime, wasm, glue };
}

/**
 * Mints a signing identity that exists only for this build.
 *
 * What it proves is worth being exact about: the container has not been altered
 * since it was made. It does not prove who made it — nobody has ever seen this
 * key before and nobody will see it again. Publisher identity needs a key its
 * holder keeps, which is a thing a web page cannot offer.
 */
export async function mintSigningKey(): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new Error(
      "WebCrypto is unavailable, so nothing can be signed here. This page must " +
        "be served over HTTPS or from localhost.",
    );
  }

  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);

  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  let binary = "";
  for (const byte of pkcs8) binary += String.fromCharCode(byte);

  return `-----BEGIN PRIVATE KEY-----\n${btoa(binary)}\n-----END PRIVATE KEY-----`;
}

/**
 * Reads an archive a person dropped in.
 *
 * Assistants hand multi-file applications over as a zip, because a folder is
 * not something you can paste into a chat window. Unpacking it here rather than
 * in the page keeps the single place that knows about zip files single —
 * `tests/one-engine.spec.ts` refuses a front end that reaches for fflate.
 *
 * Directory entries are dropped: they carry no bytes and would be sealed as
 * empty files.
 */
export function unpackZip(bytes: Uint8Array): Record<string, Uint8Array> {
  const files: Record<string, Uint8Array> = {};
  for (const [name, content] of Object.entries(unzipSync(bytes))) {
    if (!name.endsWith("/") && content.byteLength >= 0) files[name] = content;
  }
  return stripCommonPrefix(files);
}

/**
 * Removes a single wrapping directory, if every file shares one.
 *
 * An archive almost always unpacks to `my-app/index.html` rather than
 * `index.html`, and a container whose entry point is one level down opens
 * blank. Only a prefix shared by everything is removed, so an application with
 * genuine top-level folders is left alone.
 */
export function stripCommonPrefix(
  files: Record<string, Uint8Array>,
): Record<string, Uint8Array> {
  const names = Object.keys(files);
  if (names.length === 0) return files;

  const first = names[0]!.split("/");
  if (first.length < 2) return files;

  const prefix = first[0] + "/";
  if (!names.every((name) => name.startsWith(prefix))) return files;

  return Object.fromEntries(
    names.map((name) => [name.slice(prefix.length), files[name]!]),
  );
}

/** Junk the operating system and editors leave in a folder or archive. */
export function isNoise(name: string): boolean {
  const base = name.split("/").pop() ?? "";
  return (
    base === ".DS_Store" ||
    base === "Thumbs.db" ||
    base.startsWith("._") ||
    name.startsWith("__MACOSX/") ||
    name.includes("/.git/") ||
    name.startsWith(".git/") ||
    name.includes("/node_modules/") ||
    name.startsWith("node_modules/")
  );
}

export interface BrowserBuildInput {
  /** Application files, keyed by path relative to the app root. */
  files: Record<string, Uint8Array | string>;
  appName: string;
  /** Fetched if not supplied, so a caller building repeatedly can reuse them. */
  assets?: RuntimeAssets;
  /** Where the runtime assets are served from. */
  baseUrl?: string;
  /** Skip signing. The container is then editable by anyone. */
  unsigned?: boolean;
}

/** Compiles a container in the page, with nothing sent anywhere. */
export async function compileInBrowser(
  input: BrowserBuildInput,
): Promise<BuildContainerResult> {
  const assets = input.assets ?? (await loadRuntimeAssets(input.baseUrl));

  const encoder = new TextEncoder();
  const files: Record<string, Uint8Array> = {};
  for (const [name, content] of Object.entries(input.files)) {
    files[name] = typeof content === "string" ? encoder.encode(content) : content;
  }

  return buildContainer({
    files,
    template: assets.template,
    runtime: assets.runtime,
    appName: input.appName,
    wasm: assets.wasm,
    glue: assets.glue,
    signingKey: input.unsigned ? undefined : await mintSigningKey(),
  });
}
