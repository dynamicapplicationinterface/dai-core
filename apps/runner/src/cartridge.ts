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
  resealContainer,
  verifyContainer,
  type VerifiedContainer,
} from "../../../src/container.js";

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
  const buffer = await file.arrayBuffer();
  const html = new TextDecoder().decode(new Uint8Array(buffer));
  return verifyContainer(html);
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
  // Resealing changes only the database and the digests covering it; the
  // signature stays valid because document.sqlite was never in the signed set.
  return { ...resealed, signature: cartridge.signature };
}
