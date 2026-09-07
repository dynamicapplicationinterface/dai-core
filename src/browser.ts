/**
 * Compiling a container from inside a browser.
 *
 * The counterpart to compile.ts. That one resolves assets on a filesystem for
 * the plugin, the command line and an MCP server; this one fetches them over
 * HTTP for a page. It signs nothing: a browser has nowhere to keep a key, and
 * a key nobody keeps is not an identity. Both hand off to `buildContainer`.
 *
 * Two front ends already needed this and each grew its own copy: the same
 * asset fetch, written twice within an hour of each other. That is how one
 * engine quietly becomes several, so it lives here now and
 * `tests/one-engine.spec.ts` keeps it that way.
 */
import { unzipBounded } from "./unzip.js";
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

/*
 * There is deliberately no key minted here.
 *
 * A page once signed what it built with a key it generated and discarded, on
 * the reasoning that a browser has nowhere to keep one. That signature was
 * worth nothing and cost something. Worth nothing, because a signature says a
 * key made these bytes and anybody altering a container can substitute a key
 * and re-sign (§8) — a key nobody has ever held and nobody will hold again
 * distinguishes no one from no one. Cost something, because a host pins the
 * key a document was first seen with: the honest publisher had thrown it away,
 * so their own second version arrived under a different key and read as an
 * impersonation, and the card offered a safety number for a key nobody could
 * read back.
 *
 * So a container built in a page is unsigned, and says so. It is still
 * self-consistent — every entry is digested and the shell is compared with its
 * sealed copy — and a host reports it as what it is: not signed, anyone could
 * have made this. A publisher who wants to be somebody signs with a key they
 * keep, through the command line or the desktop app, and `signingKey` below is
 * how a caller that has one passes it.
 */

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
  for (const [name, content] of Object.entries(unzipBounded(bytes))) {
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
/**
 * The name of an app, from the name of the file or folder it arrived in.
 *
 * A person who drops `road-to-doomsday.dai.html`, or a folder somebody called
 * `road-to-doomsday-dai`, gets an app called "Road to doomsday". The suffix is
 * ours: it names the format the file is written in, and putting it in the
 * app's own name means it shows on the open screen, on the home screen and in
 * the message somebody is sent — a person's watch list called
 * "road-to-doomsday-dai" because of how it is stored.
 *
 * The separators become spaces and the first letter is raised, and nothing
 * else is touched: an app whose name genuinely contains the word is left with
 * it, because only a trailing one is the suffix.
 */
export function appNameFrom(fileOrFolderName: string): string {
  const bare = (fileOrFolderName.split(/[/\\]/).pop() ?? fileOrFolderName)
    // The extensions, longest first: .dai.html before .html.
    .replace(/\.dai\.html?$/i, "")
    .replace(/\.(dai|html?|zip)$/i, "")
    // And the suffix worn as part of the name.
    .replace(/[-_. ]dai$/i, "");
  const words = bare.replace(/[-_.]+/g, " ").replace(/\s+/g, " ").trim();
  // A file called nothing but the suffix names no app. The caller keeps
  // whatever it already had rather than showing an empty field.
  if (!words || /^dai$/i.test(words)) return "";
  return words[0]!.toUpperCase() + words.slice(1);
}

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
  /**
   * A PKCS#8 PEM key to sign with, for a caller that holds one.
   *
   * A page has nowhere to keep a key, so a page passes nothing and the
   * container is unsigned. See the note above: a key minted and discarded is
   * not an identity, and pretending otherwise is worse than saying nothing.
   */
  signingKey?: string;
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
    signingKey: input.signingKey,
  });
}
