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
 * A key is made only when the store says none is kept. A store that cannot be
 * read is read again for a few seconds (the iOS IndexedDB open that never
 * answers is usually transient), and if it still cannot be read the answer is
 * `PersonKeyUnreadable`, never a new key: a device that has a key and made
 * another would write in its own seat as somebody else (cold review of
 * identity step 2, #5). The caller opens the document with every write
 * refused, and says so.
 *
 * When the store reads fine and holds nothing, but refuses to keep a new key
 * (some private windows), the key lives for this page only and the device is
 * a new author on its next load. That is the accepted behavior
 * (docs/identity.md, Loss), and the console says so once.
 */
import { authorIdOf, mintPersonKey, rawPublicKey, showAuthorId, type KeptPersonKey } from "../../../src/identity.js";
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

/** The key store did not answer, within the deadline, whether a key is kept. */
export class PersonKeyUnreadable extends Error {
  constructor(why: string) {
    super(`This device's key could not be read: ${why}`);
    this.name = "PersonKeyUnreadable";
  }
}

/** How long an unreadable store is read again before the answer is "unreadable". */
const READ_DEADLINE_MS = 4_000;
const READ_PAUSE_MS = 250;

let held: Promise<Person> | null = null;

async function describe(keys: CryptoKeyPair): Promise<Person> {
  const pub = await rawPublicKey(keys.publicKey);
  const id = await authorIdOf(pub);
  return { keys, pub, id, author: showAuthorId(id) };
}

/** The store's answer, read again while it is unreadable, until the deadline. */
async function readKept(): Promise<Exclude<KeptPersonKey, { kept: "unreadable" }>> {
  const until = Date.now() + READ_DEADLINE_MS;
  for (;;) {
    const answer = await keptPersonKey();
    if (answer.kept !== "unreadable") return answer;
    if (Date.now() >= until) throw new PersonKeyUnreadable(answer.why);
    await new Promise((wait) => setTimeout(wait, READ_PAUSE_MS));
  }
}

/** Whether this page made the person key, rather than finding one kept (docs/identity.md, "Loss"). */
let mintedHere = false;
export const mintedThisPage = (): boolean => mintedHere;

async function load(): Promise<Person> {
  const kept = await readKept();
  if (kept.kept === "key") return describe(kept.keys);
  const minted = await mintPersonKey();
  mintedHere = true;
  try {
    await keepPersonKey(minted);
  } catch {
    // Either another tab kept one first (its add won), or storage refused the
    // write. Read back: a key kept by the other tab is this device's key too.
    const winner = await readKept();
    if (winner.kept === "key") {
      // Another tab's key, kept first: this page did not make the one it uses.
      mintedHere = false;
      return describe(winner.keys);
    }
    const person = await describe(minted);
    console.info(`dai: person key not kept; this page writes as ${person.author} until it closes`);
    return person;
  }
  return describe(minted);
}

/** This device's person, made on the first call. Rejects with PersonKeyUnreadable. */
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
