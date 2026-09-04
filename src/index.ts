import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { Plugin, ResolvedConfig } from "vite";
import {
  compileDirectory,
  formatBytes,
  inferAppName,
  sanitizeFileName,
} from "./compile.js";
import { buildLaunchers } from "./launchers.js";

export {
  compileDirectory,
  CompileError,
} from "./compile.js";
export type { CompileOptions, CompileResult } from "./compile.js";

export {
  buildContainer,
  toSectionedContainer,
  canonicalPayload,
  payloadFingerprint,
  sha256Hex,
  CONTAINER_ENTRY,
  MANIFEST_ENTRY,
  MANIFEST_VERSION,
  DEFAULT_APP_PREFIX,
  DEFAULT_GLUE_ENTRY,
  DEFAULT_SQLITE_ENTRY,
  DEFAULT_WASM_ENTRY,
} from "./core.js";
export {
  buildLaunchers,
  windowsLauncher,
  macLauncher,
  escapeForBatch,
  escapeForShell,
} from "./launchers.js";
export type { Launchers } from "./launchers.js";
// The sectioned binary is the canonical form, so the library has to be able to
// write and check one. Without these a caller can only produce the viewer form,
// whatever the specification calls canonical.
export {
  FormatError,
  SECTION,
  readContainerFile,
  verifyContainerFile,
  replaceData,
  sectionBytes,
} from "./format.js";
export type { ContainerFile, FileAudit, Section } from "./format.js";
// Handing a finished container to the device somebody is reading on. A host
// that gets this wrong hands over nothing and says nothing, which is how the
// site failed on iOS.
export { canHandOff, handOff } from "./handoff.js";
export type { HandOffResult, ShareCapableNavigator } from "./handoff.js";
// The plain-text shape a model emits and a person pastes. Exported because
// anything receiving generated source needs to read it, and a second parser
// would be a second format.
export { BundleError, parseBundle, writeBundle } from "./bundle.js";
export type { Bundle } from "./bundle.js";
export {
  ContainerError,
  parseContainer,
  auditContainer,
  verifyContainer,
  resealContainer,
} from "./container.js";
export type {
  ParsedContainer,
  VerifiedContainer,
  AuditReport,
  EntryAudit,
} from "./container.js";
export type {
  BuildContainerInput,
  BuildContainerResult,
  ContainerManifest,
} from "./core.js";

/** Where @sqlite.org/sqlite-wasm keeps the Emscripten glue. */
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
  /**
   * Also emit `.bat` and `.command` launchers that open the container in a
   * chromeless app window. Defaults to false: they are only useful for
   * documents that are distributed as desktop applications.
   */
  emitLaunchers?: boolean;
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

      const appName = options.appName ?? inferAppName(root);

      let result;
      try {
        result = await compileDirectory({
          sourceDir: buildDir,
          root,
          appName,
          signingKey: options.signingKey,
          sqlitePath: options.sqlitePath,
          sqliteWasmPath: options.sqliteWasmPath,
          sqliteGluePath: options.sqliteGluePath,
          templatePath: options.templatePath,
          documentUuid: options.documentUuid,
          verifyIntegrity: options.verifyIntegrity,
          compressionLevel: options.compressionLevel,
          appEntryPrefix: options.appEntryPrefix,
          sqliteEntryName: options.sqliteEntryName,
          wasmEntryName: options.wasmEntryName,
          glueEntryName: options.glueEntryName,
        });
      } catch (error) {
        this.error(`DAI: ${(error as Error).message}`);
        return;
      }

      for (const warning of result.warnings) {
        this.warn(`DAI: ${warning}`);
      }

      const outDir = options.outDir ? resolve(root, options.outDir) : root;
      const outFile = join(outDir, `${sanitizeFileName(appName)}.dai.html`);
      writeFileSync(outFile, result.html, "utf8");

      if (options.emitLaunchers) {
        const launchers = buildLaunchers(`${sanitizeFileName(appName)}.dai.html`);
        const base = join(outDir, sanitizeFileName(appName));
        writeFileSync(`${base}.bat`, launchers.bat, "utf8");
        writeFileSync(`${base}.command`, launchers.command, "utf8");
        // A .command file is only double-clickable when it is executable.
        try {
          chmodSync(`${base}.command`, 0o755);
        } catch {
          // Windows has no execute bit; the file is still correct on macOS
          // once chmod +x is applied there.
        }
      }

      config.logger.info(
        `
[dai] ${relative(root, outFile) || outFile} — ` +
          `${result.entryCount} entries, ` +
          `${result.engine}, ` +
          `uuid ${result.documentUuid.slice(0, 8)}, ` +
          `${
            result.publicKeyFingerprint
              ? `signed ${result.publicKeyFingerprint.slice(0, 8)}`
              : "unsigned"
          }, ` +
          `${formatBytes(result.zipped.byteLength)} archive, ` +
          `${formatBytes(Buffer.byteLength(result.html))} container`,
      );
    },
  };
}

export { dai };
