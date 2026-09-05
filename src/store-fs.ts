/**
 * A store that is a directory.
 *
 * For tests, for a machine that is its own relay, and for the MCP server on a
 * laptop that wants to hand out a link without an account anywhere. Two files
 * per document: the blob under its hash, and `<hash>.json` beside it. Served
 * by anything that serves files; the href it returns is whatever base URL it
 * was told those files appear under, or a `file:` URL when it was told nothing.
 *
 * Node only. Never imported by the opener.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { admit, type Sidecar, type Store } from "./store.js";

export interface FsStoreOptions {
  /** Where the files go. Created if absent. */
  root: string;
  /** The URL the directory is served under, if it is. */
  baseUrl?: string;
}

export function fsStore(options: FsStoreOptions): Store {
  const root = resolve(options.root);
  mkdirSync(root, { recursive: true });

  const hrefFor = (hash: string): string =>
    options.baseUrl
      ? options.baseUrl.replace(/\/$/, "") + "/" + hash
      : pathToFileURL(join(root, hash)).href;

  const pathFor = (href: string): string => {
    const hash = href.split("/").pop() ?? "";
    if (!/^[0-9a-f]{64}$/i.test(hash)) throw new Error(`Not a store address: ${href}`);
    return join(root, hash.toLowerCase());
  };

  return {
    async put(hash, ciphertext, sidecar: Sidecar) {
      await admit(hash, ciphertext, sidecar);
      const path = join(root, hash.toLowerCase());
      // Content-addressed, so a second put is the same bytes and nothing to do.
      if (!existsSync(path)) {
        writeFileSync(path, ciphertext);
        writeFileSync(
          path + ".json",
          JSON.stringify({ ...sidecar, storedAt: new Date().toISOString() }, null, 2) + "\n",
          "utf8",
        );
      }
      return hrefFor(hash);
    },

    async get(href) {
      return new Uint8Array(readFileSync(pathFor(href)));
    },

    async head(href) {
      const path = pathFor(href);
      if (!existsSync(path)) return { exists: false, size: 0 };
      return { exists: true, size: statSync(path).size };
    },
  };
}
