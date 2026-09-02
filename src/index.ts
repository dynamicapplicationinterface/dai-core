import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import type { Plugin, ResolvedConfig } from "vite";
import {
  buildContainer,
  DEFAULT_APP_PREFIX,
  DEFAULT_GLUE_ENTRY,
  DEFAULT_SQLITE_ENTRY,
  DEFAULT_WASM_ENTRY,
} from "./core.js";

export {
  buildContainer,
  canonicalPayload,
  sha256Hex,
  CONTAINER_ENTRY,
  MANIFEST_ENTRY,
  MANIFEST_VERSION,
  DEFAULT_APP_PREFIX,
  DEFAULT_GLUE_ENTRY,
  DEFAULT_SQLITE_ENTRY,
  DEFAULT_WASM_ENTRY,
} from "./core.js";
export type {
  BuildContainerInput,
  BuildContainerResult,
  ContainerManifest,
} from "./core.js";

/** Where @sqlite.org/sqlite-wasm keeps the engine binary. */
const SQLITE_WASM_LOOKUP = [
  // Layout since 3.53.
  "node_modules/@sqlite.org/sqlite-wasm/dist/sqlite3.wasm",
  // Earlier releases shipped the upstream jswasm tree verbatim.
  "node_modules/@sqlite.org/sqlite-wasm/sqlite-wasm/jswasm/sqlite3.wasm",
];

/** Where @sqlite.org/sqlite-wasm keeps the Emscripten glue. */
const SQLITE_GLUE_LOOKUP = ["node_modules/@sqlite.org/sqlite-wasm/dist/index.mjs"];

/** Directory holding the compiled plugin; the template and runtime sit beside it. */
declare const __dirname: string;

export interface DaiPluginOptions {
  /**
   * Base name of the emitted container, without the `.dai.html` suffix.
   * Defaults to the `name` field of the consuming project's package.json,
   * falling back to the project directory name.
   */
  appName?: string;
  /**
   * Directory the container is written to. Relative paths resolve against the
   * Vite project root. Defaults to the project root itself.
   */
  outDir?: string;
  /**
   * Path to a SQLite document to seed the container with. If the file does not
   * exist, a zero-byte `document.sqlite` entry is written into the archive.
   * Relative paths resolve against the Vite project root.
   */
  sqlitePath?: string;
  /** Path inside the archive for the SQLite document. */
  sqliteEntryName?: string;
  /**
   * Path to the `sqlite3.wasm` engine to embed. When omitted the plugin looks
   * for `@sqlite.org/sqlite-wasm` in the project's node_modules.
   */
  sqliteWasmPath?: string;
  /** Path inside the archive for the WASM engine. */
  wasmEntryName?: string;
  /**
   * Path to the Emscripten glue (`sqlite3InitModule`) that drives the engine.
   * Only packaged when an engine is packaged too.
   */
  sqliteGluePath?: string;
  /** Path inside the archive for the glue. */
  glueEntryName?: string;
  /**
   * Directory prefix inside the archive for the compiled app. Defaults to
   * `app`, matching the `/app` path the spec uses for document logic.
   */
  appEntryPrefix?: string;
  /**
   * PEM-encoded PKCS#8 ECDSA P-256 private key, or a path to one. The key never
   * enters the container. Generate a pair with `node scripts/generate-key.mjs`.
   */
  signingKey?: string;
  /**
   * Document identity. Minted fresh on every compile unless given. Per spec §1
   * a changed application is a new document and should get a new one.
   */
  documentUuid?: string;
  /** Whether the shell demands integrity verification. Defaults to true. */
  verifyIntegrity?: boolean;
  /** fflate deflate level, 0 (store) to 9 (max). */
  compressionLevel?: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
  /** Path to an alternative bootloader template. */
  templatePath?: string;
}

/**
 * Compiles the finished Vite build into a single air-gapped `.dai.html`
 * container. Runs on `closeBundle` so the application is fully written to
 * `dist` before the archive is assembled.
 *
 * This is a filesystem wrapper only: it resolves paths, reads bytes and reports
 * problems, then hands everything to `buildContainer`, which does the actual
 * compilation in memory. Any other host — a CLI, a browser-based bundler — can
 * call that directly.
 */
export default function dai(options: DaiPluginOptions = {}): Plugin {
  let config: ResolvedConfig;

  return {
    name: "vite-plugin-dai",
    apply: "build",
    // Nothing else may write to the build output after us.
    enforce: "post",

    configResolved(resolved) {
      config = resolved;
    },

    async closeBundle() {
      // Library/SSR builds have no browser entry to package.
      if (config.build.ssr) {
        this.warn("SSR build detected — skipping DAI container emit.");
        return;
      }

      const root = config.root;
      const buildDir = resolve(root, config.build.outDir);

      if (!existsSync(buildDir)) {
        this.error(`DAI: build output not found at ${buildDir}.`);
        return;
      }

      const templatePath = options.templatePath
        ? resolve(root, options.templatePath)
        : resolve(__dirname, "template.html");
      if (!existsSync(templatePath)) {
        this.error(`DAI: bootloader template not found at ${templatePath}.`);
        return;
      }

      const runtimePath = resolve(__dirname, "dai-runtime.js");
      if (!existsSync(runtimePath)) {
        this.error(
          `DAI: bootloader runtime not found at ${runtimePath}. Run \`npm run build\` in dai-core.`,
        );
        return;
      }

      const appName = options.appName ?? inferAppName(root);
      const collected = await collectFiles(buildDir);
      if (collected.length === 0) {
        this.error(`DAI: build output at ${buildDir} is empty.`);
        return;
      }

      const files: Record<string, Uint8Array> = {};
      for (const file of collected) {
        files[file.entry] = new Uint8Array(await readFile(file.absolute));
      }

      const sqlite = readOptional(root, options.sqlitePath);
      if (options.sqlitePath && !sqlite) {
        this.warn(
          `DAI: sqlitePath "${options.sqlitePath}" did not resolve to a file ` +
            `(looked in ${resolve(root, options.sqlitePath)}). ` +
            `Shipping an empty ${options.sqliteEntryName ?? DEFAULT_SQLITE_ENTRY} — ` +
            `check the path for a typo.`,
        );
      }

      const wasmPath = findFirst(root, options.sqliteWasmPath, SQLITE_WASM_LOOKUP);
      if (!wasmPath && options.sqliteWasmPath) {
        this.warn(
          `DAI: sqliteWasmPath "${options.sqliteWasmPath}" did not resolve to a ` +
            `file (looked in ${resolve(root, options.sqliteWasmPath)}). ` +
            `The container will ship without a SQLite engine.`,
        );
      }

      const gluePath = wasmPath
        ? findFirst(root, options.sqliteGluePath, SQLITE_GLUE_LOOKUP)
        : undefined;
      if (wasmPath && !gluePath) {
        this.warn(
          `DAI: packaged a SQLite engine but found no Emscripten glue` +
            `${options.sqliteGluePath ? ` at ${resolve(root, options.sqliteGluePath)}` : ""}. ` +
            `window.dai.initSqlite() will be unavailable; the raw engine bytes ` +
            `are still exposed as window.dai.sqliteWasm.`,
        );
      }

      let built;
      try {
        built = await buildContainer({
          files,
          template: readFileSync(templatePath, "utf8"),
          runtime: readFileSync(runtimePath, "utf8"),
          appName,
          sqlite,
          wasm: wasmPath ? new Uint8Array(readFileSync(wasmPath)) : undefined,
          glue: gluePath ? new Uint8Array(readFileSync(gluePath)) : undefined,
          signingKey: options.signingKey
            ? readSigningKey(root, options.signingKey)
            : undefined,
          documentUuid: options.documentUuid,
          verifyIntegrity: options.verifyIntegrity,
          compressionLevel: options.compressionLevel,
          appEntryPrefix: options.appEntryPrefix ?? DEFAULT_APP_PREFIX,
          sqliteEntryName: options.sqliteEntryName,
          wasmEntryName: options.wasmEntryName ?? DEFAULT_WASM_ENTRY,
          glueEntryName: options.glueEntryName ?? DEFAULT_GLUE_ENTRY,
        });
      } catch (error) {
        this.error(`DAI: ${(error as Error).message}`);
        return;
      }

      const outDir = options.outDir ? resolve(root, options.outDir) : root;
      const outFile = join(outDir, `${sanitizeFileName(appName)}.dai.html`);
      writeFileSync(outFile, built.html, "utf8");

      const engine = wasmPath
        ? gluePath
          ? "sqlite3 + glue embedded"
          : "sqlite3.wasm only"
        : "no sqlite engine";

      config.logger.info(
        `\n[dai] ${relative(root, outFile) || outFile} — ` +
          `${Object.keys(built.archive).length} entries, ` +
          `${engine}, ` +
          `uuid ${built.documentUuid.slice(0, 8)}, ` +
          `${
            built.publicKeyFingerprint
              ? `signed ${built.publicKeyFingerprint.slice(0, 8)}`
              : "unsigned"
          }, ` +
          `${formatBytes(built.zipped.byteLength)} archive, ` +
          `${formatBytes(Buffer.byteLength(built.html))} container`,
      );
    },
  };
}

interface CollectedFile {
  absolute: string;
  /** POSIX-separated path relative to the build directory. */
  entry: string;
}

async function collectFiles(dir: string, base = dir): Promise<CollectedFile[]> {
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
function readOptional(root: string, path?: string): Uint8Array | undefined {
  if (!path) return undefined;
  const absolute = resolve(root, path);
  if (!existsSync(absolute) || !statSync(absolute).isFile()) return undefined;
  return new Uint8Array(readFileSync(absolute));
}

/** Accepts either PEM text or a path to a PEM file. */
function readSigningKey(root: string, key: string): string {
  return key.includes("BEGIN") ? key : readFileSync(resolve(root, key), "utf8");
}

/** First existing file: the configured path if given, else the fallbacks. */
function findFirst(
  root: string,
  configured: string | undefined,
  fallbacks: string[],
): string | undefined {
  const candidates = configured
    ? [resolve(root, configured)]
    : fallbacks.map((path) => resolve(root, path));
  return candidates.find((path) => existsSync(path) && statSync(path).isFile());
}

function inferAppName(root: string): string {
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

function sanitizeFileName(name: string): string {
  const cleaned = name
    .replace(/^@/, "")
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  return cleaned || "app";
}

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export { dai };
