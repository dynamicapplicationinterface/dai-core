/**
 * The runner's adapter onto the shared container reader.
 *
 * Everything that decides whether a cartridge may run now lives in
 * `dai-core/container`, so the runner and the desktop shell reach the same
 * verdict on the same file. What remains here is the part that is genuinely
 * the runner's: turning a browser `File` into text, which the core cannot do
 * without taking on a DOM type.
 */
import {
  ContainerError,
  looksSectioned,
  resealContainer,
  verifyContainer,
  type VerifiedContainer,
} from "../../../src/container.js";
import { heldEngine } from "./engine.js";

export { ContainerError };
export type { VerifiedContainer };

/**
 * Kept as an alias so callers in the runner read naturally, and so the shape
 * has one name across the app rather than two that drift.
 */
export type Cartridge = VerifiedContainer;

/** The manifest as the runner's UI consumes it. */
export type CartridgeManifest = VerifiedContainer["manifest"];

/**
 * Reads and verifies a chosen file.
 *
 * The verification that gates mounting is the core's: bidirectional digests,
 * the shell compared against its sealed copy, and the publisher signature when
 * a key is carried.
 */
export async function readCartridge(file: File): Promise<Cartridge> {
  const bytes = new Uint8Array(await file.arrayBuffer());

  // The form comes from the leading bytes, never the name. Decoding a sectioned
  // container as text does not fail loudly — it replaces every byte that is not
  // valid UTF-8, which is most of a database, and hands the verifier a file
  // that this function damaged on the way in.
  const source = looksSectioned(bytes) ? bytes : new TextDecoder().decode(bytes);

  try {
    return await verifyContainer(source);
  } catch (error) {
    /*
     * A document published without its engine (§6.2), which this app holds.
     *
     * Tried the plain way first on purpose. The overwhelming majority of
     * documents carry their own engine, and fetching a megabyte before every
     * one of them on the chance that this one does not would make the common
     * case pay for the rare one. The refusal is how we learn, and it costs a
     * parse we had to do anyway.
     *
     * Nothing here weakens the check. The bytes go in and the whole archive is
     * verified against the manifest a moment later, so an engine that is not
     * the one the manifest names fails exactly as a tampered entry does.
     */
    if (!(error instanceof ContainerError) || error.code !== "RUNTIME_UNAVAILABLE") throw error;
    return verifyContainer(source, { supply: await heldEngine() });
  }
}

/**
 * Reseals a cartridge around a database recovered from OPFS.
 *
 * Delegates to the core so the manifest is rewritten exactly as the compiler
 * and the container's own save path write it.
 */
export async function resealCartridge(
  cartridge: Cartridge,
  database: Uint8Array,
): Promise<Cartridge> {
  const resealed = await resealContainer(cartridge, database);

  // Re-verified rather than trusted. The bytes about to be mounted are not the
  // bytes that were checked on the way in: a database recovered from OPFS has
  // been through storage this app does not control, and resealing rewrites the
  // manifest around it. Verifying the result costs one pass and removes the
  // only route by which unverified bytes reach the frame.
  return verifyContainer(resealed.html);
}
