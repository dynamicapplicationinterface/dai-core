/**
 * A publisher who is somebody. Spec §9.6.
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
 * seen before, and against what an organisation told it to trust.
 *
 *  - **known** — the key is in the key store or a root list. The only state
 *    that gets to look good.
 *  - **new** — the key is unknown and the name collides with nothing.
 *    Neutral, with a safety number a person can read to the sender over a
 *    channel the sender did not choose.
 *  - **conflict** — the key is unknown and the name is one this device knows
 *    under a different key, by either collision rule below. Red. A stranger
 *    has typed a name this device knows.
 *
 * Two collision rules, both required (§9.6). Mixed script: one word spelled
 * from two alphabets is not a name, and needs no table to see. Skeleton: the
 * UTS #39 §4 confusable skeleton of the name equals that of a name held. The
 * table for the second is loaded by the host and handed in, so that every
 * host and the Python reader compute the same skeleton from the same bytes.
 *
 * A host label — a name the person gave a key on this device — takes
 * precedence over anything a document asserts, wherever a name is shown.
 */
import type { VerifiedContainer } from "./container.js";
import { sha256Hex } from "./core.js";

/** The UTS #39 confusable table: source character to its prototype. */
export interface ConfusableTable {
  unicode: string;
  map: Record<string, string>;
}

/** What a host remembers about a publisher it has seen sign something. */
export interface PublisherPin {
  /** Base64 SPKI. The key is the identity; the name is what it calls itself. */
  publicKey: string;
  /** The name the key last signed under. */
  name: string;
  /** A name the person gave this key here. Local, never exported, shown first. */
  hostLabel?: string;
  /** `skeleton(name)` and `skeleton(hostLabel)`, stored so a collision search is a compare. */
  skeletons: string[];
  /** Which table the skeletons were computed with, so a host recomputes when it changes. */
  table: string;
  /** Unix milliseconds. */
  firstSeen: number;
  /** Document UUIDs opened under this key, so "3 of their apps" is a count of things. */
  documents: string[];
}

/** An entry provisioned by an organisation (§9.6, root lists): known without a sighting. */
export interface RootPublisher {
  spki: string;
  name: string;
  org?: string;
}

/**
 * Somewhere to keep publishers. Four methods, no logic.
 */
export interface PublisherStore {
  byKey(publicKey: string): Promise<PublisherPin | null>;
  bySkeleton(skeleton: string): Promise<PublisherPin[]>;
  /** Writes or replaces the record for a key. */
  save(pin: PublisherPin): Promise<void>;
  /** Keys an organisation told this host to know. Empty when none were provisioned. */
  roots(): Promise<RootPublisher[]>;
}

export type PublisherState =
  | { state: "unsigned" }
  | { state: "anonymous"; fingerprint: string; safetyNumber: string }
  | {
      state: "known";
      /** What to show: the host label when there is one, else the asserted name. */
      name: string;
      /** The name the document asserts, when it differs from what is shown. */
      asserted?: string;
      count: number;
      renamedFrom?: string;
      /** Set when the key came from a root list rather than a sighting. */
      org?: string;
      fingerprint: string;
    }
  | { state: "new"; name: string; fingerprint: string; safetyNumber: string }
  | {
      state: "conflict";
      claimed: string;
      knownAs: string;
      /**
       * Which rule fired (§9.6): the document is held under another key; one
       * word from two alphabets; or the skeleton of a name this host holds.
       */
      rule: "document" | "mixed-script" | "skeleton";
      fingerprint: string;
    };

/**
 * NFKC, case fold, drop whitespace and punctuation, then the UTS #39 §4
 * skeleton: every character replaced by its prototype, and NFD applied after.
 *
 * JavaScript's `toLowerCase` after NFKC is what stands in for a case fold;
 * the characters where the two differ do not occur in names this is for, and
 * the vectors are what a host has to match, not this sentence.
 */
export function skeleton(name: string, table: ConfusableTable): string {
  const folded = name.normalize("NFKC").toLowerCase();
  let kept = "";
  for (const char of folded) {
    if (/[\p{Z}\p{P}]/u.test(char)) continue;
    kept += char;
  }
  // UTS #39 §4: NFD, replace each character by its prototype, NFD again.
  let out = "";
  for (const char of kept.normalize("NFD")) out += table.map[char] ?? char;
  return out.normalize("NFD");
}

/** The scripts a name's letters may come from. Anything else is "other". */
const SCRIPTS: [string, RegExp][] = [
  ["latin", /\p{Script=Latin}/u],
  ["cyrillic", /\p{Script=Cyrillic}/u],
  ["greek", /\p{Script=Greek}/u],
  ["armenian", /\p{Script=Armenian}/u],
  ["hebrew", /\p{Script=Hebrew}/u],
  ["arabic", /\p{Script=Arabic}/u],
  ["han", /\p{Script=Han}/u],
  ["hiragana", /\p{Script=Hiragana}/u],
  ["katakana", /\p{Script=Katakana}/u],
  ["hangul", /\p{Script=Hangul}/u],
  ["thai", /\p{Script=Thai}/u],
  ["devanagari", /\p{Script=Devanagari}/u],
];

/**
 * The mixed-script rule (§9.6, rule 1): a single whitespace-separated token
 * whose letters come from more than one script.
 *
 * Han with Hiragana or Katakana is one writing system, not two, and is
 * allowed. Digits and punctuation belong to no script and never count.
 */
export function mixedScript(name: string): boolean {
  const folded = name.normalize("NFKC").toLowerCase();
  for (const token of folded.split(/\s+/)) {
    const seen = new Set<string>();
    for (const char of token) {
      if (!/\p{L}/u.test(char)) continue;
      const script = SCRIPTS.find(([, re]) => re.test(char))?.[0] ?? "other";
      seen.add(script);
    }
    seen.delete("other");
    if (seen.has("han") && (seen.has("hiragana") || seen.has("katakana"))) {
      seen.delete("hiragana");
      seen.delete("katakana");
    }
    if (seen.size > 1) return true;
  }
  return false;
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
    const chunk = parseInt(digest.slice(i * 10, i * 10 + 10), 16) % 100000;
    groups.push(String(chunk).padStart(5, "0"));
  }
  return groups.join(" ");
}

/** What a pin is called on screen: the person's label first, the key's claim second. */
function displayName(pin: { hostLabel?: string; name: string }): string {
  return pin.hostLabel?.trim() || pin.name;
}

/**
 * What this device can say about who signed a container.
 *
 * Runs after verification: `container.publicKey` is a key whose signature
 * checked out over these bytes. What is decided here is not whether the
 * signature is good but whose it is, as far as this device has seen and been
 * told.
 */
export async function publisherState(
  store: PublisherStore,
  container: VerifiedContainer,
  table: ConfusableTable,
  /**
   * The key this host holds for this document, when it has one (the document
   * store of §9.6). A host passes what its trust store says; a document held
   * under another key is a conflict before any name is looked at.
   */
  documentKey?: string | null,
): Promise<PublisherState> {
  if (container.signature !== "valid" || !container.publicKey) return { state: "unsigned" };

  const key = container.publicKey;
  const fingerprint = container.publicKeyFingerprint ?? "";
  const claimed = container.manifest.publisherName?.trim() ?? "";

  // Rule 3 (§9.6): this document, under another key. Decided first, because a
  // known publisher's name on somebody else's copy of a document is exactly
  // the impersonation the document store exists to catch.
  if (documentKey && documentKey !== key) {
    return { state: "conflict", claimed, knownAs: claimed, rule: "document", fingerprint };
  }
  const pinned = await store.byKey(key);
  const roots = await store.roots();
  const root = roots.find((r) => r.spki === key);

  if (pinned || root) {
    const count = pinned?.documents.length ?? 0;
    const shown = pinned ? displayName(pinned) : root!.name;
    const remembered = pinned?.name ?? root!.name;
    const renamed = claimed && skeleton(claimed, table) !== skeleton(remembered, table) ? remembered : undefined;
    return {
      state: "known",
      name: pinned?.hostLabel ? shown : claimed || shown,
      ...(pinned?.hostLabel && claimed && claimed !== shown ? { asserted: claimed } : {}),
      count,
      ...(renamed && !pinned?.hostLabel ? { renamedFrom: renamed } : {}),
      ...(root?.org ? { org: root.org } : {}),
      fingerprint,
    };
  }

  if (!claimed) {
    return { state: "anonymous", fingerprint, safetyNumber: await safetyNumber(key) };
  }

  // Rule 1: one word, two alphabets. Needs nothing held to be wrong.
  if (mixedScript(claimed)) {
    return { state: "conflict", claimed, knownAs: claimed, rule: "mixed-script", fingerprint };
  }

  // Rule 2: the skeleton matches a name this device holds — a pinned name, a
  // host label, or a root list entry — under a different key.
  const sk = skeleton(claimed, table);
  const collisions = (await store.bySkeleton(sk)).filter((p) => p.publicKey !== key);
  if (collisions.length > 0) {
    return { state: "conflict", claimed, knownAs: displayName(collisions[0]!), rule: "skeleton", fingerprint };
  }
  const rootCollision = roots.find((r) => r.spki !== key && skeleton(r.name, table) === sk);
  if (rootCollision) {
    return { state: "conflict", claimed, knownAs: rootCollision.name, rule: "skeleton", fingerprint };
  }

  return { state: "new", name: claimed, fingerprint, safetyNumber: await safetyNumber(key) };
}

/** The skeletons a pin is found by: its asserted name and its host label. */
function skeletonsOf(pin: { name: string; hostLabel?: string }, table: ConfusableTable): string[] {
  const out = new Set<string>();
  if (pin.name) out.add(skeleton(pin.name, table));
  if (pin.hostLabel?.trim()) out.add(skeleton(pin.hostLabel, table));
  return [...out];
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
  table: ConfusableTable,
): Promise<void> {
  if (container.signature !== "valid" || !container.publicKey) return;
  const key = container.publicKey;
  const uuid = container.manifest.documentUuid;
  const claimed = container.manifest.publisherName?.trim();

  const pinned = await store.byKey(key);
  if (pinned) {
    const documents = pinned.documents.includes(uuid) ? pinned.documents : [...pinned.documents, uuid];
    const name = claimed || pinned.name;
    const next = { ...pinned, name, documents };
    await store.save({ ...next, skeletons: skeletonsOf(next, table), table: table.unicode });
    return;
  }
  const pin = { publicKey: key, name: claimed ?? "", firstSeen: Date.now(), documents: [uuid] };
  await store.save({ ...pin, skeletons: skeletonsOf(pin, table), table: table.unicode });
}

/**
 * Gives a key a name on this device. Local, never exported, shown first.
 *
 * Also what makes "the Acme Finance you know" mean something a person chose:
 * a stranger's name is then compared against the label as well as against
 * whatever the real key last asserted.
 */
export async function labelPublisher(
  store: PublisherStore,
  publicKey: string,
  hostLabel: string,
  table: ConfusableTable,
): Promise<void> {
  const pinned = await store.byKey(publicKey);
  if (!pinned) return;
  const next = { ...pinned, hostLabel: hostLabel.trim() || undefined };
  await store.save({ ...next, skeletons: skeletonsOf(next, table), table: table.unicode });
}

/**
 * Brings a pin's skeletons up to the table in hand, when the table changed.
 * Called by a host lazily, one pin at a time as it meets them.
 */
export function refreshed(pin: PublisherPin, table: ConfusableTable): PublisherPin {
  if (pin.table === table.unicode) return pin;
  return { ...pin, skeletons: skeletonsOf(pin, table), table: table.unicode };
}
