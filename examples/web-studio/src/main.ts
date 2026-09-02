/**
 * The DAI Web Studio: an in-browser container compiler.
 *
 * TSX + a SQL schema go in, a sealed `.dai.html` comes out, with no server
 * involved in the compilation. This is the payoff of the pure core — the exact
 * same `buildContainer` that the Vite plugin calls runs here unchanged.
 *
 * The Studio itself is online and fetches the SQLite engine and the esbuild
 * WASM binary from its own origin. The air-gap rules govern the artifacts it
 * produces, not the tool producing them.
 */
// The ESM browser build explicitly: the package has no exports map, so a bare
// specifier resolves to lib/main.js (the Node build), whose namespace has no
// initialize() in a browser.
import * as esbuild from "esbuild-wasm/esm/browser.js";
import esbuildWasmUrl from "esbuild-wasm/esbuild.wasm?url";
import { buildContainer } from "../../../src/core.js";
import { CONTAINER_TEMPLATE, RUNTIME_SOURCE } from "../../../dist/templates.js";

// Deep paths rather than package specifiers: the glue is not in the package's
// exports map, so a bare import would be blocked by Node resolution rules.
import sqliteWasmUrl from "../../../node_modules/@sqlite.org/sqlite-wasm/dist/sqlite3.wasm?url";
import sqliteGlueUrl from "../../../node_modules/@sqlite.org/sqlite-wasm/dist/index.mjs?url";

const status = document.getElementById("status") as HTMLElement;
const download = document.getElementById("download") as HTMLAnchorElement;
const compileButton = document.getElementById("compile") as HTMLButtonElement;
const sourceInput = document.getElementById("source") as HTMLTextAreaElement;
const schemaInput = document.getElementById("schema") as HTMLTextAreaElement;

const encoder = new TextEncoder();

function log(line: string): void {
  status.textContent = `${status.textContent}\n${line}`.trim();
}

let esbuildReady: Promise<void> | undefined;
function initEsbuild(): Promise<void> {
  // initialize() throws if called twice, so the promise is the guard.
  esbuildReady ??= esbuild.initialize({ wasmURL: esbuildWasmUrl });
  return esbuildReady;
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} → HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * Wraps the transpiled module in a document.
 *
 * The schema travels as a global rather than a separate fetched file: a
 * container cannot fetch anything, so everything the application needs must
 * already be in the document the bootloader mounts.
 */
function entryHtml(schema: string): string {
  return (
    `<!doctype html><html lang="en"><head><meta charset="UTF-8">` +
    `<script>window.__schema = ${JSON.stringify(schema)};<\/script>` +
    `</head><body><script src="./app.js"><\/script></body></html>`
  );
}

async function compile(): Promise<void> {
  compileButton.disabled = true;
  status.textContent = "";
  download.hidden = true;

  try {
    log("initializing esbuild…");
    await initEsbuild();

    log("transpiling TSX…");
    const transpiled = await esbuild.transform(sourceInput.value, {
      loader: "tsx",
      format: "iife",
      target: "es2020",
    });
    for (const warning of transpiled.warnings) log(`warning: ${warning.text}`);

    log("fetching SQLite engine…");
    const [wasm, glue] = await Promise.all([
      fetchBytes(sqliteWasmUrl),
      fetchBytes(sqliteGlueUrl),
    ]);

    log("sealing container…");
    const built = await buildContainer({
      files: {
        "index.html": encoder.encode(entryHtml(schemaInput.value)),
        "app.js": encoder.encode(transpiled.code),
      },
      template: CONTAINER_TEMPLATE,
      runtime: RUNTIME_SOURCE,
      appName: "studio-doc",
      wasm,
      glue,
    });

    const blob = new Blob([built.html], { type: "text/html" });
    download.href = URL.createObjectURL(blob);
    download.download = "studio-doc.dai.html";
    download.hidden = false;
    download.textContent = `Download studio-doc.dai.html (${(blob.size / 1024).toFixed(0)} KB)`;

    log(`sealed ${Object.keys(built.archive).length} entries`);
    log(`uuid ${built.documentUuid}`);
    log("ready");
    document.body.dataset.compiled = "true";
  } catch (error) {
    log(`FAILED: ${(error as Error).message}`);
    document.body.dataset.compiled = "failed";
  } finally {
    compileButton.disabled = false;
  }
}

compileButton.addEventListener("click", () => void compile());
