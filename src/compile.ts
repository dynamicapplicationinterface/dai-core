/**
 * Everything between "a directory on disk" and `buildContainer`.
 *
 * The compiler itself is in core.ts and knows nothing about files. This is the
 * layer above it: finding the shell and the bootloader, locating the SQLite
 * engine in node_modules, walking a build directory, reading a signing key.
 *
 * It exists so that every way of making a container on a machine — the Vite
 * plugin, the command line, an MCP server, the desktop app — shares one
 * implementation of those decisions. Four wrappers that each resolved their own
 * asset paths would agree right up until one of them was updated, and the
 * disagreement would surface as a container that verifies under one tool and
 * not another.
 *
 * The rule that keeps this honest: nothing outside core.ts may zip, hash or
 * sign. Wrappers gather bytes and call in. `tests/one-engine.spec.ts` fails if
 * that stops being true.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildContainer,
  DEFAULT_APP_PREFIX,
  DEFAULT_GLUE_ENTRY,
  DEFAULT_WASM_ENTRY,
  type BuildContainerResult,
} from "./core.js";

/** Where @sqlite.org/sqlite-wasm keeps the engine binary. */
const SQLITE_WASM_LOOKUP = [
  // Layout since 3.53.
  "node_modules/@sqlite.org/sqlite-wasm/dist/sqlite3.wasm",
  // Earlier releases shipped the upstream jswasm tree verbatim.
  "node_modules/@sqlite.org/sqlite-wasm/sqlite-wasm/jswasm/sqlite3.wasm",
];

const SQLITE_GLUE_LOOKUP = ["node_modules/@sqlite.org/sqlite-wasm/dist/index.mjs"];

export interface CompileOptions {
  /** Directory whose contents become the application. */
  sourceDir: string;
  /** Resolves relative paths, and where node_modules is looked for. */
  root?: string;
  appName?: string;
  /** PEM text, or a path to a PEM file. */
  signingKey?: string;
  /** Seed database to ship inside the container. */
  sqlitePath?: string;
  sqliteWasmPath?: string;
  sqliteGluePath?: string;
  /** Overrides the shell. Defaults to the one shipped with this package. */
  templatePath?: string;
  documentUuid?: string;
  validUntil?: number;
  verifyIntegrity?: boolean;
  compressionLevel?: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
  appEntryPrefix?: string;
  sqliteEntryName?: string;
  wasmEntryName?: string;
  glueEntryName?: string;
  now?: () => Date;
}

export interface CompileResult extends BuildContainerResult {
  /** What was packaged, for a caller that wants to say so. */
  engine: "sqlite3 + glue embedded" | "sqlite3.wasm only" | "no sqlite engine";
  entryCount: number;
  /** Warnings worth showing a user. Never fatal. */
  warnings: string[];
}

/** Thrown for the things a caller can fix, so wrappers can print them plainly. */
export class CompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompileError";
  }
}

/**
 * Finds the shell or the bootloader.
 *
 * Both are emitted beside the compiled output, so for anything running from the
 * published package they sit next to this module. Running from source — a test,
 * or a consumer whose bundler inlined src/ — they are one directory over in
 * dist/, and a lookup that only checked the first place failed with "run npm
 * run build" for someone who had.
 */
function packagedAsset(name: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, name),
    resolve(here, "../dist", name),
    resolve(here, "..", name),
  ];
  return candidates.find((path) => existsSync(path)) ?? candidates[0]!;
}

export async function compileDirectory(options: CompileOptions): Promise<CompileResult> {
  const root = options.root ?? process.cwd();
  const sourceDir = resolve(root, options.sourceDir);
  const warnings: string[] = [];

  if (!existsSync(sourceDir)) {
    throw new CompileError(`No such directory: ${sourceDir}`);
  }

  const templatePath = options.templatePath
    ? resolve(root, options.templatePath)
    : packagedAsset("template.html");
  if (!existsSync(templatePath)) {
    throw new CompileError(`Container shell not found at ${templatePath}.`);
  }

  const runtimePath = packagedAsset("dai-runtime.js");
  if (!existsSync(runtimePath)) {
    throw new CompileError(
      `Bootloader not found at ${runtimePath}. Run \`npm run build\` in dai-core.`,
    );
  }

  const collected = await collectFiles(sourceDir);
  if (collected.length === 0) {
    throw new CompileError(`${sourceDir} is empty — nothing to package.`);
  }

  const files: Record<string, Uint8Array> = {};
  for (const file of collected) {
    files[file.entry] = new Uint8Array(await readFile(file.absolute));
  }

  // An application with no entry point mounts to a blank frame, which looks
  // exactly like a broken container to whoever opens it.
  if (!Object.keys(files).some((entry) => entry === "index.html")) {
    warnings.push(
      `No index.html at the top of ${relative(root, sourceDir) || sourceDir} — ` +
        `the container will open blank.`,
    );
  }

  const sqlite = readOptional(root, options.sqlitePath);
  if (options.sqlitePath && !sqlite) {
    warnings.push(
      `Seed database not found at ${resolve(root, options.sqlitePath)}. ` +
        `Shipping an empty document instead.`,
    );
  }

  const wasmPath = findFirst(root, options.sqliteWasmPath, SQLITE_WASM_LOOKUP);
  if (!wasmPath) {
    warnings.push(
      options.sqliteWasmPath
        ? `No SQLite engine at ${resolve(root, options.sqliteWasmPath)}.`
        : `No SQLite engine found — install @sqlite.org/sqlite-wasm if the app ` +
          `needs to store data. Building without one.`,
    );
  }

  const gluePath = wasmPath
    ? findFirst(root, options.sqliteGluePath, SQLITE_GLUE_LOOKUP)
    : undefined;
  if (wasmPath && !gluePath) {
    warnings.push(
      `Packaged a SQLite engine but found no Emscripten glue, so ` +
        `window.dai.openDatabase() will be unavailable.`,
    );
  }

  const built = await buildContainer({
    files,
    template: readFileSync(templatePath, "utf8"),
    runtime: readFileSync(runtimePath, "utf8"),
    appName: options.appName ?? inferAppName(root),
    sqlite,
    wasm: wasmPath ? new Uint8Array(readFileSync(wasmPath)) : undefined,
    glue: gluePath ? new Uint8Array(readFileSync(gluePath)) : undefined,
    signingKey: options.signingKey ? readSigningKey(root, options.signingKey) : undefined,
    documentUuid: options.documentUuid,
    validUntil: options.validUntil,
    verifyIntegrity: options.verifyIntegrity,
    compressionLevel: options.compressionLevel,
    appEntryPrefix: options.appEntryPrefix ?? DEFAULT_APP_PREFIX,
    sqliteEntryName: options.sqliteEntryName,
    wasmEntryName: options.wasmEntryName ?? DEFAULT_WASM_ENTRY,
    glueEntryName: options.glueEntryName ?? DEFAULT_GLUE_ENTRY,
    now: options.now,
  });

  return {
    ...built,
    engine: wasmPath
      ? gluePath
        ? "sqlite3 + glue embedded"
        : "sqlite3.wasm only"
      : "no sqlite engine",
    entryCount: Object.keys(built.archive).length,
    warnings,
  };
}

interface CollectedFile {
  absolute: string;
  /** POSIX-separated path relative to the source directory. */
  entry: string;
}

export async function collectFiles(dir: string, base = dir): Promise<CollectedFile[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: CollectedFile[] = [];

  for (const entry of entries) {
    const absolute = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await collectFiles(absolute, base)));
    } else if (entry.isFile()) {
      out.push({ absolute, entry: relative(base, absolute).split(sep).join("/") });
    }
  }

  return out;
}

/** Reads a file if the path resolves to one, otherwise undefined. */
export function readOptional(root: string, path?: string): Uint8Array | undefined {
  if (!path) return undefined;
  const absolute = resolve(root, path);
  if (!existsSync(absolute) || !statSync(absolute).isFile()) return undefined;
  return new Uint8Array(readFileSync(absolute));
}

/** Accepts either PEM text or a path to a PEM file. */
export function readSigningKey(root: string, key: string): string {
  if (key.includes("BEGIN")) return key;
  const absolute = resolve(root, key);
  if (!existsSync(absolute)) {
    throw new CompileError(`Signing key not found at ${absolute}.`);
  }
  return readFileSync(absolute, "utf8");
}

/**
 * First existing file: the configured path if given, else the fallbacks,
 * looked for in the caller's project and then beside this package.
 *
 * The second place matters more than it looks. Someone running `npx dai build`
 * in a folder of HTML has no node_modules, so a project-only search finds no
 * SQLite engine and quietly produces a container whose storage does not work —
 * the failure lands on whoever opens the file, far from the cause. This package
 * depends on the engine itself, so it always has a copy to fall back on.
 */
export function findFirst(
  root: string,
  configured: string | undefined,
  fallbacks: string[],
): string | undefined {
  if (configured) {
    const absolute = resolve(root, configured);
    return existsSync(absolute) && statSync(absolute).isFile() ? absolute : undefined;
  }

  const candidates = [
    ...fallbacks.map((path) => resolve(root, path)),
    ...fallbacks.flatMap((path) => packageRelative(path)),
  ];
  return candidates.find((path) => existsSync(path) && statSync(path).isFile());
}

/**
 * The same lookup path, resolved against this package's own installation.
 *
 * Walks up rather than assuming a depth: dist/ sits one level below the package
 * root in development and the same in node_modules, but a hoisted install puts
 * the dependency in a node_modules further up still.
 */
function packageRelative(path: string): string[] {
  const out: string[] = [];
  let dir = dirname(fileURLToPath(import.meta.url));

  for (let depth = 0; depth < 6; depth++) {
    out.push(resolve(dir, path));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return out;
}

export function inferAppName(root: string): string {
  try {
    const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
      name?: string;
    };
    if (pkg.name) return pkg.name;
  } catch {
    // No readable package.json — fall through to the directory name.
  }
  return root.split(sep).filter(Boolean).pop() ?? "app";
}

export function sanitizeFileName(name: string): string {
  const cleaned = name
    .replace(/^@/, "")
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  return cleaned || "app";
}

export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}
