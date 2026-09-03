#!/usr/bin/env node
/**
 * Stages the container runtime into the desktop app's static assets.
 *
 * The shell, the bootloader and the SQLite engine are copied rather than
 * imported: @sqlite.org/sqlite-wasm does not expose the raw .wasm through its
 * exports map, and reaching around that with a relative node_modules path
 * breaks the moment a hoisted install moves it.
 *
 * Staged under the same /runtime prefix the website uses, so the desktop app
 * can call the very same loadRuntimeAssets() rather than growing its own
 * loader — the difference between sharing a door and having a matching one.
 */
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const app = resolve(here, "..");
const repo = resolve(app, "../..");
const out = resolve(app, "public/runtime");

mkdirSync(out, { recursive: true });

const assets = {
  "template.html": resolve(repo, "dist/template.html"),
  "dai-runtime.js": resolve(repo, "dist/dai-runtime.js"),
  "sqlite3.wasm": resolve(repo, "node_modules/@sqlite.org/sqlite-wasm/dist/sqlite3.wasm"),
  "sqlite3.mjs": resolve(repo, "node_modules/@sqlite.org/sqlite-wasm/dist/index.mjs"),
};

for (const [name, from] of Object.entries(assets)) {
  copyFileSync(from, resolve(out, name));
}

console.log(`[dai] staged ${Object.keys(assets).length} runtime assets into public/runtime`);
