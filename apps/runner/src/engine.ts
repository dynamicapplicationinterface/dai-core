/**
 * The engine this opener holds, offered to documents published without one.
 *
 * A container normally carries its own SQLite engine, which is the largest
 * thing in it by an order of magnitude and identical in every document the
 * same compiler builds. Spec §6.2 lets a document be published without those
 * bytes, for a host that already has that exact copy. This is that host.
 *
 * Two rules make it safe, and both live here rather than in the caller:
 *
 *  - The offer is keyed on digest, never on name. What goes back is bytes this
 *    app already shipped, and only where the manifest says those exact bytes
 *    belong, so completing a document can change nothing about what runs.
 *  - Nothing is offered until a document asks. The engine is a megabyte, and
 *    the ordinary case — a complete document — must not pay for it. It is
 *    fetched the first time a thin one arrives, and held after that.
 *
 * Staged into /runtime by the build rather than bundled, so it is a cacheable
 * file on this origin rather than a megabyte inside the app's JavaScript.
 */
import { sha256Hex } from "../../../src/core.js";

/**
 * The files, by the names they are staged under.
 *
 * These are not the manifest's entry names and are not compared against them.
 * A document's manifest decides where its bytes go; this list only says what
 * this app has on disk to offer.
 */
const HELD = ["sqlite3.wasm", "sqlite3.mjs"] as const;

let holdings: Promise<Map<string, Uint8Array>> | undefined;

async function load(): Promise<Map<string, Uint8Array>> {
  const held = new Map<string, Uint8Array>();

  await Promise.all(
    HELD.map(async (name) => {
      // Same-origin and relative: the opener is served from a subpath in
      // preview and from the root in production, and an absolute path would
      // work in one and 404 in the other.
      const response = await fetch(new URL(`runtime/${name}`, document.baseURI));
      if (!response.ok) return;
      const bytes = new Uint8Array(await response.arrayBuffer());
      held.set(await sha256Hex(bytes), bytes);
    }),
  );

  return held;
}

/**
 * What this app can put back, ready to be asked.
 *
 * Returns a supplier that answers from memory. Resolving it is the network
 * call; the supplier itself is synchronous because the container reader
 * hashes and checks the whole archive in one pass, and a promise in the middle
 * of that would mean parsing could not be.
 *
 * A failed fetch is not an error here. It leaves the supplier with nothing to
 * offer, the document is refused as `RUNTIME_UNAVAILABLE`, and the person is
 * told this opener cannot run it — which is the truth, and better than a
 * network message about a file they never asked for.
 */
export async function heldEngine(): Promise<(digest: string) => Uint8Array | undefined> {
  holdings ??= load().catch(() => new Map<string, Uint8Array>());
  const held = await holdings;
  return (digest: string) => held.get(digest);
}
