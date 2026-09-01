import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { zipSync, type Zippable } from "fflate";
import type { Plugin, ResolvedConfig } from "vite";

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
  /**
   * Path inside the archive for the SQLite document. Defaults to `document.sqlite`.
   */
  sqliteEntryName?: string;
  /**
   * Path to the `sqlite3.wasm` engine to embed. Relative paths resolve against
   * the Vite project root. When omitted the plugin looks for
   * `@sqlite.org/sqlite-wasm` in the project's node_modules; if that is absent
   * too, no engine is packaged.
   */
  sqliteWasmPath?: string;
  /**
   * Path inside the archive for the WASM engine. Defaults to
   * `runtime/sqlite3.wasm`.
   */
  wasmEntryName?: string;
  /**
   * Directory prefix inside the archive for the compiled React app. Defaults to
   * `app`, matching the `/app` path the spec uses for document logic. Set to an
   * empty string to write the build output at the archive root.
   */
  appEntryPrefix?: string;
  /**
   * fflate deflate level, 0 (store) to 9 (max). Defaults to 9 — the container is
   * written once and read many times, so size beats compression time.
   */
  compressionLevel?: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
  /** Path to an alternative bootloader template. Defaults to the bundled one. */
  templatePath?: string;
}

const PAYLOAD_PLACEHOLDER = "<!--DAI_PAYLOAD-->";
/**
 * Anchors the payload substitution to the payload tag itself.
 *
 * A bare replace would hit the wrong occurrence: the bootloader carries the
 * placeholder literal too (it rebuilds the container on save) and is inlined
 * above the tag, so the first match is inside the runtime's own source.
 */
const PAYLOAD_TAG_RE = /(<script[^>]*id="dai-payload"[^>]*>)<!--DAI_PAYLOAD-->/;
const RUNTIME_PLACEHOLDER = "<!--DAI_RUNTIME-->";
const APP_NAME_PLACEHOLDER = "<!--DAI_APP_NAME-->";
const DEFAULT_SQLITE_ENTRY = "document.sqlite";
const DEFAULT_APP_PREFIX = "app";
const DEFAULT_WASM_ENTRY = "runtime/sqlite3.wasm";
/**
 * The container's own shell, stored inside its payload. A save rebuilds the
 * file from this copy rather than from whatever dai-core is installed, so a
 * document keeps the runtime semantics it was compiled with for its whole life.
 */
const CONTAINER_ENTRY = "runtime/container.html";
/** Where @sqlite.org/sqlite-wasm keeps the engine binary. */
const SQLITE_WASM_LOOKUP = [
  // Layout since 3.53.
  "node_modules/@sqlite.org/sqlite-wasm/dist/sqlite3.wasm",
  // Earlier releases shipped the upstream jswasm tree verbatim.
  "node_modules/@sqlite.org/sqlite-wasm/sqlite-wasm/jswasm/sqlite3.wasm",
];

/** Directory holding the compiled plugin; `template.html` sits beside it. */
declare const __dirname: string;

/**
 * Compiles the finished Vite build into a single air-gapped `.dai.html` polyglot
 * container. Runs on `closeBundle` so the React app is fully written to `dist`
 * before the archive is assembled.
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
      const files = await collectFiles(buildDir);

      if (files.length === 0) {
        this.error(`DAI: build output at ${buildDir} is empty.`);
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
      const runtime = readFileSync(runtimePath, "utf8");

      const template = readFileSync(templatePath, "utf8");

      if (!template.includes(RUNTIME_PLACEHOLDER)) {
        this.error(
          `DAI: template ${templatePath} has no ${RUNTIME_PLACEHOLDER} placeholder.`,
        );
        return;
      }

      if (!PAYLOAD_TAG_RE.test(template)) {
        this.error(
          `DAI: template ${templatePath} has no ${PAYLOAD_PLACEHOLDER} placeholder.`,
        );
        return;
      }

      const prefix = normalizePrefix(options.appEntryPrefix ?? DEFAULT_APP_PREFIX);
      const archive: Zippable = {};
      for (const file of files) {
        archive[prefix + file.entry] = await readFile(file.absolute);
      }

      const sqliteEntry = options.sqliteEntryName ?? DEFAULT_SQLITE_ENTRY;
      const sqlite = readSqlite(root, options.sqlitePath);
      if (options.sqlitePath && sqlite.byteLength === 0) {
        this.warn(
          `DAI: sqlitePath "${options.sqlitePath}" did not resolve to a file ` +
            `(looked in ${resolve(root, options.sqlitePath)}). ` +
            `Shipping an empty ${sqliteEntry} — check the path for a typo.`,
        );
      }
      archive[sqliteEntry] = sqlite;

      const wasmEntry = options.wasmEntryName ?? DEFAULT_WASM_ENTRY;
      const wasm = findSqliteWasm(root, options.sqliteWasmPath);
      if (wasm) {
        archive[wasmEntry] = new Uint8Array(readFileSync(wasm));
      } else if (options.sqliteWasmPath) {
        this.warn(
          `DAI: sqliteWasmPath "${options.sqliteWasmPath}" did not resolve to a ` +
            `file (looked in ${resolve(root, options.sqliteWasmPath)}). ` +
            `The container will ship without a SQLite engine.`,
        );
      }

      // The shell is the finished container minus its payload: template, app
      // name and runtime resolved, `<!--DAI_PAYLOAD-->` still open. It goes into
      // the archive it will later carry, so saves regenerate the same shell.
      const shell = template
        .split(APP_NAME_PLACEHOLDER)
        .join(escapeHtml(appName))
        .replace(RUNTIME_PLACEHOLDER, () => runtime);
      archive[CONTAINER_ENTRY] = new TextEncoder().encode(shell);

      const zipped = zipSync(archive, { level: options.compressionLevel ?? 9 });
      const payload = Buffer.from(zipped).toString("base64");

      // Base64 contains no `<`, so it cannot terminate the payload script tag.
      const html = shell.replace(PAYLOAD_TAG_RE, (_match, open: string) => open + payload);

      const outDir = options.outDir ? resolve(root, options.outDir) : root;
      const outFile = join(outDir, `${sanitizeFileName(appName)}.dai.html`);
      writeFileSync(outFile, html, "utf8");

      config.logger.info(
        `\n[dai] ${relative(root, outFile) || outFile} — ` +
          `${Object.keys(archive).length} entries, ` +
          `${wasm ? "sqlite3.wasm embedded" : "no sqlite engine"}, ` +
          `${formatBytes(zipped.byteLength)} archive, ` +
          `${formatBytes(Buffer.byteLength(html))} container`,
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

/**
 * Locates the SQLite engine binary: the configured path if given, otherwise the
 * copy installed by @sqlite.org/sqlite-wasm. Returns undefined when neither
 * exists — a container without an engine is valid, just not database-backed.
 */
function findSqliteWasm(root: string, configured?: string): string | undefined {
  const candidates = configured
    ? [resolve(root, configured)]
    : SQLITE_WASM_LOOKUP.map((path) => resolve(root, path));
  return candidates.find((path) => existsSync(path) && statSync(path).isFile());
}

function normalizePrefix(prefix: string): string {
  const trimmed = prefix.replace(/^\/+|\/+$/g, "");
  return trimmed ? `${trimmed}/` : "";
}

/**
 * Reads the seed SQLite document. Returns an empty array when no path was given
 * (the correct silent default) or when the given path does not resolve — the
 * caller warns in the latter case so a typo cannot ship a dead database.
 */
function readSqlite(root: string, sqlitePath?: string): Uint8Array {
  if (!sqlitePath) return new Uint8Array(0);
  const absolute = resolve(root, sqlitePath);
  if (!existsSync(absolute) || !statSync(absolute).isFile()) return new Uint8Array(0);
  return new Uint8Array(readFileSync(absolute));
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

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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
