import { authorIdOf, mintPersonKey, rawPublicKey, showAuthorId } from "../src/identity.js";
import { pendingBatches, recordSeal, signBatch } from "../src/replicated-batch.js";
import { mergeSibling, mergeTablesOf } from "../src/replicated-frame.js";
import type { Rows } from "../src/replicated-rows.js";

/**
 * People with real keys, for tests whose rows cross a merge.
 *
 * A merge refuses an unsigned row in the seat tables (BATCH_UNSIGNED, D133), so
 * a test that carries a seat, an ask or a confirmation from one copy to another
 * signs it the way a copy does: under the author's own key, for one document.
 * An author id is the fingerprint of a key, so a person is minted, never
 * written as sixteen chosen bytes.
 */

export const TEST_DOCUMENT = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

export interface Person {
  keys: CryptoKeyPair;
  author: Uint8Array;
  /** The author id as a merge report shows it. */
  shown: string;
}

export async function person(): Promise<Person> {
  const keys = await mintPersonKey();
  const author = await authorIdOf(await rawPublicKey(keys.publicKey));
  return { keys, author, shown: showAuthorId(author) };
}

/** Seals every row this person wrote into `db` and has not sealed: an honest signature. */
export async function sealAs(db: Rows, who: Person): Promise<void> {
  for (const batch of pendingBatches(db, who.author, mergeTablesOf(db))) {
    recordSeal(db, await signBatch(batch, { document: TEST_DOCUMENT, keys: who.keys }));
  }
}

/** A merge that verifies the sibling's signatures for the test document. */
export const mergeSigned = (into: Rows, from: Rows, as?: Person) =>
  mergeSibling(into, from, { document: TEST_DOCUMENT, ...(as ? { author: as.author } : {}) });
