/**
 * A publisher who is somebody.
 *
 * Trust on first use pins a key to a document: the second copy of a document
 * signed by somebody else is caught. It says nothing about a *new* document,
 * because a new document is a first use — and "Acme Finance" arriving for the
 * first time looks the same whether it is Acme Finance or a stranger who typed
 * the name. This closes that as far as a device can on its own, by remembering
 * publishers rather than documents: the key, the name it signs under, and how
 * many of its documents have been opened here.
 *
 * Three states, and never the word "verified", because nothing here verifies
 * a name against the world. It verifies a name against what this device has
 * seen before.
 *
 *  - **known** — the key is pinned and the name matches. The only state that
 *    gets to look good.
 *  - **new** — the key is unknown and the name collides with nothing pinned.
 *    Neutral, with a safety number a person can read to the sender over a
 *    channel the sender did not choose.
 *  - **conflict** — the key is unknown and the name, once it has been folded,
 *    stripped and de-confused, is one pinned under a different key. Red. A
 *    stranger has typed a name this device knows.
 *
 * The same key with a changed name is known, and says so: a publisher may
 * rename. A different key with the same name may not be the same publisher,
 * and this device cannot tell, so it does not pretend to.
 */
import type { VerifiedContainer } from "./container.js";
import { sha256Hex } from "./core.js";

/** What a host remembers about a publisher it has seen sign something. */
export interface PublisherPin {
  /** Base64 SPKI. The key is the identity; the name is what it calls itself. */
  publicKey: string;
  name: string;
  /** `foldName(name)`, stored so a collision search is one lookup. */
  folded: string;
  /** Unix milliseconds. */
  firstSeen: number;
  /** Document UUIDs opened under this key, so "3 of their apps" is a count of things. */
  documents: string[];
}

/**
 * Somewhere to keep publishers. Four methods, no logic.
 */
export interface PublisherStore {
  byKey(publicKey: string): Promise<PublisherPin | null>;
  byFoldedName(folded: string): Promise<PublisherPin[]>;
  /** Writes or replaces the record for a key. */
  save(pin: PublisherPin): Promise<void>;
}

export type PublisherState =
  | { state: "unsigned" }
  | { state: "anonymous"; fingerprint: string; safetyNumber: string }
  | {
      state: "known";
      name: string;
      count: number;
      renamedFrom?: string;
      fingerprint: string;
    }
  | { state: "new"; name: string; fingerprint: string; safetyNumber: string }
  | { state: "conflict"; claimed: string; knownAs: string; fingerprint: string };

/*
 * Characters that look like Latin letters and are not.
 *
 * The full Unicode confusables table is thousands of entries and mostly about
 * scripts nobody would use to impersonate an English brand name. These are the
 * ones that actually get used: Cyrillic and Greek letters that render
 * identically to Latin in every common font, plus the digits that stand in for
 * letters. A name that only differs from a pinned one by these is the same
 * name, said by somebody else.
 */
const CONFUSABLES: Record<string, string> = {
  а: "a", е: "e", о: "o", р: "p", с: "c", х: "x", у: "y", і: "i", ј: "j", ѕ: "s", ԁ: "d", һ: "h",
  ӏ: "l", ԛ: "q", ԝ: "w", ν: "v", ο: "o", ρ: "p", ι: "i", κ: "k", τ: "t", υ: "u", α: "a",
  "0": "o", "1": "l", "3": "e", "4": "a", "5": "s", "7": "t", "8": "b", "@": "a", $: "s",
  ı: "i", ł: "l", ø: "o", đ: "d",
};

/**
 * A name reduced to what a person's eye compares.
 *
 * NFKC first, so ligatures and full-width forms become their plain letters;
 * then case; then everything that is not a letter or digit, because "Acme
 * Finance", "acme-finance" and "ACME  FINANCE." are one name to anybody
 * reading them; then the lookalikes.
 */
export function foldName(name: string): string {
  const flat = name.normalize("NFKC").toLowerCase();
  let out = "";
  for (const char of flat) {
    if (!/[\p{L}\p{N}]/u.test(char)) continue;
    const mapped = CONFUSABLES[char];
    out += mapped ?? char;
  }
  return out;
}

/**
 * A number two people can read to each other.
 *
 * Six groups of five digits, from the key's digest. Digits rather than hex
 * because they are what people can say over a phone without spelling, and
 * grouped because thirty digits in a row cannot be checked by eye. The sender
 * sees the same number for their own key, so a match is a match of keys.
 */
export async function safetyNumber(publicKey: string): Promise<string> {
  const digest = await sha256Hex(new TextEncoder().encode(publicKey));
  const groups: string[] = [];
  for (let i = 0; i < 6; i++) {
    // Ten hex characters per group is 40 bits; modulo 10^5 keeps five digits.
    const chunk = parseInt(digest.slice(i * 10, i * 10 + 10), 16) % 100000;
    groups.push(String(chunk).padStart(5, "0"));
  }
  return groups.join(" ");
}

/**
 * What this device can say about who signed a container.
 *
 * Runs after verification: `container.publicKey` is a key whose signature
 * checked out over these bytes. What is decided here is not whether the
 * signature is good but whose it is, as far as this device has seen.
 */
export async function publisherState(
  store: PublisherStore,
  container: VerifiedContainer,
): Promise<PublisherState> {
  if (container.signature !== "valid" || !container.publicKey) return { state: "unsigned" };

  const key = container.publicKey;
  const fingerprint = container.publicKeyFingerprint ?? "";
  const claimed = container.manifest.publisherName?.trim() ?? "";
  const pinned = await store.byKey(key);

  if (pinned) {
    if (!claimed) {
      // A key this device knows, signing with no name this time. Still known:
      // the key is the identity.
      return { state: "known", name: pinned.name, count: pinned.documents.length, fingerprint };
    }
    return foldName(claimed) === pinned.folded
      ? { state: "known", name: claimed, count: pinned.documents.length, fingerprint }
      : {
          state: "known",
          name: claimed,
          count: pinned.documents.length,
          renamedFrom: pinned.name,
          fingerprint,
        };
  }

  if (!claimed) {
    // Signed by a key this device has not seen, under no name. There is
    // nothing to collide with and nothing to call it.
    return { state: "anonymous", fingerprint, safetyNumber: await safetyNumber(key) };
  }

  const collisions = (await store.byFoldedName(foldName(claimed))).filter((p) => p.publicKey !== key);
  if (collisions.length > 0) {
    return { state: "conflict", claimed, knownAs: collisions[0]!.name, fingerprint };
  }
  return { state: "new", name: claimed, fingerprint, safetyNumber: await safetyNumber(key) };
}

/**
 * Remembers a publisher after the person proceeded.
 *
 * After, not before: a name is recorded once somebody has looked at the card
 * and opened the document, so a conflict that was refused never becomes a
 * pin. A rename updates the stored name the same way — the person saw
 * "renamed from X" and went ahead.
 */
export async function recordPublisher(
  store: PublisherStore,
  container: VerifiedContainer,
): Promise<void> {
  if (container.signature !== "valid" || !container.publicKey) return;
  const key = container.publicKey;
  const uuid = container.manifest.documentUuid;
  const claimed = container.manifest.publisherName?.trim();

  const pinned = await store.byKey(key);
  if (pinned) {
    const documents = pinned.documents.includes(uuid) ? pinned.documents : [...pinned.documents, uuid];
    const name = claimed || pinned.name;
    await store.save({ ...pinned, name, folded: foldName(name), documents });
    return;
  }
  const name = claimed ?? "";
  await store.save({
    publicKey: key,
    name,
    folded: foldName(name),
    firstSeen: Date.now(),
    documents: [uuid],
  });
}
