/**
 * This device's person key, held by the host (docs/identity.md, binding rule 1).
 *
 * The host owns identity. The frame learns its author id from here on every
 * mount and never from a row, so a copy that arrived with somebody else's
 * rows, or somebody else's `_dai_replica`, still writes as this device.
 *
 * Made on first use, never at boot: the first thing that asks for the author
 * id is what makes the key, and opening the opener with no document makes
 * nothing. Persistence is not asked for here; D55 asks after the first real
 * write, and the key is kept by that same storage.
 *
 * When storage cannot keep it (a private window, a device that refuses), the
 * key lives for this page only and the device is a new author on its next
 * load. That is the accepted behaviour (docs/identity.md, Loss), and the
 * console says so once.
 */
import { authorIdOf, mintPersonKey, rawPublicKey, showAuthorId } from "../../../src/identity.js";
import { keepPersonKey, keptPersonKey } from "./opfs.js";

export interface Person {
  keys: CryptoKeyPair;
  /** The raw public key, 65 bytes: what `pub` carries. */
  pub: Uint8Array;
  /** The author id, as bytes: what the frame is handed and writes under. */
  id: Uint8Array;
  /** The author id, shown form. */
  author: string;
}

let held: Promise<Person> | null = null;

async function describe(keys: CryptoKeyPair): Promise<Person> {
  const pub = await rawPublicKey(keys.publicKey);
  const id = await authorIdOf(pub);
  return { keys, pub, id, author: showAuthorId(id) };
}

async function load(): Promise<Person> {
  const kept = await keptPersonKey();
  if (kept) return describe(kept);
  const minted = await mintPersonKey();
  try {
    await keepPersonKey(minted);
  } catch {
    // Either another tab kept one first (its add won), or storage refused. Read
    // back: a key kept by the other tab is this device's key too.
    const winner = await keptPersonKey();
    if (winner) return describe(winner);
    const person = await describe(minted);
    console.info(`dai: person key not kept; this page writes as ${person.author} until it closes`);
    return person;
  }
  return describe(minted);
}

/** This device's person, made on the first call. */
export function person(): Promise<Person> {
  if (!held) {
    held = load().catch((error: unknown) => {
      held = null;
      throw error;
    });
  }
  return held;
}

/** This device's author id, shown form. The first call is what makes the key. */
export async function authorId(): Promise<string> {
  return (await person()).author;
}
